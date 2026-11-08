// Bidder detail (operator view) — invoices, bid history, notes, suspend.

import Link from 'next/link';
import { lotDisplayCode } from '@auction-platform/shared';
import { notFound, redirect } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { formatCents } from '@auction-platform/shared/money';
import { formatInTimeZone, formatDateInTimeZone, warehouseTimezone } from '@/lib/datetime';
import { PageHeader, secondaryButtonStyle } from '@/components/Form';
import { BidderActions } from './BidderActions';
import { ResaleCertReview } from './ResaleCertReview';
import { invoiceStatusLabel } from '../../invoices/page';
import { formatUsPhone } from '@/lib/format-phone';
import { bidderZipFieldFrom } from '@/lib/bidder-location';
import { classifyBidderSegment, SEGMENT_LABELS } from '@/lib/bidder-insights';

// Outstanding = anything still owed (pending / grace / failed).
const OWED_STATUSES = [
  'pending',
  'payment_failed_grace',
  'payment_failed_relisted',
  'unpaid_no_show',
];

// Invoice history: newest 50 by default; `?invoices=all` lifts that to a hard
// ceiling so one customer's full history (some have 90+) is reachable.
const INVOICE_PAGE = 50;
const INVOICE_CEILING = 1000;

export default async function BidderDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ invoices?: string }>;
}) {
  const { id } = await params;
  const { invoices: invoicesParam } = await searchParams;
  const showAllInvoices = invoicesParam === 'all';
  const supabase = await getSupabaseServer();

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: me } = await supabase
    .from('operator_users')
    .select('operator_id, role')
    .eq('user_id', user.id)
    .single();
  if (!me) redirect('/onboarding');

  const operatorId = (me as { operator_id: string }).operator_id;
  const role = (me as { role: string }).role;

  // Service-role client for reads that RLS doesn't expose to operator staff.
  // Staff identity is already verified above (operator_users row required).
  const { getSupabaseAdmin } = await import('@/lib/supabase-admin');
  const adminForInfo = getSupabaseAdmin();

  // Bidder profile — read via service role. `bidders` has NO operator-staff
  // SELECT policy (only bidders_self_read: id = auth.uid()), so an RLS query
  // returns zero rows for any customer other than the staffer themselves,
  // which made this page 404 on every bidder click (bug, 2026-07-08). The
  // customer directory works because it goes through the SECURITY DEFINER
  // operator_bidder_directory() RPC; this detail read now matches that
  // "staff may view any customer" intent on the single-operator platform.
  const { data: bidder } = await adminForInfo
    .from('bidders')
    .select('id, bidder_number, email, display_name, phone, created_at, marketing_emails_enabled, push_enabled, email_enabled, sms_enabled, tax_exempt, referral_code, referred_by, card_brand, card_last4, card_type, prepaid_type, default_payment_method_id, resale_cert_status, resale_cert_permit, resale_cert_state, resale_cert_business, resale_cert_submitted_at, unpaid_fees_cents')
    .eq('id', id)
    .single();
  if (!bidder) notFound();
  const resaleStatus = (bidder.resale_cert_status as string | null) ?? null;

  // 0235 customer-info card: referrer name + credit balance.
  // 0434: the bidder's own ZIP, in a SEPARATE query on purpose. Before 0434
  // adds the column this one read errors (42703) and the row is just omitted;
  // putting postal_code in the main select above would 400 the whole page.
  const [referrerQ, creditsQ, zipQ] = await Promise.all([
    bidder.referred_by
      ? adminForInfo.from('bidders').select('id, display_name, email').eq('id', bidder.referred_by as string).maybeSingle()
      : Promise.resolve({ data: null }),
    adminForInfo.from('bidder_credits').select('amount_cents').eq('bidder_id', id),
    adminForInfo.from('bidders').select('postal_code, postal_code_updated_at').eq('id', id).maybeSingle(),
  ]);
  const zipField = bidderZipFieldFrom(zipQ.data, zipQ.error);
  const referrer = (referrerQ.data as { id: string; display_name: string | null; email: string | null } | null) ?? null;
  const creditBalanceCents = ((creditsQ.data as { amount_cents: number }[] | null) ?? []).reduce(
    (sum, r) => sum + r.amount_cents,
    0,
  );

  // 0235: the directory lists EVERY bidder (not just transacted ones), so
  // the old has-invoices 404 gate is gone — on a single-operator platform,
  // staff may view any customer. Fresh signups just show empty tables.

  // Operator warehouse zone for timestamps that have no warehouse relation of
  // their own (signup date, membership period). Invoice/bid rows below use
  // their own per-row warehouseTimezone(). Falls back to Central via the
  // datetime helpers if null.
  const { data: whRow } = await supabase
    .from('warehouses')
    .select('timezone')
    .eq('operator_id', operatorId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  const opTz = (whRow as { timezone: string } | null)?.timezone ?? null;

  // Membership (admin/manager only — mirrors H3 subs-table read gating).
  const membershipPromise =
    role === 'admin' || role === 'manager'
      ? supabase
          .from('bidder_subscriptions')
          .select('status, current_period_end, operator_pro_plans(name)')
          .eq('operator_id', operatorId)
          .eq('bidder_id', id)
          .maybeSingle()
      : Promise.resolve({ data: null });

  const [
    { data: invoices, count: invoiceCount, error: invoicesError },
    { data: owedInvoices, error: owedError },
    { data: bids, error: bidsError },
    { data: relation },
    { data: membership },
    { data: chargeAttempts },
    { data: paidInvoices, error: paidInvoicesError },
    { data: invoiceLots, error: invoiceLotsError },
  ] = await Promise.all([
    // Invoices via SERVICE ROLE, scoped explicitly to this operator + bidder,
    // like the profile and bid reads on this page (2026-10-14: the page showed
    // "No invoices" for a bidder with a paid invoice). Errors are surfaced
    // below instead of reading as an empty list.
    adminForInfo
      .from('invoices')
      .select('id, status, total_cents, application_fee_cents, paid_at, created_at, auction_id, auctions(title, warehouses(timezone))', { count: 'exact' })
      .eq('operator_id', operatorId)
      .eq('bidder_id', id)
      .order('created_at', { ascending: false })
      .limit(showAllInvoices ? INVOICE_CEILING : INVOICE_PAGE),
    // Outstanding total from its own query so an older unpaid invoice beyond
    // the loaded page still counts toward the badge.
    adminForInfo
      .from('invoices')
      .select('total_cents')
      .eq('operator_id', operatorId)
      .eq('bidder_id', id)
      .in('status', OWED_STATUSES),
    // Bid history via SERVICE ROLE, scoped to this operator's lots. The RLS
    // `bids_staff_read` policy (a correlated EXISTS on lots.operator_id =
    // current_operator_id()) returns zero rows for staff here — the same RLS
    // gap that forced the bidder profile read above onto the admin client. The
    // symptom (2026-07-14): the directory shows "22 bids · last bid Jul 13"
    // (via the SECURITY DEFINER directory RPC) while this page rendered
    // "No bids recorded." Read via admin + an explicit lots!lot_id!inner +
    // operator_id filter. The `!lot_id` hint is required: lots.current_bid_id
    // also references bids, so a bare `lots` embed is ambiguous (PGRST201) and
    // the query errored — the page showed "No bids recorded" for every bidder
    // (found 2026-10-14). Kept in packages/db/test/postgrest_embed_smoke.mjs.
    // The operator_id filter keeps another operator's bids out.
    adminForInfo
      .from('bids')
      .select('id, amount_cents, max_amount_cents, is_auto, placed_at, lot_id, lots!lot_id!inner(title, lot_code, sticker_code, display_code, auction_id, operator_id, warehouses(timezone))')
      .eq('bidder_id', id)
      .eq('lots.operator_id', operatorId)
      .order('placed_at', { ascending: false })
      .limit(100),
    supabase
      .from('operator_bidder_relations')
      .select('suspended_at, suspended_reason, internal_notes')
      .eq('operator_id', operatorId)
      .eq('bidder_id', id)
      .maybeSingle(),
    membershipPromise,
    // 0332: the append-only charge log. Only the failures are shown — a wall of
    // successful charges tells staff nothing, whereas a repeating decline code
    // is exactly what they need when a customer says "my card won't work".
    supabase
      .from('charge_attempts')
      .select('attempted_at, outcome, amount_cents, square_code, square_detail, source')
      .eq('operator_id', operatorId)
      .eq('bidder_id', id)
      .in('outcome', ['declined', 'error'])
      .order('attempted_at', { ascending: false })
      .limit(15),
    // Lifetime "total paid" — its own query (not derived from the paginated
    // `invoices` page above) so the figure is correct regardless of the
    // 50/1000-row invoice limit. Gross total_cents, same number each invoice
    // row already shows — not net-of-refund (that figure lives on the
    // ZIP/segments reports, mig 0449, which do the proportional-refund math).
    adminForInfo
      .from('invoices')
      .select('total_cents')
      .eq('operator_id', operatorId)
      .eq('bidder_id', id)
      .not('paid_at', 'is', null),
    // Lifetime lot-level stats (won / refunded / forfeited / last pickup),
    // lifetime by nature so it also isn't derived from the paginated
    // `invoices` page. `invoices!inner` + explicit operator_id/bidder_id
    // filters on the joined table, same pattern as the bids query above
    // (invoice_lots itself has neither column).
    adminForInfo
      .from('invoice_lots')
      .select('picked_up_at, refunded_at, forfeited_at, winning_bid_cents, invoices!inner(bidder_id, operator_id)')
      .eq('invoices.bidder_id', id)
      .eq('invoices.operator_id', operatorId),
  ]);

  for (const [what, err] of [
    ['invoices', invoicesError],
    ['owed invoices', owedError],
    ['bids', bidsError],
    ['paid invoices', paidInvoicesError],
    ['invoice lots', invoiceLotsError],
  ] as const) {
    if (err) console.error(`[bidders/${id}] ${what} read failed:`, err.code, err.message);
  }

  const declines = (chargeAttempts ?? []) as Array<{
    attempted_at: string;
    outcome: string;
    amount_cents: number | null;
    square_code: string | null;
    square_detail: string | null;
    source: string;
  }>;

  // Lifetime summary (profile tab, owner ask: "a clear summary for staff").
  // Everything here is lifetime — not scoped to the loaded invoice page —
  // computed from its own queries above, not from `invoices`/`bids`, EXCEPT
  // last bid / last win, which reuse those two arrays: both are already
  // ordered newest-first, so index 0 is the most recent regardless of the
  // 100-row / 50-row page limit.
  const lotLines = (invoiceLots ?? []) as Array<{
    picked_up_at: string | null;
    refunded_at: string | null;
    forfeited_at: string | null;
    winning_bid_cents: number;
  }>;
  const lotsWon = lotLines.length;
  const refundedLines = lotLines.filter((l) => l.refunded_at != null);
  const refundsCount = refundedLines.length;
  const refundsCents = refundedLines.reduce((sum, l) => sum + l.winning_bid_cents, 0);
  const forfeitsCount = lotLines.filter((l) => l.forfeited_at != null).length;
  const lastPickupAt = lotLines.reduce<string | null>(
    (latest, l) => (l.picked_up_at && (!latest || l.picked_up_at > latest) ? l.picked_up_at : latest),
    null,
  );
  const totalPaidCents = ((paidInvoices ?? []) as { total_cents: number }[]).reduce(
    (sum, inv) => sum + inv.total_cents,
    0,
  );
  const invoicesPaidCount = (paidInvoices ?? []).length;
  const lastBidAt = (bids?.[0] as { placed_at?: string } | undefined)?.placed_at ?? null;
  const lastWinAt = (invoices?.[0] as { created_at?: string } | undefined)?.created_at ?? null;
  const openInvoicesCount = (owedInvoices ?? []).length;
  const openInvoicesCents = ((owedInvoices ?? []) as { total_cents: number }[]).reduce(
    (sum, inv) => sum + inv.total_cents,
    0,
  );
  const segment = classifyBidderSegment({ createdAt: bidder.created_at as string, lastBidAt });

  // operator_pro_plans is embedded via the bidder_subscriptions.plan_id FK.
  // database.types.ts predates the 0177 migration, so we type the row locally.
  const membershipRow =
    (membership as unknown as {
      status: string;
      current_period_end: string | null;
      operator_pro_plans: { name: string } | null;
    } | null) ?? null;
  const membershipActive =
    membershipRow?.status === 'active' || membershipRow?.status === 'trialing';

  const isSuspended = !!(relation as { suspended_at?: string | null } | null)?.suspended_at;
  const suspendedReason =
    (relation as { suspended_reason?: string | null } | null)?.suspended_reason ?? null;
  const internalNotes =
    (relation as { internal_notes?: string | null } | null)?.internal_notes ?? null;
  const canManage = role === 'admin' || role === 'manager';

  const th: React.CSSProperties = {
    padding: '0.5rem',
    borderBottom: '1px solid var(--border)',
    textAlign: 'left',
    color: 'var(--fg-muted)',
    fontSize: 13,
  };
  const td: React.CSSProperties = { padding: '0.5rem', borderBottom: '1px solid var(--border)' };

  return (
    <div>
      <PageHeader
        title={bidder.display_name ?? bidder.email ?? 'Bidder'}
        action={
          <Link href="/bidders" style={{ ...secondaryButtonStyle, textDecoration: 'none' }}>
            Back to bidders
          </Link>
        }
      />

      {isSuspended && (
        <div
          style={{
            marginBottom: '1rem',
            padding: '0.75rem 1rem',
            background: 'rgba(255,84,112,0.08)',
            border: '1px solid rgba(255,84,112,0.4)',
            borderRadius: 6,
            fontSize: 13,
          }}
        >
          This bidder is currently suspended from your auctions.
          {suspendedReason && <> Reason: {suspendedReason}</>}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: '2rem' }}>
        <div style={{ display: 'grid', gap: '2rem' }}>
          {/* Profile */}
          <section
            style={{
              padding: '1rem',
              background: 'var(--bg-elev)',
              border: '1px solid var(--border)',
              borderRadius: 6,
            }}
          >
            <h2 style={{ fontSize: '1rem', margin: '0 0 0.75rem' }}>Profile</h2>
            <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.4rem 1rem', margin: 0 }}>
              <dt style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Bidder #</dt>
              <dd style={{ margin: 0, fontVariantNumeric: 'tabular-nums' }}>
                {bidder.bidder_number != null ? `#${bidder.bidder_number}` : '—'}
              </dd>
              <dt style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Email</dt>
              <dd style={{ margin: 0 }}>
                {bidder.email ? (
                  <a href={`mailto:${bidder.email}`} style={{ color: 'var(--accent)' }}>{bidder.email}</a>
                ) : '—'}
              </dd>
              <dt style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Display name</dt>
              <dd style={{ margin: 0 }}>{bidder.display_name ?? '—'}</dd>
              <dt style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Phone</dt>
              <dd style={{ margin: 0 }}>
                {bidder.phone ? (
                  <a href={`tel:${bidder.phone}`} style={{ color: 'var(--accent)' }}>{formatUsPhone(bidder.phone) ?? bidder.phone}</a>
                ) : '—'}
              </dd>
              {/* 0434: staff-only (this page requires an operator_users row).
                  Read-only: only the bidder can change their ZIP. Omitted
                  entirely until the column exists. */}
              {zipField.available && (
                <>
                  <dt style={{ color: 'var(--fg-muted)', fontSize: 13 }}>ZIP (from bidder)</dt>
                  <dd style={{ margin: 0, fontVariantNumeric: 'tabular-nums' }}>
                    {zipField.zip ?? '—'}
                    {zipField.zip && zipField.updatedAt ? (
                      <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--fg-muted)' }}>
                        updated {formatDateInTimeZone(zipField.updatedAt, opTz)}
                      </span>
                    ) : null}
                  </dd>
                </>
              )}
              <dt style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Joined</dt>
              {/* Signup timestamp has no warehouse of its own — render in the
                  operator's warehouse zone (Central fallback) so it doesn't
                  show the UTC SSR-runtime day. */}
              <dd style={{ margin: 0 }}>{formatDateInTimeZone(bidder.created_at as string, opTz)}</dd>
              <dt style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Card on file</dt>
              <dd style={{ margin: 0 }}>
                {bidder.default_payment_method_id ? (
                  <>
                    {`${(bidder.card_brand as string | null) ?? 'Card'} ···· ${(bidder.card_last4 as string | null) ?? '----'}`}
                    {/* 0332: card_type / prepaid_type come off Square payment
                        responses, so they stay null until a charge has actually
                        run. A PREPAID card is worth flagging before a big lot
                        closes — prepaid cards are the ones that decline at
                        auto-charge and leave staff taking payment at the
                        counter. */}
                    {(bidder.prepaid_type as string | null) === 'PREPAID' ? (
                      <span
                        style={{
                          marginLeft: 8,
                          padding: '1px 7px',
                          borderRadius: 999,
                          fontSize: 11,
                          fontWeight: 800,
                          background: 'var(--warn-bg, #7a4a00)',
                          color: 'var(--warn-fg, #ffd79a)',
                        }}
                      >
                        PREPAID
                      </span>
                    ) : null}
                    {bidder.card_type ? (
                      <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--fg-muted)' }}>
                        {String(bidder.card_type).toLowerCase()}
                      </span>
                    ) : null}
                  </>
                ) : (
                  'None — cannot bid'
                )}
              </dd>
              <dt style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Marketing email</dt>
              <dd style={{ margin: 0 }}>{bidder.marketing_emails_enabled ? 'Subscribed' : 'Unsubscribed'}</dd>
              <dt style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Notifications</dt>
              <dd style={{ margin: 0, fontSize: 13 }}>
                Push {bidder.push_enabled ? 'on' : 'off'} · Email {bidder.email_enabled ? 'on' : 'off'} · SMS{' '}
                {bidder.sms_enabled ? 'on' : 'off'}
              </dd>
              <dt style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Segment</dt>
              <dd style={{ margin: 0 }}>{SEGMENT_LABELS[segment]}</dd>
              <dt style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Sales tax</dt>
              <dd style={{ margin: 0 }}>
                {bidder.tax_exempt ? (
                  <span style={{ color: 'var(--accent)', fontWeight: 700 }}>Exempt (resale cert on file)</span>
                ) : 'Charged'}
              </dd>
              <dt style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Referral code</dt>
              <dd style={{ margin: 0, fontFamily: 'monospace' }}>{(bidder.referral_code as string | null) ?? '—'}</dd>
              <dt style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Referred by</dt>
              <dd style={{ margin: 0 }}>
                {referrer ? (
                  <Link href={`/bidders/${referrer.id}`} style={{ color: 'var(--accent)' }}>
                    {referrer.display_name ?? referrer.email ?? 'bidder'}
                  </Link>
                ) : '—'}
              </dd>
              <dt style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Credit balance</dt>
              <dd style={{ margin: 0 }}>
                {creditBalanceCents > 0 ? (
                  <span style={{ color: 'var(--accent)', fontWeight: 700 }}>{formatCents(creditBalanceCents)}</span>
                ) : '—'}
              </dd>
            </dl>
          </section>

          {/* Lifetime activity — owner ask: "a clear summary for staff".
              Everything here is lifetime (own queries above), not the loaded
              invoice page. Money figures are gross (total_cents), matching
              what each invoice row already shows — net-of-refund figures live
              on the ZIP/segments reports (mig 0449). */}
          <section
            style={{
              padding: '1rem',
              background: 'var(--bg-elev)',
              border: '1px solid var(--border)',
              borderRadius: 6,
            }}
          >
            <h2 style={{ fontSize: '1rem', margin: '0 0 0.75rem' }}>Lifetime activity</h2>
            <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '0.4rem 1rem', margin: 0 }}>
              <dt style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Lots won</dt>
              <dd style={{ margin: 0, fontVariantNumeric: 'tabular-nums' }}>{lotsWon}</dd>
              <dt style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Invoices paid</dt>
              <dd style={{ margin: 0 }}>
                {invoicesPaidCount} · {formatCents(totalPaidCents)} total
              </dd>
              <dt style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Refunds</dt>
              <dd style={{ margin: 0 }}>
                {refundsCount > 0 ? (
                  <>
                    {refundsCount} line{refundsCount === 1 ? '' : 's'} · {formatCents(refundsCents)}
                  </>
                ) : (
                  '—'
                )}
              </dd>
              <dt style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Forfeits / no-shows</dt>
              <dd style={{ margin: 0 }}>{forfeitsCount > 0 ? forfeitsCount : '—'}</dd>
              <dt style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Open invoices</dt>
              <dd style={{ margin: 0 }}>
                {openInvoicesCount > 0 ? (
                  <span style={{ color: 'var(--danger)', fontWeight: 700 }}>
                    {openInvoicesCount} · {formatCents(openInvoicesCents)}
                  </span>
                ) : (
                  '—'
                )}
              </dd>
              <dt style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Last bid</dt>
              <dd style={{ margin: 0 }}>{lastBidAt ? formatDateInTimeZone(lastBidAt, opTz) : '—'}</dd>
              <dt style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Last win</dt>
              <dd style={{ margin: 0 }}>{lastWinAt ? formatDateInTimeZone(lastWinAt, opTz) : '—'}</dd>
              <dt style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Last pickup</dt>
              <dd style={{ margin: 0 }}>{lastPickupAt ? formatDateInTimeZone(lastPickupAt, opTz) : '—'}</dd>
            </dl>
          </section>

          {/* Membership — admin/manager only. Shows the bidder's Pro plan
              at THIS operator (plan name, status, renewal). */}
          {canManage && (
            <section
              style={{
                padding: '1rem',
                background: 'var(--bg-elev)',
                border: '1px solid var(--border)',
                borderRadius: 6,
              }}
            >
              <h2 style={{ fontSize: '1rem', margin: '0 0 0.75rem' }}>Membership</h2>
              {membershipRow ? (
                <dl
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'auto 1fr',
                    gap: '0.4rem 1rem',
                    margin: 0,
                  }}
                >
                  <dt style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Plan</dt>
                  <dd style={{ margin: 0 }}>{membershipRow.operator_pro_plans?.name ?? '—'}</dd>
                  <dt style={{ color: 'var(--fg-muted)', fontSize: 13 }}>Status</dt>
                  <dd style={{ margin: 0 }}>
                    <span style={{ color: membershipActive ? 'var(--success)' : 'var(--fg-muted)' }}>
                      {membershipRow.status}
                    </span>
                  </dd>
                  <dt style={{ color: 'var(--fg-muted)', fontSize: 13 }}>
                    {membershipActive ? 'Renews' : 'Period ends'}
                  </dt>
                  {/* Subscription period end is an operator-org-level billing
                      date (no warehouse) — render in the operator's warehouse
                      zone (Central fallback), not the UTC SSR-runtime zone. */}
                  <dd style={{ margin: 0 }}>
                    {membershipRow.current_period_end
                      ? formatDateInTimeZone(membershipRow.current_period_end, opTz)
                      : '—'}
                  </dd>
                </dl>
              ) : (
                <p style={{ margin: 0, color: 'var(--fg-muted)', fontSize: 13 }}>
                  Not a member of your Pro plan.
                </p>
              )}
            </section>
          )}

          {/* Card declines — 0332. Only rendered when there are any, so a
              healthy customer's page is unchanged. Before this, the ONLY record
              of a decline was invoices.last_auto_charge_error, which the next
              attempt (or an operator settling offline) overwrote: a customer
              could fail ten charges and leave no trace of why. */}
          {declines.length > 0 && (
            <section>
              <h2 style={{ fontSize: '1rem', marginBottom: '0.75rem' }}>
                Card declines
                <span
                  style={{
                    color: 'var(--danger)',
                    fontWeight: 700,
                    marginLeft: 10,
                    fontSize: 13,
                  }}
                >
                  {declines.length} recent
                </span>
              </h2>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: 'var(--fg-muted)', fontSize: 12 }}>
                    <th style={{ padding: '0.4rem 0' }}>When</th>
                    <th style={{ padding: '0.4rem 0' }}>Amount</th>
                    <th style={{ padding: '0.4rem 0' }}>Issuer said</th>
                  </tr>
                </thead>
                <tbody>
                  {declines.map((d) => (
                    <tr key={`${d.attempted_at}-${d.square_code ?? ''}`} style={{ fontSize: 13 }}>
                      <td style={{ padding: '0.4rem 0', whiteSpace: 'nowrap' }}>
                        {formatDateInTimeZone(d.attempted_at, opTz)}
                      </td>
                      <td style={{ padding: '0.4rem 0' }}>
                        {d.amount_cents != null ? formatCents(d.amount_cents) : '—'}
                      </td>
                      <td style={{ padding: '0.4rem 0' }}>
                        <span style={{ fontFamily: 'monospace' }}>{d.square_code ?? '—'}</span>
                        {d.square_detail ? (
                          <div style={{ color: 'var(--fg-muted)', fontSize: 12 }}>
                            {d.square_detail}
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {/* Invoices */}
          <section>
            {(() => {
              // Outstanding surfaced as a heading badge so staff see "who owes
              // what" at a glance on the customer page (owner ask 2026-07-08).
              // Summed over every owed invoice, not just the loaded page.
              const owedCents = ((owedInvoices ?? []) as { total_cents: number }[]).reduce(
                (sum, inv) => sum + inv.total_cents,
                0,
              );
              const shown = invoices?.length ?? 0;
              const total = invoiceCount ?? shown;
              const truncated = total > shown;
              return (
                <h2 style={{ fontSize: '1rem', marginBottom: '0.75rem' }}>
                  Invoices
                  {truncated && (
                    <span style={{ color: 'var(--fg-muted)', fontWeight: 400, marginLeft: 6, fontSize: 13 }}>
                      ({shown} of {total})
                    </span>
                  )}
                  {owedCents > 0 && (
                    <span style={{ color: 'var(--danger)', fontWeight: 700, marginLeft: 10, fontSize: 13 }}>
                      {formatCents(owedCents)} outstanding
                    </span>
                  )}
                  {truncated && !showAllInvoices && (
                    <Link
                      href={`/bidders/${id}?invoices=all`}
                      style={{ color: 'var(--accent)', fontWeight: 400, marginLeft: 10, fontSize: 13 }}
                    >
                      Show all {total}
                    </Link>
                  )}
                  {truncated && showAllInvoices && (
                    <span style={{ color: 'var(--fg-muted)', fontWeight: 400, marginLeft: 10, fontSize: 13 }}>
                      Showing the newest {shown}; older invoices are not listed.
                    </span>
                  )}
                </h2>
              );
            })()}
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={th}>Invoice</th>
                  <th style={th}>Total</th>
                  <th style={th}>Status</th>
                  <th style={th}>Paid</th>
                </tr>
              </thead>
              <tbody>
                {invoices?.map((inv) => {
                  const a = (inv as { auctions?: { title?: string; warehouses?: unknown } }).auctions;
                  const invTz = warehouseTimezone(a?.warehouses);
                  // Each row opens the invoice detail (mark paid / refund /
                  // failure reason) — not the auction. Fee column dropped:
                  // BinGo is single-account Square, application_fee is always 0.
                  return (
                    <tr key={inv.id as string}>
                      <td style={td}>
                        <Link href={`/invoices/${inv.id}`} style={{ fontWeight: 600 }}>
                          View invoice →
                        </Link>
                        <div style={{ fontSize: 12, color: 'var(--fg-muted)' }}>{a?.title ?? '—'}</div>
                      </td>
                      <td style={td}>{formatCents(inv.total_cents as number)}</td>
                      <td style={td}>{invoiceStatusLabel(inv.status as string)}</td>
                      <td style={td}>
                        {inv.paid_at ? formatDateInTimeZone(inv.paid_at as string, invTz) : '—'}
                      </td>
                    </tr>
                  );
                })}
                {(invoicesError || owedError) && (
                  <tr>
                    <td colSpan={4} style={{ padding: '1rem', color: 'var(--danger)' }}>
                      Couldn&apos;t load invoices — refresh, and tell the office if it keeps happening.
                    </td>
                  </tr>
                )}
                {!invoicesError && !invoices?.length && (
                  <tr>
                    <td colSpan={4} style={{ padding: '1rem', color: 'var(--fg-muted)' }}>
                      No invoices.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>

          {/* Bid history */}
          <section>
            <h2 style={{ fontSize: '1rem', marginBottom: '0.75rem' }}>Bid history (last 100)</h2>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={th}>Lot</th>
                  <th style={th}>Amount</th>
                  <th style={th}>Max (proxy)</th>
                  <th style={th}>Auto</th>
                  <th style={th}>Placed</th>
                </tr>
              </thead>
              <tbody>
                {bids?.map((bid) => {
                  const l = (bid as { lots?: { title?: string; lot_code?: string; sticker_code?: string | null; display_code?: string | null; warehouses?: unknown } }).lots;
                  const bidTz = warehouseTimezone(l?.warehouses);
                  return (
                    <tr key={bid.id as string}>
                      <td style={td}>
                        <Link href={`/lots/${bid.lot_id}`}>
                          {(l ? lotDisplayCode({ lot_code: l.lot_code ?? null, sticker_code: l.sticker_code ?? null, display_code: l.display_code ?? null }) : null) ?? ''} {l?.title ?? '—'}
                        </Link>
                      </td>
                      <td style={td}>{formatCents(bid.amount_cents as number)}</td>
                      <td style={td}>
                        {/* Proxy ceiling — what the bidder is actually willing
                            to pay. Differs from Amount when the proxy engine
                            hasn't needed the full max yet. */}
                        {formatCents((bid.max_amount_cents as number) ?? (bid.amount_cents as number))}
                      </td>
                      <td style={td}>{bid.is_auto ? 'Auto' : ''}</td>
                      <td style={td}>
                        {formatInTimeZone(bid.placed_at as string, bidTz)}
                      </td>
                    </tr>
                  );
                })}
                {bidsError && (
                  <tr>
                    <td colSpan={5} style={{ padding: '1rem', color: 'var(--danger)' }}>
                      Couldn&apos;t load bid history — refresh, and tell the office if it keeps happening.
                    </td>
                  </tr>
                )}
                {!bidsError && !bids?.length && (
                  <tr>
                    <td colSpan={5} style={{ padding: '1rem', color: 'var(--fg-muted)' }}>
                      No bids recorded.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </section>
        </div>

        {/* Sidebar: actions */}
        <div>
          {resaleStatus && (
            <ResaleCertReview
              bidderId={id}
              status={resaleStatus}
              permit={(bidder.resale_cert_permit as string | null) ?? null}
              state={(bidder.resale_cert_state as string | null) ?? null}
              business={(bidder.resale_cert_business as string | null) ?? null}
              submittedAt={(bidder.resale_cert_submitted_at as string | null) ?? null}
              canManage={canManage}
            />
          )}
          <BidderActions
          bidderId={id}
          isSuspended={isSuspended}
          suspendedReason={suspendedReason}
          currentNotes={internalNotes}
          canManage={canManage}
          unpaidFeesCents={(bidder.unpaid_fees_cents as number | null) ?? 0}
          isAdmin={role === 'admin'}
          />
        </div>
      </div>
    </div>
  );
}
