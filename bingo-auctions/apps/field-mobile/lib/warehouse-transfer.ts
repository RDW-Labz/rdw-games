// Warehouse transfer on put-away (mig 0473, 2026-10-27).
//
// Putting a box from another building onto a shelf here is a transfer. It is
// only done by transfer_lot_to_bin, which needs the typed staff name (logins
// are shared) and a reason, and is audited. The ordinary put-away RPCs refuse
// it with "transfer_needed: ...". Pure logic so it is unit-tested.

export type TransferResult = {
  ok: boolean;
  reason: string;
  lot_id?: string | null;
  lot_code?: string | null;
  bin_code?: string | null;
  from_warehouse?: string | null;
  to_warehouse?: string | null;
  relotted_from?: string | null;
};

export const TRANSFER_REASON_MESSAGES: Record<string, string> = {
  not_authenticated: 'Sign in again — your session expired.',
  not_operator_staff: "You're not on staff for any operator.",
  staff_name_required: 'Type your name first.',
  reason_required: 'Type why it is moving first.',
  bin_not_found_or_revoked: 'That bin QR was revoked or never existed.',
  bin_retired: 'That bin is retired — pick an active bin.',
  bin_other_operator: 'That bin belongs to a different operator.',
  lot_not_found: 'No lot matched that scan.',
  lot_other_operator: 'That lot belongs to a different operator.',
  not_a_transfer: 'That shelf is in the lot’s own building — use a normal put-away.',
  in_sale: 'This item is in an auction (scheduled or live). It can’t move buildings until that auction is over.',
  sold: 'This item is sold and waiting for its buyer. It can’t move buildings.',
  not_in_stock: 'This item is not in stock (relisted, canceled or disposed).',
  in_open_auction: 'This item’s auction is still open. Wait until it closes.',
  open_invoice: 'This item’s invoice is still being paid. It can’t move buildings yet.',
  staged_for_pickup: 'This item is staged for a pickup. Un-stage it first.',
  relot_refused: 'This item could not be taken off its old auction. Ask a manager.',
};

export function transferMessage(reason: string): string {
  return TRANSFER_REASON_MESSAGES[reason] ?? `Server: ${reason}`;
}

/**
 * One-tap reasons (owner 2026-10-27). "Other" asks for a typed reason. The
 * server stores the chosen text as the audit reason.
 */
export const OTHER_REASON = 'Other';
export function transferReasonChoices(fromWarehouse: string | null): string[] {
  const from = fromWarehouse ?? 'another building';
  return [
    `Came on the truck from ${from}`,
    'Found here, recorded at the wrong building',
    'Customer pickup moved to this building',
    OTHER_REASON,
  ];
}

/** The reason sent to the server: the picked choice, or the typed text for "Other". */
export function transferReasonText(picked: string | null, otherText: string): string {
  if (!picked) return '';
  return picked === OTHER_REASON ? otherText.trim() : picked;
}

/** Name and reason are both required; whitespace does not count. */
export function transferInputsReady(staffName: string, reason: string): boolean {
  return staffName.trim().length > 0 && reason.trim().length > 0;
}

/**
 * The building whose shelves a typed bin code should be looked up in. A
 * transfer goes onto a shelf HERE (the active building); a normal put-away
 * stays in the lot's own building.
 */
export function binLookupWarehouseId(
  transfer: boolean,
  lotWarehouseId: string | null,
  activeWarehouseId: string | null,
): string | null {
  if (transfer) return activeWarehouseId ?? lotWarehouseId;
  return lotWarehouseId ?? activeWarehouseId;
}

/** Confirmation line for the done screen. */
export function transferDoneLine(r: TransferResult): string {
  const from = r.from_warehouse ?? 'another building';
  const to = r.to_warehouse ?? 'here';
  return `Transferred from ${from} to ${to} → bin ${r.bin_code ?? '?'}`;
}
