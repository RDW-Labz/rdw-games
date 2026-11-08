// OpenRouter live-data source for Tier 1 product lookups.
//
// Replaces the eBay Browse API as the primary live-data path.
// Uses `complete({ task: 'web_search_lookup', schema: 'json' })` to
// send a structured prompt to Perplexity Sonar (or its escalation
// tiers) which performs live web-grounding internally.  We don't
// supply our own search results — the model does it.
//
// Two primary functions mirror the eBay module's surface:
//   fetchOpenRouterLookup(query)  → { active, sold }
//   (priceToCents / median / average re-exported from ebay.ts)
//
// The `active` array represents current retail listings the model found.
// The `sold` array represents recent sold/completed transactions (when
// the model can find them).  Both map to the same OpenRouterListing
// shape so mergeOpenRouterResults() can aggregate them uniformly.
//
// Pricing-data quality depends on model freshness.  Perplexity Sonar
// has a short knowledge lag (~days); GPT-4o-search-preview is more
// real-time.  Use the escalation tiers (LLM_MAX_ESCALATION_DEPTH=2) for
// highest-quality price data at the cost of higher latency and spend.

import { complete } from '../ai/llm';
import type { LlmMessage } from '../ai/llm';
import { fetchProductPages } from './url-fetcher';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type OpenRouterListing = {
  /** Product title from the retailer / listing. */
  title: string;
  /** Retailer or marketplace name (e.g. "Amazon", "Home Depot", "eBay"). */
  source: string;
  /** Asking price in cents (active listings). Null when unknown. */
  asking_cents: number | null;
  /** MSRP / list price / strikethrough price in cents. Null when unknown. */
  msrp_cents: number | null;
  /** Sold/transaction price in cents (sold comps). Null when unknown. */
  sold_cents: number | null;
  /** ISO-8601 date when the item sold. Only present for sold comps. */
  sold_at: string | null;
  /** Product condition as free text ("New", "Used", "Open Box", etc.). */
  condition: string;
  /** Brand name parsed from retailer JSON-LD (`Product.brand[.name]`).
   *  Optional — only the url-fetcher path populates it; LLM-direct listings
   *  omit it and brand falls back to title-dictionary extraction in merge. */
  brand?: string | null;
  /** Manufacturer part number parsed from retailer JSON-LD
   *  (`Product.mpn` ?? `Product.sku`). Optional — url-fetcher path only. */
  mpn?: string | null;
  /** Long product description parsed from retailer JSON-LD
   *  (`Product.description`) or og:description / meta description. Optional —
   *  url-fetcher path only. Capped upstream so the cache row stays lean. */
  description?: string | null;
  /** Image URLs from the source page. May be empty — fallback handled upstream. */
  image_urls: string[];
  /** Canonical product URL. */
  url: string;
};

export type OpenRouterSearchResult = {
  active: OpenRouterListing[];
  sold: OpenRouterListing[];
  /** Model that produced this result (propagated from the LLM response). */
  model_used: string;
  /**
   * MSRP captured by the LLM directly from its search context, in USD
   * cents. Independent of the URL fetch path — this is what the model
   * "saw" as MSRP / List Price / Was-price in the search results.
   * Tier 3 MSRP signal: used when retailer JSON-LD didn't expose
   * listPrice AND the fallback max(asking_cents) is empty (e.g. when
   * retailer pages 404'd or bot-blocked our fetch). Null when the model
   * didn't surface an MSRP. */
  llm_msrp_cents: number | null;
};

// ---------------------------------------------------------------------------
// Internal: raw LLM response shape we expect back
// ---------------------------------------------------------------------------

type RawListing = {
  title?: unknown;
  source?: unknown;
  asking_cents?: unknown;
  msrp_cents?: unknown;
  sold_cents?: unknown;
  sold_at?: unknown;
  condition?: unknown;
  image_urls?: unknown;
  url?: unknown;
};

type RawResponse = {
  active?: unknown[];
  sold?: unknown[];
  confidence?: unknown;
  model?: unknown;
};

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

// Sonar's only job now: find canonical retailer product page URLs.
// Structured data (title, price, MSRP, images) comes from fetching those
// URLs and parsing the HTML ourselves — see url-fetcher.ts. This split
// is dramatically more reliable than asking the LLM to paraphrase prices
// and image URLs out of multiple retailer pages, which it does poorly
// (observed empirically: terse responses, missing image URLs, occasional
// fabricated retailer names).
//
// Retailer priority guidance (2026-05-15 stock-image smoke matrix):
//   - Target, Apple, Ulta, Walgreens, Instacart, manufacturer sites,
//     specialty Shopify stores → reliably emit og:image meta tags we can
//     extract server-side.
//   - Walmart → emits og:image but aggressively rate-limits server-side
//     fetches (serves a 15562-byte stub-page after ~3 same-host requests).
//     Still usable from production with CF Worker IP rotation, but
//     diversifying away from "Walmart-first" results gives us more
//     reliable per-product image coverage.
//   - Amazon → WAF block on Worker fetches.
//   - eBay → 403 on server-side fetches.
//   - Costco, Kroger, CVS, Macy's, Best Buy → routinely 403.
function buildSystemPrompt(): string {
  return `You are a product-page finder. Given a product query, search the web
and return canonical retailer PRODUCT PAGE URLs (not search results, not
category pages, not blog reviews). US-market retailers only. Output JSON
only — no prose, no markdown fences.`;
}

function buildUserPrompt(query: {
  upc?: string;
  title?: string;
  brand?: string;
  model?: string;
}): string {
  const parts: string[] = [];
  if (query.upc) parts.push(`UPC: ${query.upc}`);
  if (query.brand) parts.push(`Brand: ${query.brand}`);
  if (query.model) parts.push(`Model: ${query.model}`);
  if (query.title) parts.push(`Title: ${query.title}`);
  const queryDesc = parts.join(', ');

  return `Find US retailer product page URLs AND the MSRP for this product:
${queryDesc}

DIVERSIFY RETAILERS — pick a mix from these high-og:image hosts:
  - target.com, homedepot.com, lowes.com, bestbuy.com, costco.com
  - bhphotovideo.com, newegg.com, acehardware.com, tractorsupply.com
  - chewy.com, petco.com, kohls.com, macys.com, sephora.com, ulta.com
  - bathandbodyworks.com, cvs.com, walgreens.com, kroger.com
  - manufacturer official site if available (e.g. drsquatch.com, dewalt.com)
  - smaller specialty retailers / Shopify stores selling the same product
  - instacart.com or any retailer that exposes og:image on product pages

DO NOT include:
  - amazon.com / amzn.to — WAF blocks our fetch.
  - ebay.com — eBay returns 403 to server-side fetches.
  - noon.com, ubuy.com, alibaba.com, amazon.co.uk / .de / .ca — non-US.
  - Walmart links are LOW PRIORITY (aggressive rate-limit). Include at
    most 1 if you have nothing else.

Return JSON with this exact shape:
{
  "urls": ["https://www.target.com/p/foo/-/A-1234", "https://www.ulta.com/p/..."],
  "msrp_cents": 1999,
  "confidence": "high"
}

Rules:
- urls: 0-5 SPECIFIC product page URLs from your actual web search.
  Patterns: /p/, /ip/, /pd/, /site/, /dp/ — NOT /search?, /s/, /browse/,
  /c/kp/, or homepages. No fabrication.
- msrp_cents: integer USD cents. "MSRP", "List Price", or "Was \$X".
  Highest price across retailers is usually closest to MSRP. Null if
  you can't see one — never guess.
- confidence: "high"/"medium"/"none".
- Spread URLs across AT LEAST 3 different retailers when possible.

msrp_cents is valid EVEN when urls is empty. Output only the JSON object.`;
}

// ---------------------------------------------------------------------------
// Type guards / coercion
// ---------------------------------------------------------------------------

function toStr(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function toIntCents(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : null;
  if (n === null || !Number.isFinite(n) || n <= 0) return null;
  // If value looks like it might already be in dollars (< 1000 and has decimal),
  // treat as dollars and convert. If already an integer and looks like cents, keep.
  // Heuristic: if < 10 assume it's sub-dollar (still use as dollars → cents).
  // The prompt asks for integer cents so this should be a no-op most of the time.
  return Math.round(n);
}

function toStrArr(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string');
}

function coerceListing(raw: unknown): OpenRouterListing | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as RawListing;
  return {
    title: toStr(r.title),
    source: toStr(r.source) || 'unknown',
    asking_cents: toIntCents(r.asking_cents),
    msrp_cents: toIntCents(r.msrp_cents),
    sold_cents: toIntCents(r.sold_cents),
    sold_at: typeof r.sold_at === 'string' ? r.sold_at : null,
    condition: toStr(r.condition) || 'Unknown',
    image_urls: toStrArr(r.image_urls),
    url: toStr(r.url),
  };
}

// ---------------------------------------------------------------------------
// Main fetch function
// ---------------------------------------------------------------------------

export async function fetchOpenRouterLookup(
  query: { upc?: string; title?: string; brand?: string; model?: string },
  signal?: AbortSignal,
): Promise<OpenRouterSearchResult> {
  const empty: OpenRouterSearchResult = {
    active: [],
    sold: [],
    model_used: '',
    llm_msrp_cents: null,
  };

  // Need at least one identifier.
  if (!query.upc && !query.title && !query.brand && !query.model) {
    return empty;
  }

  const messages: LlmMessage[] = [
    { role: 'system', content: buildSystemPrompt() },
    { role: 'user', content: buildUserPrompt(query) },
  ];

  // ── Step 1: Sonar finds product page URLs + MSRP signal ──────────────
  // Prompt asks for 1-5 non-Amazon URLs PLUS msrp_cents. URLs feed the
  // url-fetcher in Step 2. msrp_cents is captured directly from Sonar's
  // search context — Tier 3 MSRP fallback that fires when both Tier 1
  // (retailer JSON-LD listPrice) and Tier 2 (max asking_cents from
  // fetched pages) come up empty. Sephora-style bot blocks no longer
  // mean null MSRP; the model still saw the price in its search context.
  let raw: Record<string, unknown> | null;
  try {
    raw = await complete({ task: 'web_search_lookup', schema: 'json', messages, signal });
  } catch {
    // Sonar outage / no key / etc. — return empty so caller can fall
    // through to cache-only mode rather than 500ing.
    return empty;
  }
  if (!raw) return empty;

  const llmMsrp = toIntCents(raw['msrp_cents']);
  const modelUsed = typeof raw['model'] === 'string' ? (raw['model'] as string) : 'perplexity/sonar';

  const urlsRaw = (raw as { urls?: unknown })['urls'];
  const urls: string[] = Array.isArray(urlsRaw)
    ? urlsRaw
        .filter(
          (u): u is string =>
            typeof u === 'string' && u.length >= 30 && /^https?:\/\//i.test(u),
        )
        // Reject search/category/browse pages — only specific product
        // pages. The URL-finder prompt forbids these but models still
        // occasionally return them.
        .filter((u) => !/\/(search|s|browse|c\/kp|results)(\?|\/|$)/i.test(u))
    : [];

  if (urls.length === 0) {
    return { ...empty, model_used: modelUsed, llm_msrp_cents: llmMsrp };
  }

  // ── Step 2: fetch each URL and parse structured product data ─────────
  // Concurrency-bounded inside fetchProductPages (cap 3). 5s timeout per
  // URL. Failed fetches / parses return null and are filtered. Amazon
  // URLs are auto-skipped (blocked at WAF, paywalled HTML).
  const active = await fetchProductPages(urls);

  return {
    active,
    sold: [],
    model_used: `${modelUsed}+url-fetch`,
    llm_msrp_cents: llmMsrp,
  };
}

// ---------------------------------------------------------------------------
// Math helpers — canonical implementations in normalize/stats.ts.
// Re-exported here so existing callers of lookup/openrouter continue to work.
// ---------------------------------------------------------------------------

export { median, average } from '../normalize/stats';
