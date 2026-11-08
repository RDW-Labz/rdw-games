// Undo forfeit (mig 0444, owner decision 2026-10-22): which invoice lines the
// console offers it for, the form's own checks, and plain words for the
// function's refusal codes. Pure module so it is unit-tested.
//
// The database function undo_invoice_line_forfeit() is the gate: role,
// reason, name, line state and the relist check are all enforced there. The
// checks here only save a round trip and keep the copy in one place.

export type UndoForfeitPurpose = 'refund' | 'picked_up';

export const UNDO_FORFEIT_PURPOSES: { value: UndoForfeitPurpose; label: string }[] = [
  { value: 'refund', label: 'Refund it' },
  { value: 'picked_up', label: 'Mark it picked up' },
];

export const MIN_REASON_CHARS = 5;
export const MIN_NAME_CHARS = 2;

/** A line is offered only while it is forfeited on a paid invoice. */
export function canUndoForfeit(line: { kind: string; invoicePaid: boolean }): boolean {
  return line.kind === 'forfeited' && line.invoicePaid;
}

/** The form's own check before calling the function; null when it may submit. */
export function undoForfeitInputError(input: {
  lotId: string | null;
  purpose: UndoForfeitPurpose | '';
  reason: string;
  doneBy: string;
}): string | null {
  if (!input.lotId) return 'Pick the item.';
  if (input.purpose !== 'refund' && input.purpose !== 'picked_up') {
    return 'Say what happens next: refund it or mark it picked up.';
  }
  if (input.doneBy.trim().length < MIN_NAME_CHARS) return 'Type your name — the console login is shared.';
  if (input.reason.trim().length < MIN_REASON_CHARS) return 'Say why the forfeit was wrong.';
  return null;
}

export type UndoForfeitResult = {
  ok: boolean;
  code?: string;
  lot_code?: string;
  purpose?: UndoForfeitPurpose;
  child_lot_code?: string;
  child_status?: string;
  lot_status?: string;
  /** Refund with a live relist (mig 0444): the relist lot that keeps the box. */
  relist_kept?: string | null;
};

/** Plain words for a refusal from undo_invoice_line_forfeit(). */
export function undoForfeitErrorMessage(result: UndoForfeitResult | null | undefined): string {
  switch (result?.code) {
    case 'forbidden':
      return 'Only managers and admins can undo a forfeit.';
    case 'bad_purpose':
      return 'Say what happens next: refund it or mark it picked up.';
    case 'reason_required':
      return 'Say why the forfeit was wrong.';
    case 'name_required':
      return 'Type your name — the console login is shared.';
    case 'not_found':
      return 'That item is not on this invoice.';
    case 'invoice_not_paid':
      return 'This invoice is not paid, so there is nothing to undo.';
    case 'not_forfeited':
      return 'That item is not forfeited any more. Refresh the page.';
    case 'already_refunded':
      return 'That item was already refunded.';
    case 'already_picked_up':
      return 'That item is already marked picked up.';
    case 'relist_child_live':
      return result.child_lot_code
        ? `This item was relisted as ${result.child_lot_code} (${result.child_status ?? 'listed'}), so it cannot have been picked up. If the customer really took it, pull that lot from its auction first (Cancel lot), then undo the forfeit. A refund does not need this.`
        : 'This item was relisted, so it cannot have been picked up. If the customer really took it, pull the relisted lot first (Cancel lot), then undo the forfeit. A refund does not need this.';
    case 'lot_status':
      return `This item's lot is ${result.lot_status ?? 'in another state'}, so the forfeit cannot be undone here.`;
    default:
      return `Undo forfeit failed${result?.code ? `: ${result.code}` : ''}. Nothing was changed.`;
  }
}

/** What to tell staff after a successful undo. */
export function undoForfeitDoneMessage(result: UndoForfeitResult): string {
  const item = result.lot_code ?? 'The item';
  return result.purpose === 'picked_up'
    ? `${item}: forfeit undone. Now mark it picked up in Manual pickup override below.`
    : `${item}: forfeit undone. Now refund it with Refund items.` +
        (result.relist_kept ? ` Its relist ${result.relist_kept} keeps running.` : '');
}
