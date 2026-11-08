// Price lookup + UPC/ASIN code lookup + stock-photo discovery.
//
// 2026-05-24 (PERF-8): migrated from legacy direct-Anthropic `callAnthropic`
// path → `complete()` (OpenRouter, Gemini Flash by default with
// gpt-4o-search-preview / Sonar for web-grounded tasks). The audit measured
// ~17× cost savings ($0.017/call → $0.001/call) on these three functions.
//
// Function signatures and return shapes are unchanged so existing callers
// (apps/field-mobile/lib/lottr-client.ts, evals/runners/*, mobile scan.tsx)
// continue to work without modification.
//
// Fallback behavior: when neither LottingConfig.openrouterKey nor
// process.env.OPENROUTER_API_KEY is set, each function logs a single
// warning and returns null / []. We log explicitly because SF-5 — the
// silent-fallback bug — was a recurring pain point; an unconfigured
// pricing call should be loud, not invisible.

import { CATEGORIES } from '../constants';
import { getLottingConfig, hasLottingConfig } from '../config';
import type { LotCandidate, PriceData } from '../types';
import { complete } from './llm';
import { normalizePriceData } from './normalize';

// ---------------------------------------------------------------------------
// Config + warning helpers
// ---------------------------------------------------------------------------

function readEnv(key: string): string | undefined {
  if (typeof process !== 'undefined' && process.env) {
    return (process.env as Record<string, string | undefined>)[key];
  }
  return undefined;
}

/**
 * True when an OpenRouter API key is available — either via
 * setLottingConfig({ openrouterKey }) or process.env.OPENROUTER_API_KEY.
 *
 * pricing.ts uses complete() which performs its own env check, but we
 * pre-check here so we can fall back gracefully (return null / []) and
 * log a clear warning instead of throwing deep inside complete().
 */
function hasOpenRouterKey(): boolean {
  if (hasLottingConfig()) {
    try {
      const cfg = getLottingConfig();
      if (cfg.openrouterKey) return true;
    } catch {
      // hasLottingConfig() said yes but config threw; treat as unconfigured.
    }
  }
  return Boolean(readEnv('OPENROUTER_API_KEY'));
}

// Single-shot warning so we don't spam logs when a long-running script
// calls pricing N times with no key configured.
const warned = new Set<string>();
function warnOnce(fn: string): void {
  if (warned.has(fn)) return;
  warned.add(fn);
  // eslint-disable-next-line no-console
  console.warn(
    `[domain-lotting] ${fn}: OPENROUTER_API_KEY not configured — returning empty result. ` +
      'Set via setLottingConfig({ openrouterKey }) or the OPENROUTER_API_KEY env var.',
  );
}

// ---------------------------------------------------------------------------
// fetchPrices — retail price + stock-photo lookup by free-text query
// ---------------------------------------------------------------------------
//
// Same input/output as the legacy implementation. Internally routes through
// complete({ task: 'web_search_lookup', schema: 'json', ... }) so it lands
// on openai/gpt-4o-search-preview (default) with Perplexity Sonar fallback —
// the same path scan-photo → image enrichment uses. complete() handles the
// JSON parsing AND strips response_format automatically on web-search models
// (which reject `response_format: { type: 'json_object' }`); the prompt asks
// for raw JSON and parseJson() recovers it from any markdown wrapper.

export async function fetchPrices(query: string): Promise<PriceData | null> {
  if (!hasOpenRouterKey()) {
    warnOnce('fetchPrices');
    return null;
  }

  const prompt = `Find current retail prices and product images for: "${query}"

Search Amazon, Walmart, Home Depot, Lowe's, Target, Best Buy.

RESPOND WITH ONLY JSON:
{
  "prices": [{"retailer": "Amazon", "price": 99.99, "url": "product page URL"}],
  "msrp": 129.99,
  "avg": 94.98,
  "startBid": 30,
  "fullTitle": "Official product name from retailer listing",
  "specs": "Key specs from product page",
  "stockPhotos": ["https://actual-image-url-you-found.jpg"]
}

RULES:
- Only real current prices from real retailers. price = number.
- startBid = ~30% of avg. Skip retailers that don't carry it.
- stockPhotos: ONLY include image URLs you actually see in search results or product pages.
  Look for URLs containing: m.media-amazon.com/images, i5.walmartimages.com, images.thdstatic.com, mobileimages.lowes.com
  These are direct product image URLs from retailer CDNs.
  Do NOT guess or construct URLs — only include ones you actually found.
  If you can't find any real image URLs, return an empty array.`;

  try {
    const parsed = await complete({
      task: 'web_search_lookup',
      schema: 'json',
      signal: AbortSignal.timeout(15_000),
      messages: [{ role: 'user', content: prompt }],
    });
    return normalizePriceData(parsed);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[domain-lotting] fetchPrices failed for query="${query.slice(0, 80)}":`,
      (err as Error).message,
    );
    return null;
  }
}

// ---------------------------------------------------------------------------
// lookupCode — UPC / EAN / ASIN code lookup with full LotCandidate result
// ---------------------------------------------------------------------------
//
// Note: the production path is `lookupByCode` in src/lookup/index.ts, which
// is cache-first and only invokes AI on miss. This `lookupCode` is the legacy
// Tier-2 AI-only path; it survives because:
//   - apps/field-mobile/lib/lottr-client.ts uses a thin HTTP wrapper to
//     /api/lottr/lookup-code (the server route uses lookupByCode);
//   - evals/runners/run-upc-lookup.ts and run-manifest-classify.ts call
//     this function directly to benchmark the LLM path without the cache.

export async function lookupCode(code: string): Promise<LotCandidate | null> {
  if (!hasOpenRouterKey()) {
    warnOnce('lookupCode');
    return null;
  }

  const cleanCode = String(code).replace(/[\s-]/g, '').trim();
  if (!cleanCode) return null;

  const codeType = /^B0[A-Z0-9]{8,}$/i.test(cleanCode)
    ? 'Amazon ASIN'
    : cleanCode.length <= 13
      ? 'UPC/EAN barcode'
      : 'Unknown code type';

  const prompt = `You are a product lookup expert for an auction house.

Look up this product code and find all available information:
Code: ${cleanCode}
Type: ${codeType}

INSTRUCTIONS:
1. Search for this code to identify the exact product
2. Find current retail prices from Amazon, Walmart, Target, Lowe's, Home Depot, Best Buy
3. Get full product specifications

You MUST respond with ONLY a JSON object, no other text:
{
  "title": "Brand + Full Product Name",
  "brand": "Brand",
  "model": "Model number",
  "category": "EXACTLY one of: ${CATEGORIES.join(', ')}",
  "description": "2-3 sentence auction listing description",
  "prices": [{"retailer": "Amazon", "price": 99.99}],
  "msrp": 0,
  "avg": 0,
  "startBid": 0,
  "specs": "Key specifications",
  "stockPhotos": ["https://actual-product-image-url.jpg"],
  "confidence": "high if exact match found, medium if probable match, low if uncertain"
}

For stockPhotos: ONLY include real image URLs you find in search results (m.media-amazon.com, i5.walmartimages.com, etc). Empty array if none found.`;

  let parsed: Record<string, unknown> | null;
  try {
    parsed = await complete({
      task: 'web_search_lookup',
      schema: 'json',
      signal: AbortSignal.timeout(15_000),
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[domain-lotting] lookupCode failed for code="${cleanCode}":`,
      (err as Error).message,
    );
    return null;
  }
  if (!parsed) return null;

  const price = normalizePriceData(parsed);
  if (!price) return null;

  // lookupCode doesn't return condition (we don't see the photo) and
  // doesn't return visibleText. Map onto LotCandidate with the UPC we
  // looked up filled in.
  return {
    title: String(parsed['title'] ?? '').trim(),
    brand: String(parsed['brand'] ?? '').trim(),
    model: String(parsed['model'] ?? '').trim(),
    upc: cleanCode,
    category:
      (CATEGORIES as readonly string[]).includes(String(parsed['category']))
        ? (parsed['category'] as LotCandidate['category'])
        : 'Other',
    subcategory: '',
    packagingMsrp: null,
    condition: '' as const,
    description: String(parsed['description'] ?? '').trim(),
    searchQuery: String(parsed['title'] ?? cleanCode).trim(),
    confidence:
      parsed['confidence'] === 'high' ||
      parsed['confidence'] === 'medium' ||
      parsed['confidence'] === 'low'
        ? (parsed['confidence'] as LotCandidate['confidence'])
        : 'medium',
    notes: '',
    ...price,
  };
}

// ---------------------------------------------------------------------------
// fetchStockPhotos — stand-alone stock-photo search
// ---------------------------------------------------------------------------
//
// Used when the operator wants more / better photos for a lot they've
// already identified some other way (e.g. text-only entry of brand + model).
//
// Routes through complete({ task: 'image_enrich', ... }) which uses
// Perplexity Sonar with an aggressive image-search prompt — same path the
// scan-photo Step 2.5 image enrichment uses.

export async function fetchStockPhotos(product: {
  title?: string;
  brand?: string;
  model?: string;
}): Promise<string[]> {
  if (!hasOpenRouterKey()) {
    warnOnce('fetchStockPhotos');
    return [];
  }

  const query = [product.brand, product.model, product.title].filter(Boolean).join(' ');
  if (!query) return [];

  const prompt = `Search for product images of: "${query}"

Find product image URLs from retailer websites (Amazon, Walmart, Home Depot, Lowe's).

RESPOND WITH ONLY JSON:
{
  "images": ["https://direct-image-url.jpg"]
}

RULES:
- ONLY include image URLs you actually find in search results
- Look for CDN URLs: m.media-amazon.com/images, i5.walmartimages.com, images.thdstatic.com, mobileimages.lowes.com
- Do NOT make up or guess URLs
- If you can't find real image URLs, return {"images": []}`;

  try {
    const parsed = await complete({
      task: 'image_enrich',
      schema: 'json',
      signal: AbortSignal.timeout(15_000),
      messages: [{ role: 'user', content: prompt }],
    });
    if (!parsed) return [];
    const list =
      (parsed['images'] as unknown[]) ??
      (parsed['imageUrls'] as unknown[]) ??
      (parsed['stockPhotos'] as unknown[]) ??
      [];
    return list
      .filter((u): u is string => typeof u === 'string' && u.startsWith('https://'))
      .filter(
        (u) =>
          /\.(jpg|jpeg|png|webp)/i.test(u) ||
          u.includes('/images/') ||
          u.includes('walmartimages') ||
          u.includes('thdstatic'),
      )
      .slice(0, 6);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[domain-lotting] fetchStockPhotos failed for query="${query.slice(0, 80)}":`,
      (err as Error).message,
    );
    return [];
  }
}
