// expand-tracking.ts
//
// Wayfair manifest fix: vendors occasionally pack multiple FedEx tracking
// numbers into one `ReturnTrackingNumber` cell (`"A, B"` or `"A B"` or
// `"A B C D"`). Each physical box needs its own scannable `import_rows` row.
//
// Previously the split lived inline in ImportWizard.tsx and only handled
// COMMAS — space-separated rows landed as one dirty multi-tracking row.
// Mig 0156's token-LIKE fallback exists ONLY to work around those dirty
// rows. Switching to `[\s,]+` here + filtering to 12-14 digit tokens lets
// us delete the LIKE fallback once dirty data is migrated (see mig 0163).
//
// Exporting the helpers (instead of inline definitions) makes them
// unit-testable without rendering the whole ImportWizard React tree.

import type { CommitInput } from '@/app/(operator)/imports/actions';

/** Split on any run of whitespace and/or commas. */
export const TRACKING_SPLIT_RE = /[\s,]+/;

/**
 * Valid tracking token: 12-14 digits.
 * Rejects annotation tokens that occasionally leak into the cell:
 *   - "d/d"           (delivery disposition shorthand)
 *   - "DD"            (same)
 *   - "disposal"
 *   - "vERT-..."      (Wayfair internal return ticket prefix)
 *   - "CS653238180"   (carrier-internal return note format)
 */
export const TRACKING_TOKEN_RE = /^\d{12,14}$/;

/**
 * Count how many scannable boxes a raw tracking_number cell expands to.
 * Used by the import preview ("Will create N rows") so the displayed count
 * matches what `expandRowsByTracking` will actually produce.
 *
 * Returns at least 1 — every parsed import row produces at least one
 * `import_rows` insert, even when `tracking_number` is null or empty.
 */
export function countTrackingTokens(raw: string): number {
  const trimmed = raw.trim();
  if (!trimmed) return 1;
  const parts = trimmed
    .split(TRACKING_SPLIT_RE)
    .map((t) => t.trim())
    .filter((t) => TRACKING_TOKEN_RE.test(t));
  return Math.max(1, parts.length);
}

/**
 * Split a row with N tracking-number tokens into N rows, each with one
 * `tracking_number`, sharing all other product data. Rows with no
 * tracking pass through once with `tracking_number = null` (still
 * lottable by other identifiers — ASIN, FNSKU, LPN, UPC, etc.).
 *
 * Dedup within file: if two manifest rows share an extracted token,
 * only the FIRST row's product data is kept (later rows would conflict
 * on the `(operator_id, tracking_number)` unique index anyway).
 */
export function expandRowsByTracking(rows: CommitInput['rows']): CommitInput['rows'] {
  const out: CommitInput['rows'] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const raw = row.tracking_number?.trim();
    if (!raw) {
      out.push({ ...row, tracking_number: null });
      continue;
    }
    const parts = raw
      .split(TRACKING_SPLIT_RE)
      .map((t) => t.trim())
      .filter((t) => TRACKING_TOKEN_RE.test(t));
    if (parts.length === 0) {
      // Cell had something, but no valid token (e.g. "d/d" only).
      // Land the row once with null tracking — still lottable.
      out.push({ ...row, tracking_number: null });
      continue;
    }
    for (const t of parts) {
      const tracking = t.slice(0, 64); // belt-and-suspenders cap on DB column width
      if (seen.has(tracking)) continue; // within-file dedup: one box per tracking
      seen.add(tracking);
      out.push({ ...row, tracking_number: tracking });
    }
  }
  return out;
}
