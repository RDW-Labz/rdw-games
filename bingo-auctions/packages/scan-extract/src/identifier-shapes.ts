// Identifier shape detection — pattern-only, NO network calls.
//
// Recognises marketplace identifier shapes from raw barcode data.
// "Shape" means: regex / length / prefix heuristics only.
// No API calls, no database lookups, no vendor-specific logic trees.
//
// Shapes detected:
//   FNSKU:    X00... exactly 10 chars (alphanumeric after X00)
//   ASIN:     B0[A-Z0-9]{8} — 10 chars, starts B0
//   LPN-like: alphanumeric 12-18 chars (broad catch-all for unit barcodes)
//
// LPN-like is intentionally broad. The RPC probes the lpn column first
// (more specific) before falling through to other columns, so false
// positives here only cost a fast indexed miss, not a wrong match.

/** FNSKU shape: exactly 10 chars, starts with X00. */
const FNSKU_PATTERN = /^X00[A-Z0-9]{7}$/i;

/** ASIN shape: exactly 10 chars, starts with B0, rest alphanumeric. */
const ASIN_PATTERN = /^B0[A-Z0-9]{8}$/i;

/** LPN-like: 12–18 alphanumeric chars (mixed case / digits). */
const LPN_LIKE_PATTERN = /^[A-Z0-9]{12,18}$/i;

/**
 * Detect identifier shapes in `raw`.
 *
 * Returns values to add as candidates (which may equal `raw` — the caller
 * deduplicates). Returns an empty array when no shape is detected.
 *
 * Note: the caller always prepends `raw` as the first candidate, so
 * returning `raw` here is harmless (dedup removes it).
 */
export function extractIdentifierShapes(raw: string): string[] {
  // Skip strings that are pure numerics — those are handled by retail.ts
  // (UPC/EAN/ITF) or tracking.ts (SSCC/USPS). Adding them here would only
  // create noise against non-numeric identifier columns.
  if (/^\d+$/.test(raw)) return [];

  const results: string[] = [];

  if (FNSKU_PATTERN.test(raw)) {
    results.push(raw);
  } else if (ASIN_PATTERN.test(raw)) {
    results.push(raw);
  } else if (LPN_LIKE_PATTERN.test(raw)) {
    // Only add if not already added by the above patterns.
    results.push(raw);
  }

  return results;
}
