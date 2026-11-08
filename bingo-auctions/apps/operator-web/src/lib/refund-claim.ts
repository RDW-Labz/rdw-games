// Double-click protection for refunds, both ends.
//
// Server: a claim key names the refund's shape (invoice + which lines + how
// much). The routes take the claim (mig 0389 claim_refund) before calling
// Square and release it after; a second request with the same shape inside
// the window is refused with `refund_in_flight`, even while the first is
// still running. Client: an in-flight gate that refuses a second submit
// before React has had a chance to re-render the disabled button.
//
// 2026-10-05: 13 invoices were refunded twice for the same line, almost all
// within one or two minutes of each other.

// Server-only: node:crypto. Never import this from a client component.
import { createHash } from 'node:crypto';

export const REFUND_CLAIM_WINDOW_SECONDS = 60;

/** The shape of an item refund: invoice, the lot ids (order-free), the face sum. */
export function refundItemsClaimKey(invoiceId: string, lotIds: readonly string[], amountCents: number): string {
  const lots = [...lotIds].map(String).sort().join(',');
  return `items:${createHash('sha256').update(`${invoiceId}|${lots}|${amountCents}`).digest('hex').slice(0, 40)}`;
}

/** The shape of a custom-amount refund: invoice and the face amount. */
export function refundAmountClaimKey(invoiceId: string, amountCents: number): string {
  return `amount:${createHash('sha256').update(`${invoiceId}|${amountCents}`).digest('hex').slice(0, 40)}`;
}

// The client-side gate lives in ./in-flight-gate (no Node imports) so the
// refund form can import it. This module stays server-only.
export { inFlightGate } from './in-flight-gate';
