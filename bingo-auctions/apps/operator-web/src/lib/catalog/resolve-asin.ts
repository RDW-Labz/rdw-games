// Quick Lot miss escalation: resolve a scanned ASIN by fetching its Amazon
// product page through the egress chain (Bright Data Web Unlocker) and writing
// the normalized result into the master catalog. Today a non-UPC miss (ASIN /
// FNSKU / LPN) returns null from lookupByCode — an ASIN scan of an item not yet
// in the catalog is a dead end. An ASIN maps 1:1 to a public Amazon page, so we
// can just fetch + parse it (unlike FNSKU/LPN, which are Amazon-internal codes
// with no public URL).
//
// Reuses the scrape-url route's parsers (extractProduct / classifyBlock /
// isHollowResult) and the catalog read/write-through — so a resolved ASIN is
// scraped at most once, then served from the catalog forever after.

import type { SupabaseClient } from '@supabase/supabase-js';
import { egressConfigured, fetchViaEgress } from '@/lib/scrape-egress';
import {
  extractProduct,
  classifyBlock,
  isHollowResult,
} from '@/app/api/lottr/scrape-url/route';
import { readScrapeCache, writeScrapeCache } from './scrape-cache';

/** True for a modern Amazon ASIN (B0 + 8 alphanumerics). Conservative: we only
 *  auto-scrape codes that are unambiguously an ASIN, not bare 10-digit ISBNs or
 *  UPC-shaped numbers (those go through the UPC/SERP path instead). */
export function isAsinCode(code: string): boolean {
  return /^B0[0-9A-Z]{8}$/i.test(code.trim());
}

/**
 * Fetch amazon.com/dp/<ASIN> via the egress chain and write the parsed product
 * into the master catalog. Returns true when a real product page was cataloged
 * (so the caller can re-run lookupByCode and get a cache hit), false otherwise.
 * Best-effort: never throws.
 */
export async function resolveAsinIntoCatalog(
  admin: SupabaseClient,
  asin: string,
): Promise<boolean> {
  try {
    const clean = asin.trim().toUpperCase();
    if (!isAsinCode(clean)) return false;
    const url = `https://www.amazon.com/dp/${clean}`;

    // Already cataloged (e.g. a prior scrape)? Then there's nothing to fetch —
    // the caller's lookupByCode retry will hit it.
    if (await readScrapeCache(admin, url)) return true;
    if (!egressConfigured()) return false;

    const egress = await fetchViaEgress(url);
    if (egress.kind !== 'ok') return false;

    const warnings: string[] = [];
    const data = extractProduct(egress.html, egress.finalUrl, true, warnings);
    if (classifyBlock(egress.html).blocked || isHollowResult(data)) return false;

    await writeScrapeCache(admin, url, data);
    return true;
  } catch {
    return false;
  }
}
