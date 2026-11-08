// Operations Health — a live, single-round-trip snapshot of everything an
// operator needs to answer "is the platform working right now?": signups,
// bidding, catalog, the email/push pipelines, background job queues, and
// engine liveness. Business finance (P&L, sold lots) lives on the parent
// /reports page; this is the operational audit view.
//
// All numbers come from operator_ops_health() (mig 0224) — one SECURITY
// DEFINER RPC so the page is a single call and the cross-table platform
// counts aren't blocked by operator RLS. Money (the "today" stats and the
// daily trend's money columns) comes from operator_money_daily (mig 0417),
// the Money page's calculation per Chicago day — NOT a status = 'paid' sum,
// which dropped every partially refunded invoice (2026-10-14).

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { formatInTimeZone } from '@/lib/datetime';
import { formatCents } from '@auction-platform/shared/money';
import { PageHeader } from '@/components/Form';
import { MoneyDailyLegend, MoneyDailyTable } from '@/components/MoneyDailyTable';
import { addDaysYMD, fetchMoneyDaily, todayInTimeZone } from '@/lib/money-daily';

export const dynamic = 'force-dynamic';

type Health = {
  generated_at: string;
  signups: { total: number; last_24h: number; last_7d: number; with_card: number };
  bids: {
    total: number;
    last_24h: number;
    auto: number;
    distinct_bidders: number;
    lots_with_bids: number;
  };
  catalog: { active_auctions: number; live_lots: number; lots_ending_1h: number };
  email: {
    queued: number;
    stuck_10m: number;
    failed: number;
    sent_24h: number;
    last_sent: string | null;
  };
  push: { queued: number; stuck_10m: number; last_sent: string | null };
  signup_failures_24h: number;
  jobs: {
    refunds_pending: number;
    image_enrich_pending: number;
    autocharge_errored: number;
    // v3 (mig 0227) — optional until the migration is applied
    photo_rehost_pending?: number;
  };
  // v2 (mig 0225)
  money?: {
    unpaid_count: number;
    unpaid_cents: number;
    oldest_unpaid: string | null;
    /** 0417: gross charged in the last 24 h. Not shown — the page uses Chicago days. */
    paid_24h_cents?: number;
  };
  engine: { lots_overdue_finalize: number };
};

// 0357 — the "collected item never resold" monitor's open rows for this operator.
type Invariants = {
  generated_at: string;
  last_check_at: string | null;
  sweep_last_ok: string | null;
  open_page: number;
  open_watch: number;
  unacknowledged_page: number;
  awaiting_email: number;
  resolved_7d: number;
  rows: Array<{
    id: number;
    check_code: string;
    severity: 'page' | 'watch';
    lot: string | null;
    root_lot: string | null;
    action: string | null;
    first_seen_at: string;
    acknowledged: boolean;
    notified: boolean;
  }>;
};

type Engagement = {
  funnel: { registered: number; with_card: number; bid: number; won: number; paid: number };
  // gmv_cents (gross charged) is still returned but no longer shown: the money
  // columns come from operator_money_daily.
  daily: Array<{ day: string; signups: number; bids: number; gmv_cents?: number }>;
};

export default async function OpsHealthPage() {
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

  const { data: whRow } = await supabase
    .from('warehouses')
    .select('timezone')
    .eq('operator_id', operatorId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  const tz = (whRow as { timezone: string } | null)?.timezone ?? null;

  const moneyTz = tz ?? 'America/Chicago';
  const today = todayInTimeZone(moneyTz);
  const [{ data, error }, { data: engData }, { data: invData }, money] = await Promise.all([
    supabase.rpc('operator_ops_health'),
    supabase.rpc('operator_engagement_report', {
      p_tz: tz ?? 'America/Chicago',
      p_days: 14,
    }),
    // 0357: null until the migration is applied; the group simply does not render.
    supabase.rpc('operator_invariant_summary'),
    // Same 14 Chicago days as the engagement trend (today and the 13 before).
    fetchMoneyDaily(supabase, addDaysYMD(today, -13), today, moneyTz),
  ]);
  const moneyToday = money?.days.find((d) => d.day === today) ?? null;
  const engagementByDay = new Map(
    ((engData as Engagement | null)?.daily ?? []).map((d) => [d.day, d] as const),
  );
  const health = (data as Health | null) ?? null;
  const engagement = (engData as Engagement | null) ?? null;
  const invariants = (invData as Invariants | null) ?? null;

  return (
    <div>
      <PageHeader title="Operations health" />
      <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: '0 0 1.25rem' }}>
        Live snapshot — {health ? formatInTimeZone(health.generated_at, tz) : 'unavailable'}.{' '}
        Business finance (P&amp;L, sold lots) is on{' '}
        <Link href="/reports" style={{ color: 'var(--accent)' }}>
          Reports
        </Link>
        .
      </p>

      {!health && (
        <div
          style={{
            padding: '1rem',
            border: '1px solid rgba(255,84,112,0.4)',
            background: 'rgba(255,84,112,0.08)',
            borderRadius: 8,
            color: 'var(--danger)',
            fontSize: 14,
          }}
        >
          Couldn&apos;t load operations health{error ? `: ${error.message}` : ''}. Refresh to retry.
        </div>
      )}

      {health && (
        <>
          <Group title="Signups">
            <Stat label="Registered bidders" value={health.signups.total} />
            <Stat label="New · 24h" value={health.signups.last_24h} />
            <Stat label="New · 7d" value={health.signups.last_7d} />
            <Stat label="Card on file" value={health.signups.with_card} />
            <Stat
              label="Failed signups · 24h"
              value={health.signup_failures_24h}
              tone={health.signup_failures_24h > 0 ? 'warn' : 'ok'}
              href="/bidders"
            />
          </Group>

          <Group title="Bidding">
            <Stat label="Total bids" value={health.bids.total} />
            <Stat label="Bids · 24h" value={health.bids.last_24h} />
            <Stat label="Proxy (max) bids" value={health.bids.auto} />
            <Stat label="Bidders who've bid" value={health.bids.distinct_bidders} />
            <Stat label="Lots with a bid" value={health.bids.lots_with_bids} />
          </Group>

          <Group title="Catalog">
            <Stat label="Active auctions" value={health.catalog.active_auctions} />
            <Stat label="Live lots" value={health.catalog.live_lots} />
            <Stat label="Ending within 1h" value={health.catalog.lots_ending_1h} />
          </Group>

          <Group title="Email pipeline">
            <Stat label="Queued" value={health.email.queued} />
            <Stat
              label="Stuck >10m"
              value={health.email.stuck_10m}
              tone={health.email.stuck_10m > 0 ? 'bad' : 'ok'}
            />
            <Stat
              label="Failed (gave up)"
              value={health.email.failed}
              tone={health.email.failed > 0 ? 'warn' : 'ok'}
            />
            <Stat label="Sent · 24h" value={health.email.sent_24h} />
            <Stat
              label="Last sent"
              value={health.email.last_sent ? formatInTimeZone(health.email.last_sent, tz) : '—'}
              small
            />
          </Group>

          <Group title="Push pipeline">
            <Stat label="Queued" value={health.push.queued} />
            <Stat
              label="Stuck >10m"
              value={health.push.stuck_10m}
              tone={health.push.stuck_10m > 0 ? 'bad' : 'ok'}
            />
            <Stat
              label="Last sent"
              value={health.push.last_sent ? formatInTimeZone(health.push.last_sent, tz) : '—'}
              small
            />
          </Group>

          {engagement && (
            <Group title="Bidder funnel">
              <Stat label="Registered" value={engagement.funnel.registered} />
              <Stat label="Card on file" value={engagement.funnel.with_card} />
              <Stat label="Placed a bid" value={engagement.funnel.bid} />
              <Stat label="Won a lot" value={engagement.funnel.won} />
              <Stat label="Paid an invoice" value={engagement.funnel.paid} />
            </Group>
          )}

          {health.money && (
            <Group title="Money">
              <Stat
                label="Gross charged · today"
                value={moneyToday ? formatCents(moneyToday.gross_charged_cents) : '—'}
                href="/reports/money"
              />
              <Stat
                label="Net revenue · today"
                value={moneyToday ? formatCents(moneyToday.net_revenue_cents) : '—'}
                href="/reports/money"
              />
              <Stat
                label="Unpaid invoices"
                value={health.money.unpaid_count}
                tone={health.money.unpaid_count > 0 ? 'warn' : 'ok'}
                href="/invoices"
              />
              <Stat label="Unpaid value" value={formatCents(health.money.unpaid_cents)} />
              <Stat
                label="Oldest unpaid"
                value={
                  health.money.oldest_unpaid
                    ? formatInTimeZone(health.money.oldest_unpaid, tz, {
                        month: 'short',
                        day: 'numeric',
                        hour: 'numeric',
                        minute: '2-digit',
                      })
                    : '—'
                }
                small
              />
            </Group>
          )}

          {invariants && (
            <>
              {/* 0357: an item a customer already carried out must never be
                  reclaimed, relisted, or sold again. 'page' rows are emailed
                  by the health-check cron; 'watch' rows only appear here. */}
              <Group title="Handover invariants">
                <Stat
                  label="Open · page"
                  value={invariants.open_page}
                  tone={
                    invariants.unacknowledged_page > 0 ? 'bad' : invariants.open_page > 0 ? 'warn' : 'ok'
                  }
                />
                <Stat
                  label="Open · watch"
                  value={invariants.open_watch}
                  tone={invariants.open_watch > 0 ? 'warn' : 'ok'}
                />
                <Stat
                  label="Awaiting email"
                  value={invariants.awaiting_email}
                  tone={invariants.awaiting_email > 0 ? 'bad' : 'ok'}
                />
                <Stat label="Resolved · 7d" value={invariants.resolved_7d} />
                <Stat
                  label="Last check"
                  value={
                    invariants.last_check_at
                      ? formatInTimeZone(invariants.last_check_at, tz, {
                          month: 'short',
                          day: 'numeric',
                          hour: 'numeric',
                          minute: '2-digit',
                        })
                      : '—'
                  }
                  tone={
                    !invariants.last_check_at ||
                    Date.now() - Date.parse(invariants.last_check_at) > 45 * 60 * 1000
                      ? 'bad'
                      : 'ok'
                  }
                  small
                />
                <Stat
                  label="No-show sweep last OK"
                  value={
                    invariants.sweep_last_ok
                      ? formatInTimeZone(invariants.sweep_last_ok, tz, {
                          month: 'short',
                          day: 'numeric',
                          hour: 'numeric',
                          minute: '2-digit',
                        })
                      : '—'
                  }
                  tone={
                    !invariants.sweep_last_ok ||
                    Date.now() - Date.parse(invariants.sweep_last_ok) > 90 * 60 * 1000
                      ? 'bad'
                      : 'ok'
                  }
                  small
                />
              </Group>

              {invariants.rows.length > 0 && (
                <section style={{ marginBottom: '1.5rem' }}>
                  <div
                    style={{
                      overflowX: 'auto',
                      background: 'var(--bg-elev)',
                      border: '1px solid var(--border)',
                      borderRadius: 8,
                      padding: '0.5rem 0.75rem',
                    }}
                  >
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                      <thead>
                        <tr>
                          {(['Check', 'Lot', 'Was', 'First seen', 'State', 'What to do'] as const).map((h) => (
                            <th
                              key={h}
                              style={{
                                padding: '0.4rem 0.5rem',
                                borderBottom: '1px solid var(--border)',
                                textAlign: 'left',
                                color: 'var(--fg-muted)',
                                fontSize: 12,
                              }}
                            >
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {invariants.rows.map((r) => (
                          <tr key={r.id}>
                            <td style={{ padding: '0.35rem 0.5rem', whiteSpace: 'nowrap' }}>
                              <span
                                style={{
                                  color: r.severity === 'page' ? '#ff5470' : '#f0b428',
                                  fontWeight: 700,
                                  marginRight: 6,
                                }}
                              >
                                {r.severity === 'page' ? '●' : '○'}
                              </span>
                              {r.check_code.replace(/_/g, ' ')}
                            </td>
                            <td style={{ padding: '0.35rem 0.5rem', fontVariantNumeric: 'tabular-nums' }}>
                              {r.lot ?? '—'}
                            </td>
                            <td style={{ padding: '0.35rem 0.5rem', fontVariantNumeric: 'tabular-nums' }}>
                              {r.root_lot && r.root_lot !== r.lot ? r.root_lot : '—'}
                            </td>
                            <td style={{ padding: '0.35rem 0.5rem', whiteSpace: 'nowrap' }}>
                              {formatInTimeZone(r.first_seen_at, tz, {
                                month: 'short',
                                day: 'numeric',
                                hour: 'numeric',
                                minute: '2-digit',
                              })}
                            </td>
                            <td style={{ padding: '0.35rem 0.5rem', whiteSpace: 'nowrap', color: 'var(--fg-muted)' }}>
                              {r.acknowledged ? 'acknowledged' : r.notified ? 'emailed' : 'new'}
                            </td>
                            <td style={{ padding: '0.35rem 0.5rem', color: 'var(--fg-muted)' }}>{r.action ?? ''}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              )}
            </>
          )}

          <Group title="Jobs & engine">
            <Stat
              label="Refunds pending"
              value={health.jobs.refunds_pending}
              tone={health.jobs.refunds_pending > 0 ? 'warn' : 'ok'}
            />
            <Stat label="Image enrich pending" value={health.jobs.image_enrich_pending} />
            {typeof health.jobs.photo_rehost_pending === 'number' && (
              // Lots still carrying externally-hosted photos. The photo-rehost
              // cron drains this automatically (~30 images/min) — a nonzero
              // value is a backlog counting down, not an error.
              <Stat
                label="Photos to re-host"
                value={health.jobs.photo_rehost_pending}
                tone={health.jobs.photo_rehost_pending > 0 ? 'warn' : 'ok'}
              />
            )}
            <Stat
              label="Auto-charge errors"
              value={health.jobs.autocharge_errored}
              tone={health.jobs.autocharge_errored > 0 ? 'warn' : 'ok'}
              href="/invoices"
            />
            <Stat
              label="Lots overdue to close"
              value={health.engine.lots_overdue_finalize}
              tone={health.engine.lots_overdue_finalize > 0 ? 'bad' : 'ok'}
            />
          </Group>

          {(money || (engagement && engagement.daily.length > 0)) && (
            <section style={{ marginBottom: '1.5rem' }}>
              <h2 style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--fg-muted)', margin: '0 0 0.6rem' }}>
                Daily trend · last 14 days
              </h2>
              <div
                style={{
                  overflowX: 'auto',
                  background: 'var(--bg-elev)',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  padding: '0.5rem 0.75rem',
                }}
              >
                {money ? (
                  <MoneyDailyTable
                    money={money}
                    extraColumns={[
                      { label: 'Signups', render: (day) => engagementByDay.get(day)?.signups ?? '—' },
                      { label: 'Bids', render: (day) => engagementByDay.get(day)?.bids ?? '—' },
                    ]}
                  />
                ) : (
                  <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: '0.35rem 0' }}>
                    Money by day is unavailable (operator_money_daily did not answer). See the{' '}
                    <Link href="/reports/money" style={{ color: 'var(--accent)' }}>
                      Money
                    </Link>{' '}
                    tab.
                  </p>
                )}
              </div>
              {money && <MoneyDailyLegend timeZone={money.tz} />}
            </section>
          )}
        </>
      )}
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: '1.5rem' }}>
      <h2 style={{ fontSize: 13, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--fg-muted)', margin: '0 0 0.6rem' }}>
        {title}
      </h2>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
          gap: '0.75rem',
        }}
      >
        {children}
      </div>
    </section>
  );
}

function Stat({
  label,
  value,
  tone = 'neutral',
  small = false,
  href,
}: {
  label: string;
  value: number | string;
  tone?: 'neutral' | 'ok' | 'warn' | 'bad';
  small?: boolean;
  href?: string;
}) {
  const border =
    tone === 'bad'
      ? 'rgba(255,84,112,0.5)'
      : tone === 'warn'
        ? 'rgba(240,180,40,0.5)'
        : 'var(--border)';
  const valueColor =
    tone === 'bad' ? '#ff5470' : tone === 'warn' ? '#f0b428' : 'var(--fg)';
  const body = (
    <div
      style={{
        padding: '0.75rem 1rem',
        background: 'var(--bg-elev)',
        border: `1px solid ${border}`,
        borderRadius: 8,
        height: '100%',
      }}
    >
      <div style={{ fontSize: small ? 14 : 22, fontWeight: 800, color: valueColor }}>{value}</div>
      <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{label}</div>
    </div>
  );
  return href ? (
    <Link href={href} style={{ textDecoration: 'none' }}>
      {body}
    </Link>
  ) : (
    body
  );
}
