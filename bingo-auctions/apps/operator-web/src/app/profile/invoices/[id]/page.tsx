// /profile/invoices/[id] — bidder-facing receipt (L0 launch blocker #5).
// S11 (2026-06-01): added payment_failed_grace recovery block (grace banner,
// "Update card" link, "Retry payment" button via /api/invoices/[id]/retry-auto-charge).
//
// Separate from /(operator)/invoices/[id] for two reasons:
//   1. The operator route has refund / dispute admin actions that must
//      NOT be visible to bidders (the operator-only RefundButton lives
//      under (operator)/invoices/[id]/RefundButton.tsx).
//   2. RLS: bidders read via invoices_self_read (bidder_id = auth.uid())
//      while operators read via invoices_staff_all (operator_id =
//      current_operator_id()). Same table, two policies — same query
//      different result set. Belt-and-braces: we also filter by
//      bidder_id = user.id in the query.
//
// Line item reconstruction:
//   The schema's invoice_lots row stores winning_bid_cents but per the
//   spec we reconstruct from lots WHERE auction_id=$1 AND
//   winner_bidder_id=user.id AND status='won' (lots.current_bid_cents is
//   the denormalized canonical sale price). This is the bidder's view of
//   "what did I win in this auction" and survives any operator-side
//   tweak to invoice_lots.

import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSupabaseServer } from '@/lib/supabase-server';
import { formatInTimeZone } from '@/lib/datetime';
import { formatCents } from '@auction-platform/shared/money';
import { lotDisplayCode } from '@auction-platform/shared';
import { PrintButton } from './PrintButton';
import { WinShareCard } from '../WinShareCard';
import { RetryGraceButton } from './RetryGraceButton';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Safely format a timestamp with optional IANA timezone. Wraps
// Intl.DateTimeFormat construction because:
//   - new Intl.DateTimeFormat({timeZone: ''}) throws RangeError
//   - new Intl.DateTimeFormat({timeZone: 'garbage'}) throws RangeError
//   - format(invalidDate) throws too
// Any of those used to crash the whole receipt render (Sentry ref
// 883265672, reported 2026-06-01). The `??` fallback at the call site
// only catches null/undefined; warehouses with an empty-string `timezone`
// column slipped through.
function safeFormatDate(
  iso: string | null | undefined,
  timezone: string | null | undefined,
): string {
  if (!iso) return '';
  // Shared runtime-hardened formatter (lib/datetime.ts). Replaces an inline
  // dateStyle/timeStyle formatter whose catch fell back to UTC toLocaleString
  // on the Cloudflare Worker runtime (CLOVRBID-WEB-8 class). Map the '—' empty
  // marker back to '' to preserve this receipt's blank-on-missing behavior.
  const out = formatInTimeZone(iso, timezone);
  return out === '—' ? '' : out;
}

// Format the header date label safely. Invalid `paid_at` / `created_at`
// would otherwise surface as "Invalid Date" in the UI; degrade gracefully
// to an empty string so the surrounding label stays readable.
function safeLocaleString(iso: string | null | undefined): string {
  if (!iso) return '';
  // Central time, explicitly — the bare toLocaleString() this replaces
  // rendered UTC on the Cloudflare runtime, so evening payments showed
  // tomorrow's date (owner report 2026-07-08).
  const out = formatInTimeZone(iso, null);
  return out === '\u2014' ? '' : out;
}

function statusColor(status: string): { bg: string; fg: string } {
  switch (status) {
    case 'paid':
      return { bg: 'var(--success-dim)', fg: 'var(--success)' };
    case 'pending':
      return { bg: 'var(--warning-dim)', fg: 'var(--warning)' };
    case 'refunded':
    case 'partially_refunded':
      return { bg: 'var(--accent-dim)', fg: 'var(--accent)' };
    case 'unpaid_no_show':
    case 'payment_failed_grace':
    case 'payment_failed_relisted':
      return { bg: 'rgba(255, 59, 59, 0.12)', fg: 'var(--danger)' };
    case 'canceled':
    default:
      return { bg: 'var(--bg-elev)', fg: 'var(--fg-muted)' };
  }
}

interface InvoiceDetail {
  id: string;
  status: string;
  fulfillment_method: string | null;
  subtotal_cents: number;
  buyer_premium_cents: number;
  total_cents: number;
  credit_applied_cents?: number | null;
  tax_cents: number;
  application_fee_cents: number;
  paid_at: string | null;
  created_at: string;
  grace_until: string | null;
  last_auto_charge_error: string | null;
  auction_id: string;
  operator_id: string;
  auctions: {
    title: string | null;
    pickup_starts_at: string | null;
    pickup_ends_at: string | null;
    warehouses: {
      name: string | null;
      address_line1: string | null;
      address_line2: string | null;
      city: string | null;
      state: string | null;
      postal_code: string | null;
      timezone: string | null;
    } | null;
  } | null;
  operators: {
    business_name: string | null;
    contact_email: string | null;
  } | null;
  invoice_lots: Array<{
    lot_id: string;
    winning_bid_cents: number | null;
    // 0245 stamps refunds per LINE. Without reading it, a partially refunded
    // invoice rendered every line the same, so the bidder could not tell which
    // items they still own.
    refunded_at: string | null;
    picked_up_at: string | null;
    /** 0301: per-line forfeit stamp. Preferred over the invoice-wide pickup
     *  status so a line can be reasoned about on its own. */
    forfeited_at: string | null;
    lots: {
      lot_code: string | null;
      sticker_code: string | null;
      display_code: string | null;
      title: string | null;
      intake_bin: { code: string | null } | null;
    } | null;
  }> | null;
}

export default async function ProfileInvoiceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect(`/login?next=/profile/invoices/${id}`);
  }

  const { data: bidderRow } = await supabase
    .from('bidders')
    .select('id, referral_code')
    .eq('id', user.id)
    .maybeSingle();
  if (!bidderRow) {
    redirect(`/bidder/onboarding?next=/profile/invoices/${id}`);
  }
  const referralCode = (bidderRow.referral_code as string | null) ?? null;

  const { data: invoiceRaw } = await supabase
    .from('invoices')
    .select(`
      id, status, fulfillment_method, subtotal_cents, buyer_premium_cents, total_cents, tax_cents, credit_applied_cents,
      application_fee_cents, paid_at, created_at, grace_until, last_auto_charge_error,
      auction_id, operator_id,
      auctions(title, pickup_starts_at, pickup_ends_at,
        warehouses(name, address_line1, address_line2, city, state, postal_code, timezone)),
      operators:operators_public(business_name, contact_email),
      invoice_lots(lot_id, winning_bid_cents, refunded_at, picked_up_at, forfeited_at, lots(lot_code, sticker_code, display_code, title, intake_bin_id, intake_bin:bins!lots_intake_bin_id_fkey(code)))
    `)
    .eq('id', id)
    .eq('bidder_id', user.id)
    .maybeSingle();

  const invoice = invoiceRaw as unknown as InvoiceDetail | null;

  if (!invoice) {
    return <ReceiptNotFound />;
  }

  // Pickup status (2026-07-29). A forfeited pickup means the no-show window
  // closed without collection: the bidder lost these items and the goods went
  // back into inventory. Without this the per-line block below renders
  // "On shelf · <bin>" for them -- sending someone to a counter, and to a
  // specific shelf, for an item that is not theirs and may already be relisted
  // to another bidder. Bidders read their own pickup via pickups_self_read
  // (mig 0002); maybeSingle because a ship-only invoice has no pickup row.
  const { data: pickupRow } = await supabase
    .from('pickups')
    .select('status')
    .eq('invoice_id', id)
    .maybeSingle();
  const pickupForfeited = (pickupRow as { status?: string | null } | null)?.status === 'forfeited';

  // Relisting fee for the dunning copy below. operator_policies is
  // bidder/anon-readable (mig 0088 RLS) — the mobile invoice screen reads it
  // the same way. The web receipt previously hard-stopped at "a fee may be
  // added" with no amount; this populates the actual {amount}. Defaults to 0
  // if the operator has no policy row (the copy then drops the fee sentence).
  const { data: policyRow } = await supabase
    .from('operator_policies')
    .select('relist_fee_cents')
    .eq('operator_id', invoice.operator_id)
    .maybeSingle();
  const relistFeeCents = (policyRow as { relist_fee_cents: number } | null)?.relist_fee_cents ?? 0;

  // Line items come from invoice_lots — the canonical, immutable record of
  // what this bidder owes for. winning_bid_cents is captured at invoice
  // generation; the nested lots row gives the human-readable code/title.
  const invoiceLots = invoice.invoice_lots ?? [];

  const pill = statusColor(invoice.status);
  const operatorName = invoice.operators?.business_name ?? '—';
  const operatorEmail = invoice.operators?.contact_email ?? null;
  const auctionTitle = invoice.auctions?.title ?? 'Auction';
  const pickupStart = invoice.auctions?.pickup_starts_at ?? null;
  const pickupEnd = invoice.auctions?.pickup_ends_at ?? null;
  const wh = invoice.auctions?.warehouses ?? null;
  const pickupTz = wh?.timezone ?? null;
  // Only pickup-fulfilled invoices get the warehouse/shelf/QR pickup block —
  // shipped orders have no counter to walk up to.
  const isPickup = invoice.fulfillment_method === 'pickup';
  const dateLabel = invoice.status === 'paid' && invoice.paid_at
    ? `Paid ${safeLocaleString(invoice.paid_at)}`
    : `Created ${safeLocaleString(invoice.created_at)}`;

  return (
    <main style={{ padding: '3rem 1.5rem 5rem', maxWidth: 900, margin: '0 auto' }}>
      <Link
        href="/profile/invoices"
        style={{
          fontSize: 13,
          color: 'var(--fg-muted)',
          textDecoration: 'none',
          display: 'inline-block',
          marginBottom: '2rem',
        }}
      >
        &larr; Back to invoices
      </Link>

      <header style={{ marginBottom: '2.5rem' }}>
        <div
          style={{
            fontSize: 11,
            color: 'var(--fg-dim)',
            textTransform: 'uppercase',
            letterSpacing: 2,
            marginBottom: 4,
          }}
        >
          Receipt
        </div>
        <h1
          style={{
            fontSize: 'clamp(1.75rem, 4vw, 2.5rem)',
            fontWeight: 900,
            letterSpacing: -1,
            margin: 0,
          }}
        >
          {auctionTitle}
        </h1>
        <div style={{ fontSize: 14, color: 'var(--fg-muted)', marginTop: 6 }}>
          {operatorName}
        </div>
      </header>

      {/* Meta row */}
      <section
        style={{
          marginBottom: '2rem',
          padding: '1rem 1.25rem',
          background: 'var(--bg-elev-2)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: '1rem',
          flexWrap: 'wrap',
        }}
      >
        <div>
          <div
            style={{
              fontSize: 10,
              color: 'var(--fg-dim)',
              textTransform: 'uppercase',
              letterSpacing: 1.5,
            }}
          >
            Invoice
          </div>
          <div style={{ fontSize: 14, fontWeight: 700, marginTop: 2, fontFamily: 'monospace' }}>
            #{invoice.id.slice(-8).toUpperCase()}
          </div>
        </div>
        <div>
          <div
            style={{
              fontSize: 10,
              color: 'var(--fg-dim)',
              textTransform: 'uppercase',
              letterSpacing: 1.5,
            }}
          >
            Date
          </div>
          <div style={{ fontSize: 14, marginTop: 2 }}>{dateLabel}</div>
        </div>
        <div>
          <div
            style={{
              fontSize: 10,
              color: 'var(--fg-dim)',
              textTransform: 'uppercase',
              letterSpacing: 1.5,
            }}
          >
            Status
          </div>
          <div style={{ marginTop: 2 }}>
            <span
              style={{
                background: pill.bg,
                color: pill.fg,
                padding: '3px 10px',
                borderRadius: 4,
                fontSize: 12,
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: 0.3,
              }}
            >
              {invoice.status}
            </span>
          </div>
        </div>
      </section>

      {/* Line items */}
      <section
        style={{
          marginBottom: '2rem',
          background: 'var(--bg-elev-2)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          overflow: 'hidden',
        }}
      >
        <h2
          style={{
            fontSize: '0.9rem',
            fontWeight: 800,
            textTransform: 'uppercase',
            letterSpacing: 1.5,
            color: 'var(--fg-dim)',
            margin: 0,
            padding: '1rem 1.25rem 0.75rem',
          }}
        >
          Items
        </h2>
        {invoiceLots.length === 0 ? (
          <div style={{ padding: '1rem 1.25rem', color: 'var(--fg-muted)', fontSize: 14 }}>
            No line items found for this receipt.
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={thStyle}>Lot</th>
                <th style={thStyle}>Item</th>
                <th style={{ ...thStyle, textAlign: 'right' }}>Price</th>
              </tr>
            </thead>
            <tbody>
              {invoiceLots.map((il) => (
                <tr key={il.lot_id}>
                  <td style={{ ...tdStyle, fontFamily: 'monospace', fontSize: 13 }}>
                    {lotDisplayCode({ lot_code: il.lots?.lot_code ?? null, sticker_code: il.lots?.sticker_code ?? null, display_code: il.lots?.display_code ?? null }) ?? '—'}
                  </td>
                  <td style={tdStyle}>{il.lots?.title ?? '—'}</td>
                  <td style={{ ...tdStyle, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                    {formatCents(il.winning_bid_cents ?? 0)}
                  </td>
                </tr>
              ))}
              <tr>
                <td colSpan={2} style={{ ...tdStyle, textAlign: 'right', color: 'var(--fg-muted)' }}>
                  Subtotal
                </td>
                <td
                  style={{
                    ...tdStyle,
                    textAlign: 'right',
                    color: 'var(--fg-muted)',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {formatCents(invoice.subtotal_cents ?? 0)}
                </td>
              </tr>
              <tr>
                <td colSpan={2} style={{ ...tdStyle, textAlign: 'right', color: 'var(--fg-muted)' }}>
                  Buyer&apos;s premium
                </td>
                <td
                  style={{
                    ...tdStyle,
                    textAlign: 'right',
                    color: 'var(--fg-muted)',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {formatCents(invoice.buyer_premium_cents ?? 0)}
                </td>
              </tr>
              {(invoice.tax_cents ?? 0) > 0 && (
                <tr>
                  <td colSpan={2} style={{ ...tdStyle, textAlign: 'right', color: 'var(--fg-muted)' }}>
                    Tax
                  </td>
                  <td
                    style={{
                      ...tdStyle,
                      textAlign: 'right',
                      color: 'var(--fg-muted)',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {formatCents(invoice.tax_cents ?? 0)}
                  </td>
                </tr>
              )}
              <tr>
                <td
                  colSpan={2}
                  style={{
                    ...tdStyle,
                    textAlign: 'right',
                    fontWeight: 800,
                    borderTop: '2px solid var(--border)',
                  }}
                >
                  Total
                </td>
                <td
                  style={{
                    ...tdStyle,
                    textAlign: 'right',
                    fontWeight: 800,
                    fontVariantNumeric: 'tabular-nums',
                    borderTop: '2px solid var(--border)',
                  }}
                >
                  {formatCents(invoice.total_cents)}
                </td>
              </tr>
              {(invoice.credit_applied_cents ?? 0) > 0 && (
                <>
                  <tr>
                    <td colSpan={2} style={{ ...tdStyle, textAlign: 'right', color: 'var(--accent)' }}>
                      Referral credit applied
                    </td>
                    <td
                      style={{
                        ...tdStyle,
                        textAlign: 'right',
                        color: 'var(--accent)',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      −{formatCents(invoice.credit_applied_cents ?? 0)}
                    </td>
                  </tr>
                  <tr>
                    <td colSpan={2} style={{ ...tdStyle, textAlign: 'right', fontWeight: 800 }}>
                      Charged to card
                    </td>
                    <td
                      style={{
                        ...tdStyle,
                        textAlign: 'right',
                        fontWeight: 800,
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    >
                      {formatCents(invoice.total_cents - (invoice.credit_applied_cents ?? 0))}
                    </td>
                  </tr>
                </>
              )}
            </tbody>
          </table>
        )}
      </section>

      {/* Post-win share prompt — paid receipts only. Winners bragging is the
          best local ad there is; the share text carries their referral code
          so it feeds Give $5/get $5. */}
      {invoice.status === 'paid' && referralCode && (
        <WinShareCard code={referralCode} totalCents={invoice.total_cents} />
      )}

      {/* Pickup info — pickup-fulfilled invoices only. Mirrors the dedicated
          /profile/pickup/[id] surface so the bidder can collect their items
          straight off the receipt: warehouse address, window (warehouse tz),
          per-lot shelf/bin location, support contact, and a quick link to the
          full pickup screen with the check-in QR. */}
      {isPickup && (pickupStart || pickupEnd || operatorEmail || wh?.name || invoiceLots.length > 0) && (
        <section
          style={{
            marginBottom: '2rem',
            padding: '1.25rem 1.5rem',
            background: 'var(--bg-elev-2)',
            border: '1px solid var(--border)',
            borderRadius: 12,
          }}
        >
          <h2
            style={{
              fontSize: '0.9rem',
              fontWeight: 800,
              textTransform: 'uppercase',
              letterSpacing: 1.5,
              color: 'var(--fg-dim)',
              margin: '0 0 0.75rem',
            }}
          >
            Pickup
          </h2>
          <div style={{ fontSize: 14, color: 'var(--fg)', lineHeight: 1.6, marginBottom: 8 }}>
            {wh?.name && <div className="font-semibold">{wh.name}</div>}
            {wh?.address_line1 && (
              <div>{wh.address_line1}{wh.address_line2 ? `, ${wh.address_line2}` : ''}</div>
            )}
            {(wh?.city || wh?.state) && (
              <div>{wh.city}{wh.city && wh.state ? ', ' : ''}{wh.state} {wh.postal_code ?? ''}</div>
            )}
          </div>
          {pickupStart && pickupEnd && (
            <div style={{ fontSize: 14, color: 'var(--fg)', lineHeight: 1.6 }}>
              <strong>Window:</strong>{' '}
              {safeFormatDate(pickupStart, pickupTz)} &ndash;{' '}
              {safeFormatDate(pickupEnd, pickupTz)}
            </div>
          )}
          {/* Per-lot shelf locations — lots.intake_bin_id -> bins.code, set at
              put-away. 'Location pending' until the item is shelved. */}
          {invoiceLots.length > 0 && (
            <div style={{ marginTop: 12, display: 'grid', gap: '0.4rem' }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  textTransform: 'uppercase',
                  letterSpacing: 1,
                  color: 'var(--fg-dim)',
                }}
              >
                Where your items are
              </div>
              {invoiceLots.map((il) => (
                <div
                  key={il.lot_id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: '1rem',
                    flexWrap: 'wrap',
                    fontSize: 14,
                    lineHeight: 1.5,
                    color: 'var(--fg)',
                  }}
                >
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontFamily: 'monospace', fontSize: 13 }}>
                      {lotDisplayCode({ lot_code: il.lots?.lot_code ?? null, sticker_code: il.lots?.sticker_code ?? null, display_code: il.lots?.display_code ?? null }) ?? '—'}
                    </span>
                    {il.lots?.title ? ` · ${il.lots.title}` : ''}
                  </span>
                  {/* A refunded LINE is no longer collectible, but the other
                      lines on the same invoice still are — show the shelf only
                      for what the bidder still owns, and say so explicitly for
                      the rest rather than letting the whole invoice read as
                      refunded. */}
                  <span
                    style={{
                      color: il.refunded_at
                        ? 'var(--danger)'
                        : il.forfeited_at || pickupForfeited
                          ? 'var(--warning, #f0a83c)'
                          : il.lots?.intake_bin?.code
                            ? 'var(--fg)'
                            : 'var(--fg-muted)',
                      fontWeight: 600,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {il.refunded_at
                      ? 'Refunded'
                      : il.picked_up_at
                        ? 'Collected'
                        : il.forfeited_at || pickupForfeited
                          ? 'Not collected in time'
                          : il.lots?.intake_bin?.code
                            ? `On shelf · ${il.lots.intake_bin.code}`
                            : 'Location pending'}
                  </span>
                </div>
              ))}
            </div>
          )}
          {operatorEmail && (
            <div style={{ fontSize: 14, color: 'var(--fg-muted)', marginTop: 12 }}>
              Questions? Contact{' '}
              <a
                href={`mailto:${operatorEmail}`}
                style={{ color: 'var(--accent)', textDecoration: 'none' }}
              >
                {operatorEmail}
              </a>
            </div>
          )}
          <Link
            href={`/profile/pickup/${invoice.id}`}
            className="btn-primary"
            style={{
              display: 'inline-block',
              marginTop: '1rem',
              padding: '0.6rem 1.25rem',
              fontSize: 14,
              textDecoration: 'none',
            }}
          >
            Pickup details + check-in QR &rarr;
          </Link>
        </section>
      )}

      {/* Payment recovery — only shown when the card was declined and we're
          still inside the grace window. Mirrors the mobile grace banner in
          apps/bidder-app/app/invoice/[id].tsx lines ~783–846. */}
      {invoice.status === 'payment_failed_grace' && (
        <section
          style={{
            marginBottom: '2rem',
            padding: '1.25rem 1.5rem',
            background: 'rgba(255, 59, 59, 0.10)',
            border: '1px solid rgba(255, 59, 59, 0.6)',
            borderRadius: 12,
          }}
        >
          <h2
            style={{
              fontSize: '0.9rem',
              fontWeight: 800,
              textTransform: 'uppercase',
              letterSpacing: 1.5,
              color: 'var(--danger)',
              margin: '0 0 0.6rem',
            }}
          >
            Payment failed
          </h2>
          <p style={{ fontSize: 14, color: 'var(--fg)', lineHeight: 1.6, margin: '0 0 0.75rem' }}>
            {invoice.grace_until
              ? <>
                  Update your payment method by{' '}
                  <strong>{safeFormatDate(invoice.grace_until, pickupTz)}</strong>{' '}
                  to keep your items and to keep bidding.{' '}
                  {relistFeeCents > 0
                    ? <>After that, your lots are relisted — and if you&rsquo;d like to bid again you&rsquo;ll pay a <strong>{formatCents(relistFeeCents)}</strong> relisting fee.</>
                    : <>After that, your lots are relisted.</>}
                </>
              : 'Update your payment method to keep your items and to keep bidding.'}
          </p>
          {invoice.last_auto_charge_error && (
            <p style={{ fontSize: 12, color: 'var(--fg-muted)', margin: '0 0 1rem', fontFamily: 'monospace' }}>
              Last error: {invoice.last_auto_charge_error}
            </p>
          )}
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            <Link
              href={`/bidder/onboarding/payment-method?next=/profile/invoices/${invoice.id}`}
              className="btn-primary"
              style={{ padding: '0.75rem 1.25rem', fontSize: '0.9rem' }}
            >
              Update card
            </Link>
            <RetryGraceButton invoiceId={invoice.id} />
          </div>
          <p style={{ fontSize: 12, color: 'var(--fg-muted)', margin: '0.75rem 0 0', lineHeight: 1.5 }}>
            After updating your card, tap &ldquo;Retry payment&rdquo; to charge it now.
            The auto-charge also runs automatically within an hour.
          </p>
        </section>
      )}

      {/* Actions */}
      <div
        style={{
          display: 'flex',
          gap: '0.75rem',
          flexWrap: 'wrap',
          justifyContent: 'flex-end',
        }}
      >
        <Link href="/profile/invoices" className="btn-secondary" style={{ padding: '0.6rem 1.25rem' }}>
          Back to invoices
        </Link>
        <PrintButton />
      </div>
    </main>
  );
}

// Friendly 404 — branded, not Next.js's notFound() flavor (which renders
// the operator-side 404). We respond 200 here on purpose; the caller is
// already authenticated and we'd rather show a help message than a hard
// not-found that suggests the page is broken.
function ReceiptNotFound() {
  return (
    <main style={{ padding: '4rem 1.5rem 5rem', maxWidth: 560, margin: '0 auto', textAlign: 'center' }}>
      <div
        style={{
          fontSize: 11,
          color: 'var(--fg-dim)',
          textTransform: 'uppercase',
          letterSpacing: 2,
          marginBottom: 6,
        }}
      >
        Account
      </div>
      <h1 style={{ fontSize: '1.75rem', fontWeight: 900, margin: '0 0 0.75rem' }}>
        Receipt not found
      </h1>
      <p
        style={{
          color: 'var(--fg-muted)',
          fontSize: 15,
          lineHeight: 1.6,
          marginBottom: '2rem',
        }}
      >
        We couldn&apos;t find this receipt on your account. If you think this
        is a mistake, head back to your invoices list or reach out to support.
      </p>
      <Link href="/profile/invoices" className="btn-primary" style={{ padding: '0.75rem 1.5rem' }}>
        Back to invoices
      </Link>
    </main>
  );
}

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '0.6rem 1.25rem',
  fontSize: 11,
  fontWeight: 800,
  color: 'var(--fg-dim)',
  textTransform: 'uppercase',
  letterSpacing: 1.5,
  borderBottom: '1px solid var(--border)',
};

const tdStyle: React.CSSProperties = {
  padding: '0.75rem 1.25rem',
  fontSize: 14,
  borderBottom: '1px solid var(--border)',
};
