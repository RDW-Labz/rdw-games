// POST /api/square/webhook
//
// Square webhook receiver. The auto-charge worker charges card-on-file
// SYNCHRONOUSLY (Square card-on-file MIT returns COMPLETED in the API response),
// so for the happy path this endpoint is a BACKSTOP that reconciles state. Its
// real value is the async events: refund completion and DISPUTES (chargebacks).
//
// Square signs each delivery with HMAC-SHA256 over (notificationUrl + rawBody)
// using the subscription's signature key (SQUARE_WEBHOOK_SIGNATURE_KEY), in the
// x-square-hmacsha256-signature header. We verify before trusting anything.
//
// Always returns 200 for handled + unhandled-but-valid events so Square doesn't
// retry for days; only a signature failure returns 401.

import { NextResponse, type NextRequest } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { bidderDeepLink } from '@/lib/app-links';
import { primaryLotDisplayCode } from '@/lib/invoice-lot-code';
import { getPayment, idempotencyKey45, refundPayment, verifySquareWebhook } from '@/lib/square';
import { sendOpsAlert } from '@/lib/ops-alert';
import { ensurePickupRow } from '@/lib/pickup-row';

export const runtime = 'nodejs';

// What a COMPLETED payment does to an invoice, by its status: a still-owed one
// flips to 'paid' and goes to the pickup counter; a dead one keeps its status
// and the payment is refunded. Together they are every invoice_status except
// paid / refunded / partially_refunded (see the payment.updated handler). A new
// enum value lands in neither list, so the webhook leaves it alone until
// someone decides where it goes.
const PICKUP_ELIGIBLE_STATUSES = ['pending', 'payment_failed_grace'];
const DEAD_INVOICE_STATUSES = ['canceled', 'unpaid_no_show', 'payment_failed_relisted'];

// The exact URL configured in the Square subscription — the signature is
// computed over (this string + body), so it must match byte-for-byte.
const NOTIFICATION_URL =
  process.env.SQUARE_WEBHOOK_NOTIFICATION_URL ?? 'https://bingoauctions.com/api/square/webhook';

type SquareEvent = {
  type?: string;
  data?: {
    type?: string;
    id?: string;
    object?: {
      payment?: {
        id?: string;
        status?: string;
        reference_id?: string;
        amount_money?: { amount?: number | string };
        approved_money?: { amount?: number | string };
      };
      refund?: {
        id?: string;
        status?: string;
        payment_id?: string;
        amount_money?: { amount?: number | string };
      };
      dispute?: { id?: string; state?: string; payment_id?: string; reason?: string };
      card?: {
        id?: string;
        card_brand?: string;
        last_4?: string;
        exp_month?: number;
        exp_year?: number;
        customer_id?: string;
        issuer_alert?: string;
      };
    };
  };
};

export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  const signature = req.headers.get('x-square-hmacsha256-signature');

  const ok = await verifySquareWebhook(rawBody, signature, NOTIFICATION_URL);
  if (!ok) {
    console.error('SQUARE_WEBHOOK_SIGNATURE_FAIL', {
      signature_prefix: (signature ?? '').slice(0, 16),
    });
    return NextResponse.json({ error: 'bad_signature' }, { status: 401 });
  }

  let event: SquareEvent;
  try {
    event = JSON.parse(rawBody) as SquareEvent;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const admin = getSupabaseAdmin();
  const type = event.type ?? '';

  try {
    switch (type) {
      case 'payment.created':
      case 'payment.updated': {
        // Backstop: if a payment reached COMPLETED, make sure its invoice is
        // marked paid (the worker normally already did this synchronously).
        // Match by square_payment_id OR by reference_id (= our invoice id):
        // when a charge succeeded at Square but the response never reached the
        // worker (timeout / IDEMPOTENCY_KEY_REUSED on a later attempt), we never
        // stored the payment id, so reference_id is the only link back to the
        // invoice. Also stamp the payment id when we reconcile by reference_id.
        const payment = event.data?.object?.payment;
        if (payment?.id && payment.status === 'COMPLETED') {
          const orFilter = payment.reference_id
            ? `square_payment_id.eq.${payment.id},id.eq.${payment.reference_id}`
            : `square_payment_id.eq.${payment.id}`;
          // Square re-fires payment.updated when a REFUND is applied (the
          // payment's refunded_money changes; its status stays COMPLETED). This
          // backstop used to happily re-stamp such an invoice as paid: it only
          // skipped rows already reading 'paid', so a row the refund route had
          // just set to refunded/partially_refunded was flipped back — and its
          // real paid_at was overwritten with the refund's timestamp. Between
          // 2026-07-03 and 2026-08-25 that clobbered paid_at on 318 invoices and
          // left one fully-refunded BinGo invoice reading 'paid'. Never touch an
          // invoice that carries refund state.
          //
          // The flip is split by the invoice's status BEFORE it, because only
          // a still-owed invoice should reach the pickup counter:
          //   (a) pending / payment_failed_grace → paid + pickups row.
          //   (b) canceled / unpaid_no_show / payment_failed_relisted → NOT
          //       paid. The customer was charged for an invoice that is dead:
          //       its lots may already be relisted or resold to someone else.
          //       Until 2026-09-28 this marked the invoice paid (and sent a
          //       receipt), which kept the money for something canceled. Now
          //       the payment is refunded in full, recorded on the invoice with
          //       its status left as it was, and a human is told. See
          //       refundLatePayment below.
          // (a) ∪ (b) is every invoice_status except paid / refunded /
          // partially_refunded — the same set the old single
          // .not('status','in','(paid,refunded,partially_refunded)') update
          // covered. (a) is a conditional UPDATE, so the status it matched is
          // the status the row had when it flipped; a concurrent change cannot
          // be counted twice.
          const paymentId = payment.id;
          const paidAt = new Date().toISOString();
          const flipFrom = () =>
            admin
              .from('invoices')
              .update({
                status: 'paid',
                paid_at: paidAt,
                square_payment_id: paymentId,
              })
              .or(orFilter)
              .is('square_refund_id', null);
          type FlippedInvoice = {
            id: string;
            bidder_id: string;
            total_cents: number;
            fulfillment_method: string | null;
          };
          const FLIPPED_COLS = 'id, bidder_id, total_cents, fulfillment_method';

          const flipped: FlippedInvoice[] = [];
          const { data: owed, error: owedErr } = await flipFrom()
            .in('status', PICKUP_ELIGIBLE_STATUSES)
            .select(FLIPPED_COLS);
          if (owedErr) {
            console.error('[square/webhook] paid flip failed', paymentId, owedErr.message);
          }
          for (const inv of (owed ?? []) as FlippedInvoice[]) {
            flipped.push(inv);
            // Create the pickups row, same as mark-paid + auto-charge-drain.
            // Without it the invoice is paid but invisible to the staff QR scan
            // and the bidder's Pickup Pass — which happened when auto-charge
            // parked an invoice in payment_failed_grace and this webhook flipped
            // it to paid seconds later. Ship invoices skip it (shipping queue).
            // A failure here must never fail the webhook (a non-200 makes
            // Square retry an already-applied payment); the helper only logs.
            if (inv.fulfillment_method !== 'ship') {
              await ensurePickupRow(admin, inv.id, 'square/webhook');
            }
          }
          const { data: dead, error: deadErr } = await admin
            .from('invoices')
            .select('id, operator_id, status, total_cents')
            .or(orFilter)
            .in('status', DEAD_INVOICE_STATUSES)
            .is('square_refund_id', null);
          if (deadErr) {
            console.error('[square/webhook] late-payment lookup failed', paymentId, deadErr.message);
          }
          const deadRows = (dead ?? []) as DeadInvoice[];
          if (deadRows.length === 1 && deadRows[0]) {
            await refundLatePayment(admin, deadRows[0], payment);
          } else if (deadRows.length > 1) {
            // One payment, several dead invoices (matched by payment id and by
            // reference id): refunding each would refund the same money twice.
            // Refund nothing and let a person pick.
            console.error('SQUARE_LATE_PAYMENT_AMBIGUOUS', {
              payment_id: paymentId,
              invoice_ids: deadRows.map((r) => r.id),
            });
            await sendOpsAlert(
              admin,
              'late_payment_refund_failed',
              'Refund needed: a late payment matches several dead invoices',
              `Square completed payment ${paymentId}, which matches ${deadRows.length} canceled / ` +
                `relisted invoices (${deadRows.map((r) => r.id).join(', ')}). Nothing was refunded ` +
                `automatically. Refund it once in Square, against the right invoice.`,
              { sms: true },
            ).catch(() => false);
          }

          // Receipt for any invoice THIS event actually flipped (the worker's
          // synchronous path enqueues its own; the shared idempotency key
          // 'receipt:{invoice_id}' means the bidder gets exactly one).
          for (const inv of flipped) {
            await admin
              .from('notifications_outbox')
              .insert({
                target_user_id: inv.bidder_id,
                kind: 'payment_succeeded',
                idempotency_key: `receipt:${inv.id}`,
                payload: {
                  invoice_id: inv.id,
                  amount_cents: inv.total_cents,
                  lot_code: await primaryLotDisplayCode(admin, inv.id),
                  deep_link: bidderDeepLink(`invoice/${inv.id}`),
                },
              })
              .then(undefined, (err: unknown) => {
                console.warn('[square/webhook] receipt enqueue failed:', (err as Error)?.message);
              });
          }
        }
        break;
      }

      case 'refund.created':
      case 'refund.updated': {
        const refund = event.data?.object?.refund;
        if (refund?.payment_id) {
          // Record the refund id + completion against the originating invoice.
          const patch: Record<string, unknown> = { square_refund_id: refund.id };
          if (refund.status === 'COMPLETED') {
            // Partial-refund bug (customer report, 2026-07-09): COMPLETED used to
            // force status='refunded' regardless of amount, so a PARTIAL
            // refund flipped the whole invoice to fully-refunded the moment
            // Square confirmed it (seconds after the route correctly set
            // partially_refunded) — and the customer's remaining PAID items
            // dropped off pickup. Compare the completed amount to the invoice
            // total; only >= total is a full refund. (A second partial that
            // brings the cumulative total to 100% still reads
            // partially_refunded — conservative on purpose; the routes set
            // the final status synchronously when they can tell.)
            const { data: invRow } = await admin
              .from('invoices')
              .select('total_cents, refunded_at, status')
              .eq('square_payment_id', refund.payment_id)
              .maybeSingle();
            patch.refunded_at =
              (invRow as { refunded_at?: string | null } | null)?.refunded_at ??
              new Date().toISOString();
            // A dead invoice (canceled / no-show / relisted) keeps its status
            // when its late payment is refunded — refundLatePayment. Only the
            // refund facts are recorded on it.
            const priorStatus = (invRow as { status?: string } | null)?.status ?? '';
            const amt = Number(refund.amount_money?.amount ?? NaN);
            const total = Number((invRow as { total_cents?: number } | null)?.total_cents ?? NaN);
            if (!DEAD_INVOICE_STATUSES.includes(priorStatus)) {
              patch.status =
                Number.isFinite(amt) && Number.isFinite(total) && amt < total
                  ? 'partially_refunded'
                  : 'refunded';
            }
          }
          await admin.from('invoices').update(patch).eq('square_payment_id', refund.payment_id);
        }
        break;
      }

      case 'card.disabled': {
        // A saved card-on-file was disabled (by Square, the issuer, or us).
        // Clear it off the bidder so place_bid's no_payment_method gate
        // re-engages and the auto-charge worker never tries a dead card.
        //
        // Scope the match by BOTH card id AND customer id when the event carries
        // one, so a stray / wrong-account event can't null a live card on some
        // other bidder. Emit a structured audit line with the affected bidder
        // ids — a disappearing card was previously untraceable (diagnosis #4).
        const card = event.data?.object?.card;
        if (card?.id) {
          let q = admin
            .from('bidders')
            .update({
              default_payment_method_id: null,
              card_brand: null,
              card_last4: null,
              card_exp_month: null,
              card_exp_year: null,
            })
            .eq('default_payment_method_id', card.id);
          if (card.customer_id) q = q.eq('square_customer_id', card.customer_id);
          const { data: cleared, error } = await q.select('id');
          if (error) {
            console.error('[square/webhook] card.disabled clear failed', card.id, error.message);
          } else {
            console.warn('SQUARE_CARD_CLEARED', {
              event: 'card.disabled',
              card_id: card.id,
              customer_id: card.customer_id ?? null,
              bidder_ids: (cleared ?? []).map((r) => r.id),
              count: cleared?.length ?? 0,
            });
          }
        }
        break;
      }

      case 'card.automatically_updated': {
        // Square's Card-on-File Account Updater refreshed the stored card (new
        // expiry / replacement PAN — same card id) OR flagged the underlying
        // account CLOSED. If closed, clear the card; otherwise refresh the
        // display crumbs so we charge the right card with no re-entry.
        //
        // Same customer-id scoping + audit trail as card.disabled: a CLOSED
        // event nulls the card, so it must not fire against the wrong bidder and
        // a clear must be traceable.
        const card = event.data?.object?.card;
        if (card?.id) {
          const closed = card.issuer_alert === 'ISSUER_ALERT_CARD_CLOSED';
          let q = admin
            .from('bidders')
            .update(
              closed
                ? {
                    default_payment_method_id: null,
                    card_brand: null,
                    card_last4: null,
                    card_exp_month: null,
                    card_exp_year: null,
                  }
                : {
                    card_brand: card.card_brand ?? null,
                    card_last4: card.last_4 ?? null,
                    card_exp_month: card.exp_month ?? null,
                    card_exp_year: card.exp_year ?? null,
                  },
            )
            .eq('default_payment_method_id', card.id);
          if (card.customer_id) q = q.eq('square_customer_id', card.customer_id);
          const { data: affected, error } = await q.select('id');
          if (error) {
            console.error(
              '[square/webhook] card.automatically_updated failed',
              card.id,
              error.message,
            );
          } else if (closed) {
            console.warn('SQUARE_CARD_CLEARED', {
              event: 'card.automatically_updated',
              reason: 'ISSUER_ALERT_CARD_CLOSED',
              card_id: card.id,
              customer_id: card.customer_id ?? null,
              bidder_ids: (affected ?? []).map((r) => r.id),
              count: affected?.length ?? 0,
            });
          }
        }
        break;
      }

      case 'dispute.created':
      case 'dispute.evidence.created':
      case 'dispute.evidence.deleted':
      case 'dispute.state.updated': {
        // Chargeback signal. TODO(disputes): map Square disputes onto the
        // disputes table once the operator-side dispute UI is wired for Square.
        // For now emit a structured, alertable log so the owner sees it (Square
        // also emails + dashboards every dispute). Acknowledge 200 so Square
        // stops retrying.
        const dispute = event.data?.object?.dispute;
        console.error('SQUARE_DISPUTE', {
          event_type: type,
          dispute_id: dispute?.id,
          payment_id: dispute?.payment_id,
          state: dispute?.state,
          reason: dispute?.reason,
        });
        break;
      }

      default:
        // Unhandled-but-valid event — acknowledge so Square doesn't retry.
        break;
    }
  } catch (err) {
    // Never 500 to Square on a handler error (it would retry indefinitely).
    // Log and acknowledge; the synchronous worker path is the source of truth.
    console.error('[square/webhook] handler error for', type, (err as Error).message);
  }

  return NextResponse.json({ received: true });
}

type DeadInvoice = { id: string; operator_id: string; status: string; total_cents: number };
type CompletedPayment = NonNullable<NonNullable<NonNullable<SquareEvent['data']>['object']>['payment']>;
type Admin = ReturnType<typeof getSupabaseAdmin>;

// A COMPLETED payment for an invoice that is canceled / unpaid_no_show /
// payment_failed_relisted. The realistic path: Square answered a charge
// PENDING, the invoice waited in grace, grace ran out and the lots were
// relisted, then Square completed the payment. The customer must not pay for
// items they no longer get, so the whole payment goes back.
//
// Idempotent: the refund's key is derived from the payment id, so a Square
// redelivery (or two events for one payment) can only ever make one refund,
// and the invoice row is written only while square_refund_id is still null.
// Never throws: the webhook acknowledges Square either way, and a failure pages
// a human instead (sms), because the money stays with us until someone acts.
async function refundLatePayment(admin: Admin, inv: DeadInvoice, payment: CompletedPayment) {
  const paymentId = payment.id as string;
  const fail = async (why: string) => {
    console.error('SQUARE_LATE_PAYMENT_REFUND_FAILED', { invoice_id: inv.id, payment_id: paymentId, why });
    await sendOpsAlert(
      admin,
      'late_payment_refund_failed',
      `Refund needed: a customer was charged for a ${inv.status} invoice`,
      `Square completed payment ${paymentId} for invoice ${inv.id}, which is ${inv.status}. ` +
        `The automatic refund did not go through (${why}). Refund it in Square or from the ` +
        `invoice page, and do not hand over its lots: they may already be relisted.`,
      { sms: true },
    ).catch(() => false);
  };
  try {
    const eventCents = Number(payment.approved_money?.amount ?? payment.amount_money?.amount ?? NaN);
    const cents = Number.isFinite(eventCents)
      ? eventCents
      : ((await getPayment(paymentId))?.approvedCents ?? NaN);
    if (!Number.isFinite(cents) || cents <= 0) {
      await fail('payment amount unknown');
      return;
    }
    const refund = await refundPayment({
      paymentId,
      amountCents: cents,
      idempotencyKey: await idempotencyKey45(`late:${paymentId}`),
      reason: `Payment arrived after invoice was ${inv.status.replace(/_/g, ' ')}`,
    });
    const refundedAt = new Date().toISOString();
    const { error: updErr } = await admin
      .from('invoices')
      .update({
        square_payment_id: paymentId,
        square_refund_id: refund.refundId,
        refunded_cash_cents: cents,
        refunded_at: refundedAt,
      })
      .eq('id', inv.id)
      .is('square_refund_id', null);
    if (updErr) {
      console.error('[square/webhook] CRITICAL: late payment refunded but invoice update failed', inv.id, updErr.message);
    }
    await admin
      .from('operator_audit_log')
      .insert({
        operator_id: inv.operator_id,
        actor_user_id: null,
        action_type: 'invoice.late_payment_refunded',
        target_id: inv.id,
        before_state: { status: inv.status, square_refund_id: null },
        after_state: { status: inv.status, square_payment_id: paymentId, square_refund_id: refund.refundId, refunded_cash_cents: cents },
        reason_note: 'Square completed a payment after the invoice was dead; refunded automatically',
      })
      .then(undefined, (e: unknown) => console.error('[square/webhook] audit insert failed', (e as Error)?.message));
    console.warn('SQUARE_LATE_PAYMENT_REFUNDED', {
      invoice_id: inv.id,
      prior_status: inv.status,
      payment_id: paymentId,
      refund_id: refund.refundId,
      cents,
    });
    await sendOpsAlert(
      admin,
      'late_payment_refunded',
      `Late payment refunded on a ${inv.status} invoice`,
      `Square completed payment ${paymentId} for invoice ${inv.id} after it was ${inv.status}. ` +
        `It was refunded automatically (refund ${refund.refundId}, $${(cents / 100).toFixed(2)}). ` +
        `No action needed unless the customer asks.`,
    ).catch(() => false);
  } catch (err) {
    await fail((err as Error)?.message ?? String(err));
  }
}
