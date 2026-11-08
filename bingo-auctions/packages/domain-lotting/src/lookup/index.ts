// Tier 1 lookup orchestration. Public API:
//
//   lookupByCode(supabase, code, opts?)        → LookupResult | null
//   lookupByUpc(supabase, upc, opts?)          → LookupResult | null  [deprecated alias]
//   searchByKeyword(supabase, query, opts?)     → KeywordSearchHit[]
//
// lookupByCode flow:
//   1. Detect identifier type from code shape (UPC by digit-only length;
//      ASIN by B0 prefix; FNSKU by X prefix; anything else = opaque).
//   2. Call supabase.rpc('lookup_product_by_code') — one round-trip, SQL
//      handles the UPC→ASIN→FNSKU→LPN→MPN→external_codes cascade.
//   3. Hit and not stale  → return immediately, fromCache=true.
//   4. Hit but stale      → return immediately, fromCache=true, stalePrices=true.
//   5. Miss AND code looks like a UPC (digit-only, 8/12/13/14 chars):
//      fall through to OpenRouter Sonar → merge → upsert.
//   6. Miss for non-UPC codes (ASIN, FNSKU, LPN, MPN, opaque):
//      return null. Sonar cannot reliably resolve arbitrary identifiers.
//
// Why RPC not TS-cascade?
//   Keeping the identifier-resolution cascade in SQL (migration 0043) means:
//   a) One network round-trip regardless of how many identifiers we check.
//   b) The logic is co-located with the indexes that enforce it.
//   c) Other Postgres callers (triggers, admin scripts, direct psql) share
//      the same resolution path with no code duplication.
//   d) Adding a new identifier type only requires a SQL patch, not a TS deploy.
//
// searchByKeyword flow:
//   1. Trigram search product_lookups for warm matches (returns immediately).
//   2. If fewer than `minHits`, also call OpenRouter with the query and
//      enrich the result set with new ProductLookup rows (upserted).
//
// Both paths are robust to missing OpenRouter credentials: if
// OPENROUTER_API_KEY isn't set, lookups still return cache hits but never
// fetch from OpenRouter (so the platform degrades gracefully to cache-only
// mode rather than 500-ing).

import type { SupabaseClient } from '@supabase/supabase-js';
import { getLottingConfig } from '../config';
import {
  isPricesStale,
  normalizeUpc,
  readByCode,
  searchTitleTrgm,
  upsertLookup,
} from './cache';
import { fetchOpenRouterLookup } from './openrouter';
import { mergeOpenRouterResults } from './merge';
import { enrichImages } from '../ai/image-enrich';
import { serpConfigured, searchSerp } from './serp';
import type { KeywordSearchHit, LookupResult, ProductLookup, ProductLookupSource } from './types';

// C2: background image enrichment. Cache rows from the original 187k-row
// scrape have empty image_urls. When a lookup hits one of those rows, we
// fire enrichImages() asynchronously and patch the row — the current
// request returns immediately with whatever was cached, but the NEXT
// lookup of the same product gets images for free. Speed-sensitive paths
// (Quick Lot) are unaffected; the user gets a small lag-cleanup over time.
//
// We dedupe in-flight requests so 5 concurrent scans of the same UPC
// don't all kick off enrichment.
const _imageEnrichInflight = new Set<string>();

function backgroundFillImages(supabase: SupabaseClient, product: ProductLookup): void {
  if (!product.upc) return;
  if (product.image_urls && product.image_urls.length > 0) return;
  if (_imageEnrichInflight.has(product.upc)) return;
  _imageEnrichInflight.add(product.upc);

  // Fire-and-forget. Errors are swallowed — this is a best-effort cache
  // warm. void on the promise tells engines we're intentionally not
  // awaiting.
  void (async () => {
    try {
      const images = await enrichImages({
        brand: product.brand,
        model: product.model,
        title: product.title,
        upc: product.upc,
      });
      if (images.length > 0) {
        await supabase
          .from('product_lookups')
          .update({ image_urls: images })
          .eq('upc', product.upc);
      }
    } catch {
      // best-effort
    } finally {
      _imageEnrichInflight.delete(product.upc);
    }
  })();
}

export type LookupOptions = {
  /** Skip cache; force a fresh external fetch. Use sparingly — defeats
   *  the whole point of the cache layer. */
  forceRefresh?: boolean;
  /** Return only a cached hit; on a cache MISS return null instead of falling
   *  through to the (slow) Sonar web-search + retailer page-fetch. Used by the
   *  interactive photo scan so staff aren't blocked ~10-20s on a live web
   *  lookup — the miss is enriched in the background afterward (2026-07-13). */
  cacheOnly?: boolean;
  /**
   * Extra context the caller already has (e.g. from a photo-scan vision
   * step). On a cache miss, these are passed to the OpenRouter web-search
   * query so Sonar gets richer input than a bare UPC. Sonar performs
   * noticeably better on natural-language queries
   * ("DeWalt DCD771C2 20V drill, UPC 885911540858") than on bare-digit
   * UPC queries — this is the channel for shipping that signal through.
   *
   * Cache hits ignore these (the cached row already has richer data).
   */
  hints?: {
    title?: string;
    brand?: string;
    model?: string;
  };
};

function haveOpenRouter(): boolean {
  // Check config first (set at startup via setLottingConfig), then env.
  try {
    const cfg = getLottingConfig();
    if (cfg.openrouterKey) return true;
  } catch {
    // getLottingConfig throws if not yet configured — that's fine.
  }
  if (typeof process !== 'undefined' && process.env) {
    return !!process.env['OPENROUTER_API_KEY'];
  }
  return false;
}

// Detect whether a raw code string looks like a UPC/EAN/GTIN.
// True when the code (after stripping common separators) is 8, 12, 13, or 14
// digit characters — the normalizeUpc function enforces exactly the same rule.
function looksLikeUpc(code: string): boolean {
  const digits = code.replace(/[^\d]/g, '');
  return (
    (digits.length === 8 ||
      digits.length === 12 ||
      digits.length === 13 ||
      digits.length === 14) &&
    /^[\d\-\s]+$/.test(code.trim())
  );
}

// ── Primary public API ────────────────────────────────────────────────────────

/**
 * Resolve any product identifier — UPC, ASIN, FNSKU, LPN, MPN, or a value
 * from external_codes — to a cached ProductLookup row.
 *
 * On cache miss for UPC-shaped codes, falls back to OpenRouter Sonar to
 * fetch live retail data and upsert the result. Non-UPC misses return null
 * immediately (Sonar cannot reliably resolve arbitrary identifiers by code).
 */
export async function lookupByCode(
  supabase: SupabaseClient,
  code: string,
  opts: LookupOptions = {},
): Promise<LookupResult | null> {
  const clean = code.trim();
  if (!clean) return null;

  // 1. Cache read via RPC (single round-trip, SQL handles identifier cascade).
  if (!opts.forceRefresh) {
    const cached = await readByCode(supabase, clean);
    if (cached) {
      // C2: speed-sensitive paths return the cached row immediately, even
      // if image_urls is empty. We kick off a background enrichment so
      // the next lookup of the same product gets images for free.
      backgroundFillImages(supabase, cached);
      return {
        product: cached,
        fromCache: true,
        stalePrices: isPricesStale(cached),
      };
    }
  }

  // Cache-only callers (interactive scan) stop here on a miss — the heavy
  // Sonar web lookup is deferred to a background enrichment pass so the scan
  // returns fast (2026-07-13 latency).
  if (opts.cacheOnly) return null;

  // 2. Cache miss (or forced refresh).
  //    Only fall through to OpenRouter for UPC-shaped codes — Sonar performs
  //    web search and bare UPCs resolve reasonably well. ASINs, FNSKUs, LPNs,
  //    and MPNs are Amazon-internal or vendor-specific; Sonar can't reliably
  //    resolve them from a code alone without additional context.
  const isUpc = looksLikeUpc(clean);
  if (!isUpc) {
    // Non-UPC miss: caller should prompt the operator to provide more info or
    // fall through to photo identification (Tier 2).
    return null;
  }

  if (!haveOpenRouter()) {
    // No OpenRouter key and no cache hit. Caller decides what to do next.
    return null;
  }

  const upc = normalizeUpc(clean);
  if (!upc) return null;

  // Pass the caller's hints (title/brand/model from a photo-scan vision
  // pass) alongside the UPC. fetchOpenRouterLookup builds a single Sonar
  // query that uses whichever fields are populated, so bare-UPC scans
  // still work the same way but vision-scan-derived calls get a richer
  // query string. Empty hints → identical to pre-hint behavior.
  const orResult = await safeOr(() =>
    fetchOpenRouterLookup({
      upc,
      title: opts.hints?.title || undefined,
      brand: opts.hints?.brand || undefined,
      model: opts.hints?.model || undefined,
    }),
  );

  // If web-search returned NOTHING — no URLs, no MSRP, no anything —
  // do NOT cache a negative row. Web-search models systematically miss
  // bare UPC queries; caching 'none' poisons the cache for 7 days against
  // products that a photo scan or keyword search could later identify.
  // The next attempt gets a fresh shot.
  //
  // BUT: if Sonar gave us an MSRP signal (Tier 3 — from search context,
  // not from fetched pages), still write the row. An MSRP-only row is
  // a useful cache entry — the operator gets a price anchor on the lot
  // even though no retailer URLs survived the fetch filter (Sephora-style
  // bot blocks, Amazon-only search hits, etc.).
  const hasMsrpSignal = orResult.llm_msrp_cents != null && orResult.llm_msrp_cents > 0;
  if (orResult.active.length === 0 && orResult.sold.length === 0 && !hasMsrpSignal) {
    return null;
  }

  const merged = mergeOpenRouterResults(upc, orResult);
  const stored = await upsertLookup(supabase, merged);
  if (!stored) return null;

  // C2: even after a fresh Sonar fetch, image_urls may still be empty
  // because Sonar's price search rarely returns image URLs. Kick off the
  // dedicated image-enrich path in the background so the next lookup
  // sees populated images. Doesn't block this request.
  backgroundFillImages(supabase, stored);

  return {
    product: stored,
    fromCache: false,
    stalePrices: false,
  };
}

/**
 * @deprecated Use lookupByCode instead. This alias is kept for backward
 * compatibility — callers that import lookupByUpc continue to work.
 * lookupByCode delegates to the same RPC-based multi-identifier cache,
 * so UPC lookups behave identically. Will be removed in a future major version.
 */
export async function lookupByUpc(
  supabase: SupabaseClient,
  rawUpc: string,
  opts: LookupOptions = {},
): Promise<LookupResult | null> {
  return lookupByCode(supabase, rawUpc, opts);
}

// ── Keyword search ────────────────────────────────────────────────────────────

export async function searchByKeyword(
  supabase: SupabaseClient,
  query: string,
  opts: { minHits?: number; limit?: number; cacheOnly?: boolean } = {},
): Promise<KeywordSearchHit[]> {
  const q = query.trim();
  if (!q) return [];
  const minHits = opts.minHits ?? 3;
  const limit = opts.limit ?? 8;

  // 1. Cache search via trgm.
  const cached = await searchTitleTrgm(supabase, q, limit);
  const hits: KeywordSearchHit[] = cached.map((p) => ({ product: p }));

  // 2. If we got enough warm hits, return.
  if (hits.length >= minHits) return hits;

  // Cache-only callers (interactive scan) return whatever trgm found and skip
  // the slow SERP + Sonar fallbacks — deferred to background enrichment.
  if (opts.cacheOnly) return hits;

  // 2c. Bright Data SERP (Google Shopping) identification — structured product
  // candidates for no-barcode items. No-op unless BRIGHTDATA_API_TOKEN is set.
  if (serpConfigured()) {
    const serpHits = await searchSerp(q, limit);
    for (const h of serpHits) {
      if (hits.length >= limit) break;
      hits.push(h);
    }
    if (hits.length >= minHits) return hits;
  }

  // 3. Fall back to OpenRouter for fresh results.
  if (!haveOpenRouter()) return hits;

  const orResult = await safeOr(() => fetchOpenRouterLookup({ title: q }));

  for (const listing of orResult.active) {
    // For keyword search we build an in-memory product row. Only persist
    // if the result has enough signal (medium+ confidence). Transient
    // rows (confidence=low, empty title) are returned to the UI but not
    // cached — they don't pollute the product_lookups table.
    const merged = mergeOpenRouterResults('', {
      active: [listing],
      sold: [],
      model_used: orResult.model_used,
      llm_msrp_cents: orResult.llm_msrp_cents,
    });
    if (merged.confidence !== 'none') {
      hits.push({ product: merged });
    }
    if (hits.length >= limit) break;
  }

  // Edge case: Sonar found no retailer product pages (e.g. an obscure
  // SKU that doesn't index well, OR all candidate retailers bot-blocked
  // our fetcher) but did surface an MSRP in its search context. The
  // prior code dropped this row because mergeOpenRouterResults sets
  // confidence='none' when active=[] AND sold=[]. That lost the only
  // MSRP signal we had (production bug 2026-05-15: Morphe 18CT Matte
  // Essentials scan returned no retailer pages but Sonar saw it priced
  // around $14.99 on Ulta — and we discarded that).
  //
  // Fix: if we've discovered nothing else AND llm_msrp_cents is set,
  // emit a minimal "MSRP-only" hit so the downstream candidate at
  // least gets the price anchor. confidence='low' marks it so the
  // catalog write-through skips persisting it (we don't want a row
  // with no title contaminating future trgm searches), but the UI
  // and persistence.ts MSRP cascade get the value.
  if (
    hits.length === 0 &&
    orResult.llm_msrp_cents != null &&
    orResult.llm_msrp_cents > 0
  ) {
    const now = new Date().toISOString();
    const sourceTag: ProductLookupSource = `openrouter:${(orResult.model_used || 'sonar').replace(/\//g, ':')}-msrp-only`;
    hits.push({
      product: {
        upc: '',
        title: q,
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
        msrp_cents: orResult.llm_msrp_cents,
        avg_asking_cents: null,
        median_sold_cents: null,
        start_bid_cents: null,
        prices: [],
        sold_comps: [],
        description: null,
        specs: null,
        confidence: 'low',
        sources: [sourceTag],
        identity_refreshed_at: now,
        prices_refreshed_at: now,
        created_at: now,
        updated_at: now,
      },
    });
  }

  return hits;
}

// Safely call an OpenRouter fetcher, returning an empty result on failure.
async function safeOr(
  fn: () => ReturnType<typeof fetchOpenRouterLookup>,
): ReturnType<typeof fetchOpenRouterLookup> {
  try {
    return await fn();
  } catch {
    return { active: [], sold: [], model_used: '', llm_msrp_cents: null };
  }
}

export type { ProductLookup, LookupResult, KeywordSearchHit } from './types';

// ── Direct fetch primitives ────────────────────────────────────────────────────
// Surface the OpenRouter URL-finder + the per-page retailer fetcher/parser so
// server routes (e.g. operator-web /api/lottr/scrape-url) can drive the AI
// fallback path directly without re-implementing it. fetchOpenRouterLookup runs
// Sonar→url-fetch internally; fetchProductPage/fetchProductPages parse a known
// retailer product page into an OpenRouterListing.
export { fetchOpenRouterLookup } from './openrouter';
export type { OpenRouterListing, OpenRouterSearchResult } from './openrouter';
export { fetchProductPage, fetchProductPages, isHardBlockedHost } from './url-fetcher';
