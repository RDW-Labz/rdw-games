// Refunded lots in console Inventory (0475 adds lot status 'refunded').
// They are not sellable until a manager relists them with a PIN on the lot
// page, so Inventory only tags them and links there.
//
// Before 0475 exists, filtering on status='refunded' is an invalid enum value:
// the queries return an error, the count reads 0 and the tab stays hidden.

export const REFUNDED_STATUS = 'refunded';
export const REFUNDED_TAG = 'Refunded – relist';
export const REFUNDED_HINT =
  'Sale refunded. Not sellable until a manager relists it with a PIN on the lot page.';

export function isRefundedLot(status: string | null | undefined): boolean {
  return status === REFUNDED_STATUS;
}

/** Show the Refunded tab only when it has lots, or when it is the open tab. */
export function showRefundedTab(count: number, active: boolean): boolean {
  return active || count > 0;
}
