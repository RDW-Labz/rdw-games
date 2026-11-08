// Shared client for the /api/lottr/scrape-url endpoint (D-server PR #260).
//
// One place owns the request contract + the TWO-STAGE fallback so both
// callers — Web Lookup's paste-URL import (web.tsx) and Manual lot's
// "Paste product URL → Autofill" block (manual.tsx) — behave identically.
//
// Server contract (PR #260):
//   Success 200: { ok:true, host, source:'direct'|'ai_fallback',
//                  data:{ title, msrp_cents, primary_image_url,
//                         additional_image_urls, description, brand,
//                         upc, asin, item_condition }, warnings:string[] }
//   Failure 4xx/5xx: { ok:false, error, needs_fallback?:boolean }
//     needs_fallback:true ⇒ retry the SAME url with ?allowAiFallback=1.
//
// The OpenRouter key is server-side only — the client just POSTs the URL
// (+ optional ?allowAiFallback=1 query flag).

import { getFreshAccessToken } from './fresh-token';
import { fetchWithTimeout } from './fetch-with-timeout';

// Scraper endpoint base URL. Same env-var pattern other lottr-client calls
// use; falls back to the production operator-web host.
const API_BASE =
  (typeof process !== 'undefined' && process.env.EXPO_PUBLIC_API_BASE_URL) ||
  'https://bingoauctions.com';

/** Structured product data returned by a successful scrape. Mirrors the
 *  server's `data` block field-for-field. All fields optional/nullable —
 *  the scraper fills what it can and the caller fills the rest manually. */
export type ScrapedData = {
  title?: string | null;
  msrp_cents?: number | null;
  primary_image_url?: string | null;
  additional_image_urls?: string[] | null;
  description?: string | null;
  brand?: string | null;
  upc?: string | null;
  asin?: string | null;
  item_condition?: string | null;
};

export type ScrapeSuccess = {
  ok: true;
  host: string;
  /** 'direct' = JSON-LD/DOM scrape; 'ai_fallback' = web-search assisted. */
  source: 'direct' | 'ai_fallback';
  data: ScrapedData;
  warnings: string[];
};

export type ScrapeFailure = {
  ok: false;
  error: string;
  /** true ⇒ the direct read was blocked; retry with allowAiFallback. */
  needs_fallback?: boolean;
};

export type ScrapeResult = ScrapeSuccess | ScrapeFailure;

/** Distinct failure for "no Supabase session" so callers can prompt re-auth
 *  instead of showing a generic scrape error. */
export type ScrapeOutcome =
  | ScrapeResult
  | { ok: false; error: string; noSession: true };

/** Single round-trip to the scraper. `allowAiFallback` appends the query
 *  flag that tells the server it may spend an OpenRouter web-search call.
 *  Throws on network failure (caller catches); returns the parsed
 *  ok/!ok body otherwise. */
async function scrapeOnce(url: string, allowAiFallback: boolean, token: string): Promise<ScrapeResult> {
  const qs = allowAiFallback ? '?allowAiFallback=1' : '';
  const res = await fetchWithTimeout(`${API_BASE}/api/lottr/scrape-url${qs}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Mobile-safe auth: verifyLottrAuth accepts a Bearer token or cookie.
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ url }),
  });
  // The endpoint returns JSON for both success and failure. A non-JSON
  // body (e.g. an HTML 502 page) is treated as a generic failure.
  const json = (await res.json().catch(() => null)) as ScrapeResult | null;
  if (!json || typeof json !== 'object' || !('ok' in json)) {
    return { ok: false, error: `Scraper returned an unexpected response (HTTP ${res.status}).` };
  }
  return json;
}

/**
 * Two-stage scrape with progress callbacks. Both paste-URL flows call this:
 *
 *   1. POST WITHOUT the flag first (fast direct attempt) — `onStage('reading')`.
 *   2. If the response is `ok:false` with `needs_fallback:true`, retry the
 *      SAME url with `?allowAiFallback=1` — `onStage('searching')`.
 *   3. Return the success `data`, or the final failure.
 *
 * Never throws for scrape failures — network errors are caught and returned
 * as `{ ok:false }`. Returns `{ noSession:true }` when there's no Supabase
 * session so the caller can prompt the operator to sign back in.
 */
export async function scrapeProductUrl(
  url: string,
  onStage?: (stage: 'reading' | 'searching') => void,
): Promise<ScrapeOutcome> {
  // 2026-07-10: fresh token (refreshes when expired/near-expiry) — see
  // lib/fresh-token.ts. A cached-but-dead token made these calls 401
  // mid-shift when the shared staff account signed out on another device.
  const token = await getFreshAccessToken();
  if (!token) {
    return { ok: false, error: 'Session expired', noSession: true };
  }

  try {
    // Stage 1 — fast direct read.
    onStage?.('reading');
    const first = await scrapeOnce(url, false, token);
    if (first.ok) return first;

    // Stage 2 — only when the server explicitly asks for the AI fallback.
    if (first.needs_fallback) {
      onStage?.('searching');
      const second = await scrapeOnce(url, true, token);
      return second;
    }

    // Direct failure with no fallback offered — surface it as-is.
    return first;
  } catch (err) {
    return { ok: false, error: (err as Error).message || 'Network error reading the page.' };
  }
}

/** Strip the machine-readable prefix before the em-dash for a cleaner
 *  user-facing message; show the whole string if there's no dash. Matches
 *  the existing web.tsx / share-intent error formatting. */
export function cleanScrapeError(error: string): string {
  return error.includes(' — ') ? (error.split(' — ')[1] ?? error) : error;
}
