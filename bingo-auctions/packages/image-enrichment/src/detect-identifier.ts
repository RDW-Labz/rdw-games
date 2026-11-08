// detect-identifier.ts
//
// Pure function: given a bag of potential identifiers from an import row,
// returns the strongest recognised identifier kind and its cleaned value.
//
// Priority order: ASIN > UPC (includes EAN-13) > ISBN
//
// All detection is shape-only — no network calls, no API keys.
//
// Used by the image-enrichment-drain to decide which upstream module
// to dispatch (amazon-asin-image | open-food-facts-image | open-library-image).

export type IdentifierKind = 'asin' | 'upc' | 'isbn';

export interface DetectedIdentifier {
  kind: IdentifierKind | null;
  /** Cleaned (trimmed) value, or empty string when kind is null. */
  value: string;
}

// ── Shape regexes ─────────────────────────────────────────────────────────────

/** ASIN: exactly 10 alphanumeric chars, must start with B0 (product ASIN). */
const ASIN_RE = /^B0[A-Z0-9]{8}$/;

/** UPC-A: exactly 12 decimal digits. */
const UPC_A_RE = /^\d{12}$/;

/** EAN-13: exactly 13 decimal digits (includes ISBN-13 with 978/979 prefix). */
const EAN_13_RE = /^\d{13}$/;

/**
 * ISBN-13: 13 decimal digits whose prefix is 978 or 979.
 * (EAN-13 values that are NOT 978/979 are UPC-like barcodes for non-book goods.)
 */
const ISBN_13_RE = /^97[89]\d{10}$/;

/**
 * ISBN-10: 9 decimal digits + optional uppercase X check digit.
 * Note: We only use this when no stronger identifier is present.
 */
const ISBN_10_RE = /^\d{9}[\dX]$/i;

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Inspect a row's identifier fields and return the highest-priority
 * recognised identifier.
 *
 * @param fields - Subset of an import_row / lot containing the identifier columns.
 * @returns `{ kind, value }` where kind is null when nothing recognisable is found.
 */
export function detectIdentifier(fields: {
  upc?: string | null;
  asin?: string | null;
  fnsku?: string | null;
  lpn?: string | null;
  external_code?: string | null;
}): DetectedIdentifier {
  // ── 1. ASIN (highest priority) ────────────────────────────────────────────
  // Primary ASIN column only. FNSKU and LPN are warehouse barcodes — they are
  // NOT ASINs and the Amazon probe URL requires a real ASIN. We intentionally
  // skip fnsku / lpn here to avoid bogus 404s.
  const asinRaw = fields.asin?.trim().toUpperCase() ?? '';
  if (ASIN_RE.test(asinRaw)) {
    return { kind: 'asin', value: asinRaw };
  }

  // ── 2. UPC (second priority) ──────────────────────────────────────────────
  // Try dedicated upc column first, then external_code as fallback.
  // EAN-13 that is NOT an ISBN-13 prefix → treat as UPC for Open Food Facts.
  const upcCandidates = [fields.upc, fields.external_code];
  for (const raw of upcCandidates) {
    const v = raw?.trim() ?? '';
    if (!v) continue;

    if (UPC_A_RE.test(v)) {
      return { kind: 'upc', value: v };
    }
    if (EAN_13_RE.test(v) && !ISBN_13_RE.test(v)) {
      // EAN-13 that is not ISBN-13 → treat as UPC for OFF lookup.
      return { kind: 'upc', value: v };
    }
  }

  // ── 3. ISBN ───────────────────────────────────────────────────────────────
  // Check both UPC column (manifests sometimes put ISBN-13 there) and
  // external_code, in the same priority order.
  for (const raw of upcCandidates) {
    const v = raw?.trim() ?? '';
    if (!v) continue;

    if (ISBN_13_RE.test(v)) {
      return { kind: 'isbn', value: v };
    }
    if (ISBN_10_RE.test(v)) {
      return { kind: 'isbn', value: v };
    }
  }

  return { kind: null, value: '' };
}
