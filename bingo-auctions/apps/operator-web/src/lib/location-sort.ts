// Sort report rows by warehouse bin location — aisle, then bay, then shelf —
// so "2" comes before "10" instead of lexicographic "10" < "2". Used by the
// Missing Items report (missing_items_report(), mig 0426/0452) and the Aging
// Inventory report (aging_inventory_report(), mig 0286/0318/0320).
//
// Bin codes are produced by warehouses/[id]/bins/actions.ts (createBinsBulk)
// as `${aisle}-${bay}-${level}` or `${aisle}-${bay}-${level}-${position}`,
// with bay/level/position zero-padded to 2 digits (mig 0107 renormalized
// older unpadded rows) and `aisle` free text — numeric ("2", "12") or named
// ("Right"). See mig 0001_init (bins.aisle/bay/level/position columns),
// 0107_renormalize_bin_codes (padding), 0108_bins_section (section is a
// separate free-text zone label, not part of the ABLP code).
//
// Neither report RPC exposes bins.aisle/bay/level as separate columns — only
// the already-composed code string (missing_items_report: location_code,
// aging_inventory_report: bin_code) — so this parses the code rather than
// reading structured columns. If a future report starts from bins directly,
// prefer the real aisle/bay/level columns over parsing.
//
// Numeric-vs-named aisles: there is no natural order between "2" and
// "Right", so this puts all-numeric aisles first (ordered numerically), then
// named aisles after them (ordered alphabetically, case-insensitive). State
// this choice wherever the comparator is used in a report, since it is a
// judgment call, not a fact.

export type LocationLike = {
  /** Warehouse name/label this row belongs to. Rows are grouped by warehouse
   *  before location, so two warehouses' rows never interleave. Null/empty
   *  sorts after any named warehouse (same "unknown goes last" rule as a
   *  missing location). */
  warehouseName?: string | null;
  /** The bin/location code, e.g. "2-14-01", "12-12-01", "Right-01-06".
   *  Null/empty = no known location; such rows sort last within their
   *  warehouse group. */
  locationCode?: string | null;
  /** Stable tie-break when warehouse + location are equal (or both empty) —
   *  pass the row's display code / lot code. */
  tieBreak: string;
};

type Segment = { kind: 'num'; value: number } | { kind: 'alpha'; value: string };

function isEmpty(s: string | null | undefined): s is null | undefined {
  return s == null || s.trim().length === 0;
}

function splitSegments(code: string): Segment[] {
  return code
    .split('-')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s): Segment => (/^\d+$/.test(s) ? { kind: 'num', value: Number(s) } : { kind: 'alpha', value: s.toLowerCase() }));
}

/** Numeric aisles/bays/shelves sort before named ones; within a kind, numeric
 *  compares by value (2 < 10) and alpha compares case-insensitively. */
function compareSegment(a: Segment, b: Segment): number {
  if (a.kind === 'num' && b.kind === 'num') return a.value - b.value;
  if (a.kind === 'alpha' && b.kind === 'alpha') return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
  // Mixed kinds: numeric first.
  return a.kind === 'num' ? -1 : 1;
}

/** Compares two location codes segment by segment (aisle, bay, shelf, ...).
 *  Null/empty codes sort last. A code with fewer segments than the other,
 *  but matching on every shared segment, sorts first (it is "less specific",
 *  e.g. an aisle-only code before an aisle+bay code). */
function compareCode(a: string | null | undefined, b: string | null | undefined): number {
  const aEmpty = isEmpty(a);
  const bEmpty = isEmpty(b);
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;

  const segA = splitSegments(a);
  const segB = splitSegments(b);
  const len = Math.max(segA.length, segB.length);
  for (let i = 0; i < len; i++) {
    const sa = segA[i];
    const sb = segB[i];
    if (sa === undefined) return -1;
    if (sb === undefined) return 1;
    const c = compareSegment(sa, sb);
    if (c !== 0) return c;
  }
  return 0;
}

function compareWarehouse(a: string | null | undefined, b: string | null | undefined): number {
  const aEmpty = isEmpty(a);
  const bEmpty = isEmpty(b);
  if (aEmpty && bEmpty) return 0;
  if (aEmpty) return 1;
  if (bEmpty) return -1;
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  return la < lb ? -1 : la > lb ? 1 : 0;
}

/** Pure comparator: warehouse, then location (aisle/bay/shelf, numeric-aware,
 *  nulls last), then a stable tie-break. Pass to Array#sort. */
export function compareLocation(a: LocationLike, b: LocationLike): number {
  const whCmp = compareWarehouse(a.warehouseName, b.warehouseName);
  if (whCmp !== 0) return whCmp;

  const locCmp = compareCode(a.locationCode, b.locationCode);
  if (locCmp !== 0) return locCmp;

  return a.tieBreak < b.tieBreak ? -1 : a.tieBreak > b.tieBreak ? 1 : 0;
}

/** Builds an Array#sort comparator for a row type, given how to read its
 *  warehouse/location/tie-break fields. Keeps compareLocation itself free of
 *  any particular report's row shape. */
export function locationComparator<T>(toKey: (row: T) => LocationLike): (a: T, b: T) => number {
  return (a, b) => compareLocation(toKey(a), toKey(b));
}
