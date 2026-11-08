// Undo pickup (mig 0487, owner decision 2026-11-03 via #706): which invoice
// lines the console offers it for, the form's own checks, and plain words for
// the function's refusal codes. Pure module so it is unit-tested.
//
// The database function undo_invoice_line_pickup() is the gate: admin role,
// reason, line state, lot status and the relist check are all enforced there.
// The checks here only save a round trip and keep the copy in one place.

export const MIN_UNDO_PICKUP_REASON_CHARS = 5;

/**
 * A line is offered only while it is stamped picked up on a paid invoice, and
 * only to an admin (#706 — deliberately narrower than the manager override).
 */
export function canUndoPickup(line: {
  kind: string;
  invoicePaid: boolean;
  isAdmin: boolean;
}): boolean {
  return line.kind === 'picked_up' && line.invoicePaid && line.isAdmin;
}

/** The form's own check before calling the function; null when it may submit. */
export function undoPickupInputError(input: {
  lotId: string | null;
  reason: string;
}): string | null {
  if (!input.lotId) return 'Pick the item that was marked picked up by mistake.';
  if (input.reason.trim().length < MIN_UNDO_PICKUP_REASON_CHARS) {
    return 'Say why this pickup was wrong — it goes in the audit log.';
  }
  return null;
}

export type UndoPickupResult = {
  ok: boolean;
  code?: string;
  reverted?: boolean;
  already_undone?: boolean;
  lot_code?: string;
  old_picked_up_at?: string;
  pickup_status?: string;
  bin_assignment_reverted?: boolean;
  collected_outcomes_removed?: number;
  session_ticks_removed?: number;
  /** The line was also forfeited (0256 forfeited-not-resold path). */
  forfeit_remains?: boolean;
  child_lot_code?: string;
  child_status?: string;
  lot_status?: string;
  /** Present on an expired window (`pickup_expired`), ISO timestamp. */
  pickup_deadline?: string;
};

/** Plain words for a refusal from undo_invoice_line_pickup(). */
export function undoPickupErrorMessage(result: UndoPickupResult | null | undefined): string {
  switch (result?.code) {
    case 'forbidden':
      return 'Only an admin can undo a pickup.';
    case 'reason_required':
      return 'Say why this pickup was wrong — it goes in the audit log.';
    case 'not_found':
      return 'That item is not on this invoice.';
    case 'invoice_not_paid':
      return 'This invoice is not paid, so there is no pickup to undo.';
    case 'refunded':
      return 'That item was refunded — the money already went back, so the pickup cannot be undone.';
    case 'relist_child_live':
      return result.child_lot_code
        ? `This item is listed again as ${result.child_lot_code} (${result.child_status ?? 'listed'}), so it is not owed to this customer. Cancel that lot first if the customer really did not take it.`
        : 'This item is listed again, so it is not owed to this customer. Cancel the relisted lot first if the customer really did not take it.';
    case 'lot_status':
      return `This item's lot is ${result.lot_status ?? 'in another state'}, so the pickup cannot be undone here.`;
    case 'pickup_closed':
      return result.pickup_status === 'forfeited'
        ? 'This visit is already closed as forfeited. Use Undo forfeit on the line instead, or ask a manager to reopen the visit.'
        : 'This visit is already closed as a no-show. Ask a manager to approve reopening it; undo pickup would not put the item back on the pickup list.';
    case 'pickup_expired':
      return 'This pickup window has already closed. Reopening it would let the no-show sweep forfeit the item again, so it needs a manager/Braden-approved deadline first. Nothing was changed.';
    case 'pickup_missing':
      return 'No pickup visit is attached to this invoice, so there is nothing to reopen.';
    default:
      return `Undo pickup failed${result?.code ? `: ${result.code}` : ''}. Nothing was changed.`;
  }
}

/** What to tell staff after a successful undo. */
export function undoPickupDoneMessage(result: UndoPickupResult): string {
  const item = result.lot_code ?? 'The item';
  if (result.already_undone) {
    return `${item} was already not marked picked up. Nothing changed.`;
  }
  return (
    `${item}: pickup undone — it is owed again and back on the pickup list.` +
    (result.forfeit_remains
      ? ' This line is also forfeited; use Undo forfeit below to clear that too.'
      : '')
  );
}
