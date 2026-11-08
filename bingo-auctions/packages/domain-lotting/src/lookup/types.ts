// Tier 1 lookup types. The cache row IS the product representation —
// every external source (eBay, AI fallback, manual entry) merges INTO
// this shape, then upserts to product_lookups.

export type ProductLookupSource =
  | 'cache'
  | 'ebay_browse'
  | 'ebay_sold'
  | 'manual'
  | 'ai'
  | 'serp'
  // OpenRouter web-search sources.  The suffix encodes the model that
  // produced the result, e.g. 'openrouter:perplexity:sonar' or
  // 'openrouter:openai:gpt-4o-search-preview'. TypeScript's string
  // literal union can't express the open-ended suffix, so we use a
  // template-literal type here and the actual stored string is the
  // full tag (forward-slashes replaced with colons by the merger).
  | `openrouter:${string}`;

export type ProductConfidence = 'high' | 'medium' | 'low' | 'none';

export type RetailerPricePoint = {
  retailer: string;
  cents: number;
  url: string;
  fetched_at: string; // ISO-8601
};

export type SoldComp = {
  title: string;
  cents: number;
  sold_at: string;       // ISO-8601
  condition: string;     // free-form from source ("New", "Used", etc)
  url: string;
};

// Mirrors the product_lookups table 1:1 (including columns added by 0042).
export type ProductLookup = {
  upc: string;                  // digits-only normalized, OR synthetic 'asin:<ASIN>' / 'fnsku:<FNSKU>' key for identifier-only rows
  title: string | null;
  brand: string | null;
  model: string | null;
  category_id: string | null;
  category_raw: string | null;
  image_urls: string[];

  // ── Multi-identifier fields (migration 0042) ─────────────────────────────
  // All nullable — a row needs at least one identifier (upc) but rarely has all.
  /** Amazon Standard Identification Number, e.g. B0DK7R7KWV. */
  asin: string | null;
  /** Amazon Fulfillment Network SKU, e.g. X00123ABCD. */
  fnsku: string | null;
  /** Amazon License Plate Number on FC return labels. */
  lpn: string | null;
  /** Manufacturer part number / model number, e.g. DCD771C2. */
  mpn: string | null;
  /** Catch-all array for operator-supplied identifiers (supplier SKU, asset tag, etc.). */
  external_codes: string[];

  msrp_cents: number | null;
  avg_asking_cents: number | null;
  median_sold_cents: number | null;
  start_bid_cents: number | null;

  prices: RetailerPricePoint[];
  sold_comps: SoldComp[];

  description: string | null;
  specs: string | null;

  confidence: ProductConfidence;
  sources: ProductLookupSource[];

  identity_refreshed_at: string;       // ISO-8601
  prices_refreshed_at: string | null;  // ISO-8601 or null

  created_at: string;
  updated_at: string;
};

// What lookupByUpc / searchByKeyword return to the caller. The cache
// row plus a freshness hint so the UI can render "fetched 3 days ago"
// or "live just now".
export type LookupResult = {
  product: ProductLookup;
  /** True if returned from cache without an external fetch this call. */
  fromCache: boolean;
  /** True if the cached prices are older than the configured TTL — the
   *  caller (or a background worker) may want to kick off a refresh. */
  stalePrices: boolean;
};

export type KeywordSearchHit = {
  product: ProductLookup;
  /** trgm similarity 0..1 if matched from cache, undefined if from eBay. */
  similarity?: number;
};
