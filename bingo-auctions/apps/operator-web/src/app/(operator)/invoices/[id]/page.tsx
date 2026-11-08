// S11 (2026-06-01): added PaymentRecoveryPanel — read-only dunning visibility
// for operators. Shows auto_charge_jobs + payment_followups for this invoice.
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { computeLotFullRefundableCents } from '@/lib/refund-math';
import { formatCents } from '@auction-platform/shared/money';
import { lotDisplayCode } from '@auction-platform/shared';
import { formatInTimeZone } from '@/lib/datetime';
import { PageHeader } from '@/components/Form';
import { RefundButton } from './RefundButton';
import { MarkPaidButton } from './MarkPaidButton';
import { ManualPickupOverride, type OverrideLot } from './ManualPickupOverride';
import { pickupOverrideOffer } from '@/lib/pickup-override-offer';
import { UndoForfeitPanel, type ForfeitedLot } from './UndoForfeitPanel';
import { UndoPickupPanel, type PickedUpLot } from './UndoPickupPanel';
import { RefundOverridePanel, type OverrideRefundLot } from './RefundOverridePanel';
import { allowedOverrideMethods, canOfferRefundOverride } from '@/lib/refund-override';
import { canUndoForfeit } from '@/lib/undo-forfeit';
import { canUndoPickup } from '@/lib/undo-pickup';
import { invoiceStatusLabel } from '../page';
import { remainingRefundableCents, type RefundLineState } from '@/lib/refund-copy';
import { auctionHref, lotHref, lotAsListedHref, pickupSessionHref, pickLatestOpenSession } from '@/lib/console-links';

// Types for the dunning panel data (B2).
type AutoChargeJobRow = {
  invoice_id: string;
  attempt_count: number;
  next_attempt_at: string;
  last_error: string | null;
  created_at: string;
};

type PaymentFollowupRow = {
  invoice_id: string;
  attempt_count: number;
  next_attempt_at: string;
  last_attempt_at: string;
  final_status: string | null;
  created_at: string;
};

export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await getSupabaseServer();

  const { data: invoice } = await supabase
    .from('invoices')
    .select(
      'id, status, subtotal_cents, buyer_premium_cents, tax_cents, total_cents, application_fee_cents, paid_at, refunded_at, refunded_cash_cents, refunded_credit_cents, credit_applied_cents, created_at, bidder_id, auction_id, stripe_charge_id, square_payment_id, auctions(title)',
    )
    .eq('id', id)
    .single();
  if (!invoice) notFound();

  const { data: lines } = await supabase
    .from('invoice_lots')
    // picked_up_at / refunded_at (migs 0217/0245) drive the per-lot pickup
    // status column + the manager override's "still owed" list.
    //
    // forfeited_at (0166) and the lot's own status joined 2026-09-11. The
    // status column was a three-way fallthrough over picked_up_at and
    // refunded_at alone, so ANY line without one of those two stamps printed
    // "Owed" — including lines already stamped forfeited, and lines whose lot
    // had been reclaimed and resold to somebody else.
    //
    // Owner, looking at a payment_failed_relisted invoice: "Why does it show
    // payment failed but we owe?" Because nothing in that badge could see the
    // payment, the forfeit, or the relist. Measured across every invoice:
    // 1,403 lines rendered "Owed", of which 547 were already forfeited and 476
    // sat on a lot that had been relisted onto a new lot and sold again. Most
    // of it on PAID invoices — so this was misreading the ordinary forfeit
    // flow, not just failed payments.
    .select(
      'lot_id, winning_bid_cents, picked_up_at, refunded_at, forfeited_at, lots(title, lot_code, sticker_code, display_code, status)',
    )
    .eq('invoice_id', id);

  // Has each lot been reclaimed and put back out as a NEW lot? A relist mints
  // a child row rather than mutating this one, so the line can only tell by
  // looking for the child. Without this, an item already sold to a second
  // customer still reads as owed to the first.
  const lineLotIds = (lines ?? []).map((l) => l.lot_id as string);
  const { data: relistChildren } = lineLotIds.length
    ? await supabase
        .from('lots')
        .select('relisted_from_lot_id, status')
        .in('relisted_from_lot_id', lineLotIds)
        .is('deleted_at', null)
    : { data: null };
  // Any child at all, canceled included: the #524 override still treats a
  // canceled child as "a person decided something about that box".
  const anyRelistChildLotIds = new Set(
    (relistChildren ?? []).map((c) => c.relisted_from_lot_id as string),
  );
  // For the line's own state, a canceled child no longer holds the box. After
  // an Undo forfeit (mig 0444) staff pull the relist lot (Cancel lot) and the
  // parent goes back to 'won'; counting the canceled child here would keep the
  // line reading "Relisted" and the refund greyed out.
  const resoldLotIds = new Set(
    (relistChildren ?? [])
      .filter((c) => c.status !== 'canceled')
      .map((c) => c.relisted_from_lot_id as string),
  );

  // Lines the counter reported missing on this invoice's pickup (mig 0393).
  // The refund is owed even when the no-show sweep stamped the line forfeited
  // (it did until 0393): a missing item was never the customer's to forfeit.
  // The refund-items route makes the same call server-side.
  const { data: invoicePickups } = await supabase
    .from('pickups')
    .select('id')
    .eq('invoice_id', id);
  const invoicePickupIds = (invoicePickups ?? []).map((p) => p.id as string);
  const { data: missingOutcomes } = invoicePickupIds.length
    ? await supabase
        .from('pickup_lot_outcomes')
        .select('lot_id')
        .in('pickup_id', invoicePickupIds)
        .eq('outcome', 'missing')
    : { data: null };
  const missingLotIds = new Set((missingOutcomes ?? []).map((o) => o.lot_id as string));

  // Lines whose forfeit was undone FOR A REFUND (mig 0444). When the item's
  // relist is still running the lot stays 'relisted', so without this the line
  // would read "Relisted" and the refund form would grey it out. The audit row
  // is the record of that decision; service-role read, scoped to this invoice.
  const { data: undoRows } = await getSupabaseAdmin()
    .from('operator_audit_log')
    .select('after_state')
    .eq('target_id', id)
    .eq('action_type', 'invoice_line.forfeit_undone');
  const refundUndoneLotIds = new Set(
    ((undoRows ?? []) as { after_state: { lot_id?: string; purpose?: string } | null }[])
      .filter((r) => r.after_state?.purpose === 'refund' && r.after_state.lot_id)
      .map((r) => r.after_state!.lot_id as string),
  );

  const { data: pickupSessionRows } = await supabase
    .from('pickup_sessions')
    .select('token, status, created_at')
    .eq('bidder_id', invoice.bidder_id as string)
    .order('created_at', { ascending: false })
    .limit(5);
  const pickupSession = pickLatestOpenSession(pickupSessionRows ?? []);

  // Captured before the closure: `invoice` is narrowed by the notFound() guard
  // above, but that narrowing does not reach inside a function declaration.
  const invoicePaidAt = (invoice.paid_at as string | null) ?? null;

  // One place decides what a line's state is, so the badge and the manager
  // override below cannot disagree about what is still owed.
  const RELISTED_LOT_STATUSES = new Set(['relisted', 'unsold', 'in_inventory']);
  function lineState(l: {
    picked_up_at?: unknown;
    refunded_at?: unknown;
    forfeited_at?: unknown;
    lot_id?: unknown;
    lots?: unknown;
  }): { label: string; tone: 'muted' | 'success' | 'warning'; owed: boolean; kind: RefundLineState; when: string | null } {
    const lot = Array.isArray(l.lots) ? l.lots[0] : l.lots;
    const lotStatus = (lot as { status?: string } | null)?.status ?? null;
    if (l.refunded_at) {
      const when = formatInTimeZone(l.refunded_at as string, null);
      return { label: `Refunded ${when}`, tone: 'muted', owed: false, kind: 'refunded', when };
    }
    if (l.picked_up_at) {
      const when = formatInTimeZone(l.picked_up_at as string, null);
      return { label: `Picked up ${when}`, tone: 'success', owed: false, kind: 'picked_up', when };
    }
    // Reported missing at the counter: a refund is owed, forfeited or not.
    if (missingLotIds.has(l.lot_id as string)) {
      return { label: 'Missing — refund owed', tone: 'warning', owed: true, kind: 'missing', when: null };
    }
    if (l.forfeited_at) {
      const when = formatInTimeZone(l.forfeited_at as string, null);
      return { label: `Forfeited ${when}`, tone: 'muted', owed: false, kind: 'forfeited', when };
    }
    // Forfeit undone for a refund (mig 0444): refundable, not owed as goods.
    if (refundUndoneLotIds.has(l.lot_id as string)) {
      return { label: 'Forfeit undone — refund owed', tone: 'warning', owed: false, kind: 'forfeit_undone', when: null };
    }
    // Reclaimed and put back out — it belongs to whoever buys it next, if they
    // have not already.
    if (resoldLotIds.has(l.lot_id as string) || (lotStatus && RELISTED_LOT_STATUSES.has(lotStatus))) {
      return { label: 'Relisted — back in stock', tone: 'muted', owed: false, kind: 'relisted', when: null };
    }
    // Never paid for. Nothing is owed to the customer and nothing is owed to
    // the warehouse either; the sale did not happen.
    if (!invoicePaidAt) {
      return { label: 'Not paid', tone: 'muted', owed: false, kind: 'not_paid', when: null };
    }
    return { label: 'Owed', tone: 'warning', owed: true, kind: 'owed', when: null };
  }

  // The code staff read off the box at the pickup counter. lot_code is the
  // synthetic BIN-###### and is printed on nothing — a customer arriving to
  // collect an item cannot match it to a physical label, which is exactly the
  // failure reported 2026-08-14. display_code (mig 0315) resolves the sticker
  // over the relist lineage; lot_code stays only as a last-resort fallback.
  const codeOf = (lot: { lot_code?: string; sticker_code?: string | null; display_code?: string | null } | null) =>
    lotDisplayCode({
      lot_code: lot?.lot_code ?? null,
      sticker_code: lot?.sticker_code ?? null,
      display_code: lot?.display_code ?? null,
    }) ?? lot?.lot_code ?? null;

  // Per-lot full-refund amounts (hammer + proportional premium + tax) so the
  // refund dialog can auto-fill instead of making managers hand-calculate.
  const refundLots = (lines ?? []).map((l) => {
    const lot = Array.isArray(l.lots) ? l.lots[0] : l.lots;
    const st = lineState(l);
    return {
      lotId: l.lot_id as string,
      // 2026-10-05: a line refunded on Oct 4 was refunded again 40 s later
      // because the form let any line be ticked. The form greys these out.
      state: st.kind,
      stateWhen: st.when,
      title: (lot as { title?: string } | null)?.title ?? 'Lot',
      // Keep the lot code visible through the refund flow — staff reported it
      // disappears once they leave the "Missing Items Awaiting Refund" list,
      // which is confusing with multiple similar items (2026-07-13 feedback).
      lotCode: codeOf(lot as { lot_code?: string; sticker_code?: string | null; display_code?: string | null } | null),
      refundCents: computeLotFullRefundableCents(
        {
          subtotal_cents: invoice.subtotal_cents as number | null,
          buyer_premium_cents: invoice.buyer_premium_cents as number | null,
          tax_cents: invoice.tax_cents as number | null,
        },
        (l.winning_bid_cents as number) ?? 0,
      ),
    };
  });

  // Manual pickup override (2026-07-10): manager/admin-only panel. Resolve
  // the viewer's role here so pickers never see the control (the RPC
  // re-checks the role server-side regardless).
  const {
    data: { user: viewer },
  } = await supabase.auth.getUser();
  const { data: viewerStaffRow } = viewer
    ? await supabase
        .from('operator_users')
        .select('role')
        .eq('user_id', viewer.id)
        .maybeSingle()
    : { data: null };
  const viewerRole = (viewerStaffRow as { role?: string } | null)?.role ?? null;
  const canOverridePickup = viewerRole === 'admin' || viewerRole === 'manager';
  // Undo pickup (mig 0487, #706): admin only — deliberately narrower than the
  // manager override. The RPC re-checks the role server-side regardless.
  const canUndoPickupOnThisInvoice = viewerRole === 'admin';

  // Same source of truth as the badge. Previously this filtered on
  // picked_up_at/refunded_at only, so a manager was offered "mark handed over"
  // for items that had been forfeited or already resold to another customer.
  // 2026-10-19: also a forfeited line whose lot was never resold, so an item
  // that really left the building can still be stamped (lib/pickup-override-offer).
  const owedLots: OverrideLot[] = (lines ?? []).flatMap((l) => {
    const lot = Array.isArray(l.lots) ? l.lots[0] : l.lots;
    const st = lineState(l);
    const offer = pickupOverrideOffer({
      owed: st.owed,
      kind: st.kind,
      invoicePaid: !!invoicePaidAt,
      lotStatus: (lot as { status?: string } | null)?.status ?? null,
      hasRelistChild: anyRelistChildLotIds.has(l.lot_id as string),
    });
    if (!offer) return [];
    return [
      {
        lotId: l.lot_id as string,
        title: (lot as { title?: string } | null)?.title ?? 'Lot',
        lotCode: codeOf(lot as { lot_code?: string; sticker_code?: string | null; display_code?: string | null } | null),
        forfeitedNotResold: offer === 'forfeited_not_resold',
      },
    ];
  });

  // Undo forfeit (mig 0444): forfeited lines on a paid invoice. The database
  // function re-checks everything, including the relist lineage.
  const forfeitedLots: ForfeitedLot[] = (lines ?? []).flatMap((l) => {
    const lot = Array.isArray(l.lots) ? l.lots[0] : l.lots;
    const st = lineState(l);
    if (!canUndoForfeit({ kind: st.kind, invoicePaid: !!invoicePaidAt })) return [];
    return [
      {
        lotId: l.lot_id as string,
        title: (lot as { title?: string } | null)?.title ?? 'Lot',
        lotCode: codeOf(lot as { lot_code?: string; sticker_code?: string | null; display_code?: string | null } | null),
        forfeitedWhen: st.when,
      },
    ];
  });

  // Undo pickup (mig 0487): lines currently stamped picked up. The database
  // function re-checks the role, the line state, the lot status and the relist
  // lineage, so this list only decides what the panel offers.
  const pickedUpLots: PickedUpLot[] = (lines ?? []).flatMap((l) => {
    const lot = Array.isArray(l.lots) ? l.lots[0] : l.lots;
    const st = lineState(l);
    if (
      !canUndoPickup({
        kind: st.kind,
        invoicePaid: !!invoicePaidAt,
        isAdmin: canUndoPickupOnThisInvoice,
      })
    ) {
      return [];
    }
    return [
      {
        lotId: l.lot_id as string,
        title: (lot as { title?: string } | null)?.title ?? 'Lot',
        lotCode: codeOf(lot as { lot_code?: string; sticker_code?: string | null; display_code?: string | null } | null),
        pickedUpWhen: st.when,
        forfeited: !!l.forfeited_at,
      },
    ];
  });

  // Refund override (mig 0474): open lines on a paid invoice with no card
  // payment. The database function re-checks everything, including the caps.
  const overrideLots: OverrideRefundLot[] = refundLots
    .filter((l) => ['owed', 'picked_up', 'missing', 'forfeit_undone'].includes(l.state))
    .map((l) => ({ lotId: l.lotId, title: l.title, lotCode: l.lotCode, paidCents: l.refundCents }));
  const offerRefundOverride =
    canOverridePickup &&
    canOfferRefundOverride({
      status: invoice.status as string,
      square_payment_id: (invoice.square_payment_id as string | null) ?? null,
      stripe_charge_id: (invoice.stripe_charge_id as string | null) ?? null,
    });

  // B2: fetch dunning data for the payment recovery panel.
  // auto_charge_jobs — RLS deny-all (mig 0151), must use service-role admin client.
  const admin = getSupabaseAdmin();
  const { data: autoChargeJob } = await admin
    .from('auto_charge_jobs')
    .select('invoice_id, attempt_count, next_attempt_at, last_error, created_at')
    .eq('invoice_id', id)
    .maybeSingle();
  const chargeJob = autoChargeJob as AutoChargeJobRow | null;

  // payment_followups — operator RLS policy present (mig 0077/0133),
  // getSupabaseServer is sufficient here.
  const { data: followupRaw } = await supabase
    .from('payment_followups')
    .select('invoice_id, attempt_count, next_attempt_at, last_attempt_at, final_status, created_at')
    .eq('invoice_id', id)
    .maybeSingle();
  const followup = followupRaw as PaymentFollowupRow | null;

  const a = (invoice as { auctions?: { title?: string } }).auctions;
  // Customer via service role — the invoices `bidders(...)` embed goes through
  // RLS, and `bidders` has no operator-staff SELECT policy, so it came back
  // null (name showed "—", no contact). Staff identity is verified by the
  // layout; fetch the display fields directly.
  const { data: bRow } = await admin
    .from('bidders')
    .select('email, display_name, phone')
    .eq('id', invoice.bidder_id as string)
    .maybeSingle();
  const b = bRow as { email?: string; display_name?: string | null; phone?: string | null } | null;

  const invoiceTitle = a?.title
    ? `Invoice — ${a.title}`
    : `Invoice ${invoice.id as string}`;

  return (
    <div>
      <PageHeader title={invoiceTitle} />

      <section
        style={{
          padding: '1rem',
          background: 'var(--bg-elev)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          marginBottom: '2rem',
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: '1rem',
        }}
      >
        <Stat label="Status" value={invoiceStatusLabel(invoice.status as string)} />
        <div>
          <div style={{ fontSize: 12, color: 'var(--fg-muted)', textTransform: 'uppercase' }}>Auction</div>
          <div style={{ marginTop: 4, fontSize: 14 }}>
            {invoice.auction_id && a?.title ? (
              <Link href={auctionHref(invoice.auction_id as string)} style={{ color: 'var(--accent)', fontWeight: 600 }}>
                {a.title}
              </Link>
            ) : (
              (a?.title ?? '—')
            )}
          </div>
        </div>
        {/* Bidder → full customer page (all their invoices, contact, card,
            bids). Owner ask 2026-07-08: jump between an invoice and the
            customer behind it. */}
        <div>
          <div style={{ fontSize: 12, color: 'var(--fg-muted)', textTransform: 'uppercase' }}>Customer</div>
          <div style={{ marginTop: 4, fontSize: 14 }}>
            <Link href={`/bidders/${invoice.bidder_id}`} style={{ color: 'var(--accent)', fontWeight: 600 }}>
              {b?.display_name ?? b?.email ?? '—'}
            </Link>
            {(b?.email || b?.phone) && (
              <div style={{ fontSize: 12, color: 'var(--fg-muted)', marginTop: 2 }}>
                {b?.email ?? ''}
                {b?.phone ? ` · ${b.phone}` : ''}
              </div>
            )}
          </div>
        </div>
        <Stat label="Created" value={formatInTimeZone(invoice.created_at as string, null)} />
      </section>

      {pickupSession && (
        <p style={{ fontSize: 13, color: 'var(--fg-muted)', margin: '0 0 1.5rem' }}>
          Pickup pass:{' '}
          <Link href={pickupSessionHref(pickupSession.token)} style={{ color: 'var(--accent)', fontWeight: 600 }}>
            Open counter page
          </Link>{' '}
          (
          {pickupSession.status === 'open'
            ? 'open'
            : `last visit ${formatInTimeZone(pickupSession.created_at, null)}`}
          )
        </p>
      )}

      <h2 style={{ fontSize: '1.1rem', marginBottom: '0.75rem' }}>Lots</h2>
      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '2rem' }}>
        <tbody>
          {lines?.map((l) => {
            const lot = Array.isArray(l.lots) ? l.lots[0] : l.lots;
            const state = lineState(l);
            return (
              <tr key={l.lot_id as string}>
                <td style={{ padding: '0.5rem', borderBottom: '1px solid var(--border)' }}>
                  <Link
                    href={lotHref(l.lot_id as string)}
                    style={{ color: 'var(--accent)', textDecoration: 'none', fontWeight: 600 }}
                  >
                    {codeOf(lot as { lot_code?: string; sticker_code?: string | null; display_code?: string | null } | null) && (
                      <span
                        style={{
                          fontFamily: 'var(--font-mono)',
                          color: 'var(--fg-muted)',
                          marginRight: 8,
                        }}
                      >
                        {codeOf(lot as { lot_code?: string; sticker_code?: string | null; display_code?: string | null } | null)}
                      </span>
                    )}
                    {(lot as { title?: string } | null)?.title ?? '—'}
                  </Link>
                  <Link
                    href={lotAsListedHref(id, l.lot_id as string)}
                    style={{
                      marginLeft: 10,
                      color: 'var(--fg-dim)',
                      fontSize: 12,
                      fontWeight: 400,
                      textDecoration: 'underline',
                    }}
                  >
                    As listed
                  </Link>
                </td>
                <td
                  style={{
                    padding: '0.5rem',
                    borderBottom: '1px solid var(--border)',
                    fontSize: 12,
                    whiteSpace: 'nowrap',
                    color:
                      state.tone === 'success'
                        ? 'var(--success, #4ade80)'
                        : state.tone === 'warning'
                          ? 'var(--warning, #eab308)'
                          : 'var(--fg-muted)',
                  }}
                >
                  {state.label}
                </td>
                <td
                  style={{
                    padding: '0.5rem',
                    borderBottom: '1px solid var(--border)',
                    textAlign: 'right',
                  }}
                >
                  {formatCents(l.winning_bid_cents as number)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <section
        style={{
          padding: '1rem',
          background: 'var(--bg-elev)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          maxWidth: 480,
          marginLeft: 'auto',
          display: 'grid',
          gap: '0.5rem',
        }}
      >
        <Row label="Subtotal" value={formatCents(invoice.subtotal_cents as number)} />
        <Row label="Buyer premium" value={formatCents(invoice.buyer_premium_cents as number)} />
        {(invoice.tax_cents as number) > 0 && (
          <Row label="Tax" value={formatCents(invoice.tax_cents as number)} />
        )}
        <div style={{ height: 1, background: 'var(--border)', margin: '0.25rem 0' }} />
        <Row label="Total" value={formatCents(invoice.total_cents as number)} bold />
        {/* legacy "Platform fee" row removed 2026-07-08 (owner report):
            BinGo is single-account Square — the business IS the platform, no
            fee exists. application_fee_cents stays in the DB for the fork's
            multi-operator lineage but is always 0 here. */}
      </section>

      {(invoice.status === 'paid' || invoice.status === 'partially_refunded') &&
        // A credit-paid invoice refunds as store credit (2026-10-27,
        // TEA3828564): it has no card payment but is still refundable.
        (invoice.square_payment_id ||
          invoice.stripe_charge_id ||
          ((invoice.credit_applied_cents as number | null) ?? 0) > 0) && (
          <div style={{ marginTop: '2rem', maxWidth: 480, marginLeft: 'auto' }}>
            <RefundButton
              invoiceId={invoice.id as string}
              // What is still refundable, not what was charged: the customer
              // may already have some of it back (2026-10-05: "up to $100.14"
              // on an invoice with $86.94 refunded).
              maxRefundCents={remainingRefundableCents({
                total_cents: invoice.total_cents as number | null,
                refunded_cash_cents: invoice.refunded_cash_cents as number | null,
                refunded_credit_cents: invoice.refunded_credit_cents as number | null,
              })}
              lots={refundLots}
            />
          </div>
        )}

      {/* Offline payment (cash/check in person, or no-Stripe test mode). Only
          for unpaid, non-terminal invoices; the route enforces operator scope,
          AAL2, and an auction-settled guard. */}
      {(invoice.status === 'pending' || invoice.status === 'payment_failed_grace') && (
        <div style={{ marginTop: '2rem', maxWidth: 480, marginLeft: 'auto' }}>
          <MarkPaidButton invoiceId={invoice.id as string} />
        </div>
      )}

      {/* Undo pickup (mig 0487): admin-only, one line at a time, reason +
          confirm + audit log. Puts a wrongly stamped item back on the pickup
          list. Moves no money. */}
      {canUndoPickupOnThisInvoice &&
        (invoice.status === 'paid' || invoice.status === 'partially_refunded') && (
          <UndoPickupPanel invoiceId={invoice.id as string} pickedUpLots={pickedUpLots} />
        )}

      {/* Undo forfeit (mig 0444): manager/admin-only, one line at a time,
          name + reason + audit log. Moves no money. */}
      {canOverridePickup &&
        (invoice.status === 'paid' || invoice.status === 'partially_refunded') && (
          <UndoForfeitPanel invoiceId={invoice.id as string} forfeitedLots={forfeitedLots} />
        )}

      {/* Refund override (mig 0474): manager/admin-only, for an invoice Square
          cannot refund (paid offline or with account credit). */}
      {offerRefundOverride && (
        <RefundOverridePanel
          invoiceId={invoice.id as string}
          lots={overrideLots}
          methods={allowedOverrideMethods({
            total_cents: invoice.total_cents as number | null,
            credit_applied_cents: invoice.credit_applied_cents as number | null,
            refunded_cash_cents: invoice.refunded_cash_cents as number | null,
          })}
        />
      )}

      {/* Manual pickup override (2026-07-10): manager/admin-only. Marks items
          picked up when the scan path failed — required reason + audit log. */}
      {canOverridePickup &&
        (invoice.status === 'paid' || invoice.status === 'partially_refunded') && (
          <ManualPickupOverride invoiceId={invoice.id as string} owedLots={owedLots} />
        )}

      {/* S11 (2026-06-01): payment recovery dunning panel. Read-only visibility
          into auto_charge_jobs + payment_followups for this invoice.
          Only renders when at least one dunning record exists. */}
      {(chargeJob || followup) && (
        <PaymentRecoveryPanel chargeJob={chargeJob} followup={followup} />
      )}
    </div>
  );
}

// PaymentRecoveryPanel — read-only dunning visibility (S11).
// Shows auto_charge_jobs + payment_followups for operators. No write actions.
function PaymentRecoveryPanel({
  chargeJob,
  followup,
}: {
  chargeJob: AutoChargeJobRow | null;
  followup: PaymentFollowupRow | null;
}) {
  function fmt(iso: string | null | undefined): string {
    // Server-rendered — format in Central explicitly (bare toLocaleString
    // renders UTC on the Cloudflare runtime).
    return formatInTimeZone(iso, null);
  }

  return (
    <details
      style={{
        marginTop: '2rem',
        maxWidth: 720,
        marginLeft: 'auto',
        marginRight: 'auto',
        padding: '1rem',
        background: 'var(--bg-elev)',
        border: '1px solid var(--border)',
        borderRadius: 6,
      }}
    >
      <summary
        style={{
          cursor: 'pointer',
          fontSize: 16,
          fontWeight: 600,
          marginBottom: '0.25rem',
          userSelect: 'none',
        }}
      >
        Payment recovery
      </summary>
      <p style={{ fontSize: 12, color: 'var(--fg-muted)', margin: '0.5rem 0 1rem', lineHeight: 1.5 }}>
        Read-only dunning state for this invoice.
        Auto-charge jobs are picked up by the worker every minute.
        Payment followups drive the 24h / 72h notification sequence.
      </p>

      {chargeJob ? (
        <div style={{ marginBottom: '1.25rem' }}>
          <h3 style={{ fontSize: 13, fontWeight: 700, textTransform: 'uppercase', color: 'var(--fg-muted)', margin: '0 0 0.5rem' }}>
            Auto-charge job
          </h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <tbody>
              <DRow label="Attempt count" value={String(chargeJob.attempt_count)} />
              <DRow label="Next attempt at" value={fmt(chargeJob.next_attempt_at)} />
              <DRow label="Last error" value={chargeJob.last_error ?? '—'} />
              <DRow label="Enqueued at" value={fmt(chargeJob.created_at)} />
            </tbody>
          </table>
        </div>
      ) : (
        <p style={{ fontSize: 13, color: 'var(--fg-muted)', marginBottom: '1rem' }}>
          No active auto-charge job for this invoice.
        </p>
      )}

      {followup ? (
        <div>
          <h3 style={{ fontSize: 13, fontWeight: 700, textTransform: 'uppercase', color: 'var(--fg-muted)', margin: '0 0 0.5rem' }}>
            Payment followup (dunning)
          </h3>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <tbody>
              <DRow label="Attempt count" value={String(followup.attempt_count)} />
              <DRow label="Last attempt at" value={fmt(followup.last_attempt_at)} />
              <DRow label="Next attempt at" value={fmt(followup.next_attempt_at)} />
              <DRow label="Final status" value={followup.final_status ?? 'pending'} />
              <DRow label="Created at" value={fmt(followup.created_at)} />
            </tbody>
          </table>
        </div>
      ) : (
        <p style={{ fontSize: 13, color: 'var(--fg-muted)' }}>
          No payment followup record for this invoice.
        </p>
      )}
    </details>
  );
}

function DRow({ label, value }: { label: string; value: string }) {
  return (
    <tr style={{ borderTop: '1px solid var(--border)' }}>
      <td style={{ padding: '6px 8px', color: 'var(--fg-muted)', width: '40%' }}>{label}</td>
      <td style={{ padding: '6px 8px', fontFamily: value.length > 20 ? 'monospace' : undefined, wordBreak: 'break-all' as const }}>{value}</td>
    </tr>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--fg-muted)', textTransform: 'uppercase' }}>{label}</div>
      <div style={{ marginTop: 4, fontSize: 14 }}>{value}</div>
    </div>
  );
}

function Row({
  label,
  value,
  bold,
  muted,
}: {
  label: string;
  value: string;
  bold?: boolean;
  muted?: boolean;
}) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between' }}>
      <span style={{ color: muted ? 'var(--fg-muted)' : 'var(--fg)', fontWeight: bold ? 700 : 400 }}>
        {label}
      </span>
      <span style={{ color: 'var(--fg)', fontWeight: bold ? 700 : 400 }}>{value}</span>
    </div>
  );
}
