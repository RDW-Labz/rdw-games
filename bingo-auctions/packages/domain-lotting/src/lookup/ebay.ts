// eBay Browse API client — DEPRECATED / OPTIONAL.
//
// eBay API access was denied in May 2025.  The platform now uses
// OpenRouter web-search models (Perplexity Sonar) as the live data
// source via lookup/openrouter.ts.
//
// This file is kept so that eBay support can be re-enabled without
// a rewrite if access is restored.  ALL exported functions gate on
// the EBAY_CLIENT_ID env var / config.ebay being present; they return
// empty results silently if not set, so the rest of the stack is
// unaffected while the credentials are absent.
//
// To re-enable: set EBAY_CLIENT_ID + EBAY_CLIENT_SECRET in .env.local
// and call setLottingConfig({ ebay: { clientId, clientSecret } }).
// The lookup/index.ts call-sites that call OpenRouter first will
// automatically supplement with eBay data once credentials exist.
//
// Original endpoints:
//   1. /buy/browse/v1/item_summary/search?q={UPC}  → current asking listings
//   2. (same, filter sold) → past sold comps for the auction-startBid signal
//
// Auth: OAuth client-credentials grant. Tokens last 7200s; we cache a
// single token per process and refresh ~5 min before expiry.

import { getLottingConfig } from '../config';

const EBAY_TOKEN_URL_PROD = 'https://api.ebay.com/identity/v1/oauth2/token';
const EBAY_TOKEN_URL_SBOX = 'https://api.sandbox.ebay.com/identity/v1/oauth2/token';
const EBAY_API_PROD = 'https://api.ebay.com';
const EBAY_API_SBOX = 'https://api.sandbox.ebay.com';
const SCOPE = 'https://api.ebay.com/oauth/api_scope';

let tokenCache: { token: string; expiresAt: number } | null = null;

function ebayHosts(): { token: string; api: string } {
  const env = getLottingConfig().ebay?.env ?? 'PRODUCTION';
  return env === 'SANDBOX'
    ? { token: EBAY_TOKEN_URL_SBOX, api: EBAY_API_SBOX }
    : { token: EBAY_TOKEN_URL_PROD, api: EBAY_API_PROD };
}

function ebayMarketplaceId(): string {
  return getLottingConfig().ebay?.marketplaceId ?? 'EBAY_US';
}

function b64(s: string): string {
  // Cross-platform base64 (Node 18+, browsers, RN all expose btoa or Buffer).
  if (typeof btoa === 'function') return btoa(s);
  return Buffer.from(s, 'utf8').toString('base64');
}

async function getAccessToken(): Promise<string | null> {
  const cfg = getLottingConfig();
  if (!cfg.ebay?.clientId || !cfg.ebay?.clientSecret) return null;

  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt > now + 60_000) {
    return tokenCache.token;
  }

  const { token: tokenUrl } = ebayHosts();
  const basic = b64(`${cfg.ebay.clientId}:${cfg.ebay.clientSecret}`);

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    scope: SCOPE,
  });

  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`eBay token ${res.status}: ${text.substring(0, 200)}`);
  }

  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error('eBay token: no access_token in response');

  const expiresAt = now + (data.expires_in ?? 7200) * 1000;
  tokenCache = { token: data.access_token, expiresAt };
  return data.access_token;
}

// ----- API call shapes -------------------------------------------------------

export type EbaySummaryItem = {
  itemId: string;
  title: string;
  price?: { value: string; currency: string };
  image?: { imageUrl: string };
  thumbnailImages?: Array<{ imageUrl: string }>;
  itemWebUrl: string;
  condition?: string;
  conditionId?: string;
  brand?: string;
  mpn?: string;
  categoryPath?: string;
  itemEndDate?: string;
  itemSoldDate?: string; // present when filtering for sold
};

type SearchResponse = {
  itemSummaries?: EbaySummaryItem[];
  total?: number;
};

async function ebayFetch<T>(path: string): Promise<T | null> {
  const token = await getAccessToken();
  if (!token) return null;
  const { api } = ebayHosts();
  const res = await fetch(`${api}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'X-EBAY-C-MARKETPLACE-ID': ebayMarketplaceId(),
      Accept: 'application/json',
    },
  });
  if (res.status === 204 || res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`eBay ${res.status} ${path}: ${text.substring(0, 200)}`);
  }
  return (await res.json()) as T;
}

// Search by UPC → current asking listings (sorted by price).
export async function searchActiveByUpc(upc: string, limit = 20): Promise<EbaySummaryItem[]> {
  const params = new URLSearchParams({
    q: upc,
    limit: String(limit),
    sort: 'price',
    'fieldgroups': 'EXTENDED',
  });
  const data = await ebayFetch<SearchResponse>(
    `/buy/browse/v1/item_summary/search?${params.toString()}`,
  );
  return data?.itemSummaries ?? [];
}

// Search by free-form keyword (e.g. "DeWalt DCD771C2").
export async function searchActiveByKeyword(query: string, limit = 10): Promise<EbaySummaryItem[]> {
  const params = new URLSearchParams({
    q: query,
    limit: String(limit),
    sort: 'price',
    'fieldgroups': 'EXTENDED',
  });
  const data = await ebayFetch<SearchResponse>(
    `/buy/browse/v1/item_summary/search?${params.toString()}`,
  );
  return data?.itemSummaries ?? [];
}

// Sold listings via the standard Browse search with the SOLD filter.
// (eBay's official Marketplace Insights API requires special grant; the
// public Browse API exposes sold via filter=conditions=USED&buyingOptions=...
// or the FILTER=soldItemsOnly query. We use the documented filter param.)
//
// Note: the publicly available Browse endpoint may not always return
// historical sold data on every keypair; in that case the array is empty
// and median_sold_cents stays null. We still return what we can get.
export async function searchSoldByUpc(upc: string, limit = 20): Promise<EbaySummaryItem[]> {
  const params = new URLSearchParams({
    q: upc,
    limit: String(limit),
    'filter': 'soldItemsOnly:true',
    'fieldgroups': 'EXTENDED',
  });
  const data = await ebayFetch<SearchResponse>(
    `/buy/browse/v1/item_summary/search?${params.toString()}`,
  );
  return data?.itemSummaries ?? [];
}

// ----- Helpers ---------------------------------------------------------------

export function priceToCents(p: { value: string; currency: string } | undefined): number | null {
  if (!p?.value) return null;
  const n = Number(p.value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

// median and average are canonical in normalize/stats.ts.
// Re-exported here so existing callers of lookup/ebay continue to work.
export { median, average } from '../normalize/stats';
