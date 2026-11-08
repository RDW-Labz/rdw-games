// scan-extract — public API.
//
// Converts a raw barcode scan + symbology into a deduped candidate array
// suitable for passing to the find_import_row_by_scan RPC.
//
// Design principles:
//   - Format-coupled, never vendor-coupled.
//   - Pure functions, no I/O.
//   - Candidates are ordered: raw first, then by specificity.

import { parseGs1Candidates } from './gs1';
import { extractTrackingCandidates } from './tracking';
import { extractRetailCandidates } from './retail';
import { extractIdentifierShapes } from './identifier-shapes';

export { isNonUpcCode } from './product-code';

// ---------------------------------------------------------------------------
// Symbology union
//
// A superset of vision-camera v4's CodeType | 'unknown'. The exact CodeType
// values from react-native-vision-camera v4 (kebab-case) map 1:1 here; any
// value not in this union should be cast to 'unknown' at the call site.
//
// Vision-camera CodeType values confirmed from apps/field-mobile/lib/vision-camera.ts:
//   'qr', 'upc-a', 'upc-e', 'ean-8', 'ean-13', 'code-128', 'code-39',
//   'code-93', 'codabar', 'itf-14', 'pdf-417', 'aztec', 'data-matrix'
// ---------------------------------------------------------------------------
export type Symbology =
  | 'qr'
  | 'data-matrix'
  | 'pdf-417'
  | 'aztec'
  | 'code-128'
  | 'code-39'
  | 'code-93'
  | 'codabar'
  | 'itf-14'
  | 'upc-a'
  | 'upc-e'
  | 'ean-8'
  | 'ean-13'
  | 'unknown';

export interface ScanCandidates {
  /** The original raw scan value, untouched. */
  raw: string;
  /**
   * Deduped candidate strings in priority order.
   * `raw` is always candidates[0].
   * Subsequent entries are values extracted by format-specific parsers.
   */
  candidates: string[];
}

/**
 * Extract scan candidates from a raw barcode value and its detected symbology.
 *
 * The returned `candidates` array is safe to pass directly as `p_candidates`
 * to the `find_import_row_by_scan` RPC.
 *
 * Extraction pipeline (order determines candidate priority after raw):
 *   1. GS1-128 / Data-Matrix AI parsing (FNC1 prefix detection)
 *   2. Carrier tracking shape extraction (SSCC-22 last-12, USPS IMpb)
 *   3. Retail normalisation (UPC-E expansion, EAN-13→UPC-12, ITF-14 strip)
 *   4. Identifier shape detection (FNSKU, ASIN, LPN-like)
 *
 * Always returns `raw` as the first candidate regardless of other results.
 */
export function extractScanCandidates(value: string, type: Symbology): ScanCandidates {
  const raw = value;
  const seen = new Set<string>();
  const ordered: string[] = [];

  const add = (s: string): void => {
    if (s.length > 0 && !seen.has(s)) {
      seen.add(s);
      ordered.push(s);
    }
  };

  // raw is always first.
  add(raw);

  // 1. GS1-128 / Data-Matrix AI parsing (applicable to code-128, data-matrix, qr).
  if (type === 'code-128' || type === 'data-matrix' || type === 'qr') {
    for (const c of parseGs1Candidates(raw)) add(c);
  }

  // 2. Carrier tracking shapes.
  for (const c of extractTrackingCandidates(raw, type)) add(c);

  // 3. Retail normalisation.
  for (const c of extractRetailCandidates(raw, type)) add(c);

  // 4. Identifier shape detection (skip if already fully extracted above).
  for (const c of extractIdentifierShapes(raw)) add(c);

  return { raw, candidates: ordered };
}
