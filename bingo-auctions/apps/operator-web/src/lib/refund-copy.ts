// Staff-facing copy for the refund form: what the server's error codes mean,
// and which invoice lines can still be refunded.
//
// 2026-10-05: a $100.14 invoice showed "up to $100.14" after $86.94 had been
// refunded (one item refunded twice, 40 seconds apart), and the refusal read
// `refund_exceeds_invoice_total`. Pure module so it is unit-tested and shared
// by the form and the invoice page.

import { formatCents } from '@auction-platform/shared';

/** What the invoice page knows about a line, reduced to what refunds care about. */
export type RefundLineState =
  | 'owed'
  | 'picked_up'
  | 'missing'
  | 'refunded'
  | 'forfeited'
  | 'relisted'
  | 'not_paid'
  // Undo forfeit for a refund (mig 0444): the line is owed a refund even
  // while the item's relist keeps running.
  | 'forfeit_undone';

export interface RefundLotAvailability {
  refundable: boolean;
  /** Short note shown next to a line that cannot be refunded. */
  note: string | null;
}

/**
 * Owed (paid, not collected), picked-up and missing lines are refundable. A
 * line that was already refunded, forfeited, or relisted to another customer
 * is not, and the form says why instead of letting a second click through.
 *
 * 'missing' (mig 0393): the counter reported the item missing. Its refund is
 * owed even if the pickup later went no-show and the line was stamped
 * forfeited: a missing item was never the customer's to forfeit.
 */
export function refundLotAvailability(state: RefundLineState, when?: string | null): RefundLotAvailability {
  switch (state) {
    case 'missing':
      return { refundable: true, note: 'Missing — refund owed' };
    case 'forfeit_undone':
      return { refundable: true, note: 'Forfeit undone — refund owed' };
    case 'refunded':
      return { refundable: false, note: when ? `Already refunded ${when}` : 'Already refunded' };
    case 'forfeited':
      return { refundable: false, note: when ? `Forfeited ${when}` : 'Forfeited' };
    case 'relisted':
      return { refundable: false, note: 'Relisted — back in stock' };
    case 'not_paid':
      return { refundable: false, note: 'Not paid' };
    default:
      return { refundable: true, note: null };
  }
}

/**
 * The server's per-line refusal for /api/invoices/[id]/refund-items, or null
 * when the line may be refunded. A refunded line is done. A forfeited line is
 * refused unless the counter reported it missing (mig 0393): before 0393 the
 * no-show sweep stamped forfeited_at on missing lines too.
 */
export function refundLineRefusal(
  line: { refunded_at?: string | null; forfeited_at?: string | null },
  reportedMissing: boolean,
): 'lot_already_refunded' | 'lot_forfeited' | null {
  if (line.refunded_at) return 'lot_already_refunded';
  if (line.forfeited_at && !reportedMissing) return 'lot_forfeited';
  return null;
}

/** Remaining refundable face amount: what the customer paid minus what went back. */
export function remainingRefundableCents(invoice: {
  total_cents: number | null;
  refunded_cash_cents?: number | null;
  refunded_credit_cents?: number | null;
}): number {
  const total = invoice.total_cents ?? 0;
  const back = (invoice.refunded_cash_cents ?? 0) + (invoice.refunded_credit_cents ?? 0);
  return Math.max(0, total - back);
}

/**
 * Plain words for a refund route's error body. `remaining_cents` comes from the
 * server when it has it; the form's own figure is the fallback.
 */
export function refundErrorMessage(
  body: { error?: unknown; remaining_cents?: unknown; lot_code?: unknown; [extra: string]: unknown } | null | undefined,
  status: number,
  fallbackRemainingCents: number,
): string {
  const code = typeof body?.error === 'string' ? body.error : '';
  const remaining =
    typeof body?.remaining_cents === 'number' ? body.remaining_cents : fallbackRemainingCents;
  switch (code) {
    case 'refund_exceeds_invoice_total':
      return `Only ${formatCents(remaining)} left to refund on this invoice.`;
    case 'nothing_left_to_refund':
      return 'Nothing left to refund on this invoice.';
    case 'lot_already_refunded':
      return typeof body?.lot_code === 'string' && body.lot_code
        ? `${body.lot_code} was already refunded. Pick a different item or use a custom amount for the balance.`
        : 'That item was already refunded. Pick a different item or use a custom amount for the balance.';
    case 'lot_forfeited':
      return typeof body?.lot_code === 'string' && body.lot_code
        ? `${body.lot_code} was forfeited by a no-show, so it cannot be refunded.`
        : 'That item was forfeited by a no-show, so it cannot be refunded.';
    case 'refund_in_flight':
      return 'That refund is already being processed. Wait a minute, then refresh the page before trying again.';
    case 'lot_not_in_invoice':
      return 'That item is not on this invoice.';
    case 'no_payment_to_refund':
    case 'no_card_payment':
      return 'This invoice was paid offline (cash or check), not by card, so Square cannot refund it. A manager can record a cash or store-credit refund with Refund override.';
    case 'not_authenticated':
    case 'forbidden':
      return 'You are not signed in with permission to refund. Sign out and back in.';
    case 'refund_failed':
      return 'The refund did not go through. Nothing was charged back. Try again, then contact support.';
    case '':
      return `Server returned ${status}`;
    default:
      // Anything else is already a sentence from the server (window, status,
      // Square's own detail). Show it as is.
      return code;
  }
}
