// Bright Data SERP API — no-UPC product identification.
//
// For items with no barcode, search Google Shopping and surface candidate
// products (title / price / image / source) the lister can pick; full
// enrichment then runs on the chosen URL through the scrape-url route (Web
// Unlocker). Dormant unless BRIGHTDATA_API_TOKEN is set; best-effort — returns
// [] on any error so the keyword search falls through to the existing paths.
//
// Contract (Bright Data SERP, brd_json=1):
//   POST https://api.brightdata.com/request
//   { zone, url, format:'raw' }  +  Authorization: Bearer <token>
//   → JSON of search results. The field names below are parsed DEFENSIVELY and
//   should be confirmed against a live response when the key is wired up.

import type { KeywordSearchHit, ProductLookup } from './types';

const DEFAULT_API = 'https://api.brightdata.com/request';
const TIMEOUT_MS = 15_000;

function token(): string | null {
  return process.env['BRIGHTDATA_API_TOKEN']?.trim() || null;
}
function zone(): string {
  return process.env['BRIGHTDATA_SERP_ZONE']?.trim() || 'serp_api';
}
function apiUrl(): string {
  return process.env['BRIGHTDATA_API_URL']?.trim() || DEFAULT_API;
}

/** True when the Bright Data SERP API is configured. */
export function serpConfigured(): boolean {
  return !!token();
}

export function parsePriceCents(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.round(raw * 100);
  if (typeof raw !== 'string') return null;
  const m = raw.replace(/,/g, '').match(/(\d+(?:\.\d{1,2})?)/);
  if (!m?.[1]) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : null;
}

// A transient product row built from a SERP candidate. Not persisted to the
// catalog (confidence 'low', source 'serp') — it's a pick-list entry; the real
// enrichment happens when the lister opens its URL.
function transient(fields: Partial<ProductLookup>): ProductLookup {
  const now = new Date().toISOString();
  return {
    upc: '',
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
    confidence: 'low',
    sources: ['serp'],
    identity_refreshed_at: now,
    prices_refreshed_at: null,
    created_at: now,
    updated_at: now,
    ...fields,
  };
}

type SerpItem = {
  title?: unknown;
  link?: unknown;
  url?: unknown;
  price?: unknown;
  image?: unknown;
  thumbnail?: unknown;
  shop?: unknown; // Google Shopping retailer name (the live brd_json field)
  source?: unknown;
};

/**
 * Google-Shopping search for a free-text query → candidate products. Returns []
 * when unconfigured or on any failure.
 */
export async function searchSerp(query: string, limit = 6): Promise<KeywordSearchHit[]> {
  const q = query.trim();
  const tok = token();
  if (!q || !tok) return [];

  // gl=us&hl=en pins Google to US/English so prices come back in USD — without
  // it the SERP zone's exit IP geo leaks through and returns localized results
  // (e.g. BRL), which are useless for US resale comps.
  const searchUrl = `https://www.google.com/search?tbm=shop&q=${encodeURIComponent(q)}&gl=us&hl=en&brd_json=1`;
  let res: Response;
  try {
    res = await fetch(apiUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
      body: JSON.stringify({ zone: zone(), url: searchUrl, format: 'raw' }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return [];
  }
  if (!res.ok) return [];

  let json: { shopping?: SerpItem[]; organic?: SerpItem[] };
  try {
    json = JSON.parse(await res.text()) as typeof json;
  } catch {
    return [];
  }

  const items = Array.isArray(json.shopping)
    ? json.shopping
    : Array.isArray(json.organic)
      ? json.organic
      : [];

  const hits: KeywordSearchHit[] = [];
  for (const it of items) {
    const title = typeof it.title === 'string' ? it.title.trim() : '';
    if (!title) continue;
    const url = typeof it.link === 'string' ? it.link : typeof it.url === 'string' ? it.url : null;
    const image = typeof it.image === 'string' ? it.image : typeof it.thumbnail === 'string' ? it.thumbnail : null;
    const cents = parsePriceCents(it.price);
    const retailer =
      typeof it.shop === 'string' && it.shop
        ? it.shop
        : typeof it.source === 'string' && it.source
          ? it.source
          : 'serp';
    hits.push({
      product: transient({
        title,
        image_urls: image ? [image] : [],
        msrp_cents: cents,
        prices: cents && url ? [{ retailer, cents, url, fetched_at: new Date().toISOString() }] : [],
      }),
    });
    if (hits.length >= limit) break;
  }
  return hits;
}
