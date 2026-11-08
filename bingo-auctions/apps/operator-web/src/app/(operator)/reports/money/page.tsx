// Money & Square reconciliation (owner ask 2026-07-24: "I want visibility to
// all of it"). ONE page that shows every component of the money and explains,
// line by line, why a platform figure and a Square figure legitimately differ.
//
// Data via operator_money_summary() (mig 0287, refunds re-dated by 0421) —
// operator-scoped. Sales are bucketed on invoices.paid_at; refunds on the day
// each refund was issued (warehouse wall clock), so a September sale refunded
// in October lowers October, not September. ?from=&to= picks the window.
//
// The reconciliation ladder is the point of this page: start from what bidders
// were charged, walk down through refunds / tax / Square fees, and land on the
// number that should match a Square DEPOSIT. Every row states its own basis so
// no figure here can be mistaken for a different one.

import { redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { formatCents } from '@auction-platform/shared/money';
import { dayRangeInTimeZone } from '@/lib/datetime';
import { PageHeader } from '@/components/Form';
import { KpiCard } from '@/components/console';
import { ReportDateRange } from '@/components/ReportDateRange';
import { parseReportRange } from '@/lib/report-range';

export const dynamic = 'force-dynamic';

type MoneySummary = {
  invoices: number;
  hammer_cents: number;
  premium_cents: number;
  tax_cents: number;
  gross_charged_cents: number;
  refunded_cash_cents: number;
  refunded_credit_cents: number;
  refunded_tax_cents: number;
  net_collected_cents: number;
  net_tax_cents: number;
  square_fee_cents: number;
  square_fee_known_count: number;
  square_payment_count: number;
  offline_paid_count: number;
  offline_paid_cents: number;
  platform_fee_cents: number;
  unpaid_count: number;
  unpaid_cents: number;
  by_status: Array<{
    status: string;
    invoices: number;
    gross_cents: number;
    refunded_cents: number;
  }>;
  first_paid_at: string | null;
  last_paid_at: string | null;
};

export default async function MoneyReportPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string }>;
}) {
  const sp = await searchParams;
  // 0289/2026-07-25: replaced the fixed 7/30/90/all buttons with the shared
  // ?from=&to= control so this tab is comparable with every other report tab.
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

  // Interpret the range in the warehouse wall clock (2026-07-05 fix): UTC
  // boundaries pushed late-evening sales into the next day.
  const { data: whRow } = await supabase
    .from('warehouses')
    .select('timezone')
    .eq('operator_id', operatorId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  const tz = (whRow as { timezone: string } | null)?.timezone ?? null;
  const range = from && to ? dayRangeInTimeZone(from, to, tz) : null;

  const { data, error } = await supabase.rpc('operator_money_summary', {
    p_from: range?.startISO ?? null,
    p_to: range?.endISO ?? null,
  });
  const m = (data ?? null) as MoneySummary | null;

  const periodLabel = from && to ? `${from} → ${to}` : 'all time';

  // The reconciliation ladder: charged → refunds → collected → tax → revenue,
  // then the Square-side view: collected → fees → deposit.
  const refundedFace =
    (m?.refunded_cash_cents ?? 0) + (m?.refunded_credit_cents ?? 0);
  const netCollected = m?.net_collected_cents ?? 0;
  const netTax = m?.net_tax_cents ?? 0;
  // 0421: not clamped at 0. Refunds land on their own date, so a window with
  // more refunds than sales genuinely shows money going out — and /reports
  // (operator_reports_period_summary) no longer clamps either, so they agree.
  const netRevenue = netCollected - netTax;
  const squareFee = m?.square_fee_cents ?? 0;
  const netDeposit = netCollected - squareFee;
  // Square fees are only final at settlement, so the deposit line is an
  // estimate until every payment reports one. Say so rather than implying
  // precision we don't have.
  const feesComplete =
    (m?.square_payment_count ?? 0) > 0 &&
    (m?.square_fee_known_count ?? 0) >= (m?.square_payment_count ?? 0);

  const ladder: Array<{
    label: string;
    basis: string;
    cents: number;
    kind?: 'deduction' | 'total' | 'estimate';
  }> = [
    {
      label: 'Hammer (winning bids)',
      basis: 'What items sold for, before premium and tax',
      cents: m?.hammer_cents ?? 0,
    },
    {
      label: "+ Buyer's premium",
      basis: 'Your commission on top of the hammer',
      cents: m?.premium_cents ?? 0,
    },
    {
      label: '+ Sales tax',
      basis: "Collected for the state — not your money",
      cents: m?.tax_cents ?? 0,
    },
    {
      label: '= Gross charged',
      basis: 'Total billed to bidders. Closest to a Square GROSS SALES figure.',
      cents: m?.gross_charged_cents ?? 0,
      kind: 'total',
    },
    {
      label: '− Refunds (by refund date)',
      basis: `Refunds issued in this window, whenever the sale was paid. Cash ${formatCents(m?.refunded_cash_cents ?? 0)} + store credit ${formatCents(m?.refunded_credit_cents ?? 0)}`,
      cents: refundedFace,
      kind: 'deduction',
    },
    {
      label: '= Net collected',
      basis: 'Money you actually kept, tax included',
      cents: netCollected,
      kind: 'total',
    },
    {
      label: '− Sales tax owed',
      basis: 'Tax on sales paid in this window, less tax refunded in it',
      cents: netTax,
      kind: 'deduction',
    },
    {
      label: '= Net revenue',
      basis: 'Hammer + premium, net of refunds, excluding tax. Your real top line.',
      cents: netRevenue,
      kind: 'total',
    },
    {
      label: '− Square processing fees',
      basis: feesComplete
        ? 'As reported by Square'
        : `Known for ${m?.square_fee_known_count ?? 0} of ${m?.square_payment_count ?? 0} payments — fees finalize at settlement`,
      cents: squareFee,
      kind: 'deduction',
    },
    {
      label: '≈ Net deposit to bank',
      basis: feesComplete
        ? 'Net collected − Square fees. Compare against Square DEPOSITS.'
        : 'Incomplete until every payment reports its fee — treat as a floor.',
      cents: netDeposit,
      kind: feesComplete ? 'total' : 'estimate',
    },
  ];

  return (
    <div>
      <PageHeader title="Money & Square reconciliation" />
      <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: '0 0 1rem', maxWidth: 860 }}>
        Every component of the money for the <strong>{periodLabel}</strong>. Sales count on
        the day the invoice was paid; refunds count on the day they were issued. Read
        top to bottom: what bidders were charged, what came back, and what should land
        in the bank.
      </p>

      <ReportDateRange
        from={from}
        to={to}
        hint="Sales by paid date, refunds by refund date, in your warehouse timezone."
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
          Couldn&apos;t load the money summary: {error.message}. If this persists, the
          operator_money_summary migration (0287) may not be applied yet.
        </div>
      )}

      <section
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
          gap: '1rem',
          marginBottom: '2rem',
        }}
      >
        <KpiCard label="Gross charged (incl. tax)" value={formatCents(m?.gross_charged_cents ?? 0)} />
        <KpiCard label="Net collected (incl. tax)" value={formatCents(netCollected)} />
        <KpiCard label="Net revenue (excl. tax)" value={formatCents(netRevenue)} tone="accent" />
        <KpiCard label="Refunds (by refund date)" value={formatCents(refundedFace)} muted />
        <KpiCard
          label="Still owed"
          value={formatCents(m?.unpaid_cents ?? 0)}
          href="/invoices?status=unpaid"
          tone={(m?.unpaid_cents ?? 0) > 0 ? 'danger' : 'default'}
        />
      </section>

      {/* The ladder. */}
      <section style={{ marginBottom: '2rem' }}>
        <h2 style={{ fontSize: '1rem', margin: '0 0 0.75rem' }}>
          Charged → collected → deposited
        </h2>
        <div className="console-table-card" style={{ overflowX: 'auto' }}>
          <table className="console-table">
            <thead>
              <tr>
                <th>Line</th>
                <th>What it means</th>
                <th style={{ textAlign: 'right' }}>Amount</th>
              </tr>
            </thead>
            <tbody>
              {ladder.map((row) => {
                const isTotal = row.kind === 'total';
                const isDeduction = row.kind === 'deduction';
                return (
                  <tr key={row.label}>
                    <td
                      style={{
                        fontWeight: isTotal ? 800 : 500,
                        whiteSpace: 'nowrap',
                        color: isTotal ? 'var(--fg)' : undefined,
                      }}
                    >
                      {row.label}
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{row.basis}</td>
                    <td
                      style={{
                        textAlign: 'right',
                        fontVariantNumeric: 'tabular-nums',
                        fontWeight: isTotal ? 800 : 500,
                        color: isDeduction ? 'var(--danger)' : undefined,
                        borderTop: isTotal ? '2px solid var(--border)' : undefined,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {isDeduction && row.cents > 0 ? '−' : ''}
                      {formatCents(row.cents)}
                      {row.kind === 'estimate' ? ' *' : ''}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!feesComplete && (
          <p style={{ fontSize: 12, color: 'var(--fg-muted)', margin: '0.5rem 0 0' }}>
            * Square processing fees are only final once a payment settles, so the
            deposit line is a floor until every payment reports one.
          </p>
        )}
      </section>

      {/* Why Square disagrees — the whole point of the page. */}
      <section style={{ marginBottom: '2rem' }}>
        <h2 style={{ fontSize: '1rem', margin: '0 0 0.5rem' }}>
          Why your Square total looks bigger
        </h2>
        <div
          style={{
            padding: '1rem 1.15rem',
            border: '1px solid var(--border)',
            background: 'var(--bg-elev)',
            borderRadius: 8,
            maxWidth: 900,
            fontSize: 13,
            color: 'var(--fg-muted)',
            lineHeight: 1.6,
          }}
        >
          <ol style={{ margin: 0, paddingLeft: '1.2rem', display: 'grid', gap: '0.55rem' }}>
            <li>
              <strong style={{ color: 'var(--fg)' }}>Square shows every location.</strong>{' '}
              Your Square account covers the brick-and-mortar stores too. Auction
              payments are pinned to the single BinGo auction location — so a
              Square total across all locations will always exceed this page.
              Filter Square to the BinGo location before comparing.
            </li>
            <li>
              <strong style={{ color: 'var(--fg)' }}>Match like for like.</strong>{' '}
              Square&apos;s &ldquo;gross sales&rdquo; is tax-inclusive → compare it to{' '}
              <strong style={{ color: 'var(--fg)' }}>Gross charged</strong> above, not
              to Net revenue (which strips tax).
            </li>
            <li>
              <strong style={{ color: 'var(--fg)' }}>Deposits are net and lagged.</strong>{' '}
              Square deposits subtract processing fees and arrive on a settlement
              delay, so a deposit never equals a day&apos;s sales. Compare deposits to{' '}
              <strong style={{ color: 'var(--fg)' }}>Net deposit to bank</strong>.
            </li>
            <li>
              <strong style={{ color: 'var(--fg)' }}>Cash / manual payments never reach Square.</strong>{' '}
              {(m?.offline_paid_count ?? 0) > 0 ? (
                <>
                  {m?.offline_paid_count} invoice
                  {(m?.offline_paid_count ?? 0) === 1 ? '' : 's'} worth{' '}
                  {formatCents(m?.offline_paid_cents ?? 0)} were marked paid without a
                  Square payment in this window — real revenue that Square will not show.
                </>
              ) : (
                <>
                  None in this window — every paid invoice here has a Square payment,
                  so nothing is missing on the auction side.
                </>
              )}
            </li>
          </ol>
        </div>
      </section>

      {/* Invoice mix, so the totals above are auditable. */}
      <section>
        <h2 style={{ fontSize: '1rem', margin: '0 0 0.75rem' }}>Invoice mix</h2>
        <div className="console-table-card" style={{ overflowX: 'auto' }}>
          <table className="console-table">
            <thead>
              <tr>
                <th>Invoice status</th>
                <th style={{ textAlign: 'right' }}>Invoices</th>
                <th style={{ textAlign: 'right' }}>Gross charged</th>
                <th style={{ textAlign: 'right' }}>Refunds (by refund date)</th>
                <th style={{ textAlign: 'right' }}>Net</th>
              </tr>
            </thead>
            <tbody>
              {(m?.by_status ?? []).map((r) => (
                <tr key={r.status}>
                  <td>{r.status.replace(/_/g, ' ')}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{r.invoices}</td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    {formatCents(r.gross_cents)}
                  </td>
                  <td
                    style={{
                      textAlign: 'right',
                      fontVariantNumeric: 'tabular-nums',
                      color: r.refunded_cents ? 'var(--danger)' : undefined,
                    }}
                  >
                    {r.refunded_cents ? `−${formatCents(r.refunded_cents)}` : '—'}
                  </td>
                  <td style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontWeight: 700 }}>
                    {formatCents(r.gross_cents - r.refunded_cents)}
                  </td>
                </tr>
              ))}
              {(m?.by_status ?? []).length === 0 && (
                <tr>
                  <td colSpan={5} style={{ padding: '2rem', textAlign: 'center', color: 'var(--fg-muted)' }}>
                    No paid invoices or refunds in this window.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p style={{ fontSize: 12, color: 'var(--fg-muted)', margin: '0.75rem 0 0', maxWidth: 860 }}>
          Note: an invoice with even a small partial refund is stored as{' '}
          <em>partially refunded</em>. It is still mostly collected money — which
          is why this page nets refunds instead of dropping the whole invoice.
          Invoices and gross count sales paid in this window; refunds count those
          issued in it, listed under the refunded invoice&apos;s current status.
        </p>
      </section>
    </div>
  );
}
