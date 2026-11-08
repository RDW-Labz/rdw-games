// Relist after refund (mig 0475, owner 2026-10-28). Pure: which lots are
// offered, the form's own check, and plain words for every refusal from
// relist_refunded_lot(). The database function is the gate.

export const MIN_NAME_CHARS = 2;
export const MIN_REASON_CHARS = 5;

/**
 * Offered for a lot in 'refunded', and for a legacy 'won' lot whose every
 * invoice line is refunded and none was picked up (the 580 lots refunded
 * before 0475 that are still 'won').
 */
export function canRelistAfterRefund(input: {
  lotStatus: string;
  lines: { refunded_at: string | null; picked_up_at: string | null }[];
}): boolean {
  if (input.lotStatus === 'refunded') return true;
  if (input.lotStatus !== 'won' || input.lines.length === 0) return false;
  return input.lines.every((l) => l.refunded_at && !l.picked_up_at);
}

export function relistAfterRefundInputError(i: {
  managerId: string;
  pin: string;
  staffName: string;
  reason: string;
}): string | null {
  if (!i.managerId) return 'Pick the manager approving it.';
  if (!/^\d{4,8}$/.test(i.pin.trim())) return 'Enter the manager PIN.';
  if (i.staffName.trim().length < MIN_NAME_CHARS) return 'Type your name — the console login is shared.';
  if (i.reason.trim().length < MIN_REASON_CHARS) return 'Say why it can be sold again (e.g. box on the shelf, undamaged).';
  return null;
}

export type RelistAfterRefundResult = {
  ok: boolean;
  reason?: string;
  status?: string;
  detail?: string;
  lot_code?: string;
  to_inventory?: boolean;
};

export function relistAfterRefundMessage(r: RelistAfterRefundResult | null | undefined): string {
  if (r?.ok) {
    return r.to_inventory
      ? `Back in inventory as ${r.lot_code ?? 'a new lot'}. Put it away, then list it.`
      : `Relisted as ${r.lot_code ?? 'a new lot'}.`;
  }
  switch (r?.reason) {
    case 'pin_bad_pin':
      return 'Wrong manager PIN. Five wrong tries lock that manager for 15 minutes.';
    case 'pin_locked':
      return 'That manager is locked for a few minutes after wrong PINs. Try again later.';
    case 'pin_not_found':
      return 'That manager is not active any more.';
    case 'pin_not_manager':
      return 'That person is not a manager. A manager or admin must approve.';
    case 'staff_name_required':
      return 'Type your name — the console login is shared.';
    case 'reason_required':
      return 'Say why it can be sold again.';
    case 'not_refunded':
      return 'This item was never refunded.';
    case 'not_fully_refunded':
      return 'Not every sale of this item is refunded yet.';
    case 'buyer_took_it':
      return 'The buyer took this item home, so it is not here to sell again.';
    case 'wrong_status':
      return `This item is ${r.status ?? 'in another state'} now. Refresh the page.`;
    case 'relist_refused':
      return `The relist was refused: ${r.detail ?? 'unknown reason'}. Nothing changed.`;
    case 'not_operator_staff':
    case 'not_authenticated':
      return 'Sign in again with a staff login.';
    default:
      return `Relist failed${r?.reason ? `: ${r.reason}` : ''}. Nothing changed.`;
  }
}
