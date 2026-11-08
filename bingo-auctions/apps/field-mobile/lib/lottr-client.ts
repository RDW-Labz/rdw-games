// Mobile AI proxy client — field-mobile side.
//
// All AI calls (photo scan, keyword search, UPC lookup) go through
// operator-web's /api/lottr/* routes. The mobile bundle never holds
// AI keys. The Supabase JWT is the auth boundary: every request sends
// `Authorization: Bearer <access_token>` and the server verifies the
// token + operator_users membership before forwarding to domain-lotting.
//
// Usage:
//   import { scanPhoto, lookupCode, searchKeyword } from '@/lib/lottr-client';
//
// The function signatures are intentionally identical to domain-lotting's
// AI surface so callers need minimal changes.
//
// Re-exported types let callers do:
//   import { scanPhoto, type LotCandidate } from '@/lib/lottr-client';
// instead of reaching into domain-lotting directly.

import { getFreshAccessToken } from './fresh-token';
import { fetchWithTimeout } from './fetch-with-timeout';

// Re-export the types that callers previously imported from domain-lotting
// so they don't need to change their import paths for types.
export type {
  LotCandidate,
  Identification,
  KeywordSearchHit,
} from '@auction-platform/domain-lotting';

// ── Cost event ring buffer ────────────────────────────────────────────────────
//
// Populated by every proxy call that returns cost data. The CostHud polls
// this in-memory buffer every 750ms. Max 20 entries — older events are
// evicted automatically.

export type CostEvent = {
  /** Human-readable task name matching the proxy route (e.g. 'lookup-code'). */
  task: string;
  /** Estimated USD cost from the telemetry hook, or 0 on cache hits. */
  cost_usd: number;
  /** True when the server returned fromCache: true (no AI call). */
  cached: boolean;
  /** unix ms timestamp of when this client received the response. */
  at: number;
};

const RING_SIZE = 20;
const _recentCosts: CostEvent[] = [];

function pushCostEvent(event: CostEvent): void {
  _recentCosts.unshift(event);
  if (_recentCosts.length > RING_SIZE) {
    _recentCosts.length = RING_SIZE;
  }
}

export function getRecentCosts(): readonly CostEvent[] {
  return _recentCosts;
}

export function clearCostHistory(): void {
  _recentCosts.length = 0;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// Fallback to the production operator-web URL when the env var isn't
// present. Builds are SUPPOSED to bake EXPO_PUBLIC_API_BASE_URL in via
// eas.json, but EAS Update doesn't always pick it up the same way EAS
// Build does — and once Cloudflare aliases admin.cluerholdings.com to
// the Vercel deployment, the env var override takes precedence.
const DEFAULT_API_BASE = 'https://project-9ymiy.vercel.app';
const API_BASE = (process.env['EXPO_PUBLIC_API_BASE_URL'] ?? DEFAULT_API_BASE).replace(/\/$/, '');

class LottrProxyError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'LottrProxyError';
  }
}

async function getAccessToken(): Promise<string> {
  // 2026-07-10: freshness-aware — refreshes an expired/near-expiry token
  // before use (see lib/fresh-token.ts) instead of riding the cached one.
  const token = await getFreshAccessToken();
  if (!token) {
    throw new LottrProxyError(401, 'No active Supabase session — sign in first.');
  }
  return token;
}

// Raw POST helper — returns the full parsed response body so callers can
// extract both `data` and `meta` fields.
async function postRaw<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<{ data: T; meta: ProxyMeta }> {
  if (!API_BASE) {
    throw new LottrProxyError(
      503,
      'EXPO_PUBLIC_API_BASE_URL is not set. Add it to apps/field-mobile/.env.',
    );
  }

  const token = await getAccessToken();

  const res = await fetchWithTimeout(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  let json: {
    ok: boolean;
    data?: T;
    error?: string;
    meta?: ProxyMeta;
  } & Record<string, unknown>;
  try {
    json = (await res.json()) as typeof json;
  } catch {
    throw new LottrProxyError(res.status, `Server returned non-JSON (${res.status})`);
  }

  if (!res.ok || !json.ok) {
    throw new LottrProxyError(
      res.status,
      (json.error as string | undefined) ?? `Request failed with status ${res.status}`,
    );
  }

  return {
    data: json.data as T,
    meta: json.meta ?? {},
  };
}

// Convenience wrapper for routes that embed data at the top level (lookup-code)
// vs. routes that nest it under 'data' (scan-photo, identify-photo).
async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const { data } = await postRaw<T>(path, body);
  return data;
}

// ── Proxy meta shape ──────────────────────────────────────────────────────────

type ProxyMeta = {
  fromCache?: boolean;
  stalePrices?: boolean;
  cost_usd?: number;
  [key: string]: unknown;
};

// ── Public API — mirrors domain-lotting's AI surface ─────────────────────────

import type {
  LotCandidate,
  Identification,
  KeywordSearchHit,
} from '@auction-platform/domain-lotting';

/**
 * Vision + web-search scan of one or more photos of the same product.
 * Caller can pass a single (base64, mediaType) pair OR an array of 1-3
 * images for multi-angle OCR. Server caps at 3.
 *
 * ~10-20s per call. Returns a full LotCandidate (ID + prices + stock
 * photos). Returns null when the server returns 422 (could not identify).
 */
export async function scanPhoto(
  base64OrImages: string | Array<{ base64: string; mediaType: string }>,
  mediaType?: string,
): Promise<LotCandidate | null> {
  const body =
    typeof base64OrImages === 'string'
      ? { base64: base64OrImages, mediaType: mediaType ?? 'image/jpeg' }
      : { images: base64OrImages.slice(0, 3) };

  try {
    const { data, meta } = await postRaw<LotCandidate>('/api/lottr/scan-photo', body);
    pushCostEvent({
      task: 'scan-photo',
      cost_usd: typeof meta.cost_usd === 'number' ? meta.cost_usd : 0,
      cached: meta.fromCache === true,
      at: Date.now(),
    });
    return data;
  } catch (err) {
    if (err instanceof LottrProxyError && err.status === 422) return null;
    throw err;
  }
}

/**
 * Multi-SKU shelf/pallet detection — Sonnet 4.6 vision. ~10-20s.
 * Returns 1-20 distinct SKUs detected in the photo, ordered by visibility.
 * Returns [] when the server returns 422 (no SKUs detected).
 */
export async function shelfScan(base64: string, mediaType: string): Promise<LotCandidate[]> {
  try {
    // Use postRaw to capture meta.cost_usd — the previous version called
    // post() which discards meta, so the CostHud showed "$0.000" for every
    // shelf scan even though the route returns cost_usd in meta. User
    // confirmed the missing cost on 2026-05-13.
    const { data, meta } = await postRaw<LotCandidate[]>('/api/lottr/shelf-scan', {
      base64,
      mediaType,
    });
    pushCostEvent({
      task: 'shelf-scan',
      cost_usd: typeof meta.cost_usd === 'number' ? meta.cost_usd : 0,
      cached: meta.fromCache === true,
      at: Date.now(),
    });
    return data;
  } catch (err) {
    if (err instanceof LottrProxyError && err.status === 422) return [];
    throw err;
  }
}

/**
 * Fast vision-only identification — no web-search, no pricing. ~5-8s.
 * Use when you'll fetch prices separately (e.g. by UPC from identifyPhoto's result).
 * Returns null when the server returns 422 (could not identify).
 */
export async function identifyPhoto(
  base64: string,
  mediaType: string,
): Promise<Identification | null> {
  try {
    const { data, meta } = await postRaw<Identification>('/api/lottr/identify-photo', {
      base64,
      mediaType,
    });
    pushCostEvent({
      task: 'identify-photo',
      cost_usd: typeof meta.cost_usd === 'number' ? meta.cost_usd : 0,
      cached: meta.fromCache === true,
      at: Date.now(),
    });
    return data;
  } catch (err) {
    if (err instanceof LottrProxyError && err.status === 422) return null;
    throw err;
  }
}

/**
 * UPC / EAN / ASIN / FNSKU / LPN / MPN barcode lookup (cache-first, OpenRouter on miss).
 * Returns null when the server returns 404 (no match).
 *
 * The response wraps the candidate in { candidate, meta } at the top level.
 * This function unwraps it so callers only receive the LotCandidate.
 * Cost metadata is captured in the ring buffer for the HUD.
 */
export async function lookupCode(code: string): Promise<LotCandidate | null> {
  try {
    // lookup-code returns { ok, candidate, meta } at the top level (not nested under 'data')
    const token = await getAccessToken();
    const res = await fetchWithTimeout(`${API_BASE}/api/lottr/lookup-code`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ code }),
    });

    let json: {
      ok: boolean;
      candidate?: LotCandidate;
      meta?: ProxyMeta;
      error?: string;
    };
    try {
      json = (await res.json()) as typeof json;
    } catch {
      throw new LottrProxyError(res.status, `Server returned non-JSON (${res.status})`);
    }

    if (res.status === 404 || (json.ok === false && json.error === 'no_match')) {
      return null;
    }

    if (!res.ok || !json.ok) {
      throw new LottrProxyError(
        res.status,
        json.error ?? `Request failed with status ${res.status}`,
      );
    }

    const meta: ProxyMeta = json.meta ?? {};
    pushCostEvent({
      task: 'lookup-code',
      cost_usd: typeof meta.cost_usd === 'number' ? meta.cost_usd : 0,
      // Cache hit means no AI call — distinguish $0 cache from $0 unconfigured
      cached: meta.fromCache === true,
      at: Date.now(),
    });

    return json.candidate ?? null;
  } catch (err) {
    if (err instanceof LottrProxyError && err.status === 404) return null;
    throw err;
  }
}

/**
 * Lookup with full meta returned — used by Quick Lot confirmation card to
 * display the matched catalog data alongside the cost event.
 */
export async function lookupCodeWithMeta(
  code: string,
  opts: { fast?: boolean } = {},
): Promise<{ candidate: LotCandidate | null; meta: ProxyMeta; cacheMiss?: boolean }> {
  const token = await getAccessToken();
  const res = await fetchWithTimeout(`${API_BASE}/api/lottr/lookup-code`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    // `fast` returns a cache-only answer so the scan isn't held on a live web
    // lookup; the caller enriches afterward. See the route's `fast` comment.
    body: JSON.stringify(opts.fast ? { code, fast: true } : { code }),
  });

  let json: {
    ok: boolean;
    candidate?: LotCandidate;
    meta?: ProxyMeta;
    error?: string;
    cacheMiss?: boolean;
  };
  try {
    json = (await res.json()) as typeof json;
  } catch {
    throw new LottrProxyError(res.status, `Server returned non-JSON (${res.status})`);
  }

  if (res.status === 404 || (json.ok === false && json.error === 'no_match')) {
    // cacheMiss distinguishes "the fast path skipped the web rungs" from
    // "every rung was tried and nothing matched".
    return { candidate: null, meta: json.meta ?? {}, cacheMiss: json.cacheMiss === true };
  }

  if (!res.ok || !json.ok) {
    throw new LottrProxyError(res.status, json.error ?? `Request failed with status ${res.status}`);
  }

  const meta: ProxyMeta = json.meta ?? {};
  pushCostEvent({
    task: 'lookup-code',
    cost_usd: typeof meta.cost_usd === 'number' ? meta.cost_usd : 0,
    cached: meta.fromCache === true,
    at: Date.now(),
  });

  return { candidate: json.candidate ?? null, meta };
}

/**
 * Lazy-enrich a Top-3 alternate the reviewer just tapped. The photo scan
 * returns alternates vision-only (no prices/photos/msrp); this fetches the
 * full detail on demand so scans stay fast. POSTs the candidate to
 * /api/lottr/enrich-candidate and returns the enriched candidate, or null if
 * nothing was found (caller keeps the candidate as-is).
 */
export async function enrichCandidate(candidate: LotCandidate): Promise<LotCandidate | null> {
  const token = await getAccessToken();
  const res = await fetchWithTimeout(`${API_BASE}/api/lottr/enrich-candidate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ candidate }),
  });

  let json: {
    ok: boolean;
    candidate?: LotCandidate;
    meta?: ProxyMeta;
    error?: string;
  };
  try {
    json = (await res.json()) as typeof json;
  } catch {
    throw new LottrProxyError(res.status, `Server returned non-JSON (${res.status})`);
  }

  if (res.status === 404 || (json.ok === false && json.error === 'no_match')) {
    return null;
  }

  if (!res.ok || !json.ok) {
    throw new LottrProxyError(res.status, json.error ?? `Request failed with status ${res.status}`);
  }

  const meta: ProxyMeta = json.meta ?? {};
  pushCostEvent({
    task: 'enrich-candidate',
    cost_usd: typeof meta.cost_usd === 'number' ? meta.cost_usd : 0,
    cached: meta.fromCache === true,
    at: Date.now(),
  });

  return json.candidate ?? null;
}

/**
 * PHOTO-2: resolve catalog stock images for a product identifier so the
 * lotting review card can show a photo BEFORE the lot is saved. Calls
 * /api/lottr/resolve-images (catalog read-through → free identifier
 * enrichment → self-warming write-back). Best-effort: returns [] on any
 * error / miss so the caller simply shows no stock photo. NOT AI-billed
 * (free identifier sources only), so no CostEvent is pushed.
 */
export async function resolveStockImages(ids: {
  upc?: string;
  asin?: string;
  isbn?: string;
}): Promise<string[]> {
  const upc = ids.upc?.trim();
  const asin = ids.asin?.trim();
  const isbn = ids.isbn?.trim();
  if (!upc && !asin && !isbn) return [];
  try {
    const token = await getAccessToken();
    const res = await fetchWithTimeout(`${API_BASE}/api/lottr/resolve-images`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ upc, asin, isbn }),
    });
    let json: { ok?: boolean; imageUrls?: unknown };
    try {
      json = (await res.json()) as typeof json;
    } catch {
      return [];
    }
    if (!res.ok || json.ok !== true || !Array.isArray(json.imageUrls)) return [];
    return json.imageUrls.filter((u): u is string => typeof u === 'string' && u.trim().length > 0);
  } catch {
    return [];
  }
}

/**
 * Keyword search (trigram cache → OpenRouter on miss). Returns up to 8 hits.
 * Returns [] on no match (server 404 is mapped to empty array).
 *
 * NOTE: The server response shape is { hits: Array<{ candidate, upc, sources, cached }> }.
 * This function remaps to KeywordSearchHit[] so callers can use the same
 * iteration patterns they used with searchByKeyword from domain-lotting.
 */
export async function searchKeyword(query: string): Promise<KeywordSearchHit[]> {
  type HitRaw = {
    candidate: LotCandidate;
    upc: string;
    sources: string[];
    cached: boolean;
  };
  type SearchRes = { hits: HitRaw[] };

  let res: SearchRes;
  try {
    res = await post<SearchRes>('/api/lottr/search-keyword', { query });
  } catch (err) {
    if (err instanceof LottrProxyError && err.status === 404) return [];
    throw err;
  }

  // Remap to the KeywordSearchHit shape that callers already know.
  // The server returns candidates mapped via productToCandidate(); we
  // don't have a ProductLookup to reconstruct, so we embed what we have
  // into a minimal KeywordSearchHit-compatible object for display.
  return res.hits.map((h) => ({
    // KeywordSearchHit.product is ProductLookup — we approximate from candidate.
    product: {
      upc: h.upc,
      title: h.candidate.title ?? null,
      brand: h.candidate.brand ?? null,
      model: h.candidate.model ?? null,
      category_id: null,
      category_raw: h.candidate.category ?? null,
      image_urls: h.candidate.stockPhotos ?? [],
      msrp_cents: h.candidate.msrp != null ? Math.round(h.candidate.msrp * 100) : null,
      avg_asking_cents: h.candidate.avg != null ? Math.round(h.candidate.avg * 100) : null,
      median_sold_cents: null,
      start_bid_cents: h.candidate.startBid != null ? Math.round(h.candidate.startBid * 100) : null,
      // Multi-identifier columns added in 0042 — synthesized as null/empty
      // for keyword hits since the server doesn't return them in this shape.
      asin: h.candidate.asin ?? null,
      fnsku: h.candidate.fnsku ?? null,
      lpn: h.candidate.lpn ?? null,
      mpn: h.candidate.mpn ?? null,
      external_codes: [],
      prices: [],
      sold_comps: [],
      description: h.candidate.description ?? null,
      specs: h.candidate.specs ?? null,
      confidence: 'medium' as const,
      sources: h.sources as import('@auction-platform/domain-lotting').ProductLookupSource[],
      identity_refreshed_at: new Date(0).toISOString(),
      prices_refreshed_at: null,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    },
    similarity: undefined,
  }));
}

export { LottrProxyError };
