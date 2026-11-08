// Typed bin codes are only unique WITHIN a warehouse: every location is laid
// out 1-01-01, 3-09-01, ... (59 codes repeat across Harrison, Dodge City,
// Springdale and Crandall). A typed-code lookup must be scoped to a warehouse
// and to active, unretired bins; this turns the rows it got back into one bin,
// none, or "several" with plain staff text. Pure, so it is tested without a device.

export type TypedBinRow = { code: string; warehouse_id: string | null };
export type TypedBinResult<T extends TypedBinRow> =
  | { kind: 'one'; bin: T }
  | { kind: 'none'; title: string; detail: string }
  | { kind: 'many'; title: string; detail: string };

export function resolveTypedBin<T extends TypedBinRow>(
  rows: readonly T[],
  code: string,
  warehouseName: string | null,
  warehouseNames: ReadonlyMap<string, string> = new Map(),
): TypedBinResult<T> {
  if (rows.length === 1) return { kind: 'one', bin: rows[0]! };
  if (rows.length === 0) {
    return {
      kind: 'none',
      title: 'Unknown bin code',
      detail: warehouseName
        ? `No active bin "${code}" at ${warehouseName}. Check the bin label, or switch location if you're at a different building.`
        : `No active bin "${code}" exists for your operator. Check the bin label, or create the bin in Warehouse layout first.`,
    };
  }
  const where = [...new Set(rows.map((r) => (r.warehouse_id && warehouseNames.get(r.warehouse_id)) || 'another location'))];
  return {
    kind: 'many',
    title: 'Several bins have that code',
    detail: `"${code}" exists at ${where.join(', ')}. Scan the bin's QR code, or switch to the right location and try again.`,
  };
}
