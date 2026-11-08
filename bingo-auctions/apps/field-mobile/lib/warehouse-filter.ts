// Client-side warehouse list filter for staff pickup/checkout screens.
//
// Default (warehouseId null/undefined) must leave queries and row sets unchanged;
// callers apply this after fetch. Rows with no warehouse id are always kept so a
// partial embed or legacy row never hides work from staff.

export function filterRowsByWarehouse<T>(
  rows: readonly T[],
  warehouseId: string | null | undefined,
  getWarehouseId: (row: T) => string | null | undefined,
): T[] {
  if (!warehouseId) return [...rows];
  return rows.filter((row) => {
    const wid = getWarehouseId(row);
    if (wid == null || wid === '') return true;
    return wid === warehouseId;
  });
}

export function filterByWarehouseId<T extends { warehouse_id?: string | null }>(
  rows: readonly T[],
  warehouseId: string | null | undefined,
): T[] {
  return filterRowsByWarehouse(rows, warehouseId, (row) => row.warehouse_id);
}
