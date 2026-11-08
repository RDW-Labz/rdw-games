// Bulk-selection helpers — logic duplicated from InventoryTable.tsx so v2 can
// match v1 rules without editing the classic table.

export type LotWarehouseRef = { id: string; warehouse_id: string | null };

export type OpenAuctionRef = {
  id: string;
  title: string;
  warehouse_id: string;
  ends_at: string;
  status: string;
  warehouses?: { timezone: string } | { timezone: string }[] | null;
};

export function bulkActionBarVisible(canEdit: boolean, selectedCount: number): boolean {
  return canEdit && selectedCount > 0;
}

/** Assign affordance is shown only when the viewer can edit and the bucket allows assign. */
export function bulkAssignOffered(canEdit: boolean, canAssign: boolean): boolean {
  return canEdit && canAssign;
}

/** v1 disables assign when selection spans multiple warehouses (or none with a warehouse). */
export function bulkAssignEnabled(selectedWarehouseId: string | null): boolean {
  return selectedWarehouseId != null;
}

export function selectedWarehouseIdForLots(
  selectedIds: ReadonlySet<string>,
  lots: LotWarehouseRef[],
): string | null {
  if (selectedIds.size === 0) return null;
  const wids = new Set<string>();
  for (const lot of lots) {
    if (selectedIds.has(lot.id) && lot.warehouse_id) wids.add(lot.warehouse_id);
  }
  if (wids.size !== 1) return null;
  const [only] = wids;
  return only ?? null;
}

export function filterEligibleAuctions(
  openAuctions: OpenAuctionRef[],
  selectedWarehouseId: string | null,
): OpenAuctionRef[] {
  if (!selectedWarehouseId) return [];
  return openAuctions.filter((a) => a.warehouse_id === selectedWarehouseId);
}

/** Mirrors InventoryTable onSetPrice dollars → cents conversion and validation. */
export function dollarsToStartingBidCents(
  bulkBidDollars: string,
): { ok: true; cents: number } | { ok: false; message: string } {
  const dollars = Number(bulkBidDollars);
  if (!Number.isFinite(dollars) || dollars < 1) {
    return { ok: false, message: 'Starting bid must be at least $1.00.' };
  }
  return { ok: true, cents: Math.round(dollars * 100) };
}

export function isBulkErrorFeedback(message: string): boolean {
  return message.startsWith('Could not');
}
