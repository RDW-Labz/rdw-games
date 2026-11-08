// Who did it, and why (owner 2026-10-27, mig 0471). Staff share one console
// login, so withdraw / undo withdraw / Dispose / Business use / undo removal
// all need a typed staff name and a written reason, saved on the audit row.
// Same rule as refunds (#598) and mark-paid-offline (#557).

export const STAFF_NAME_MAX = 100;
export const STAFF_REASON_MAX = 500;
/** An admin can undo a Dispose or Business use for this long. */
export const REMOVAL_UNDO_WINDOW_MS = 24 * 60 * 60 * 1000;

export type StaffAttribution = { staffName: string; reason: string };

/** Trimmed name + reason, or the message the console shows. */
export function checkStaffAttribution(
  staffName: unknown,
  reason: unknown,
): { ok: true; value: StaffAttribution } | { ok: false; error: string } {
  const name = typeof staffName === 'string' ? staffName.trim() : '';
  const why = typeof reason === 'string' ? reason.trim() : '';
  if (!name) return { ok: false, error: 'Type your name.' };
  if (name.length > STAFF_NAME_MAX) return { ok: false, error: `Name must be ${STAFF_NAME_MAX} characters or fewer.` };
  if (!why) return { ok: false, error: 'Say why.' };
  if (why.length > STAFF_REASON_MAX) return { ok: false, error: `Reason must be ${STAFF_REASON_MAX} characters or fewer.` };
  return { ok: true, value: { staffName: name, reason: why } };
}

/** The RPCs' refusal codes in operator language. Unknown codes pass through. */
const LOT_ACTION_ERRORS: Record<string, string> = {
  not_authenticated: 'Not signed in.',
  lot_not_found: 'Lot not found.',
  lot_other_operator: 'That lot belongs to another operator.',
  admin_or_manager_required: 'Admin or manager role required.',
  admin_required: 'Only an admin can undo this.',
  staff_name_required: 'Type your name.',
  reason_required: 'Say why.',
  lot_won: 'This lot is already won. Use the refund flow instead.',
  lot_on_invoice: 'This lot is on an invoice (sold). Use the refund flow instead.',
  lot_not_in_open_auction: 'Only a lot in a scheduled or live auction can be withdrawn.',
  lot_removed: 'This lot was already removed from inventory.',
  not_withdrawn: 'This lot is not withdrawn.',
  lot_changed_since_withdrawal:
    'This lot changed after it was withdrawn (for example it was disposed or kept), so it can’t go back.',
  auction_closed: 'Its auction has closed, so the lot can’t go back into it.',
  lot_number_taken: 'Its lot number in that auction is now used by another lot.',
  not_removed: 'This lot is not removed from inventory.',
  undo_window_passed: 'More than 24 hours have passed, so this can no longer be undone.',
  lot_live_with_bids: 'This lot is in a running auction with bids. Withdraw it from the auction first.',
  lot_canceled: 'This lot is canceled.',
  lot_disposed: 'This lot is already disposed.',
  invalid_price: 'Enter a valid price.',
  invalid_removal_kind: 'Pick what happened to the item.',
};

export function lotActionMessage(reason: string | undefined | null): string {
  if (!reason) return 'Could not do that.';
  if (reason.startsWith('already_removed_as_')) {
    return `This item was already removed as "${reason.replace('already_removed_as_', '')}".`;
  }
  return LOT_ACTION_ERRORS[reason] ?? reason;
}

/** Can an admin still undo a removal made at removedAt? */
export function removalUndoOpen(removedAt: string | null | undefined, now: Date = new Date()): boolean {
  if (!removedAt) return false;
  const t = Date.parse(removedAt);
  return Number.isFinite(t) && now.getTime() - t < REMOVAL_UNDO_WINDOW_MS;
}

/** Bid-history label: the bidder NUMBER only, never a name or contact. */
export function bidderNumberLabel(n: number | null | undefined): string {
  return typeof n === 'number' && Number.isFinite(n) ? `#${n}` : '—';
}
