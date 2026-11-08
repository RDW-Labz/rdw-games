// source-key.ts
//
// Stable natural key for UNTRACKED manifest rows uploaded through
// /imports/new, so re-uploading a file collides with what already landed
// instead of cloning every box in it.
//
// WHY THIS EXISTS
// ───────────────
// commitImport upserts on (operator_id, tracking_number). Postgres treats
// NULLs as distinct in a unique btree, so that target can never fire for a
// row without a tracking number — every re-upload re-inserts the whole
// untracked population. That is the exact bug mig 0309 diagnosed and mig
// 0310 fixed for the daily D2L feed (18,297 rows standing in for 923 real
// units, +812/day). The fix there was `import_rows.source_key` plus the
// partial unique index `import_rows_source_key_uniq (operator_id,
// source_key) where source_key is not null`, and scripts/import-d2l-
// manifest.mjs targets it for its untracked rows. The wizard never learned
// to, so the same hole is still open on the UI path — which matters now
// that /imports/new is going into the nav.
//
// KEY SHAPE — 'csv:<16 hex>:<occurrence>'
//
//   'csv:' namespaces these away from the D2L script's 'u:<unit_id>' and
//   'nk:<item_number>:<n>'. The index is operator-wide, not import-scoped,
//   so two producers must never be able to mint the same string.
//
//   The hex is a 64-bit FNV-1a over the file scope + the row's identity
//   columns. 64 bits over a 300k-row table is a ~1-in-4-billion collision
//   chance; a 32-bit hash would collide roughly ten times at that size and
//   silently drop real units.
//
//   The occurrence counter is what lets a file legitimately carry N copies
//   of one identical item: they group together and get :0, :1, :2 … Re-
//   uploading reproduces the same counts in the same order, so they collide
//   one-for-one rather than doubling.
//
// FILE SCOPE — why filename + row count are in the hash
//
//   The D2L script keys globally because it replays ONE feed forever. The
//   wizard takes arbitrary files, and a weekly manifest that ships the same
//   SKU as a genuinely new unit each week would collide with itself under a
//   global key — week two would vanish as a "duplicate". Mixing the
//   filename and the file's total row count into the hash scopes collisions
//   to re-uploads of the same file, which is the case we actually want to
//   dedupe (a retry after a failed chunk, or a nervous second click).
//
// TITLE IS INCLUDED — deliberately unlike mig 0310's (order_id, product_sku)
//   fallback. 0310 had to exclude title because its key FORMAT omitted it:
//   two rows differing only by title would group apart, both take occurrence
//   0, and then render the identical string. Here the hash covers every
//   field it groups on, so a differing title yields a differing key and the
//   rows stay distinct. Strictly more discriminating, no collision risk.

import type { CommitInput } from '@/app/(operator)/imports/actions';

type CommitRow = CommitInput['rows'][number];

/**
 * Identity columns, in a fixed order — changing this order or the set
 * changes every key, which would make one more re-upload look brand new.
 * Deliberately excludes anything a manifest can restate differently for the
 * same physical unit (prices, condition, photo URL, return reason).
 */
const IDENTITY_FIELDS = [
  'external_code',
  'upc',
  'asin',
  'fnsku',
  'lpn',
  'product_sku',
  'sku',
  'site_sku',
  'manufacture_sku',
  'catalog_id',
  'order_id',
  'po_number',
  'pallet_id',
  'title',
] as const satisfies ReadonlyArray<keyof CommitRow>;

/**
 * Unit separator — cannot appear in a spreadsheet cell, so 'a' + 'bc' and
 * 'ab' + 'c' can never hash alike.
 */
const SEP = '\u001f';
/** Record separator — same job, between the file scope and the row tuple. */
const SCOPE_SEP = '\u001e';

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const U64 = 0xffffffffffffffffn;

/**
 * 64-bit FNV-1a, hex, zero-padded to 16 chars. Synchronous by design —
 * crypto.subtle is async and this runs inline while building the payload.
 */
export function fnv1a64(input: string): string {
  let hash = FNV_OFFSET;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * FNV_PRIME) & U64;
  }
  return hash.toString(16).padStart(16, '0');
}

/** The row's identity columns, normalised and joined. Exported for tests. */
export function identityTuple(row: CommitRow): string {
  return IDENTITY_FIELDS.map((field) => {
    const value = row[field];
    return typeof value === 'string' ? value.trim().toLowerCase() : '';
  }).join(SEP);
}

/**
 * Assign `source_key` across a WHOLE file's rows, before chunking.
 *
 * Must see every row at once: the occurrence counter is what separates two
 * identical units, and a counter restarted per chunk would hand the same
 * key to different boxes. The wizard holds the full expanded list at commit
 * time (as the D2L script does), so this is called once there.
 *
 * Tracked rows get `null` — mig 0310 keeps source_key untracked-only so the
 * partial index stays small, and import_rows_tracking_uniq already keys
 * them. Returns new row objects; the input is not mutated.
 */
export function assignSourceKeys(
  rows: CommitRow[],
  opts: { filename: string },
): CommitRow[] {
  const scope = `${opts.filename}${SCOPE_SEP}${rows.length}`;
  const occurrences = new Map<string, number>();

  return rows.map((row) => {
    if (row.tracking_number != null && row.tracking_number.trim() !== '') {
      return { ...row, source_key: null };
    }
    const digest = fnv1a64(`${scope}${SCOPE_SEP}${identityTuple(row)}`);
    const seen = occurrences.get(digest) ?? 0;
    occurrences.set(digest, seen + 1);
    return { ...row, source_key: `csv:${digest}:${seen}` };
  });
}
