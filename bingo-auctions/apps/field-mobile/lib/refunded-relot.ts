// 0475: a fully refunded sale whose item never left is status 'refunded'. It
// goes back to inventory only through relist_refunded_lot() (manager PIN,
// typed name, reason, audit row), presented by /lotting/relot.
//
// Lot Lookup (the screen staff already have open at the shelf) used to dead-end
// on that status: its action block only knew unsold/in_inventory/relisted/won,
// so scanning a refunded box showed "can't be relotted from here" and staff had
// to know to open Inventory -> Refunded instead. Route them to the one existing
// form rather than duplicating the manager-PIN logic in another screen.

export type RefundedRelotTarget = {
  pathname: '/lotting/relot';
  params: { code: string };
};

export function refundedRelotTarget(input: {
  status: string;
  lotCode: string;
  /** An existing child means the item already has its new listing. */
  relotChildCode: string | null;
}): RefundedRelotTarget | null {
  if (input.status !== 'refunded') return null;
  if (input.relotChildCode) return null;
  return { pathname: '/lotting/relot', params: { code: input.lotCode } };
}
