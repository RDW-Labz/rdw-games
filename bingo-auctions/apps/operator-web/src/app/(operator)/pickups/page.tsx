// Operator pickups dashboard.
// Today's appointments first, then upcoming. Action buttons mark a pickup
// completed (after physical checkout) or no_show (after the window passes
// without the bidder showing).

import Link from 'next/link';
import { getSupabaseServer } from '@/lib/supabase-server';
import { lotDisplayCode } from '@auction-platform/shared';
import { PageHeader } from '@/components/Form';
import { formatInTimeZone, warehouseTimezone } from '@/lib/datetime';
import { PickupActions } from './PickupActions';
import { CustomerSearch } from './CustomerSearch';
import { SessionsToggle } from './SessionsToggle';
import { MissingItemsQueue, type MissingItemRow } from './MissingItemsQueue';
import { isPickupSessionsEnabled } from '@/lib/pickup-session';
import { DONE_PICKUP_STATUSES, OPEN_PICKUP_STATUSES, pickupBucket } from './buckets';
import { customerLabel, invoiceShortId, owedLotCodes, type OwedLotLine } from './counter-rows';
import { FilterSelect } from '@/components/FilterSelect';
import {
  filterMissingItemsByWarehouseId,
  filterPickupsByWarehouseId,
  resolveActiveWarehouseId,
} from './warehouse-filter';
import { cookies } from 'next/headers';
import { CONSOLE_UI_COOKIE, isConsoleV2 } from '@/lib/console-ui';
import { PickupsV2 } from './v2/PickupsV2';
import { counterDetailsToRecord, mapPickupRow } from './v2/map-pickup-row';

type WarehouseLite = { id: string; name: string };

export default async function PickupsPage(props: {
  searchParams: Promise<{ warehouse?: string }>;
}) {
  const supabase = await getSupabaseServer();
  const sessionsEnabled = await isPickupSessionsEnabled();
  const sp = await props.searchParams;

  const { data: warehousesData } = await supabase
    .from('warehouses')
    .select('id, name')
    .order('name', { ascending: true });
  const warehouses = (warehousesData ?? []) as unknown as WarehouseLite[];
  const warehouseIds = warehouses.map((w) => w.id);
  const activeWarehouseId = resolveActiveWarehouseId(sp.warehouse, warehouseIds);

  // Missing-item refund queue (mig 0243): unresolved 'missing' outcomes.
  const { data: missingRows } = await supabase
    .from('pickup_lot_outcomes')
    .select('id, created_at, lots(lot_code, sticker_code, display_code, title), pickups(invoice_id, warehouse_id, invoices(bidder_id, bidders(email, display_name)))')
    .eq('outcome', 'missing')
    .is('resolved_at', null)
    .order('created_at', { ascending: true })
    .limit(50);
  const missing: MissingItemRow[] = ((missingRows ?? []) as unknown as Array<{
    id: string;
    created_at: string;
    lots: {
      lot_code: string;
      sticker_code: string | null;
      display_code: string | null;
      title: string;
    } | null;
    pickups: {
      invoice_id: string;
      warehouse_id: string | null;
      invoices: { bidders: { email: string | null; display_name: string | null } | null } | null;
    } | null;
  }>)
    .filter((r) => r.lots && r.pickups)
    .map((r) => ({
      outcomeId: r.id,
      lotCode: lotDisplayCode({ lot_code: r.lots!.lot_code, sticker_code: r.lots!.sticker_code, display_code: r.lots!.display_code }) ?? r.lots!.lot_code,
      title: r.lots!.title,
      invoiceId: r.pickups!.invoice_id,
      warehouseId: r.pickups!.warehouse_id ?? null,
      bidderLabel:
        r.pickups!.invoices?.bidders?.display_name ??
        r.pickups!.invoices?.bidders?.email ??
        'customer',
      markedAt: r.created_at,
    }));
  const missingFiltered = filterMissingItemsByWarehouseId(missing, activeWarehouseId);
  // 2026-10-08 (see ./buckets.ts): open pickups are loaded on their own, so a
  // checked-in customer at the counter is always listed. The old single query
  // left out 'checked_in' and kept 200 effectively random rows out of ~9,400,
  // because almost no pickup has a scheduled_at to sort by.
  const PICKUP_COLUMNS =
    'id, status, scheduled_at, checked_in_at, completed_at, invoice_id, warehouse_id, warehouses(name, timezone), invoices(status, bidder_id, total_cents, bidders(email, display_name))';
  const [{ data: openPickups }, { data: donePickups }] = await Promise.all([
    supabase
      .from('pickups')
      .select(PICKUP_COLUMNS)
      .in('status', [...OPEN_PICKUP_STATUSES])
      .order('checked_in_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(1000),
    supabase
      .from('pickups')
      .select(PICKUP_COLUMNS)
      .in('status', [...DONE_PICKUP_STATUSES])
      .order('completed_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .limit(50),
  ]);

  const openFiltered = filterPickupsByWarehouseId(openPickups ?? [], activeWarehouseId);
  const doneFiltered = filterPickupsByWarehouseId(donePickups ?? [], activeWarehouseId);

  const counter: NonNullable<typeof openPickups> = [];
  const today: NonNullable<typeof openPickups> = [];
  const upcoming: NonNullable<typeof openPickups> = [];
  const past: NonNullable<typeof openPickups> = [];
  const now = new Date();

  for (const p of [...openFiltered, ...doneFiltered]) {
    const bucket = pickupBucket(
      { status: p.status as string | null, scheduled_at: (p.scheduled_at as string | null) ?? null },
      now,
    );
    if (bucket === 'counter') counter.push(p);
    else if (bucket === 'today') today.push(p);
    else if (bucket === 'waiting') upcoming.push(p);
    else past.push(p);
  }

  const counterBidderIds = [
    ...new Set(
      counter
        .map((p) => (p.invoices as { bidder_id?: string } | null)?.bidder_id)
        .filter((id): id is string => Boolean(id)),
    ),
  ];

  let bidderById = new Map<string, { display_name: string | null; email: string | null }>();
  if (counterBidderIds.length) {
    const { getSupabaseAdmin } = await import('@/lib/supabase-admin');
    const { data: bidderRows } = await getSupabaseAdmin()
      .from('bidders')
      .select('id, display_name, email')
      .in('id', counterBidderIds);
    bidderById = new Map(
      ((bidderRows ?? []) as { id: string; display_name: string | null; email: string | null }[]).map(
        (b) => [b.id, { display_name: b.display_name, email: b.email }],
      ),
    );
  }

  const counterPickupIds = counter.map((p) => p.id as string);
  const counterInvoiceIds = [...new Set(counter.map((p) => p.invoice_id as string))];

  const invoiceLotsByInvoice = new Map<string, OwedLotLine[]>();
  const missingLotsByPickup = new Map<string, Set<string>>();

  if (counterInvoiceIds.length) {
    const { data: lotRows } = await supabase
      .from('invoice_lots')
      .select('invoice_id, lot_id, picked_up_at, refunded_at, lots(lot_code, sticker_code, display_code)')
      .in('invoice_id', counterInvoiceIds);
    for (const row of (lotRows ?? []) as unknown as Array<{
      invoice_id: string;
      lot_id: string;
      picked_up_at: string | null;
      refunded_at: string | null;
      lots: OwedLotLine['lots'];
    }>) {
      const list = invoiceLotsByInvoice.get(row.invoice_id) ?? [];
      list.push({
        lot_id: row.lot_id,
        picked_up_at: row.picked_up_at,
        refunded_at: row.refunded_at,
        lots: row.lots,
      });
      invoiceLotsByInvoice.set(row.invoice_id, list);
    }
  }

  if (counterPickupIds.length) {
    const { data: missingOutcomeRows } = await supabase
      .from('pickup_lot_outcomes')
      .select('pickup_id, lot_id')
      .eq('outcome', 'missing')
      .in('pickup_id', counterPickupIds);
    for (const row of (missingOutcomeRows ?? []) as { pickup_id: string; lot_id: string }[]) {
      const set = missingLotsByPickup.get(row.pickup_id) ?? new Set<string>();
      set.add(row.lot_id);
      missingLotsByPickup.set(row.pickup_id, set);
    }
  }

  const counterDetails = new Map<string, CounterRowDetail>();
  for (const p of counter) {
    const inv = p.invoices as { bidder_id?: string } | null;
    const bidder = inv?.bidder_id ? bidderById.get(inv.bidder_id) : undefined;
    const pickupId = p.id as string;
    const invoiceId = p.invoice_id as string;
    counterDetails.set(pickupId, {
      customerLabel: customerLabel(bidder),
      owed: owedLotCodes(
        invoiceLotsByInvoice.get(invoiceId) ?? [],
        missingLotsByPickup.get(pickupId) ?? new Set(),
      ),
    });
  }

  const cookieStore = await cookies();
  if (isConsoleV2(cookieStore.get(CONSOLE_UI_COOKIE)?.value)) {
    const counterDetailsV2 = counterDetailsToRecord(counterDetails);
    return (
      <PickupsV2
        warehouses={warehouses}
        activeWarehouseId={activeWarehouseId}
        sessionsEnabled={sessionsEnabled}
        missing={missingFiltered}
        counter={counter.map((p) => mapPickupRow(p as Record<string, unknown>, counterDetails))}
        today={today.map((p) => mapPickupRow(p as Record<string, unknown>))}
        waiting={upcoming.map((p) => mapPickupRow(p as Record<string, unknown>))}
        recentlyDone={past.map((p) => mapPickupRow(p as Record<string, unknown>))}
        counterDetails={counterDetailsV2}
      />
    );
  }

  return (
    <div>
      <PageHeader title="Pickups" />
      {warehouses.length > 0 && (
        <form
          method="GET"
          style={{
            display: 'flex',
            gap: 8,
            marginBottom: '1.25rem',
            flexWrap: 'wrap',
            alignItems: 'center',
            maxWidth: 480,
          }}
        >
          <FilterSelect
            name="warehouse"
            defaultValue={activeWarehouseId ?? ''}
            ariaLabel="Filter pickups by warehouse"
          >
            <option value="">All warehouses</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </FilterSelect>
          {activeWarehouseId ? (
            <a
              href="/pickups"
              style={{
                padding: '6px 12px',
                background: 'transparent',
                color: 'var(--fg-muted)',
                border: '1px solid var(--border)',
                borderRadius: 4,
                fontSize: 13,
                textDecoration: 'none',
              }}
            >
              Clear
            </a>
          ) : null}
        </form>
      )}
      {/* Mig 0241 rollout switch — Pickup pass QR sessions. */}
      <SessionsToggle enabled={sessionsEnabled} />
      <MissingItemsQueue rows={missingFiltered} warehouseQuery={activeWarehouseId} />
      {/* S12: customer-search fallback — find a paid invoice by name/email/phone */}
      <CustomerSearch warehouseQuery={activeWarehouseId} />
      <Section
        title={`At the counter (${counter.length})`}
        pickups={counter}
        highlight
        counterDetails={counterDetails}
        warehouseQuery={activeWarehouseId}
      />
      <Section title={`Today (${today.length})`} pickups={today} highlight />
      <Section title={`Waiting (${upcoming.length})`} pickups={upcoming} />
      <Section title={`Recently done (${past.length})`} pickups={past} muted />
    </div>
  );
}

type CounterRowDetail = {
  customerLabel: string;
  owed: ReturnType<typeof owedLotCodes>;
};

function Section({
  title,
  pickups,
  highlight,
  muted,
  counterDetails,
  warehouseQuery,
}: {
  title: string;
  pickups: NonNullable<Awaited<ReturnType<typeof _loadPickups>>>;
  highlight?: boolean;
  muted?: boolean;
  counterDetails?: Map<string, CounterRowDetail>;
  warehouseQuery?: string | null;
}) {
  const invoiceLinkSuffix = warehouseQuery
    ? `?warehouse=${encodeURIComponent(warehouseQuery)}`
    : '';
  if (!pickups.length) {
    return (
      <section style={{ marginBottom: '2rem' }}>
        <h2 style={{ fontSize: '1rem', color: muted ? 'var(--fg-muted)' : 'var(--fg)', marginBottom: '0.5rem' }}>
          {title}
        </h2>
        <p style={{ color: 'var(--fg-muted)', fontSize: 13, margin: 0 }}>—</p>
      </section>
    );
  }

  return (
    <section style={{ marginBottom: '2rem' }}>
      <h2
        style={{
          fontSize: '1rem',
          color: muted ? 'var(--fg-muted)' : highlight ? 'var(--accent)' : 'var(--fg)',
          marginBottom: '0.5rem',
        }}
      >
        {title}
      </h2>
      <ul style={{ listStyle: 'none', padding: 0, display: 'grid', gap: '0.5rem' }}>
        {pickups.map((p) => {
          const inv = p.invoices as
            | { status?: string; bidder_id?: string; total_cents?: number; bidders?: { email?: string; display_name?: string | null } }
            | null;
          const wh = (p.warehouses as { name?: string; timezone?: string } | null) ?? null;
          const tz = warehouseTimezone(wh);
          const pickupId = p.id as string;
          const invoiceId = p.invoice_id as string;
          const counterRow = counterDetails?.get(pickupId);
          const owed = counterRow?.owed ?? [];
          const owedVisible = owed.slice(0, 12);
          const owedMore = owed.length - owedVisible.length;
          return (
            <li
              key={pickupId}
              style={{
                padding: '1rem',
                background: 'var(--bg-elev)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: counterRow ? 'flex-start' : 'center',
                gap: '1rem',
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>
                  {counterRow
                    ? counterRow.customerLabel
                    : (inv?.bidders?.display_name ?? inv?.bidders?.email ?? 'Bidder')}
                </div>
                <div style={{ color: 'var(--fg-muted)', fontSize: 13 }}>
                  {wh?.name ?? '—'} ·{' '}
                  {counterRow ? (
                    <>
                      <Link
                        href={`/invoices/${invoiceId}${invoiceLinkSuffix}`}
                        style={{ color: 'var(--accent)', textDecoration: 'none' }}
                      >
                        Invoice #{invoiceShortId(invoiceId)}
                      </Link>
                      {' · '}
                    </>
                  ) : null}
                  {p.scheduled_at ? formatInTimeZone(p.scheduled_at as string, tz) : 'unscheduled'} · {p.status}
                </div>
                {counterRow ? (
                  <div style={{ marginTop: 8 }}>
                    {owed.length === 0 ? (
                      <div style={{ color: 'var(--fg-muted)', fontSize: 12 }}>Nothing owed</div>
                    ) : (
                      <>
                        <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>Owed ({owed.length})</div>
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 10px', fontSize: 13 }}>
                          {owedVisible.map((item, idx) => (
                            <span key={`${item.code}-${idx}`}>
                              <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{item.code}</span>
                              {item.secondary ? (
                                <span style={{ color: 'var(--fg-muted)', fontSize: 11, marginLeft: 4 }}>
                                  {item.secondary}
                                </span>
                              ) : null}
                              {item.noSticker ? (
                                <span style={{ color: '#b45309', fontSize: 10, marginLeft: 4 }}>no sticker</span>
                              ) : null}
                            </span>
                          ))}
                          {owedMore > 0 ? (
                            <span style={{ color: 'var(--fg-muted)', fontSize: 12 }}>+{owedMore} more</span>
                          ) : null}
                        </div>
                      </>
                    )}
                  </div>
                ) : null}
              </div>
              <PickupActions
                pickupId={p.id as string}
                status={p.status as string}
                invoiceId={p.invoice_id as string}
                invoiceStatus={inv?.status ?? null}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// Helper that gives us the type of `pickups`. Prefix avoids the
// unused-var warning while leaving it available for future code paths.
async function _loadPickups() {
  const supabase = await getSupabaseServer();
  const { data } = await supabase.from('pickups').select(
    'id, status, scheduled_at, checked_in_at, completed_at, invoice_id, warehouse_id, warehouses(name), invoices(status, bidder_id, total_cents, bidders(email, display_name))',
  );
  return data;
}
void _loadPickups;
