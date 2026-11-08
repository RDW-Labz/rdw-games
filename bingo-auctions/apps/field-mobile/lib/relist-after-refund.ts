// Relist after refund (mig 0475). A lot in status 'refunded' goes back to
// inventory only through relist_refunded_lot(): manager PIN, typed staff name,
// reason, audit-logged. The database function is the gate; this is the form's
// own check and plain words for each refusal. Mirrors operator-web's
// lib/relist-after-refund.ts.

export const REFUNDED_STATUS = 'refunded';
export const REFUNDED_TAG = 'Refunded – relist';
export const MIN_NAME_CHARS = 2;
export const MIN_REASON_CHARS = 5;

export function isRefundedLot(status: string | null | undefined): boolean {
  return status === REFUNDED_STATUS;
}

/**
 * Result of the Inventory count probe (status = 'refunded'). Before 0475 the
 * enum value does not exist and the query errors, so the pill stays hidden
 * (null). After 0475 it is a number, 0 included.
 */
export function refundedCountFromProbe(r: { count: number | null; error: unknown }): number | null {
  if (r.error) return null;
  return r.count ?? 0;
}

export function managersOnly<T extends { role: string }>(workers: T[]): T[] {
  return workers.filter((w) => w.role === 'manager' || w.role === 'admin');
}

export function relistAfterRefundInputError(i: {
  managerId: string;
  pin: string;
  staffName: string;
  reason: string;
}): string | null {
  if (!i.managerId) return 'Pick the manager approving it.';
  if (!/^\d{4,8}$/.test(i.pin.trim())) return 'Enter the manager PIN.';
  if (i.staffName.trim().length < MIN_NAME_CHARS) return 'Type your name — the floor login is shared.';
  if (i.reason.trim().length < MIN_REASON_CHARS) return 'Say why it can be sold again (e.g. box on the shelf, undamaged).';
  return null;
}

export type RelistAfterRefundResult = {
  ok: boolean;
  reason?: string;
  status?: string;
  detail?: string;
  lot_id?: string;
  lot_code?: string;
  to_inventory?: boolean;
};

export function relistAfterRefundMessage(r: RelistAfterRefundResult | null | undefined): string {
  if (r?.ok) {
    return `Back in inventory as ${r.lot_code ?? 'a new lot'}. Put it away, then list it.`;
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
      return 'Type your name — the floor login is shared.';
    case 'reason_required':
      return 'Say why it can be sold again.';
    case 'not_refunded':
      return 'This item was never refunded.';
    case 'not_fully_refunded':
      return 'Not every sale of this item is refunded yet.';
    case 'buyer_took_it':
      return 'The buyer took this item home, so it is not here to sell again.';
    case 'wrong_status':
      return `This item is ${r.status ?? 'in another state'} now. Scan it again.`;
    case 'lot_not_found':
      return 'This lot is gone. Scan it again to see its current state.';
    case 'relist_refused':
      return `The relist was refused: ${r.detail ?? 'unknown reason'}. Nothing changed.`;
    case 'not_operator_staff':
    case 'not_authenticated':
      return 'Sign in again with a staff login.';
    default:
      return `Relist failed${r?.reason ? `: ${r.reason}` : ''}. Nothing changed.`;
  }
}
