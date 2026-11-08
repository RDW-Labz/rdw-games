// Pickup card: which auction's window to show, and whether the pickup was
// forfeited. Pure so it is tested without a device.
//
// 2026-10-21 (customer screenshot, invoice d684ead9): a forfeited Harrison
// pickup read "2 ready to collect" with no dates. Two causes:
//   1. The badge only knew pickup status 'no_show'. The no-show sweep writes
//      'forfeited' (and stamps invoice_lots.forfeited_at), which fell through
//      to the ready/staging labels. 776 paid invoices on prod had that status.
//   2. The window came from each LOT's current auction. A relist takes the lot
//      off its auction (lots.auction_id NULL), so the card lost its dates
//      (641 of those 776). The invoice's own auction is the one the customer
//      won in and still carries the window.

export type PickupWindow = { pickup_starts_at: string | null; pickup_ends_at: string | null };

/** Invoice's auction first; the lot's auction only if the invoice has none. */
export function pickupWindowFor(
  invoiceAuction: PickupWindow | null | undefined,
  lotAuction: PickupWindow | null | undefined,
): PickupWindow {
  const src = invoiceAuction ?? lotAuction ?? null;
  return {
    pickup_starts_at: src?.pickup_starts_at ?? null,
    pickup_ends_at: src?.pickup_ends_at ?? null,
  };
}

/**
 * Forfeited = the pickups row says so, or every owed line (not refunded,
 * not picked up) carries forfeited_at. Lines already collected or refunded
 * don't count either way.
 */
export function isPickupForfeited(
  pickupStatus: string | null,
  owedLines: Array<{ forfeited_at: string | null }>,
): boolean {
  if (pickupStatus === 'forfeited') return true;
  return owedLines.length > 0 && owedLines.every((l) => l.forfeited_at != null);
}
