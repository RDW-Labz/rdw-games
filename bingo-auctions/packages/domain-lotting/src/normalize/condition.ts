// Condition normalization.
//
// Maps free-form condition strings (from scrapers, manifests, AI output,
// competitor lots) to the platform's canonical condition vocabulary.
//
// The platform's DB uses these values in import_rows.condition and lots.condition:
//   'appears_new' | 'open_box' | 'good' | 'as_is'
//
// For competitor_lots we also store the raw string in `condition` — this
// normalizer produces the canonical form used in platform-owned rows.

/**
 * Canonical platform condition values.
 * Mirrors the CHECK constraint in import_rows and the lots table.
 */
export type PlatformCondition = 'appears_new' | 'open_box' | 'good' | 'as_is';

/**
 * Normalize a free-form condition string to the platform's four-value
 * vocabulary. Returns `null` when the input is empty or doesn't match
 * any known pattern — never throws.
 *
 * Mapping intent:
 *   appears_new  — new, sealed, like new, factory sealed, refurbished (by mfr)
 *   open_box     — open box, opened, customer return, store return
 *   good         — used, good, fair, very good, tested, functional
 *   as_is        — as-is, damaged, parts only, for parts, broken
 *
 * @example
 *   normalizeCondition("LIKE NEW")   → "appears_new"
 *   normalizeCondition("Open Box")   → "open_box"
 *   normalizeCondition("For Parts")  → "as_is"
 *   normalizeCondition("")           → null
 *   normalizeCondition(null)         → null
 */
export function normalizeCondition(raw: unknown): PlatformCondition | null {
  if (raw == null || raw === '') return null;
  const s = String(raw).toLowerCase().trim();
  if (!s) return null;

  // appears_new — sealed / mint / factory state
  if (
    /new[/\\]?sealed|factory[\s-]?sealed|brand[\s-]?new|sealed[\s-]?box/.test(s) ||
    /^new$/.test(s) ||
    /like[\s-]?new/.test(s) ||
    /appears[\s-]?new/.test(s) ||
    /mint(\s|$)/.test(s) ||
    /refurbished/.test(s)
  ) {
    return 'appears_new';
  }

  // open_box — customer / store return, opened packaging
  if (
    /open[\s-]?box/.test(s) ||
    /opened/.test(s) ||
    /customer[\s-]?return/.test(s) ||
    /store[\s-]?return/.test(s) ||
    /shelf[\s-]?pull/.test(s)
  ) {
    return 'open_box';
  }

  // as_is — damaged, parts, non-functional
  if (
    /as[\s-]?is/.test(s) ||
    /damaged/.test(s) ||
    /for[\s-]?parts/.test(s) ||
    /parts[\s-]?only/.test(s) ||
    /broken/.test(s) ||
    /non[\s-]?functional/.test(s) ||
    /salvage/.test(s)
  ) {
    return 'as_is';
  }

  // good — catch-all for known-working used items
  if (
    /^good$/.test(s) ||
    /^fair$/.test(s) ||
    /^used$/.test(s) ||
    /very[\s-]?good/.test(s) ||
    /tested/.test(s) ||
    /functional/.test(s) ||
    /working/.test(s)
  ) {
    return 'good';
  }

  return null;
}
