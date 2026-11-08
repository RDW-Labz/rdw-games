// Pluggable egress backend for the scrape-url route.
//
// Amazon/eBay block datacenter IPs (including this Cloudflare Worker). To
// fetch them directly we delegate to an external egress that exits from a
// trusted (residential) IP. Today that's the self-hosted Playwright relay
// (see /scrape-relay); the SAME interface lets a managed scraping-API or a
// residential-proxy backend drop in later without touching the route.
//
// Dormant-until-configured: when RELAY_URL / RELAY_SECRET are unset,
// relayConfigured() is false and the route behaves exactly as before
// (Amazon/eBay fall to the existing Sonar substitute-page path). Both values
// are server-side Worker secrets — never shipped to a client.

/** Outcome of an egress fetch, shaped for the route's branch logic. */
export type EgressResult =
  | { kind: 'ok'; html: string; status: number; finalUrl: string }
  | { kind: 'blocked'; reason: string } // reached the page but it was a bot-block/captcha
  | { kind: 'unavailable'; reason: string }; // relay down / network / not configured

/** Per-attempt ceiling. The relay drives a real browser, so it's slow — give
 *  it more room than a plain fetch but still bounded so the Worker request
 *  can't hang. */
const RELAY_TIMEOUT_MS = 25_000;

function relayUrl(): string | null {
  return process.env['RELAY_URL']?.trim() || null;
}
function relaySecret(): string | null {
  return process.env['RELAY_SECRET']?.trim() || null;
}

/** True when an egress backend is configured and may be used. */
export function relayConfigured(): boolean {
  return !!relayUrl() && !!relaySecret();
}

type RelayResponse = {
  ok?: boolean;
  status?: number;
  finalUrl?: string;
  blocked?: boolean;
  blockReason?: string | null;
  html?: string;
  error?: string;
};

/**
 * Fetch a URL through the configured egress relay. Never throws — returns an
 * `unavailable` result on any error so the caller can fall through to the AI
 * substitute path.
 */
export async function fetchViaRelay(url: string): Promise<EgressResult> {
  const endpoint = relayUrl();
  const secret = relaySecret();
  if (!endpoint || !secret) return { kind: 'unavailable', reason: 'not_configured' };

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });
  } catch (err) {
    return { kind: 'unavailable', reason: `relay_unreachable:${(err as Error).message.slice(0, 80)}` };
  }

  if (!res.ok) {
    return { kind: 'unavailable', reason: `relay_http_${res.status}` };
  }

  let body: RelayResponse;
  try {
    body = (await res.json()) as RelayResponse;
  } catch {
    return { kind: 'unavailable', reason: 'relay_bad_json' };
  }

  if (!body.ok) {
    return { kind: 'unavailable', reason: `relay_error:${body.error ?? 'unknown'}` };
  }
  if (body.blocked) {
    return { kind: 'blocked', reason: body.blockReason ?? 'blocked' };
  }
  if (typeof body.html !== 'string' || body.html.length === 0) {
    return { kind: 'unavailable', reason: 'relay_empty_html' };
  }

  return {
    kind: 'ok',
    html: body.html,
    status: body.status ?? 200,
    finalUrl: body.finalUrl || url,
  };
}

// ─── Bright Data Web Unlocker backend ───────────────────────────────────────
//
// Managed egress: one API call returns the unblocked page (rotates residential
// IPs, runs JS, solves CAPTCHA). Handles ANY host — Amazon, eBay, AliExpress,
// the lot — at ~98% success, so it's tried BEFORE the self-hosted relay.
// Server-side token only. Docs: POST https://api.brightdata.com/request
// { zone, url, format:'raw' } with Authorization: Bearer <token> → raw HTML.

const UNLOCKER_TIMEOUT_MS = 30_000;
const DEFAULT_UNLOCKER_API = 'https://api.brightdata.com/request';

function unlockerToken(): string | null {
  return process.env['BRIGHTDATA_API_TOKEN']?.trim() || null;
}
function unlockerZone(): string {
  return process.env['BRIGHTDATA_UNLOCKER_ZONE']?.trim() || 'web_unlocker';
}
function unlockerApiUrl(): string {
  return process.env['BRIGHTDATA_API_URL']?.trim() || DEFAULT_UNLOCKER_API;
}

/** True when the Bright Data Web Unlocker is configured. */
export function unlockerConfigured(): boolean {
  return !!unlockerToken();
}

/** Fetch a URL through Bright Data Web Unlocker. Never throws — returns
 *  `unavailable` on any error so the caller falls through to the next backend. */
export async function fetchViaUnlocker(url: string): Promise<EgressResult> {
  const token = unlockerToken();
  if (!token) return { kind: 'unavailable', reason: 'not_configured' };

  let res: Response;
  try {
    res = await fetch(unlockerApiUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ zone: unlockerZone(), url, format: 'raw' }),
      signal: AbortSignal.timeout(UNLOCKER_TIMEOUT_MS),
    });
  } catch (err) {
    return { kind: 'unavailable', reason: `unlocker_unreachable:${(err as Error).message.slice(0, 80)}` };
  }

  if (!res.ok) {
    return { kind: 'unavailable', reason: `unlocker_http_${res.status}` };
  }

  // format:'raw' returns the page body as text.
  let html: string;
  try {
    html = await res.text();
  } catch {
    return { kind: 'unavailable', reason: 'unlocker_body_read_failed' };
  }
  if (!html || html.length === 0) {
    return { kind: 'unavailable', reason: 'unlocker_empty' };
  }

  return { kind: 'ok', html, status: 200, finalUrl: url };
}

// ─── Egress chain ────────────────────────────────────────────────────────────
//
// Try the most reliable configured backend first (managed Unlocker), then the
// self-hosted relay. Returns the first usable result; a `blocked` from one
// backend still falls through to the next.

/** True when ANY egress backend is configured. */
export function egressConfigured(): boolean {
  return unlockerConfigured() || relayConfigured();
}

/**
 * Fetch a URL through the configured egress chain (Unlocker → relay). Returns
 * `ok` from the first backend that yields a page, else the most informative
 * non-ok result, else `unavailable` when nothing is configured.
 */
export async function fetchViaEgress(url: string): Promise<EgressResult> {
  const backends: Array<() => Promise<EgressResult>> = [];
  if (unlockerConfigured()) backends.push(() => fetchViaUnlocker(url));
  if (relayConfigured()) backends.push(() => fetchViaRelay(url));
  if (backends.length === 0) return { kind: 'unavailable', reason: 'not_configured' };

  let last: EgressResult = { kind: 'unavailable', reason: 'not_configured' };
  for (const run of backends) {
    const r = await run();
    if (r.kind === 'ok') return r;
    last = r; // remember the most recent (e.g. 'blocked') for the caller's warnings
  }
  return last;
}
