// Catalog read-through / write-through for the paste-URL scraper.
//
// Goal: every URL we scrape should compound the master catalog
// (product_lookups), and a URL we've scraped before should NEVER be re-scraped
// (re-billing Bright Data) — the catalog answers instantly and free.
//
// The catalog is keyed by `upc` (or a synthetic primary key for code-only
// items, following domain-lotting's `asin:` / `fnsku:` / `lpn:` convention).
// Here we extend that convention to every allowlisted retailer:
//   Amazon   → raw ASIN (lives in the `asin` column; the RPC resolves it)
//   others   → `<retailer>:<id>`  (walmart:, target:, homedepot:, …)
//   fallback → `url:<host><path>` (stable per product page)
//
// read-through keys off the URL alone (pre-scrape). write-through stores the
// real UPC as the primary key when the page yielded one, and ALWAYS pushes the
// URL-derived code into external_codes, so a later read by either id hits the
// same row. upsertLookup() does the normalize + non-null merge + embedding.

import type { SupabaseClient } from '@supabase/supabase-js';
import {
  readByCode,
  upsertLookup,
  normalizeUpc,
  type ProductLookup,
  type ProductLookupSource,
} from '@auction-platform/domain-lotting';

/** The subset of the scrape route's ScrapedData that the catalog round-trips.
 *  Declared locally (not imported from the route) so this lib never depends on
 *  a route module — the field names/types match ScrapedData structurally. */
export type CatalogScrapeData = {
  title: string;
  msrp_cents: number | null;
  primary_image_url: string | null;
  additional_image_urls: string[];
  description: string | null;
  brand: string | null;
  upc: string | null;
  asin: string | null;
  item_condition: string | null;
  variant_asins: string[];
  specs: string | null;
};

const MAX_IMAGES = 7;

/**
 * Derive a stable catalog key from a product URL. Returns the raw ASIN for
 * Amazon (matches the `asin` column), a `<retailer>:<id>` token for the known
 * retailers, or a normalized `url:<host><path>` fallback. null only for an
 * unparseable URL.
 */
export function retailerCodeForUrl(rawUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  const fullHost = u.hostname.toLowerCase();
  const host = fullHost.replace(/^www\./, '');
  const path = u.pathname;

  // Amazon → raw ASIN. The catalog stores ASINs in the `asin` column and the
  // lookup RPC resolves a bare ASIN, so we key on the raw code (not `asin:`).
  if (/(?:^|\.)amazon\./.test(fullHost)) {
    const asin = path.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/i)?.[1];
    if (asin) return asin.toUpperCase();
  }
  // eBay → item number (/itm/<id> or ?item=<id>).
  if (/(?:^|\.)ebay\./.test(fullHost)) {
    const id = path.match(/\/itm\/(?:[^/]+\/)?(\d{6,})/)?.[1] ?? u.searchParams.get('item');
    if (id) return `ebay:${id}`;
  }
  switch (host) {
    case 'walmart.com': {
      const id = path.match(/\/ip\/(?:[^/]+\/)?(\d{4,})/)?.[1];
      if (id) return `walmart:${id}`;
      break;
    }
    case 'target.com': {
      const id = path.match(/\/A-(\d{5,})/i)?.[1];
      if (id) return `target:${id}`;
      break;
    }
    case 'homedepot.com': {
      const id = path.match(/\/p\/(?:[^/]+\/)*(\d{6,})(?:\/|$)/)?.[1];
      if (id) return `homedepot:${id}`;
      break;
    }
    case 'lowes.com': {
      const id = path.match(/\/pd\/(?:[^/]+\/)?(\d{6,})/)?.[1];
      if (id) return `lowes:${id}`;
      break;
    }
    case 'bestbuy.com': {
      const id = path.match(/\/(\d{6,})\.p/)?.[1] ?? u.searchParams.get('skuId');
      if (id) return `bestbuy:${id}`;
      break;
    }
    case 'wayfair.com': {
      const id = path.match(/([a-z]{2,5}\d{4,})\.html/i)?.[1];
      if (id) return `wayfair:${id.toLowerCase()}`;
      break;
    }
    case 'costco.com': {
      const id = path.match(/\.product\.(\d{5,})\.html/)?.[1];
      if (id) return `costco:${id}`;
      break;
    }
    case 'etsy.com': {
      const id = path.match(/\/listing\/(\d{4,})/)?.[1];
      if (id) return `etsy:${id}`;
      break;
    }
    case 'ikea.com': {
      const id = path.match(/-(\w{6,})\/?$/)?.[1];
      if (id) return `ikea:${id.toLowerCase()}`;
      break;
    }
    case 'overstock.com': {
      const id = path.match(/\/(\d{5,})\/product\.html/)?.[1];
      if (id) return `overstock:${id}`;
      break;
    }
    default:
      break;
  }

  // Generic fallback: normalized host+path (query + trailing slash stripped).
  // Stable per product page; capped to sit comfortably in the key column.
  const norm = `${host}${path.replace(/\/+$/, '')}`.slice(0, 180);
  return norm.length > host.length ? `url:${norm}` : null;
}

/** Strip a synthetic prefix; return a real numeric UPC or null. */
function realUpc(key: string | null): string | null {
  if (!key) return null;
  return /^\d{8,14}$/.test(key) ? key : null;
}

function imagesOf(row: ProductLookup): string[] {
  return Array.isArray(row.image_urls) ? row.image_urls.filter(Boolean) : [];
}

function lookupToScraped(row: ProductLookup, images: string[]): CatalogScrapeData {
  return {
    title: row.title ?? 'Imported product',
    msrp_cents: row.msrp_cents ?? null,
    primary_image_url: images[0] ?? null,
    additional_image_urls: images.slice(1, MAX_IMAGES),
    description: row.description ?? null,
    brand: row.brand ?? null,
    upc: realUpc(row.upc) ?? null,
    asin: row.asin ?? null,
    item_condition: null, // condition isn't a per-listing catalog field
    variant_asins: [],
    specs: row.specs ?? null,
  };
}

/**
 * Catalog read-through. Returns a complete prior entry (real title + at least
 * one image) for this URL, or null to fall through to a live scrape. Best-
 * effort: never throws.
 */
export async function readScrapeCache(
  admin: SupabaseClient,
  rawUrl: string,
): Promise<CatalogScrapeData | null> {
  try {
    const code = retailerCodeForUrl(rawUrl);
    if (!code) return null;
    const row = await readByCode(admin, code);
    if (!row) return null;
    const title = (row.title ?? '').trim();
    const images = imagesOf(row);
    // Only short-circuit on a genuinely useful row — otherwise scrape so the
    // write-through can fill it in.
    if (!title || title === 'Imported product' || images.length === 0) return null;
    return lookupToScraped(row, images);
  } catch {
    return null;
  }
}

/**
 * Catalog write-through. Normalizes a fresh scrape into the master catalog so
 * the next scan/paste of the same item is a free cache hit. Keyed by real UPC
 * when present, else the URL-derived retailer code; the retailer code is always
 * recorded in external_codes for cross-id resolution. Best-effort: never throws,
 * never blocks the caller's success response on failure.
 */
export async function writeScrapeCache(
  admin: SupabaseClient,
  rawUrl: string,
  data: CatalogScrapeData,
): Promise<void> {
  try {
    const title = (data.title ?? '').trim();
    if (!title || title === 'Imported product') return; // don't cache hollow rows

    const code = retailerCodeForUrl(rawUrl);
    const upc = normalizeUpc(data.upc ?? '');
    const asin = data.asin ? data.asin.toUpperCase() : null;
    const primaryKey =
      (upc && /^\d{8,14}$/.test(upc) ? upc : null) ??
      (asin ? `asin:${asin}` : null) ??
      code;
    if (!primaryKey) return;

    const images = [data.primary_image_url, ...(data.additional_image_urls ?? [])]
      .filter((s): s is string => !!s)
      .slice(0, MAX_IMAGES);

    const externalCodes: string[] = [];
    if (code && code !== primaryKey) externalCodes.push(code);

    const now = new Date().toISOString();
    const row: ProductLookup = {
      upc: primaryKey,
      title,
      brand: data.brand ?? null,
      model: null,
      category_id: null,
      category_raw: null,
      image_urls: images,
      asin,
      fnsku: null,
      lpn: null,
      mpn: null,
      external_codes: externalCodes,
      msrp_cents: data.msrp_cents ?? null,
      avg_asking_cents: null,
      median_sold_cents: null,
      start_bid_cents: null,
      prices: [],
      sold_comps: [],
      description: data.description ?? null,
      specs: data.specs ?? null,
      confidence: 'high', // parsed from a real, non-hollow product page
      sources: ['scrape' as ProductLookupSource],
      identity_refreshed_at: now,
      prices_refreshed_at: data.msrp_cents != null ? now : null,
      created_at: now,
      updated_at: now,
    };
    await upsertLookup(admin, row);
  } catch {
    // best-effort — the scrape response is returned regardless
  }
}
