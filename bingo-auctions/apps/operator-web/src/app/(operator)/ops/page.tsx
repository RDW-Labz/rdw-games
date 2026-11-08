// /ops — operations dashboard.
//
// Single-pane view of platform health signals. Surfaces the data the
// recent post-launch backlog work made available:
//   - Stuck webhook claims (migration 0100's stuck_webhook_claims view)
//   - Failed background jobs (build_invoice_jobs.attempt_count > 0)
//   - Today's invoice + revenue snapshot. Revenue is operator_money_daily
//     (mig 0417) for today's Chicago day — the Money page's calculation. It
//     used to sum status = 'paid' invoices, so any partial refund dropped the
//     whole invoice out of "Revenue today" (2026-10-14).
//   - Recent state transitions across lots / auctions / invoices
//     (migration 0098 audit trail)
//
// Admin-only because the data exposes cross-operator state (in the
// stuck-webhook view, those events span every operator's PI).

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { lotDisplayCode } from '@auction-platform/shared';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import {
  dayRangeInTimeZone,
  formatInTimeZone,
  formatDateInTimeZone,
  warehouseTimezone,
} from '@/lib/datetime';
import { fetchMoneyDaily, todayInTimeZone } from '@/lib/money-daily';
import { PageHeader, secondaryButtonStyle } from '@/components/Form';
import { KpiCard, MoneyText } from '@/components/console';

export default async function OpsDashboardPage() {
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: me } = await supabase
    .from('operator_users')
    .select('role, operator_id')
    .eq('user_id', user.id)
    .single();
  if (!me) redirect('/onboarding');
  if ((me as { role: string }).role !== 'admin') {
    return (
      <div>
        <PageHeader title="Operations" />
        <p style={{ color: 'var(--fg-muted)' }}>Admin access required.</p>
      </div>
    );
  }

  const operatorId = (me as { operator_id: string }).operator_id;
  const now = new Date();
  // "Today" is the warehouse's calendar day (America/Chicago for BinGo), not
  // the server's: the Worker runs in UTC, whose midnight is 7 PM Central.
  const { data: whRow } = await supabase
    .from('warehouses')
    .select('timezone')
    .eq('operator_id', operatorId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  const tz = (whRow as { timezone: string } | null)?.timezone || 'America/Chicago';
  const today = todayInTimeZone(tz, now);
  const startOfDay = new Date(dayRangeInTimeZone(today, today, tz)?.startISO ?? now.toISOString());
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // Admin client for cross-operator queries (stuck_webhook_claims).
  // The view itself is service-role-only at the table level, so we
  // need the admin client to read it. We display only counts + event
  // type so we don't leak PII (event ids alone aren't sensitive).
  const admin = getSupabaseAdmin();

  const [
    todayInvoices,
    todayMoney,
    failedJobs,
    stuckWebhookClaims,
    recentLotActivity,
    recentAuctionActivity,
    recentInvoiceActivity,
    unsoldLots,
  ] = await Promise.all([
    supabase
      .from('invoices')
      .select('id', { count: 'exact', head: true })
      .eq('operator_id', operatorId)
      .gte('created_at', startOfDay.toISOString()),
    fetchMoneyDaily(supabase, today, today, tz),
    admin
      .from('build_invoice_jobs')
      .select('auction_id, run_at, attempt_count, last_error')
      .gte('attempt_count', 1)
      .lte('attempt_count', 5)
      .order('attempt_count', { ascending: false })
      .limit(20),
    admin.from('stuck_webhook_claims').select('stripe_event_id, event_type').limit(20),
    supabase
      .from('lot_status_history')
      .select('id, lot_id, from_status, to_status, changed_at, changed_by, lots(warehouses(timezone))')
      .gte('changed_at', since24h.toISOString())
      .order('changed_at', { ascending: false })
      .limit(15),
    supabase
      .from('auction_status_history')
      .select('id, auction_id, from_status, to_status, changed_at, changed_by, auctions(warehouses(timezone))')
      .gte('changed_at', since24h.toISOString())
      .order('changed_at', { ascending: false })
      .limit(15),
    supabase
      .from('invoice_status_history')
      .select('id, invoice_id, from_status, to_status, changed_at, changed_by, invoices(auctions(warehouses(timezone)))')
      .gte('changed_at', since24h.toISOString())
      .order('changed_at', { ascending: false })
      .limit(15),
    supabase
      .from('lots')
      .select('id, lot_code, sticker_code, display_code, title, closed_at, relist_count, warehouses(timezone)', { count: 'exact' })
      .eq('operator_id', operatorId)
      .eq('status', 'unsold')
      .is('deleted_at', null)
      .order('closed_at', { ascending: false })
      .limit(20),
  ]);

  // Money page calculation (operator_money_daily): every invoice charged
  // today counts, whatever happened to it afterwards; refunds count on the
  // day they were issued. null = RPC unavailable → the cards show "—".
  const moneyToday = todayMoney?.days[0] ?? null;
  const todayPaidCount = moneyToday?.invoices_paid ?? 0;
  const todayGrossCents = moneyToday?.gross_charged_cents ?? 0;
  const todayNetRevenueCents = moneyToday?.net_revenue_cents ?? 0;

  const failedJobsRows =
    (failedJobs.data ?? []) as Array<{
      auction_id: string;
      run_at: string;
      attempt_count: number;
      last_error: string | null;
    }>;

  const stuckWebhooksRows =
    (stuckWebhookClaims.data ?? []) as Array<{
      stripe_event_id: string;
      event_type: string;
    }>;

  const unsoldRows =
    (unsoldLots.data ?? []) as Array<{
      id: string;
      lot_code: string;
      sticker_code: string | null;
      title: string;
      closed_at: string | null;
      relist_count: number;
      warehouses: unknown;
    }>;
  const unsoldTotal = unsoldLots.count ?? 0;

  // Merge the three activity feeds into a single chronological list.
  // Each row carries the IANA timezone of its OWN entity's warehouse
  // (lot/auction directly; invoice via its auction) so the timestamp renders
  // in that warehouse's wall-clock zone, not the UTC SSR runtime zone. This
  // admin feed can span warehouses, so the zone must be resolved per row.
  type ActivityRow = {
    key: string;
    entity: 'lot' | 'auction' | 'invoice';
    entity_id: string;
    from_status: string | null;
    to_status: string;
    changed_at: string;
    changed_by: string | null;
    tz: string | null;
  };
  const activity: ActivityRow[] = [
    ...((recentLotActivity.data ?? []) as unknown as Array<{
      id: number;
      lot_id: string;
      from_status: string | null;
      to_status: string;
      changed_at: string;
      changed_by: string | null;
      lots: { warehouses: unknown } | null;
    }>).map((r) => ({
      key: `lot-${r.id}`,
      entity: 'lot' as const,
      entity_id: r.lot_id,
      from_status: r.from_status,
      to_status: r.to_status,
      changed_at: r.changed_at,
      changed_by: r.changed_by,
      tz: warehouseTimezone(r.lots?.warehouses),
    })),
    ...((recentAuctionActivity.data ?? []) as unknown as Array<{
      id: number;
      auction_id: string;
      from_status: string | null;
      to_status: string;
      changed_at: string;
      changed_by: string | null;
      auctions: { warehouses: unknown } | null;
    }>).map((r) => ({
      key: `auction-${r.id}`,
      entity: 'auction' as const,
      entity_id: r.auction_id,
      from_status: r.from_status,
      to_status: r.to_status,
      changed_at: r.changed_at,
      changed_by: r.changed_by,
      tz: warehouseTimezone(r.auctions?.warehouses),
    })),
    ...((recentInvoiceActivity.data ?? []) as unknown as Array<{
      id: number;
      invoice_id: string;
      from_status: string | null;
      to_status: string;
      changed_at: string;
      changed_by: string | null;
      invoices: { auctions: { warehouses: unknown } | null } | null;
    }>).map((r) => ({
      key: `invoice-${r.id}`,
      entity: 'invoice' as const,
      entity_id: r.invoice_id,
      from_status: r.from_status,
      to_status: r.to_status,
      changed_at: r.changed_at,
      changed_by: r.changed_by,
      tz: warehouseTimezone(r.invoices?.auctions?.warehouses),
    })),
  ]
    .sort((a, b) => b.changed_at.localeCompare(a.changed_at))
    .slice(0, 30);

  return (
    <div>
      <PageHeader title="Operations" />
      <p style={{ color: 'var(--fg-muted)', fontSize: 13, marginTop: -8, marginBottom: '1.5rem' }}>
        Health signals + recent activity. Refresh manually — this page does not auto-update yet.
      </p>

      {/* Today's snapshot */}
      <h2 style={sectionHeading}>Today</h2>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 12,
          marginBottom: 28,
          maxWidth: 760,
        }}
      >
        <KpiCard
          label="Invoices created"
          value={String(todayInvoices.count ?? 0)}
          sub={`since midnight (${tz})`}
        />
        <KpiCard
          label="Invoices paid"
          value={String(todayPaidCount)}
          sub="charged today (incl. later refunded)"
          tone={todayPaidCount > 0 ? 'success' : 'default'}
          muted={todayPaidCount === 0}
        />
        <KpiCard
          label="Gross charged today"
          value={moneyToday ? <MoneyText cents={todayGrossCents} /> : '—'}
          sub="incl. tax, before refunds"
          href="/reports/money"
          muted={todayGrossCents === 0}
        />
        <KpiCard
          label="Net revenue today"
          value={moneyToday ? <MoneyText cents={todayNetRevenueCents} /> : '—'}
          sub="bids + premium − refunds issued today, excl. tax"
          href="/reports/money"
          tone={todayNetRevenueCents > 0 ? 'success' : 'default'}
          muted={todayNetRevenueCents === 0}
        />
        <KpiCard
          label="Unsold awaiting relist"
          value={String(unsoldTotal)}
          sub="auto-relist or manual"
          tone={unsoldTotal > 5 ? 'warning' : 'default'}
          muted={unsoldTotal <= 5}
        />
      </div>

      {/* Alerts */}
      <h2 style={sectionHeading}>Alerts</h2>
      <div style={{ display: 'grid', gap: 12, marginBottom: 28, maxWidth: 960 }}>
        <AlertCard
          title="Stuck webhook claims"
          count={stuckWebhooksRows.length}
          tone={stuckWebhooksRows.length > 0 ? 'danger' : 'success'}
          empty="None — all webhooks committed cleanly."
          description="claim_webhook_event() rows with processed_at=NULL >5 min ago. Handler crashed or Square never retried. Manual investigation needed if non-zero."
        >
          {stuckWebhooksRows.length > 0 && (
            <ul style={listStyle}>
              {stuckWebhooksRows.map((w) => (
                <li key={w.stripe_event_id} style={listItemStyle}>
                  <code style={{ color: 'var(--fg-muted)' }}>{w.stripe_event_id.slice(0, 28)}…</code>
                  <span style={{ color: 'var(--fg)' }}>{w.event_type}</span>
                </li>
              ))}
            </ul>
          )}
        </AlertCard>

        <AlertCard
          title="Background job failures"
          count={failedJobsRows.length}
          tone={failedJobsRows.length > 0 ? 'warning' : 'success'}
          empty="None — invoice-build queue is draining cleanly."
          description="build_invoice_jobs rows with attempt_count ≥ 1. After 5 attempts the job is abandoned (visible above but no auto-retry)."
        >
          {failedJobsRows.length > 0 && (
            <ul style={listStyle}>
              {failedJobsRows.map((j, i) => (
                <li key={`${j.auction_id}-${i}`} style={listItemStyle}>
                  <Link
                    href={`/auctions/${j.auction_id}`}
                    style={{ color: 'var(--accent)', textDecoration: 'none' }}
                  >
                    auction {j.auction_id.slice(0, 8)}…
                  </Link>
                  <span style={{ color: 'var(--fg-muted)' }}>attempts: {j.attempt_count}</span>
                  {j.last_error && (
                    <span style={{ color: 'var(--danger, #f87171)', fontSize: 12 }} title={j.last_error}>
                      {j.last_error.slice(0, 80)}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </AlertCard>
      </div>

      {/* Recent activity */}
      <h2 style={sectionHeading}>Recent activity (24 h)</h2>
      {activity.length === 0 ? (
        <p style={{ color: 'var(--fg-muted)', fontSize: 13 }}>No status transitions in the last 24 h.</p>
      ) : (
        <div
          style={{
            border: '1px solid var(--border)',
            borderRadius: 6,
            overflow: 'hidden',
            maxWidth: 960,
          }}
        >
          {activity.map((evt, idx) => (
            <div
              key={evt.key}
              style={{
                display: 'grid',
                gridTemplateColumns: '180px 80px 1fr auto',
                gap: 12,
                padding: '8px 14px',
                borderBottom: idx < activity.length - 1 ? '1px solid var(--border)' : 'none',
                alignItems: 'center',
                fontSize: 13,
              }}
            >
              <span style={{ color: 'var(--fg-muted)', fontFamily: 'monospace', fontSize: 12 }}>
                {formatInTimeZone(evt.changed_at, evt.tz)}
              </span>
              <span
                style={{
                  fontSize: 11,
                  textTransform: 'uppercase',
                  letterSpacing: 0.6,
                  fontWeight: 800,
                  color:
                    evt.entity === 'invoice'
                      ? 'var(--accent, #4f8cff)'
                      : evt.entity === 'auction'
                        ? 'var(--warning, #fbbf24)'
                        : 'var(--fg)',
                }}
              >
                {evt.entity}
              </span>
              <Link
                href={
                  evt.entity === 'lot'
                    ? `/lots/${evt.entity_id}`
                    : evt.entity === 'auction'
                      ? `/auctions/${evt.entity_id}`
                      : `/invoices/${evt.entity_id}`
                }
                style={{ color: 'var(--fg)', textDecoration: 'none' }}
              >
                {evt.from_status ?? 'created'} → <strong>{evt.to_status}</strong>
              </Link>
              {evt.changed_by && (
                <span style={{ color: 'var(--fg-muted)', fontSize: 11 }}>
                  {String(evt.changed_by).slice(0, 8)}
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Unsold + auto-relist watch */}
      {unsoldRows.length > 0 && (
        <>
          <h2 style={{ ...sectionHeading, marginTop: 32 }}>
            Unsold lots (top {unsoldRows.length} of {unsoldTotal})
            {' '}
            <Link
              href="/worklist"
              style={{
                fontSize: 11,
                fontWeight: 700,
                color: 'var(--accent)',
                textDecoration: 'none',
                marginLeft: 8,
                padding: '2px 8px',
                border: '1px solid var(--accent)',
                borderRadius: 999,
                letterSpacing: 0.4,
              }}
            >
              View Worklist →
            </Link>
          </h2>
          <p style={{ color: 'var(--fg-muted)', fontSize: 12, maxWidth: 960 }}>
            Auto-relist picks these up every 10 min and pushes them into the next eligible auction
            until each lot hits the operator&apos;s max_attempts setting. Staff can also{' '}
            <Link href="/lotting/inventory?filter=unsold" style={{ color: 'var(--accent)' }}>
              relist now from inventory
            </Link>
            {' '}or triage Flagged-for-disposal / Forfeited returns on the{' '}
            <Link href="/worklist" style={{ color: 'var(--accent)' }}>
              Worklist
            </Link>
            .
          </p>
          <div
            style={{
              border: '1px solid var(--border)',
              borderRadius: 6,
              overflow: 'hidden',
              maxWidth: 960,
            }}
          >
            {unsoldRows.map((lot, idx) => (
              <Link
                key={lot.id}
                href={`/lots/${lot.id}`}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '120px 1fr 80px 140px',
                  gap: 12,
                  padding: '8px 14px',
                  borderBottom: idx < unsoldRows.length - 1 ? '1px solid var(--border)' : 'none',
                  alignItems: 'center',
                  fontSize: 13,
                  textDecoration: 'none',
                  color: 'inherit',
                }}
              >
                <code style={{ color: 'var(--accent)' }}>{lotDisplayCode(lot) ?? lot.lot_code}</code>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {lot.title}
                </span>
                <span style={{ color: 'var(--fg-muted)', fontSize: 12 }}>
                  relist #{lot.relist_count ?? 0}
                </span>
                <span style={{ color: 'var(--fg-muted)', fontSize: 12 }}>
                  {lot.closed_at
                    ? `closed ${formatDateInTimeZone(lot.closed_at, warehouseTimezone(lot.warehouses))}`
                    : '—'}
                </span>
              </Link>
            ))}
          </div>
        </>
      )}

      <div style={{ marginTop: 32 }}>
        <Link href="/" style={{ ...secondaryButtonStyle, textDecoration: 'none' }}>
          ← Dashboard
        </Link>
      </div>
    </div>
  );
}

const sectionHeading: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 800,
  letterSpacing: 1,
  textTransform: 'uppercase',
  color: 'var(--fg-muted)',
  margin: '0 0 12px',
};

const listStyle: React.CSSProperties = {
  listStyle: 'none',
  padding: 0,
  margin: '12px 0 0',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const listItemStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '280px 100px 1fr',
  gap: 12,
  padding: '6px 0',
  fontSize: 13,
  borderBottom: '1px dashed var(--border)',
};

function AlertCard({
  title,
  count,
  tone,
  empty,
  description,
  children,
}: {
  title: string;
  count: number;
  tone: 'danger' | 'warning' | 'success';
  empty: string;
  description: string;
  children?: React.ReactNode;
}) {
  const accent =
    tone === 'danger'
      ? 'var(--danger, #f87171)'
      : tone === 'warning'
        ? 'var(--warning, #fbbf24)'
        : 'var(--success, #4ade80)';
  return (
    <section
      style={{
        padding: 16,
        background: 'var(--bg-elev)',
        border: '1px solid var(--border)',
        borderLeft: `4px solid ${accent}`,
        borderRadius: 6,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <h3 style={{ fontSize: 14, margin: 0, fontWeight: 700 }}>{title}</h3>
        <span style={{ fontSize: 22, fontWeight: 900, color: accent }}>{count}</span>
      </div>
      <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--fg-muted)' }}>
        {count === 0 ? empty : description}
      </p>
      {children}
    </section>
  );
}
