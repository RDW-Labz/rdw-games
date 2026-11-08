// Ownership & fulfillment text on the console lot page. Pure so it is tested.
//
// 2026-10-28, Lot #14 (TEA4842561): the page said "Pickup: Awaiting pickup"
// although the invoice's pickup was completed and this item was refunded.
// Cause: pickups.invoice_id is UNIQUE (0007/0094), so PostgREST embeds
// `pickups(...)` under an invoice as ONE OBJECT, not an array. The page read
// `pickups?.[0]`, which is always undefined on an object, and fell through to
// the "Awaiting pickup" default for every line without its own picked-up stamp
// (refunded, forfeited, missing). Lines that were stamped picked up showed
// correctly, which is why the other items on that invoice looked right.

export type EmbeddedPickup = { status: string | null; completed_at: string | null };

/** The invoice's pickup whether PostgREST sent an object (1:1) or an array. */
export function embeddedPickup(
  p: EmbeddedPickup | EmbeddedPickup[] | null | undefined,
): EmbeddedPickup | null {
  if (!p) return null;
  return Array.isArray(p) ? (p[0] ?? null) : p;
}

export type OwnershipInput = {
  linePickedUpAt: string | null;
  lineRefundedAt: string | null;
  lineForfeitedAt: string | null;
  invoiceStatus: string;
  invoicePaidAt: string | null;
  pickup: EmbeddedPickup | null;
  /** This row was relisted (its sale ended; the item lives on a newer row). */
  rowRelisted: boolean;
  fmt: (iso: string) => string;
};

const SALE_CANCELLED_INVOICE = new Set(['payment_failed_relisted', 'canceled']);

/** The Pickup line. Never the bare "Awaiting pickup" default. */
export function pickupLabel(i: OwnershipInput): string {
  if (i.linePickedUpAt) return `Picked up ${i.fmt(i.linePickedUpAt)}`;
  if (i.lineRefundedAt) return `Refunded ${i.fmt(i.lineRefundedAt)} — not handed over`;
  if (i.lineForfeitedAt) return `Forfeited ${i.fmt(i.lineForfeitedAt)} (no-show)`;
  if (SALE_CANCELLED_INVOICE.has(i.invoiceStatus) || (i.rowRelisted && !i.invoicePaidAt)) {
    return 'Relisted — sale cancelled';
  }
  if (!i.invoicePaidAt) return 'Not paid — nothing to hand over';
  if (i.pickup?.completed_at) return `Picked up ${i.fmt(i.pickup.completed_at)}`;
  if (i.pickup?.status === 'forfeited' || i.pickup?.status === 'no_show') {
    return `Pickup ${i.pickup.status.replace(/_/g, ' ')}`;
  }
  if (i.pickup?.status && i.pickup.status !== 'pending' && i.pickup.status !== 'scheduled') {
    return i.pickup.status.replace(/_/g, ' ');
  }
  // Paid, nothing handed over, no refund or forfeit: genuinely waiting.
  return 'Awaiting pickup';
}

/** The Purchased line. */
export function purchasedLabel(i: Pick<OwnershipInput, 'invoiceStatus' | 'invoicePaidAt' | 'fmt'>): string {
  if (i.invoicePaidAt) return i.fmt(i.invoicePaidAt);
  if (i.invoiceStatus === 'payment_failed_relisted') return 'Card declined — relisted';
  if (i.invoiceStatus === 'canceled') return 'Invoice canceled';
  return 'Unpaid';
}

/** True only when this item really left with the buyer. */
export function handedOver(i: Pick<OwnershipInput, 'linePickedUpAt' | 'lineRefundedAt' | 'lineForfeitedAt' | 'pickup'>): boolean {
  if (i.linePickedUpAt) return true;
  if (i.lineRefundedAt || i.lineForfeitedAt) return false;
  return Boolean(i.pickup?.completed_at);
}
