// Which scanned codes the catalog lookup must refuse outright, before the
// cache read. Pure decision; the manifest query is injected by the caller.
//
// ── WHY ──────────────────────────────────────────────────────────────────────
// 2026-09-24: a FedEx 12-digit tracking number is UPC-A length, and
// lookupByCode's looksLikeUpc checks length only — so every tracking number
// that missed the manifest went to Sonar as if it were a UPC, and whatever Sonar
// invented was cached in the platform-shared product_lookups table. Prod held 16
// such rows keyed by manifest tracking numbers, 13 with invented products
// ("Doritos" for a Roman shade, "AirPods Pro 3" for a standing desk). The
// route's older non-GTIN guard ran AFTER lookupByCode, so it never protected
// that step, and the fast path served a cached invention instantly. Same class
// as the 2026-09-21 FNSKU misfire (#355): a shipping label turned into a
// product and offered to staff as a match.
//
// Two refusals, both for bare-numeric codes only (typed keywords/models and
// ASIN/FNSKU shapes are unaffected):
//   non_gtin_numeric  — fails the GS1 check digit (or is not 8/12/13/14 long):
//                       a carrier/SSCC/internal label, never a retail barcode.
//   manifest_tracking — a valid-looking GTIN that is a tracking number on one of
//                       this operator's manifest rows: ~1 in 10 FedEx numbers
//                       passes the UPC check digit by chance (2 of the 16).
// A real product scan is neither, so it is looked up exactly as before.

import { isValidGtinCheckDigit } from '@auction-platform/domain-lotting';

export type CatalogRefusal = 'non_gtin_numeric' | 'manifest_tracking';

/**
 * @param isManifestTracking resolves true when `code` is a tracking number on
 *   one of the caller's import_rows. If it throws, the manifest rule is skipped
 *   and only the check-digit rule applies — a DB hiccup must not block scans.
 */
export async function catalogRefusal(
  code: string,
  isManifestTracking: (code: string) => Promise<boolean>,
): Promise<CatalogRefusal | null> {
  if (!/^\d+$/.test(code)) return null;
  if (!isValidGtinCheckDigit(code)) return 'non_gtin_numeric';
  try {
    if (await isManifestTracking(code)) return 'manifest_tracking';
  } catch {
    // See @param.
  }
  return null;
}
