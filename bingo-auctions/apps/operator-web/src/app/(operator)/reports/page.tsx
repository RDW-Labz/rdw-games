// Reports — monthly P&L summary + paid-invoice table with CSV export, plus an
// "Operations" section with inventory-by-location, re-lot rate, missed-pickup
// rate, and disposal counts. URL param: ?month=YYYY-MM (defaults to current
// month). The Operations metrics are NOT month-scoped — they describe
// current state (inventory, disposal flags) or trailing 30/90-day windows
// (re-lot, missed-pickup) so the month navigator above doesn't affect them.
//
// Money totals (KPI cards, Prior 3 months, the table's period-total row) come
// from operator_reports_period_summary (mig 0418), never from summing loaded
// rows — the invoice list is paginated (?page=N) and is display only.
// Since mig 0421 the totals count sales on the invoice's paid date and refunds
// on the date each refund was issued (same as the Money page), so a refund on
// an invoice paid in an earlier period lowers THIS period's totals.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { formatCents } from '@auction-platform/shared/money';
import { monthRangeInTimeZone, dayRangeInTimeZone, formatDateInTimeZone } from '@/lib/datetime';
import { PageHeader } from '@/components/Form';
import { KpiCard } from '@/components/console';
import { ExportCsvButton } from './ExportCsvButton';
import { MonthNav } from './MonthNav';
import { DateRangeNav } from './DateRangeNav';
import { ReportsInvoicesTable, type ReportInvoiceRow } from './ReportsInvoicesTable';
import {
  REPORT_INVOICE_PAGE_SIZE,
  invoiceRowMoney,
  loadReportPeriodTotals,
  parsePage,
} from './report-totals';

// Trailing-window cutoffs for re-lot + missed-pickup rate cards.
const MS_PER_DAY = 86_400_000;

function parseMonth(raw: string | undefined): { year: number; month: number } {
  if (raw && /^\d{4}-\d{2}$/.test(raw)) {
    const parts = raw.split('-').map(Number);
    const y = parts[0];
    const m = parts[1];
    if (typeof y === 'number' && typeof m === 'number' && Number.isFinite(y) && Number.isFinite(m)) {
      return { year: y, month: m };
    }
  }
  const now = new Date();
  return { year: now.getFullYear(), month: now.getMonth() + 1 };
}

export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; from?: string; to?: string; page?: string }>;
}) {
  const sp = await searchParams;
  const { year, month } = parseMonth(sp.month);
  const page = parsePage(sp.page);
  const customFrom = sp.from && /^\d{4}-\d{2}-\d{2}$/.test(sp.from) ? sp.from : null;
  const customTo = sp.to && /^\d{4}-\d{2}-\d{2}$/.test(sp.to) ? sp.to : null;
  const customMode = Boolean(customFrom && customTo);

  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: me } = await supabase
    .from('operator_users')
    .select('operator_id')
    .eq('user_id', user.id)
    .single();
  if (!me) redirect('/onboarding');

  const operatorId = (me as { operator_id: string }).operator_id;

  // Month boundaries in the operator's WAREHOUSE zone (2026-07-05 fix — UTC
  // boundaries were counting evening sales on the last day of a month into
  // the next month's books).
  const { data: whRow } = await supabase
    .from('warehouses')
    .select('timezone')
    .eq('operator_id', operatorId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  const tz = (whRow as { timezone: string } | null)?.timezone ?? null;

  // Reporting window: a custom [from,to] range when both are set, else the
  // selected calendar month. Both are bucketed by the warehouse wall clock.
  const monthRange = monthRangeInTimeZone(year, month, tz);
  const customRange = customMode ? dayRangeInTimeZone(customFrom!, customTo!, tz) : null;
  const rangeStart = customRange ? customRange.startISO : monthRange.startISO;
  const rangeEnd = customRange ? customRange.endISO : monthRange.endISO;

  const monthLabel = new Date(Date.UTC(year, month - 1, 1)).toLocaleString('default', {
    month: 'long',
    year: 'numeric',
  });
  const periodLabel = customMode ? `${customFrom} → ${customTo}` : monthLabel;

  // Previous 3 closed months for comparison (month mode only — a custom range
  // has no natural "prior 3" to compare against).
  // Money model (owner ask 2026-07-08): net revenue = hammer + buyer's
  // premium; sales tax is pass-through (owed to the state), NOT revenue.
  // Totals from the DB (mig 0418) — the old per-month invoice fetch hit
  // PostgREST's 1,000-row cap and under-reported busy months.
  const comparisonMonths = customMode
    ? []
    : [1, 2, 3].map((i) => {
        const d = new Date(Date.UTC(year, month - 1 - i, 1));
        return {
          label: d.toLocaleString('default', { month: 'short', year: 'numeric' }),
          range: monthRangeInTimeZone(d.getUTCFullYear(), d.getUTCMonth() + 1, tz),
        };
      });
  const [periodRes, ...comparisonRes] = await Promise.all([
    loadReportPeriodTotals(supabase, rangeStart, rangeEnd),
    ...comparisonMonths.map((c) => loadReportPeriodTotals(supabase, c.range.startISO, c.range.endISO)),
  ]);
  const comparison = comparisonMonths.map((c, i) => ({
    label: c.label,
    totals: comparisonRes[i]?.totals ?? null,
  }));
  const periodTotals = periodRes.totals;
  const totalsError = periodRes.error ?? comparisonRes.find((r) => r.error)?.error ?? null;

  // Selected-period paid invoices for the LIST (one page). Never summed.
  // Include refunded / partially-refunded invoices (mig 0270) — filtering to
  // status='paid' alone dropped any refunded invoice out of the report
  // entirely, so its revenue AND tax silently vanished. We include them and
  // subtract the refunded amounts below so figures are net of refunds.
  const { data: periodInvoices } = await supabase
    .from('invoices')
    .select(
      'id, subtotal_cents, buyer_premium_cents, tax_cents, total_cents, ' +
        'refunded_cash_cents, refunded_credit_cents, refunded_tax_cents, ' +
        'paid_at, auction_id, bidder_id, auctions(title)',
    )
    .eq('operator_id', operatorId)
    .in('status', ['paid', 'partially_refunded', 'refunded'])
    .gte('paid_at', rangeStart)
    .lt('paid_at', rangeEnd)
    .order('paid_at', { ascending: false })
    .order('id', { ascending: false })
    .range((page - 1) * REPORT_INVOICE_PAGE_SIZE, page * REPORT_INVOICE_PAGE_SIZE - 1);

  // Customer names via service role — the invoices→bidders embed is
  // RLS-blocked for operator staff (bidders has no operator SELECT policy),
  // so the old embed rendered every name as "—". Same fix as the invoices tab.
  const invRows = (periodInvoices ?? []) as unknown as Array<{
    id: string;
    subtotal_cents: number | null;
    buyer_premium_cents: number | null;
    tax_cents: number | null;
    total_cents: number | null;
    refunded_cash_cents: number | null;
    refunded_credit_cents: number | null;
    refunded_tax_cents: number | null;
    paid_at: string | null;
    auction_id: string | null;
    bidder_id: string | null;
    auctions?: { title?: string } | null;
  }>;
  const repBidderIds = Array.from(new Set(invRows.map((r) => r.bidder_id).filter(Boolean))) as string[];
  const { data: repBidderRows } = repBidderIds.length
    ? await getSupabaseAdmin().from('bidders').select('id, display_name, email').in('id', repBidderIds)
    : { data: [] as { id: string; display_name: string | null; email: string | null }[] };
  const repBidderById = new Map(
    ((repBidderRows ?? []) as { id: string; display_name: string | null; email: string | null }[]).map((r) => [r.id, r]),
  );

  const reportRows: ReportInvoiceRow[] = invRows.map((r) => {
    const b = r.bidder_id ? repBidderById.get(r.bidder_id) : null;
    return {
      id: r.id,
      auctionId: r.auction_id,
      auctionTitle: r.auctions?.title ?? '—',
      bidderId: r.bidder_id,
      bidderName: b?.display_name ?? b?.email ?? '—',
      ...invoiceRowMoney(r), // hammer + premium, net of refunds
      paidAt: r.paid_at,
      paidLabel: r.paid_at ? formatDateInTimeZone(r.paid_at, tz) : '—',
    };
  });

  const totalInvoices = periodTotals?.invoices ?? null;
  const pageCount =
    totalInvoices !== null ? Math.max(1, Math.ceil(totalInvoices / REPORT_INVOICE_PAGE_SIZE)) : page;
  const pageHref = (p: number) => {
    const q = new URLSearchParams();
    if (customMode) {
      q.set('from', customFrom!);
      q.set('to', customTo!);
    } else if (sp.month) {
      q.set('month', sp.month);
    }
    if (p > 1) q.set('page', String(p));
    const qs = q.toString();
    return qs ? `/reports?${qs}` : '/reports';
  };
  const money = (c: number | undefined) => (periodTotals ? formatCents(c ?? 0) : '—');

  // ============================================================================
  // OPERATIONS METRICS (NOT month-scoped — see file header)
  // ============================================================================
  // Operator scoping:
  //   - Queries against `lots` and `warehouses` pass an explicit
  //     .eq('operator_id', operatorId) — matches the existing finance queries
  //     above so intent stays uniform and visible.
  //   - Queries against `lot_status_history` and `pickups` rely on their RLS
  //     policies (migs 0098 and 0002 respectively) which enforce operator
  //     scope at the SQL level via the parent-row join. Those tables don't
  //     carry operator_id directly so an explicit predicate would require an
  //     embed, and the RLS predicate is the canonical source of truth anyway.
  // Counts use HEAD/count:'exact' so we never materialize row data we won't render.

  const now = new Date();
  const cutoff30d = new Date(now.getTime() - 30 * MS_PER_DAY).toISOString();
  const cutoff90d = new Date(now.getTime() - 90 * MS_PER_DAY).toISOString();

  // ---- A. Inventory by location -----------------------------------------
  // For each warehouse the operator owns, three counts:
  //   - Live on auction: auction_id IS NOT NULL AND status IN ('scheduled','live')
  //   - Put away: status='in_inventory' AND auction_id IS NULL
  //   - Not put away: status='pending_intake' (warehouse_id is NULL on these rows
  //     so they don't attach to any warehouse — surfaced as a single "Unassigned"
  //     bucket below).
  // All counts also require deleted_at IS NULL — soft-deleted (trashed) lots
  // are excluded from operational rollups.
  const { data: opsWarehousesData } = await supabase
    .from('warehouses')
    .select('id, name')
    .eq('operator_id', operatorId)
    .order('name', { ascending: true });
  const opsWarehouses = (opsWarehousesData ?? []) as Array<{ id: string; name: string }>;

  // Per-warehouse counts — parallel HEAD queries. 2 queries per warehouse
  // (live + put-away). Cap is small (a single operator rarely has more than a
  // handful of warehouses) but Promise.all keeps even a 10-warehouse operator
  // under a single round-trip's wall clock.
  type LocationRow = {
    warehouseId: string | null;
    name: string;
    live: number | null;
    putAway: number | null;
    notPutAway: number | null;
  };

  const perWarehouseRows: LocationRow[] = await Promise.all(
    opsWarehouses.map(async (w) => {
      const [liveRes, putAwayRes] = await Promise.all([
        supabase
          .from('lots')
          .select('id', { count: 'exact', head: true })
          .eq('operator_id', operatorId)
          .eq('warehouse_id', w.id)
          .is('deleted_at', null)
          .not('auction_id', 'is', null)
          .in('status', ['scheduled', 'live']),
        supabase
          .from('lots')
          .select('id', { count: 'exact', head: true })
          .eq('operator_id', operatorId)
          .eq('warehouse_id', w.id)
          .is('deleted_at', null)
          .is('auction_id', null)
          .eq('status', 'in_inventory'),
      ]);
      return {
        warehouseId: w.id,
        name: w.name,
        live: liveRes.count ?? 0,
        putAway: putAwayRes.count ?? 0,
        notPutAway: null, // pending_intake rows have NULL warehouse_id (see Unassigned row)
      };
    }),
  );

  // Single "Unassigned" bucket for status='pending_intake' (warehouse_id NULL).
  const { count: unassignedCount } = await supabase
    .from('lots')
    .select('id', { count: 'exact', head: true })
    .eq('operator_id', operatorId)
    .is('deleted_at', null)
    .eq('status', 'pending_intake');

  const locationRows: LocationRow[] = [
    ...perWarehouseRows,
    {
      warehouseId: null,
      name: 'Unassigned (pending intake)',
      live: null,
      putAway: null,
      notPutAway: unassignedCount ?? 0,
    },
  ];

  const locationTotals = {
    live: perWarehouseRows.reduce((s, r) => s + (r.live ?? 0), 0),
    putAway: perWarehouseRows.reduce((s, r) => s + (r.putAway ?? 0), 0),
    notPutAway: unassignedCount ?? 0,
  };
  const locationGrandTotal =
    locationTotals.live + locationTotals.putAway + locationTotals.notPutAway;

  // ---- B. Re-lot rate (30 / 90 days) ------------------------------------
  // Count of lot_status_history transitions TO 'relisted'. Operator scoping
  // is enforced by the lot_status_history_operator_read RLS policy (mig 0098)
  // which JOINs lot_status_history → lots and matches lots.operator_id
  // against current_operator_id(). The count is therefore implicitly
  // operator-scoped at the SQL level even though we don't pass operator_id
  // here.
  const [relot30Res, relot90Res] = await Promise.all([
    supabase
      .from('lot_status_history')
      .select('id', { count: 'exact', head: true })
      .eq('to_status', 'relisted')
      .gte('changed_at', cutoff30d),
    supabase
      .from('lot_status_history')
      .select('id', { count: 'exact', head: true })
      .eq('to_status', 'relisted')
      .gte('changed_at', cutoff90d),
  ]);
  const relot30 = relot30Res.count ?? 0;
  const relot90 = relot90Res.count ?? 0;

  // ---- C. Missed-pickup rate (30 / 90 days) -----------------------------
  // Pickups in status 'no_show' or 'forfeited' (the two terminal-missed states
  // in the pickup_status enum, migration 0001). Operator scoping is enforced
  // by the pickups RLS policy (mig 0002) which JOINs pickups → invoices and
  // matches invoices.operator_id = current_operator_id(). We anchor the time
  // window on pickups.created_at — the moment the pickup row was generated for
  // the invoice (post-payment via ensure_pickup_row, 0094). updated_at would
  // correlate to the state flip but is less stable across our own backfills.
  const [missed30Res, missed90Res] = await Promise.all([
    supabase
      .from('pickups')
      .select('id', { count: 'exact', head: true })
      .in('status', ['no_show', 'forfeited'])
      .gte('created_at', cutoff30d),
    supabase
      .from('pickups')
      .select('id', { count: 'exact', head: true })
      .in('status', ['no_show', 'forfeited'])
      .gte('created_at', cutoff90d),
  ]);
  const missed30 = missed30Res.count ?? 0;
  const missed90 = missed90Res.count ?? 0;

  // ---- D. Disposal count -------------------------------------------------
  // Lots flagged for disposal by either the auto_relist_unsold_lots cron
  // (mig 0146: relist_count >= auto_flag_disposal_at_strikes) or by manual
  // staff action via mark_lot_disposed. We exclude soft-deleted (trashed)
  // rows so the count reflects what's actually awaiting disposition.
  const { count: disposalCount } = await supabase
    .from('lots')
    .select('id', { count: 'exact', head: true })
    .eq('operator_id', operatorId)
    .is('deleted_at', null)
    .eq('flagged_for_disposal', true);

  // These server tables use the shared `.console-table`/`.console-table-card`
  // chrome (same as DataTable) — the class supplies header/cell padding, the
  // uppercase-muted header, hairline rows and hover. Only alignment + the
  // in-body totals-row accent live here.
  const thNum: React.CSSProperties = { textAlign: 'right' };
  const tdNum: React.CSSProperties = { textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
  const totalCell: React.CSSProperties = { fontWeight: 700, borderTop: '2px solid var(--border)' };
  const totalNum: React.CSSProperties = {
    ...totalCell,
    textAlign: 'right',
    fontVariantNumeric: 'tabular-nums',
  };

  return (
    <div>
      <PageHeader
        title="Reports"
        action={
          customMode ? undefined : (
            <ExportCsvButton operatorId={operatorId} year={year} month={month} />
          )
        }
      />

      {!customMode && <MonthNav year={year} month={month} />}
      <DateRangeNav from={customFrom} to={customTo} />

      {totalsError && (
        <div
          role="alert"
          style={{
            padding: '0.75rem 1rem',
            marginBottom: '1rem',
            border: '1px solid rgba(255,84,112,0.4)',
            borderRadius: 6,
            fontSize: 13,
          }}
        >
          Couldn&apos;t load report totals: {totalsError}
        </div>
      )}

      {/* Period summary — money broken out (owner ask 2026-07-08). */}
      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
          gap: '1rem',
          marginBottom: '0.5rem',
        }}
      >
        <KpiCard label={`Hammer — ${periodLabel}`} value={money(periodTotals?.hammerCents)} />
        <KpiCard label="Buyer's premium" value={money(periodTotals?.premiumCents)} />
        <KpiCard label="Sales tax (pass-through)" value={money(periodTotals?.taxCents)} muted />
        <KpiCard label="Total collected" value={money(periodTotals?.totalCents)} />
        <KpiCard label="Net revenue" value={money(periodTotals?.netCents)} tone="accent" />
        <KpiCard
          label="Refunds (by refund date)"
          value={money(periodTotals?.refundedCents)}
          muted
        />
      </section>
      <p style={{ color: 'var(--fg-muted)', fontSize: 12, margin: '0 0 2rem' }}>
        Net revenue = hammer + buyer&apos;s premium, net of refunds. Sales tax is
        collected on the customer&apos;s behalf and owed to the state — it is not your
        revenue. Sales count on the day the invoice was paid; refunds count on the day
        they were issued, so a refund on an earlier sale lowers this period. Invoice
        rows below show each invoice net of all its refunds.
      </p>

      {/* Comparison: previous 3 months (month mode only) */}
      {!customMode && (
        <section
          style={{
            marginBottom: '2rem',
            padding: '1rem',
            background: 'var(--bg-elev)',
            border: '1px solid var(--border)',
            borderRadius: 6,
          }}
        >
          <h2 style={{ fontSize: '0.95rem', margin: '0 0 0.75rem' }}>Prior 3 months</h2>
          <table className="console-table">
            <thead>
              <tr>
                <th>Month</th>
                <th style={thNum}>Net revenue</th>
                <th style={thNum}>Sales tax</th>
                <th style={thNum}>Total collected</th>
                <th style={thNum}>Refunds (by refund date)</th>
              </tr>
            </thead>
            <tbody>
              {comparison.map((c) => (
                <tr key={c.label}>
                  <td>{c.label}</td>
                  <td style={tdNum}>{c.totals ? formatCents(c.totals.netCents) : '—'}</td>
                  <td style={{ ...tdNum, color: 'var(--fg-muted)' }}>
                    {c.totals ? formatCents(c.totals.taxCents) : '—'}
                  </td>
                  <td style={tdNum}>{c.totals ? formatCents(c.totals.totalCents) : '—'}</td>
                  <td style={{ ...tdNum, color: 'var(--fg-muted)' }}>
                    {c.totals ? formatCents(c.totals.refundedCents) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* Paid invoices — searchable, sortable, with a totals row. */}
      <section>
        <h2 style={{ fontSize: '1rem', margin: '0 0 0.75rem' }}>
          Invoices — {periodLabel}
        </h2>
        <ReportsInvoicesTable
          rows={reportRows}
          periodTotals={periodTotals}
          pageInfo={{ pageCount }}
        />
        {pageCount > 1 && (
          <nav
            aria-label="Invoice pages"
            style={{ display: 'flex', gap: 12, alignItems: 'center', marginTop: '0.75rem', fontSize: 13 }}
          >
            {page > 1 ? <Link href={pageHref(page - 1)}>← Newer</Link> : <span style={{ color: 'var(--fg-muted)' }}>← Newer</span>}
            <span style={{ color: 'var(--fg-muted)' }}>
              Page {page} of {pageCount}
            </span>
            {page < pageCount ? <Link href={pageHref(page + 1)}>Older →</Link> : <span style={{ color: 'var(--fg-muted)' }}>Older →</span>}
          </nav>
        )}
      </section>

      {/* ===================================================================
          OPERATIONS — current-state + trailing-window metrics. Not affected
          by the MonthNav above; those windows are baked into the queries.
          ================================================================== */}
      <section style={{ marginTop: '3rem' }}>
        <h2 style={{ fontSize: '1.05rem', margin: '0 0 0.25rem' }}>Operations</h2>
        <p style={{ color: 'var(--fg-muted)', fontSize: 13, margin: '0 0 1rem' }}>
          Current inventory state and trailing-window operational health. Not
          affected by the month selector above.
        </p>

        {/* Trailing-window stat cards: re-lot, missed-pickup, disposal. */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: '1rem',
            marginBottom: '2rem',
          }}
        >
          <DualWindowCard
            label="Re-lots"
            sublabel="lots relisted (30d / 90d)"
            v30={relot30}
            v90={relot90}
          />
          <DualWindowCard
            label="Missed pickups"
            sublabel="no-show or forfeited (30d / 90d)"
            v30={missed30}
            v90={missed90}
          />
          <KpiCard
            label="Flagged for disposal"
            value={String(disposalCount ?? 0)}
            tone="accent"
          />
        </div>

        {/* Inventory by location table. */}
        <div
          style={{
            padding: '1rem',
            background: 'var(--bg-elev)',
            border: '1px solid var(--border)',
            borderRadius: 6,
          }}
        >
          <h3 style={{ fontSize: '0.95rem', margin: '0 0 0.75rem' }}>
            Inventory by location
          </h3>
          <table className="console-table">
            <thead>
              <tr>
                <th>Location</th>
                <th style={thNum}>Live on auction</th>
                <th style={thNum}>Put away</th>
                <th style={thNum}>Not put away</th>
                <th style={thNum}>Total</th>
              </tr>
            </thead>
            <tbody>
              {opsWarehouses.length === 0 ? (
                // No warehouses yet: the Unassigned row alone would be misleading
                // (operator hasn't set up locations). Show an explicit empty state
                // that points them to /warehouses/new. We still surface the
                // pending-intake count via the row content so it isn't hidden,
                // but we frame it as setup-needed rather than a normal rollup.
                <tr>
                  <td
                    colSpan={5}
                    style={{ padding: '2rem', textAlign: 'center', color: 'var(--fg-muted)' }}
                  >
                    No warehouses configured.{' '}
                    <Link href="/warehouses/new">Add one</Link> to start tracking inventory.
                    {(unassignedCount ?? 0) > 0 && (
                      <div style={{ marginTop: '0.5rem' }}>
                        {unassignedCount} lot{unassignedCount === 1 ? '' : 's'} awaiting intake.
                      </div>
                    )}
                  </td>
                </tr>
              ) : (
                <>
                  {locationRows.map((row) => {
                    const rowTotal =
                      (row.live ?? 0) + (row.putAway ?? 0) + (row.notPutAway ?? 0);
                    return (
                      <tr key={row.warehouseId ?? 'unassigned'}>
                        <td>{row.name}</td>
                        <td style={tdNum}>{row.live === null ? '—' : row.live}</td>
                        <td style={tdNum}>{row.putAway === null ? '—' : row.putAway}</td>
                        <td style={tdNum}>{row.notPutAway === null ? '—' : row.notPutAway}</td>
                        <td style={tdNum}>{rowTotal}</td>
                      </tr>
                    );
                  })}
                  <tr>
                    <td style={totalCell}>Total</td>
                    <td style={totalNum}>{locationTotals.live}</td>
                    <td style={totalNum}>{locationTotals.putAway}</td>
                    <td style={totalNum}>{locationTotals.notPutAway}</td>
                    <td style={totalNum}>{locationGrandTotal}</td>
                  </tr>
                </>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function DualWindowCard({
  label,
  sublabel,
  v30,
  v90,
}: {
  label: string;
  sublabel: string;
  v30: number;
  v90: number;
}) {
  return (
    <div
      style={{
        padding: '1rem',
        background: 'var(--bg-elev)',
        border: '1px solid var(--border)',
        borderRadius: 6,
      }}
    >
      <div
        style={{
          fontSize: 12,
          color: 'var(--fg-muted)',
          textTransform: 'uppercase',
          letterSpacing: 0.5,
        }}
      >
        {label}
      </div>
      <div
        style={{
          marginTop: 6,
          display: 'flex',
          alignItems: 'baseline',
          gap: '0.75rem',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        <span style={{ fontSize: 22, fontWeight: 700 }}>{v30}</span>
        <span style={{ fontSize: 13, color: 'var(--fg-muted)' }}>/ {v90}</span>
      </div>
      <div style={{ marginTop: 4, fontSize: 11, color: 'var(--fg-muted)' }}>
        {sublabel}
      </div>
    </div>
  );
}

