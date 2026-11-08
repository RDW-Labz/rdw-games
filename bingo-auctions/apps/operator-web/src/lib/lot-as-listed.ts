// "As listed" read-only snapshot — what staff see when they open a sold
// lot's original listing from the invoice/checkout screen: the exact lot row
// that sold (the caller must pass invoice_lots.lot_id's own row, never the
// newest relist copy or the relist parent — a relist always mints a
// brand-new lots row, so that FK already points at the one true sold row
// forever) plus a best-effort signal for whether its content might have
// changed since the sale.
//
// KNOWN GAP (no migration in this change): lots.title/description/condition/
// photo_urls are NOT locked after a sale — editLot() (./app/(operator)/lots/
// [id]/actions.ts) and savePhotoOrder() (./lots/[id]/photos/actions.ts) both
// write to a 'won' lot same as any other, and the async image-enrichment
// drain can rewrite photo_urls independent of lot status. There is also no
// audit/history table for those fields specifically: lot_status_history only
// logs `status` column changes, and operator_audit_log never gets a
// lot-content-edit row. So the best this can do is flag "lots.updated_at is
// after the sale" — a heuristic, not a diff: it also fires on unrelated
// updates (e.g. a bin reassignment during staging) that never touched
// title/description/condition/photo_urls. See the PR description for the
// full writeup and the fix this rules out (a real snapshot-at-sale-time
// column, which would need a migration).

export type LotAsListedFields = {
  title: string;
  description: string | null;
  condition: string | null;
  photoUrls: string[];
  /** lots.updated_at. Pass null if it could not be loaded. */
  lotUpdatedAt: string | null;
};

export type SaleTimeInfo = {
  /** invoices.paid_at for the invoice this lot actually sold on. */
  paidAt: string | null;
};

export type LotAsListedSnapshot = LotAsListedFields & {
  /** True when lots.updated_at is clearly after the sale, so the content MAY
   *  differ from what the bidder saw when they won it. Never a confirmed
   *  diff — see the gap noted above. Always false when `editCheckPossible`
   *  is false. */
  mayBeEditedAfterSale: boolean;
  /** False when either the sale timestamp (invoices.paid_at) or the lot's
   *  updated_at is missing, so `mayBeEditedAfterSale` could not be evaluated
   *  at all (as opposed to being evaluated and coming back false). The UI
   *  should only render the "edited after sale" note when this is true AND
   *  `mayBeEditedAfterSale` is true — never claim "not edited" from an
   *  unevaluated check. */
  editCheckPossible: boolean;
};

// Same-transaction / clock-skew slack: the server action that marks an
// invoice paid and whatever last touched the lot can land within the same
// second or two without either being "an edit after the sale" in any
// meaningful sense.
const EDIT_DETECTION_BUFFER_MS = 60_000;

export function resolveLotAsListedSnapshot(
  lot: LotAsListedFields,
  sale: SaleTimeInfo,
): LotAsListedSnapshot {
  if (!sale.paidAt || !lot.lotUpdatedAt) {
    return { ...lot, mayBeEditedAfterSale: false, editCheckPossible: false };
  }
  const updatedMs = new Date(lot.lotUpdatedAt).getTime();
  const paidMs = new Date(sale.paidAt).getTime();
  const bothValid = Number.isFinite(updatedMs) && Number.isFinite(paidMs);
  if (!bothValid) {
    return { ...lot, mayBeEditedAfterSale: false, editCheckPossible: false };
  }
  const mayBeEditedAfterSale = updatedMs - paidMs > EDIT_DETECTION_BUFFER_MS;
  return { ...lot, mayBeEditedAfterSale, editCheckPossible: true };
}

export const LOT_CONDITION_LABELS: Record<string, string> = {
  appears_new: 'Appears New',
  open_box: 'Open Box',
  good: 'Good',
  as_is: 'As-Is',
};

export function lotConditionLabel(condition: string | null): string | null {
  if (!condition) return null;
  return LOT_CONDITION_LABELS[condition] ?? condition;
}
