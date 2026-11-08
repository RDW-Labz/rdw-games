// Bidders & retention (owner ask 2026-07-25: "better bidder reporting like
// distinct weekly bidders and retention stuff").
//
// The point of this page is to separate two things that get conflated:
//   ACQUISITION — are new people arriving and placing a first bid?
//   RETENTION   — do the ones who bought come back?
// BinGo's numbers are lopsided (retention strong, activation weak), and you
// can't see that from a single "active bidders" number. So the weekly table
// splits new vs returning, and the funnel shows where people stall.
//
// Data via operator_bidder_report() (mig 0289), honouring the shared
// ?from=&to= date filter. Segment membership loads on demand — see
// BidderSegmentPanel.

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { formatCents } from '@auction-platform/shared/money';
import { dayRangeInTimeZone } from '@/lib/datetime';
import { PageHeader } from '@/components/Form';
import { KpiCard } from '@/components/console';
import { ReportDateRange } from '@/components/ReportDateRange';
import { parseReportRange } from '@/lib/report-range';
import { BidderSegmentPanel } from './BidderSegmentPanel';
import type { SegmentKey } from './actions';

export const dynamic = 'force-dynamic';

type WeekRow = {
  week: string;
  bidders: number;
  new_bidders: number;
  returning_bidders: number;
  bids: number;
  buyers: number;
  net_cents: number;
};

type Report = {
  registered: number;
  ever_bid: number;
  ever_bought: number;
  repeat_buyers: number;
  one_and_done: number;
  avg_invoices_per_buyer: number | null;
  avg_lifetime_cents: number | null;
  seg_never_bid: number;
  seg_one_and_done: number;
  seg_lapsed_14d: number;
  period_active_bidders: number;
  period_buyers: number;
  period_net_cents: number;
  period_new_signups: number;
  weekly: WeekRow[];
};

function pct(n: number, d: number): string {
  if (!d) return '—';
  return `${Math.round((n / d) * 100)}%`;
}

export default async function BiddersReportPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const sp = await searchParams;
  const { from, to } = parseReportRange(sp);

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

  // Bucket weeks + interpret the range in the warehouse wall clock, same as the
  // money report, so periods line up across tabs.
  const { data: whRow } = await supabase
    .from('warehouses')
    .select('timezone')
    .eq('operator_id', operatorId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  const tz = (whRow as { timezone: string } | null)?.timezone ?? null;

  const range = from && to ? dayRangeInTimeZone(from, to, tz) : null;

  const { data, error } = await supabase.rpc('operator_bidder_report', {
    p_from: range?.startISO ?? null,
    p_to: range?.endISO ?? null,
    p_tz: tz ?? 'America/Chicago',
  });
  const r = (data ?? null) as Report | null;
  const weekly = (r?.weekly ?? []).filter(Boolean);

  const periodLabel = from && to ? `${from} → ${to}` : 'all time';

  // Acquisition trend: compare the newest COMPLETE week's new-bidder count to
  // the one before it. The current week is partial by definition, so including
  // it would always read as a collapse.
  const complete = weekly.slice(0, Math.max(0, weekly.length - 1));
  const lastNew = complete.length > 0 ? complete[complete.length - 1]!.new_bidders : null;
  const prevNew = complete.length > 1 ? complete[complete.length - 2]!.new_bidders : null;
  const newTrendDown = lastNew != null && prevNew != null && prevNew > 0 && lastNew < prevNew * 0.6;

  const segCounts: Partial<Record<SegmentKey, number>> = {
    never_bid: r?.seg_never_bid,
    one_and_done: r?.seg_one_and_done,
    lapsed: r?.seg_lapsed_14d,
  };

  return (
    <div>
      <PageHeader title="Bidders & retention" />
      <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: '0 0 1rem', maxWidth: 860 }}>
        Acquisition and retention, split apart. The funnel shows where people stall; the weekly
        table separates <strong>new</strong> from <strong>returning</strong> bidders so a flat
        headline count can&apos;t hide a fall-off in either one. Money figures are net of refunds —
        see{' '}
        <Link href="/reports/money" style={{ color: 'var(--accent)' }}>
          Money &amp; Square
        </Link>{' '}
        for the full breakdown.
      </p>

      <ReportDateRange
        from={from}
        to={to}
        hint="Bids are bucketed by when they were placed; buyers and money by when the invoice was paid. Weeks start Monday in your warehouse timezone. The funnel below is lifetime by nature and ignores the range."
      />

      {error && (
        <div
          style={{
            padding: '1rem',
            border: '1px solid rgba(255,84,112,0.4)',
            background: 'rgba(255,84,112,0.08)',
            borderRadius: 8,
            color: 'var(--danger)',
            fontSize: 14,
            marginBottom: '1rem',
          }}
        >
          Couldn&apos;t load the bidder report: {error.message}. If this persists, migration 0289
          may not be applied yet.
        </div>
      )}

      {/* Period activity */}
      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: '1rem',
          marginBottom: '0.5rem',
        }}
      >
        <KpiCard label={`Active bidders · ${periodLabel}`} value={String(r?.period_active_bidders ?? 0)} />
        <KpiCard label="Buyers" value={String(r?.period_buyers ?? 0)} />
        <KpiCard label="Net collected" value={formatCents(r?.period_net_cents ?? 0)} tone="accent" />
        <KpiCard label="New signups" value={String(r?.period_new_signups ?? 0)} />
      </section>
      <p style={{ fontSize: 12, color: 'var(--fg-muted)', margin: '0 0 2rem' }}>
        &ldquo;Active bidder&rdquo; = placed at least one bid in the period. A signup who never bids
        is not counted here — that&apos;s the gap the funnel below measures.
      </p>

      {/* Funnel — lifetime */}
      <section style={{ marginBottom: '2rem' }}>
        <h2 style={{ fontSize: '1.05rem', margin: '0 0 0.75rem' }}>Lifetime funnel</h2>
        <div className="console-table-card" style={{ overflowX: 'auto' }}>
          <table className="console-table">
            <thead>
              <tr>
                <th>Stage</th>
                <th style={{ textAlign: 'right' }}>People</th>
                <th style={{ textAlign: 'right' }}>Conversion</th>
                <th>What it means</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={{ fontWeight: 600 }}>Registered</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r?.registered ?? 0}</td>
                <td style={{ textAlign: 'right', color: 'var(--fg-muted)' }}>—</td>
                <td style={{ fontSize: 12, color: 'var(--fg-muted)' }}>Accounts created</td>
              </tr>
              <tr>
                <td style={{ fontWeight: 600 }}>Placed a bid</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r?.ever_bid ?? 0}</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>
                  {pct(r?.ever_bid ?? 0, r?.registered ?? 0)}
                </td>
                <td style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
                  Everyone below this line is dead weight until activated
                </td>
              </tr>
              <tr>
                <td style={{ fontWeight: 600 }}>Bought</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r?.ever_bought ?? 0}</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>
                  {pct(r?.ever_bought ?? 0, r?.ever_bid ?? 0)} of bidders
                </td>
                <td style={{ fontSize: 12, color: 'var(--fg-muted)' }}>Bidder → buyer</td>
              </tr>
              <tr>
                <td style={{ fontWeight: 600, color: 'var(--accent)' }}>Bought again</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r?.repeat_buyers ?? 0}</td>
                <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 800, color: 'var(--accent)' }}>
                  {pct(r?.repeat_buyers ?? 0, r?.ever_bought ?? 0)} of buyers
                </td>
                <td style={{ fontSize: 12, color: 'var(--fg-muted)' }}>
                  Your retention. High here means the product works — spend effort further up.
                </td>
              </tr>
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 700 }}>
                <td style={{ padding: '11px 12px', borderTop: '2px solid var(--border)' }}>
                  Avg per buyer
                </td>
                <td style={{ padding: '11px 12px', borderTop: '2px solid var(--border)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  {r?.avg_invoices_per_buyer ?? '—'} orders
                </td>
                <td style={{ padding: '11px 12px', borderTop: '2px solid var(--border)', textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  {formatCents(r?.avg_lifetime_cents ?? 0)}
                </td>
                <td style={{ padding: '11px 12px', borderTop: '2px solid var(--border)', fontSize: 12, color: 'var(--fg-muted)' }}>
                  Lifetime value of one buyer, net of refunds
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      </section>

      {/* Weekly: new vs returning */}
      <section>
        <h2 style={{ fontSize: '1.05rem', margin: '0 0 0.25rem' }}>Weekly distinct bidders</h2>
        <p style={{ fontSize: 12.5, color: 'var(--fg-muted)', margin: '0 0 0.75rem', maxWidth: 860 }}>
          A bidder counts once per week no matter how many bids they place.{' '}
          <strong>New</strong> = their first-ever bid landed that week.
        </p>

        {newTrendDown && (
          <div
            style={{
              padding: '0.8rem 1rem',
              border: '1px solid var(--warning, #fbbf24)',
              background: 'rgba(251,191,36,0.08)',
              borderRadius: 8,
              maxWidth: 860,
              marginBottom: '0.9rem',
              fontSize: 13,
              color: 'var(--fg)',
              lineHeight: 1.55,
            }}
          >
            <strong>Acquisition is falling.</strong> First-time bidders dropped from{' '}
            <strong>{prevNew}</strong> to <strong>{lastNew}</strong> in the last complete week.
            Returning bidders can hold revenue flat for a while, which makes this easy to miss —
            but it&apos;s the leading indicator. The <em>Never bid</em> segment below is the
            cheapest place to recover from, since those people already registered.
          </div>
        )}

        <div className="console-table-card" style={{ overflowX: 'auto' }}>
          <table className="console-table">
            <thead>
              <tr>
                <th>Week of</th>
                <th style={{ textAlign: 'right' }}>Bidders</th>
                <th style={{ textAlign: 'right' }}>New</th>
                <th style={{ textAlign: 'right' }}>Returning</th>
                <th style={{ textAlign: 'right' }}>Bids</th>
                <th style={{ textAlign: 'right' }}>Buyers</th>
                <th style={{ textAlign: 'right' }}>Net collected</th>
              </tr>
            </thead>
            <tbody>
              {weekly.length === 0 ? (
                <tr>
                  <td colSpan={7} style={{ padding: '2rem', textAlign: 'center', color: 'var(--fg-muted)' }}>
                    No bidder activity in this period.
                  </td>
                </tr>
              ) : (
                weekly.map((w, i) => {
                  const isCurrent = i === weekly.length - 1;
                  return (
                    <tr key={w.week}>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {w.week}
                        {isCurrent && (
                          <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--fg-muted)', fontWeight: 700 }}>
                            (partial)
                          </span>
                        )}
                      </td>
                      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>
                        {w.bidders}
                      </td>
                      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--accent)' }}>
                        {w.new_bidders}
                      </td>
                      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                        {w.returning_bidders}
                      </td>
                      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'var(--fg-muted)' }}>
                        {w.bids}
                      </td>
                      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{w.buyers}</td>
                      <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                        {formatCents(w.net_cents)}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      <BidderSegmentPanel counts={segCounts} />
    </div>
  );
}
