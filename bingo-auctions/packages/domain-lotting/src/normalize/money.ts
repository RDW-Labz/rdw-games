// Money / price normalization.
//
// Canonical implementation for every ingestion path. DB-side mirror:
// parse_dollars_to_cents() in migration 0038_normalize_helpers.sql.
//
// All monetary values on the platform are stored as integer cents (BIGINT).
// Float dollars are only used at the display layer.

/**
 * Parse a dollar-amount string (or number) into integer cents.
 *
 * Strips `$`, commas, and whitespace. Handles negative values by returning
 * `null` — we never store negative prices. Returns `null` on any input that
 * can't be coerced cleanly.
 *
 * @example
 *   parseCents("$1,234.56") → 123456
 *   parseCents("1234.56")   → 123456
 *   parseCents(1234.56)     → 123456
 *   parseCents("free")      → null
 *   parseCents(null)        → null
 *   parseCents("")          → null
 */
export function parseCents(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw >= 0 ? Math.round(raw * 100) : null;
  }
  const cleaned = String(raw).replace(/[$,\s]/g, '');
  if (cleaned === '' || cleaned === '-') return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

/**
 * Format integer cents as a USD currency string for display.
 *
 * Returns `''` for null/undefined — callers can use `|| '—'` for display.
 *
 * @example
 *   centsToDollars(123456) → "$1,234.56"
 *   centsToDollars(null)   → ""
 */
export function centsToDollars(cents: number | null | undefined): string {
  if (cents == null) return '';
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
  });
}

/**
 * Safe `parseFloat` that returns `null` instead of `NaN`.
 * Useful for parsing scraper numeric fields that may be strings or missing.
 */
export function safeParseFloat(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : parseFloat(String(raw));
  return Number.isFinite(n) ? n : null;
}
