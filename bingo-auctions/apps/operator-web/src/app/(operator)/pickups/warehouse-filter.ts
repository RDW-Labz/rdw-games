// Pure warehouse filter helpers for the pickups dashboard (?warehouse= search param).

export function resolveActiveWarehouseId(
  param: string | undefined,
  warehouseIds: readonly string[],
): string | null {
  const id = (param ?? '').trim();
  if (!id) return null;
  return warehouseIds.includes(id) ? id : null;
}

/** When activeWarehouseId is null, returns rows unchanged (same reference semantics as spread copy). */
export function filterPickupsByWarehouseId<T extends { warehouse_id?: string | null }>(
  rows: readonly T[],
  activeWarehouseId: string | null,
): T[] {
  if (!activeWarehouseId) return [...rows];
  return rows.filter((row) => {
    const wid = row.warehouse_id;
    // Fail open: legacy/missing warehouse_id must not hide pickups from staff.
    if (wid == null || wid === '') return true;
    return wid === activeWarehouseId;
  });
}

export function filterMissingItemsByWarehouseId<T extends { warehouseId?: string | null }>(
  rows: readonly T[],
  activeWarehouseId: string | null,
): T[] {
  if (!activeWarehouseId) return [...rows];
  return rows.filter((row) => {
    const wid = row.warehouseId;
    if (wid == null || wid === '') return true;
    return wid === activeWarehouseId;
  });
}
