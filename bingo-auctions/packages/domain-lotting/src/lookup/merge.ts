// Convert raw eBay / OpenRouter search results into a ProductLookup row ready
// for upsert into product_lookups. Pure function — no I/O.
//
// The auction-startBid signal is median_sold_cents × 0.30 when sold
// data is available; otherwise we fall back to avg_asking_cents × 0.25
// (asking prices skew higher than realized, hence the lower multiplier).
//
// Untrusted-URL handling: image URLs from eBay (or any external source)
// are filtered through `isSafeImageUrl` before storing. This is the
// security boundary between unverified third-party data and the bidder-
// rendered URL — closes the cross-tenant XSS / Referer-leak / image-decoder
// CVE surface called out in the security audit (finding M2).
//
// IMPORTANT: isSafeImageUrl, filterSafeImageUrls, mostCommon, median, and
// average are canonical implementations in normalize/. This file imports
// from there rather than defining its own copies.

import type {
  ProductLookup,
  RetailerPricePoint,
  SoldComp,
  ProductLookupSource,
} from './types';
import { type EbaySummaryItem, priceToCents } from './ebay';
import {
  type OpenRouterListing,
  type OpenRouterSearchResult,
} from './openrouter';
import {
  isSafeImageUrl,
  filterSafeImageUrls,
  mostCommon,
  median,
  average,
} from '../normalize';
import { extractBrand } from '../normalize/brand';

// SKU/model-number-shaped token within a free-text title. Examples that hit:
//   "DCD771C2"  "WD-40-12345"  "L3500X"  "MSI-G27CQ4"  "RX580"
// Requires at least one letter AND one digit, total length 4-20, allows
// hyphens. Returns the first match — title order roughly correlates with
// retailer-side prominence (brand → model → variant), so the leftmost
// SKU-shaped token is usually the canonical model.
const MODEL_TOKEN_RE = /\b(?=[A-Z0-9-]*[A-Z])(?=[A-Z0-9-]*[0-9])[A-Z][A-Z0-9-]{3,19}\b/;

function extractModelFromTitle(title: string): string | null {
  const m = MODEL_TOKEN_RE.exec(title);
  return m ? m[0] : null;
}

// Re-export for callers that import from this path (backwards compat).
export { isSafeImageUrl, filterSafeImageUrls };
// ALLOWED_IMAGE_HOSTS is the authoritative set; re-export for callers that
// need it for ad-hoc checks (e.g. tests).
export { ALLOWED_IMAGE_HOSTS } from '../normalize/images';

export type EbayInputs = {
  active: EbaySummaryItem[];
  sold: EbaySummaryItem[];
};

export function mergeEbayResults(upc: string, inputs: EbayInputs): ProductLookup {
  const { active, sold } = inputs;

  // Deduplicate images across active items, prefer the higher-res `image`
  // field over thumbnail. Filter through isSafeImageUrl so non-https or
  // non-allowlisted hosts never reach product_lookups. Cap at 6.
  const imageSet = new Set<string>();
  for (const it of active) {
    if (it.image?.imageUrl && isSafeImageUrl(it.image.imageUrl)) {
      imageSet.add(it.image.imageUrl);
    }
    for (const t of it.thumbnailImages ?? []) {
      if (t.imageUrl && isSafeImageUrl(t.imageUrl)) imageSet.add(t.imageUrl);
    }
    if (imageSet.size >= 6) break;
  }
  const image_urls = Array.from(imageSet).slice(0, 6);

  // Brand / model — pick the most-common non-null value across active hits.
  const brand = mostCommon(active.map((i) => i.brand).filter(Boolean) as string[]);
  const model = mostCommon(active.map((i) => i.mpn).filter(Boolean) as string[]);

  // Title — pick the longest title from the top 3 listings (longer titles
  // tend to include model + variant info).
  const title =
    [...active]
      .slice(0, 3)
      .map((i) => i.title)
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)[0] ?? null;

  // Category — pick the most-common categoryPath.
  const category_raw = mostCommon(
    active.map((i) => i.categoryPath).filter(Boolean) as string[],
  );

  // Active asking prices.
  const askingCents = active
    .map((i) => priceToCents(i.price))
    .filter((c): c is number => c !== null);
  const avg_asking_cents = average(askingCents);

  // Sold comps + median.
  const soldCents = sold
    .map((i) => priceToCents(i.price))
    .filter((c): c is number => c !== null);
  const median_sold_cents = median(soldCents);

  // Suggested startBid: 30% of sold median, else 25% of asking avg.
  let start_bid_cents: number | null = null;
  if (median_sold_cents) start_bid_cents = Math.round(median_sold_cents * 0.3);
  else if (avg_asking_cents) start_bid_cents = Math.round(avg_asking_cents * 0.25);
  if (start_bid_cents !== null && start_bid_cents < 100) start_bid_cents = 100;

  const now = new Date().toISOString();

  const prices: RetailerPricePoint[] = active.slice(0, 5).map((i) => ({
    retailer: 'eBay',
    cents: priceToCents(i.price) ?? 0,
    url: i.itemWebUrl ?? '',
    fetched_at: now,
  }));

  const sold_comps: SoldComp[] = sold.slice(0, 10).map((i) => ({
    title: i.title ?? '',
    cents: priceToCents(i.price) ?? 0,
    sold_at: i.itemSoldDate ?? i.itemEndDate ?? now,
    condition: i.condition ?? '',
    url: i.itemWebUrl ?? '',
  }));

  const sources: ProductLookupSource[] = [];
  if (active.length) sources.push('ebay_browse');
  if (sold.length) sources.push('ebay_sold');

  // Confidence:
  //   high   = ≥3 active + ≥3 sold OR brand+model both resolved
  //   medium = ≥1 active hit
  //   low    = anything but no hits
  //   none   = zero data; caller turns this into a negative-cache row
  let confidence: ProductLookup['confidence'];
  if (!active.length && !sold.length) {
    confidence = 'none';
  } else if (
    (active.length >= 3 && sold.length >= 3) ||
    (brand && model)
  ) {
    confidence = 'high';
  } else if (active.length >= 1) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }

  return {
    upc,
    title,
    brand,
    model,
    category_id: null,             // resolved later via category_aliases adapter
    category_raw,
    image_urls,
    // eBay doesn't reliably expose Amazon identifiers; leave null.
    // If the caller already knows the ASIN (e.g., from a competitor import),
    // they should merge it in via upsertLookup which calls mergeNonNull.
    asin: null,
    fnsku: null,
    lpn: null,
    mpn: model ?? null,            // eBay MPN field maps to mpn when model is resolved
    external_codes: [],
    msrp_cents: null,              // eBay doesn't expose MSRP
    avg_asking_cents,
    median_sold_cents,
    start_bid_cents,
    prices,
    sold_comps,
    description: null,
    specs: null,
    confidence,
    sources,
    identity_refreshed_at: now,
    prices_refreshed_at: confidence === 'none' ? null : now,
    created_at: now,
    updated_at: now,
  };
}

// Build a negative-cache row for a UPC that returned no results from any
// source. The 7d TTL is enforced by the cache reader, not stored here.
export function negativeRow(upc: string): ProductLookup {
  const now = new Date().toISOString();
  return {
    upc,
    title: null,
    brand: null,
    model: null,
    category_id: null,
    category_raw: null,
    image_urls: [],
    asin: null,
    fnsku: null,
    lpn: null,
    mpn: null,
    external_codes: [],
    msrp_cents: null,
    avg_asking_cents: null,
    median_sold_cents: null,
    start_bid_cents: null,
    prices: [],
    sold_comps: [],
    description: null,
    specs: null,
    confidence: 'none',
    sources: [],
    identity_refreshed_at: now,
    prices_refreshed_at: null,
    created_at: now,
    updated_at: now,
  };
}

// ── ASIN extraction from URLs ─────────────────────────────────────────────────
//
// Amazon product URLs contain the ASIN in the path: /dp/B0xxxxxxxx/ or
// /gp/product/B0xxxxxxxx. This pattern extracts it without needing Sonar
// to explicitly return the ASIN field. Same approach as image_url extraction.
//
// Valid ASIN: 10 uppercase alphanumeric chars (we filter for consumer B0 ASINs
// specifically since those are what the catalog cares about).
const AMAZON_ASIN_RE = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$|\?)/;

export function extractAsinFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    // Only extract from amazon.com / amazon.co.uk / etc.
    if (!/amazon\./i.test(u.hostname)) return null;
    const m = u.pathname.match(AMAZON_ASIN_RE);
    if (!m) return null;
    return m[1] ?? null;
  } catch {
    return null;
  }
}

// Extract the first valid ASIN from a set of listing URLs.
function extractAsinFromListings(listings: Array<{ url: string }>): string | null {
  for (const l of listings) {
    const asin = extractAsinFromUrl(l.url);
    if (asin) return asin;
  }
  return null;
}

// ============================================================================
// mergeOpenRouterResults — sibling to mergeEbayResults
// ============================================================================
//
// Converts OpenRouter web-search result listings into a ProductLookup row
// ready for upsert.  Reuses all the same logic (image dedup + allowlist,
// mostCommon brand/model, longest title, price aggregation, confidence
// rules, start-bid derivation).
//
// Image URLs returned by Perplexity/GPT may come from any retailer CDN.
// They are filtered through isSafeImageUrl() — same boundary as eBay
// images.  Only hosts in ALLOWED_IMAGE_HOSTS above pass through.
//
// The `sources` field is set to `['openrouter:perplexity-sonar']` (the
// default model) unless openRouterResult.model_used tells us otherwise.
// The model suffix is appended as a human-readable audit trail.

export function mergeOpenRouterResults(
  upc: string,
  result: OpenRouterSearchResult,
): ProductLookup {
  const { active, sold, model_used } = result;

  // ------------------------------------------------------------------
  // Image deduplication + allowlist filtering.
  // Cap at 6.  Prefer first image per listing (primary product shot).
  // ------------------------------------------------------------------
  const imageSet = new Set<string>();
  for (const listing of active) {
    for (const imgUrl of listing.image_urls) {
      if (isSafeImageUrl(imgUrl)) {
        imageSet.add(imgUrl);
        if (imageSet.size >= 6) break;
      }
    }
    if (imageSet.size >= 6) break;
  }
  const image_urls = Array.from(imageSet).slice(0, 6);

  // ------------------------------------------------------------------
  // Identity: brand / model / title from active listings.
  // ------------------------------------------------------------------
  // OpenRouter listings don't expose brand/model fields directly, but
  // the titles are rich enough to extract them. Brand comes from the
  // canonical dictionary (extractBrand). Model is the first SKU-shaped
  // token in the title (regex above). Populating both here is what
  // unlocks the confidence='high' path in the rules below — previously
  // these were hardcoded null, so Sonar lookups never escalated past
  // tier 0 even when the result was clearly identifiable.

  // Longest title from top 3 active listings.
  const title =
    [...active]
      .slice(0, 3)
      .map((l) => l.title)
      .filter((t) => t.length > 0)
      .sort((a, b) => b.length - a.length)[0] ?? null;

  // Prefer structured brand/mpn parsed from retailer JSON-LD (now surfaced on
  // each listing by url-fetcher) — most-common value across listings — and
  // fall back to dictionary/regex extraction from the title when the page
  // didn't expose them. This fills the operator-facing Brand·Model line that
  // was previously blank whenever the title lacked a dictionary brand or an
  // [A-Z]+[0-9]+ SKU token.
  const listingBrand = mostCommon(
    active.map((l) => l.brand).filter((b): b is string => !!b && b.length > 0),
  );
  const brand = listingBrand ?? (title ? extractBrand(title) : null);
  const listingMpn = mostCommon(
    active.map((l) => l.mpn).filter((m): m is string => !!m && m.length > 0),
  );
  const model = listingMpn ?? (title ? extractModelFromTitle(title) : null);

  // Longest retailer-supplied description across listings (most informative).
  // Previously hardcoded null in the return, so the candidate description fell
  // back to empty / SKU-only text. url-fetcher parses this from JSON-LD
  // Product.description / og:description.
  const description =
    [...active]
      .map((l) => l.description)
      .filter((d): d is string => !!d && d.length > 0)
      .sort((a, b) => b.length - a.length)[0] ?? null;

  // Most-common source name as a rough category proxy.
  const category_raw = mostCommon(active.map((l) => l.source).filter((s) => s.length > 0));

  // ------------------------------------------------------------------
  // Pricing.
  // ------------------------------------------------------------------
  const askingCents = active
    .map((l) => l.asking_cents)
    .filter((c): c is number => c !== null && c > 0);
  const avg_asking_cents = average(askingCents);

  const soldCents = sold
    .map((l) => l.sold_cents)
    .filter((c): c is number => c !== null && c > 0);
  const median_sold_cents = median(soldCents);

  // MSRP capture has three tiers, in priority order:
  //
  //  Tier 1 (preferred): explicit listPrice / msrp / suggestedRetailPrice in
  //    the retailer's JSON-LD Product node. Best Buy, Costco, and some
  //    others emit this; Walmart/Home Depot/Target generally do not.
  //  Tier 2 (fallback): highest current asking price observed across
  //    retailers. If no retailer published an explicit MSRP but we have
  //    asking-price data from N retailers, the max(asking_cents) is a
  //    reasonable lower-bound proxy for MSRP — retailers discount below
  //    MSRP, so the highest observed price is near (and never above) it.
  //  Tier 3 (Sonar direct): MSRP that Sonar surfaced from its own search
  //    context (llm_msrp_cents on the OpenRouterSearchResult). Fires
  //    when Tier 1 and Tier 2 both yield null — typically because
  //    retailer pages bot-blocked our fetch (Sephora, Ulta), all URLs
  //    returned were Amazon (skipped at fetch), or Sonar returned 0 URLs
  //    in the first place. The model still saw the price in its search
  //    results context even when the page itself was unfetchable.
  //
  // The result feeds startBid pricing + the operator-facing MSRP display.
  // Null is the worst possible outcome (operator has no anchor and must
  // hand-research); even a coarse proxy is materially better.
  const msrpCents = active
    .map((l) => l.msrp_cents)
    .filter((c): c is number => c !== null && c > 0);
  let msrp_cents_value: number | null = msrpCents.length
    ? Math.max(...msrpCents)
    : null;
  if (msrp_cents_value === null && askingCents.length > 0) {
    msrp_cents_value = Math.max(...askingCents);
  }
  if (msrp_cents_value === null && result.llm_msrp_cents != null && result.llm_msrp_cents > 0) {
    msrp_cents_value = result.llm_msrp_cents;
  }

  // Suggested startBid: 30 % of sold median, else 25 % of asking avg.
  let start_bid_cents: number | null = null;
  if (median_sold_cents) start_bid_cents = Math.round(median_sold_cents * 0.3);
  else if (avg_asking_cents) start_bid_cents = Math.round(avg_asking_cents * 0.25);
  if (start_bid_cents !== null && start_bid_cents < 100) start_bid_cents = 100;

  const now = new Date().toISOString();

  const prices: RetailerPricePoint[] = active.slice(0, 5).map((l) => ({
    retailer: l.source || 'unknown',
    cents: l.asking_cents ?? 0,
    url: l.url,
    fetched_at: now,
  }));

  const sold_comps: SoldComp[] = sold.slice(0, 10).map((l) => ({
    title: l.title,
    cents: l.sold_cents ?? 0,
    sold_at: l.sold_at ?? now,
    condition: l.condition,
    url: l.url,
  }));

  // ------------------------------------------------------------------
  // Sources — encode which OpenRouter model produced this result so we
  // have an audit trail even if we later mix providers.
  // ------------------------------------------------------------------
  const modelSuffix = model_used ? model_used.replace(/\//g, ':') : 'perplexity:sonar';
  const sourceTag = `openrouter:${modelSuffix}` as ProductLookupSource;
  const sources: ProductLookupSource[] = active.length || sold.length ? [sourceTag] : [];

  // ------------------------------------------------------------------
  // Confidence.
  //   high   = (brand AND model resolved) OR (≥3 active AND ≥3 sold)
  //   medium = ≥1 active hit
  //   low    = sold data only (no active listings)
  //   none   = zero data
  //
  // With brand+model now populated above, the (brand && model) path
  // actually fires — Sonar lookups for items with clear brand+SKU titles
  // get confidence='high', short-circuiting the escalation loop in
  // ai/llm.ts (saves the sonar-pro/gpt-4o-search fallback cost on
  // items that are already well-identified).
  // ------------------------------------------------------------------
  let confidence: ProductLookup['confidence'];
  if (!active.length && !sold.length) {
    confidence = 'none';
  } else if ((brand && model) || (active.length >= 3 && sold.length >= 3)) {
    confidence = 'high';
  } else if (active.length >= 1) {
    confidence = 'medium';
  } else {
    confidence = 'low';
  }

  // ------------------------------------------------------------------
  // ASIN extraction from Amazon URLs.
  // OpenRouter often returns Amazon product page URLs. We extract the
  // ASIN from the /dp/ path segment without asking Sonar explicitly —
  // same approach as image_url extraction. This populates the asin
  // column for free when Sonar sources Amazon listings.
  // ------------------------------------------------------------------
  const extractedAsin = extractAsinFromListings(active);

  return {
    upc,
    title,
    brand,
    model,
    category_id: null,
    category_raw,
    image_urls,
    // Identifier fields: populate asin when extractable from URLs.
    asin: extractedAsin,
    fnsku: null,
    lpn: null,
    mpn: model ?? null,
    external_codes: [],
    msrp_cents: msrp_cents_value,
    avg_asking_cents,
    median_sold_cents,
    start_bid_cents,
    prices,
    sold_comps,
    description,
    specs: null,
    confidence,
    sources,
    identity_refreshed_at: now,
    prices_refreshed_at: confidence === 'none' ? null : now,
    created_at: now,
    updated_at: now,
  };
}

// filterSafeImageUrls is also re-exported above for backwards compat
// with callers that imported it from lookup/merge.
void (filterSafeImageUrls satisfies typeof filterSafeImageUrls);
