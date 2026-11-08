// Text field normalization.
//
// Canonical implementations for brand, model, title, and CSV header
// normalization. Every ingestion path (CSV importer, scraper, AI output,
// mobile capture) must route through these functions.

// Sentinel strings that scrapers / retailers emit instead of a real value.
// Checked case-insensitively after trimming.
const EMPTY_SENTINELS = new Set([
  '',
  'null',
  'n/a',
  'na',
  'none',
  'unknown',
  '-',
  '--',
  'n.a.',
  'n.a',
  'not available',
  'not applicable',
]);

/**
 * Normalize a brand name.
 *
 * - Trims surrounding whitespace.
 * - Returns `null` for empty strings and common null-sentinel values that
 *   scrapers emit (e.g. "N/A", "null", "unknown").
 * - Preserves display case — do NOT lowercase unless doing a comparison.
 *
 * DB-side mirror: normalize_brand() in 0038_normalize_helpers.sql.
 */
export function normalizeBrand(raw: unknown): string | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (EMPTY_SENTINELS.has(trimmed.toLowerCase())) return null;
  return trimmed || null;
}

/**
 * Normalize a model number / part number.
 *
 * Same sentinel-stripping as normalizeBrand. Also trims.
 */
export function normalizeModel(raw: unknown): string | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim();
  if (EMPTY_SENTINELS.has(trimmed.toLowerCase())) return null;
  return trimmed || null;
}

/**
 * Normalize a product title.
 *
 * Trims and collapses internal runs of whitespace. Returns `null` for
 * empty / sentinel strings.
 */
export function normalizeTitle(raw: unknown): string | null {
  if (raw == null) return null;
  const trimmed = String(raw).trim().replace(/\s+/g, ' ');
  if (EMPTY_SENTINELS.has(trimmed.toLowerCase())) return null;
  return trimmed || null;
}

/**
 * Normalize a CSV column header for pattern matching.
 *
 * Lowercases, strips zero-width characters, trims, and collapses internal
 * whitespace. Amazon/Wayfair manifests ship headers like ` Retail ` and
 * ` Ext Retail ` with leading/trailing spaces; this strips them so the
 * HEADER_PATTERNS regexes can fire reliably.
 *
 * Used by: ImportWizard.tsx (CSV column auto-detection).
 */
export function normalizeHeader(header: string): string {
  return String(header)
    .toLowerCase()
    .replace(/[​‌‍﻿]/g, '') // zero-width / BOM chars
    .trim()
    .replace(/\s+/g, ' ');
}
