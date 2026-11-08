// Read/write helpers for the product_lookups table. Supabase client is
// passed in (same pattern as persistence.ts) so both field-mobile and
// operator-web can call from their own authenticated context.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ProductLookup } from './types';
import { normalizeUpc as _normalizeUpc } from '../normalize/upc';
import { extractBrand } from '../normalize/brand';

// Default freshness windows (override via lookupByUpc options if needed).
//
//   PRICES_TTL_MS — after this, cache hit is "stale" and the caller may
//                   trigger a background refresh. Identity (title/brand)
//                   is treated as never stale.
//   NEGATIVE_TTL_MS — confidence='none' rows expire after this so a UPC
//                    that gets cataloged later eventually gets a retry.
export const PRICES_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
export const NEGATIVE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// normalizeUpc: canonical implementation is in normalize/upc.ts.
// This wrapper preserves the original signature (accepts string, never null)
// that existing cache.ts callers depend on.
export function normalizeUpc(input: string): string {
  return _normalizeUpc(input) ?? String(input).replace(/[^0-9]/g, '');
}

// Read a single row by UPC. Returns null if not found OR if the row is
// a negative-cache entry that has expired (so the caller refetches).
export async function readByUpc(
  supabase: SupabaseClient,
  rawUpc: string,
): Promise<ProductLookup | null> {
  const upc = normalizeUpc(rawUpc);
  if (!upc) return null;

  const { data, error } = await supabase
    .from('product_lookups')
    .select('*')
    .eq('upc', upc)
    .maybeSingle();
  if (error || !data) return null;

  const row = hydrateRow(data as unknown as Record<string, unknown>);
  if (row.confidence === 'none') {
    const age = Date.now() - new Date(row.identity_refreshed_at).getTime();
    if (age > NEGATIVE_TTL_MS) return null; // expired negative cache → refetch
  }
  return row;
}

// Multi-identifier lookup via the lookup_product_by_code SQL RPC (migration 0043).
// Resolves UPC → ASIN → FNSKU → LPN → MPN → external_codes in one DB round-trip.
// Returns null if not found or if the matching row is an expired negative-cache entry.
export async function readByCode(
  supabase: SupabaseClient,
  code: string,
): Promise<ProductLookup | null> {
  const clean = code.trim();
  if (!clean) return null;

  const { data, error } = await supabase.rpc('lookup_product_by_code', {
    p_code: clean,
  });

  if (error || !data || !Array.isArray(data) || data.length === 0) return null;

  const row = hydrateRow(data[0] as Record<string, unknown>);
  if (row.confidence === 'none') {
    const age = Date.now() - new Date(row.identity_refreshed_at).getTime();
    if (age > NEGATIVE_TTL_MS) return null; // expired negative cache → refetch
  }
  return row;
}

// Ensure rows returned from Supabase (which omits default-value columns when
// they're absent from older rows) always conform to the full ProductLookup type.
// New columns from 0042 default to null / [] in Postgres but older clients
// or stripped select() calls might miss them.
function hydrateRow(raw: Record<string, unknown>): ProductLookup {
  return {
    ...(raw as unknown as ProductLookup),
    asin: (raw['asin'] as string | null) ?? null,
    fnsku: (raw['fnsku'] as string | null) ?? null,
    lpn: (raw['lpn'] as string | null) ?? null,
    mpn: (raw['mpn'] as string | null) ?? null,
    external_codes: Array.isArray(raw['external_codes']) ? (raw['external_codes'] as string[]) : [],
  };
}

export function isPricesStale(row: ProductLookup): boolean {
  if (!row.prices_refreshed_at) return true;
  const age = Date.now() - new Date(row.prices_refreshed_at).getTime();
  return age > PRICES_TTL_MS;
}

// Upsert a freshly-computed ProductLookup row. The DB trigger handles
// updated_at; we still set it locally for caller-visible immediacy.
//
// On conflict we MERGE the fields — never wipe a non-null cached value
// with a null from a fresh fetch. This protects identity fields when a
// later eBay query returns thinner data than the first one did.
//
// Also resolves category_id from category_aliases when the fresh row
// has a category_raw but no category_id yet. This is the link between
// per-source category strings ("Power Tools > Drills") and the
// platform's canonical category tree.
export async function upsertLookup(
  supabase: SupabaseClient,
  fresh: ProductLookup,
): Promise<ProductLookup | null> {
  // If the incoming lookup has no brand but has a title, attempt dictionary
  // extraction. This catches product_lookups rows populated from scrapers
  // that return a title but omit brand, without a separate backfill step.
  const enrichedFresh: ProductLookup =
    !fresh.brand && fresh.title ? { ...fresh, brand: extractBrand(fresh.title) } : fresh;

  // Resolve category_id from category_aliases if not already set. Best-
  // effort — null is fine, it just means "unclassified" until a later
  // pass picks it up.
  let resolved = enrichedFresh;
  if (!enrichedFresh.category_id && enrichedFresh.category_raw) {
    const cid = await resolveCategoryFromAlias(
      supabase,
      enrichedFresh.category_raw,
      enrichedFresh.title,
    );
    if (cid) resolved = { ...enrichedFresh, category_id: cid };
  }

  // Read the existing row (if any) so we can do a defensive non-null merge.
  const { data: prev } = await supabase
    .from('product_lookups')
    .select('*')
    .eq('upc', resolved.upc)
    .maybeSingle();

  const merged = prev ? mergeNonNull(prev as unknown as ProductLookup, resolved) : resolved;

  const { data, error } = await supabase
    .from('product_lookups')
    .upsert({
      upc: merged.upc,
      title: merged.title,
      brand: merged.brand,
      model: merged.model,
      category_id: merged.category_id,
      category_raw: merged.category_raw,
      image_urls: merged.image_urls,
      // Multi-identifier fields (migration 0042).
      asin: merged.asin,
      fnsku: merged.fnsku,
      lpn: merged.lpn,
      mpn: merged.mpn,
      external_codes: merged.external_codes,
      msrp_cents: merged.msrp_cents,
      avg_asking_cents: merged.avg_asking_cents,
      median_sold_cents: merged.median_sold_cents,
      start_bid_cents: merged.start_bid_cents,
      prices: merged.prices,
      sold_comps: merged.sold_comps,
      description: merged.description,
      specs: merged.specs,
      confidence: merged.confidence,
      sources: merged.sources,
      identity_refreshed_at: merged.identity_refreshed_at,
      prices_refreshed_at: merged.prices_refreshed_at,
    })
    .select('*')
    .single();
  if (error || !data) return null;
  return hydrateRow(data as Record<string, unknown>);
}

// Longest-substring match between (category_raw + title) lowercased and
// the alias.raw needles. Mirrors the algorithm in operator-web's import
// action so cache-side classification matches import-time classification.
async function resolveCategoryFromAlias(
  supabase: SupabaseClient,
  categoryRaw: string,
  title: string | null,
): Promise<string | null> {
  const target = `${categoryRaw.toLowerCase()} ${(title ?? '').toLowerCase()}`.trim();
  if (!target) return null;

  const { data } = await supabase.from('category_aliases').select('raw, category_id');
  const aliases = (data ?? []) as Array<{ raw: string; category_id: string }>;

  let bestId: string | null = null;
  let bestLen = 0;
  for (const a of aliases) {
    if (a.raw.length <= bestLen) continue;
    if (target.includes(a.raw)) {
      bestId = a.category_id;
      bestLen = a.raw.length;
    }
  }
  return bestId;
}

function mergeNonNull(prev: ProductLookup, fresh: ProductLookup): ProductLookup {
  // Identity fields: prefer fresh if non-null, else keep prev.
  // Pricing fields: always take fresh (they're the point of the refresh).
  // Arrays: take fresh if non-empty, else keep prev (union for external_codes).
  return {
    upc: fresh.upc,
    title: fresh.title ?? prev.title,
    brand: fresh.brand ?? prev.brand,
    model: fresh.model ?? prev.model,
    category_id: fresh.category_id ?? prev.category_id,
    category_raw: fresh.category_raw ?? prev.category_raw,
    image_urls: fresh.image_urls.length ? fresh.image_urls : prev.image_urls,
    // Multi-identifier: never clobber a good identifier with null.
    // external_codes: union so codes from different import passes accumulate.
    asin: fresh.asin ?? prev.asin,
    fnsku: fresh.fnsku ?? prev.fnsku,
    lpn: fresh.lpn ?? prev.lpn,
    mpn: fresh.mpn ?? prev.mpn,
    external_codes: dedupe([...prev.external_codes, ...fresh.external_codes]),
    msrp_cents: fresh.msrp_cents ?? prev.msrp_cents,
    avg_asking_cents: fresh.avg_asking_cents,
    median_sold_cents: fresh.median_sold_cents ?? prev.median_sold_cents,
    start_bid_cents: fresh.start_bid_cents ?? prev.start_bid_cents,
    prices: fresh.prices.length ? fresh.prices : prev.prices,
    sold_comps: fresh.sold_comps.length ? fresh.sold_comps : prev.sold_comps,
    description: fresh.description ?? prev.description,
    specs: fresh.specs ?? prev.specs,
    confidence: pickConfidence(prev.confidence, fresh.confidence),
    sources: dedupe([...prev.sources, ...fresh.sources]),
    identity_refreshed_at: fresh.identity_refreshed_at,
    prices_refreshed_at: fresh.prices_refreshed_at ?? prev.prices_refreshed_at,
    created_at: prev.created_at,
    updated_at: new Date().toISOString(),
  };
}

const CONFIDENCE_RANK: Record<ProductLookup['confidence'], number> = {
  high: 3,
  medium: 2,
  low: 1,
  none: 0,
};

function pickConfidence(
  a: ProductLookup['confidence'],
  b: ProductLookup['confidence'],
): ProductLookup['confidence'] {
  return CONFIDENCE_RANK[a] >= CONFIDENCE_RANK[b] ? a : b;
}

function dedupe<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}

// Trigram fuzzy search on title for keyword search. The pg_trgm GIN
// index from migration 0027 makes this fast even at scale.
//
// Returns rows ordered by similarity desc. Caller decides similarity
// threshold; here we filter > 0.3 which roughly excludes "no real match"
// noise without being too strict.
//
// 2026-08-07: this used `.textSearch(title, …, {type:'websearch'})`, which is
// FULL-TEXT search — it cannot use the trigram GIN index this function is named
// after, and no tsvector index on product_lookups exists. So every call was a
// sequential scan of 262,665 rows: 12,169 calls at a mean of 3,428 ms and
// 41,711 s total, the single largest statement on the instance, with the
// no-match case running until the 8 s statement_timeout killed it. ILIKE
// '%q%' is what the trigram index actually serves — the same query the error
// fallback below was already using — and measures 143 ms via a Bitmap Index
// Scan on product_lookups_title_trgm_idx. The FTS path is gone, not reordered:
// it never errored, it was just slow, so the fallback never rescued it.
export async function searchTitleTrgm(
  supabase: SupabaseClient,
  query: string,
  limit = 5,
): Promise<ProductLookup[]> {
  const q = query.trim();
  if (!q) return [];
  const { data, error } = await supabase
    .from('product_lookups')
    .select('*')
    .neq('confidence', 'none')
    .ilike('title', `%${q}%`)
    .limit(limit);
  if (error || !data) {
    return [];
  }
  return data as unknown as ProductLookup[];
}
