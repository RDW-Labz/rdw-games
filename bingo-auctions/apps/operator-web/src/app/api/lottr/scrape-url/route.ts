// POST /api/lottr/scrape-url  { url: string }   (optional ?allowAiFallback=1)
//
// Universal product-page scraper. Accepts any retailer URL (subject to the
// host allowlist below) and returns structured lot-import data via a 4-rung
// extraction ladder:
//
//   1. JSON-LD Product schema  — most reliable; all major retailers embed it
//   2. OpenGraph product meta  — og:title, og:image, og:price:amount, etc.
//   3. schema.org itemprop meta — older/legacy sites use <meta itemprop=…>
//   4. HTML fallback            — <title> + first reasonably-sized <img>
//
// Each rung fills only fields still empty after the previous rung (merge
// semantics, not overwrite). The extractor never throws — it always returns
// something even if all four rungs produce no structured data.
//
// AI fallback (Batch D): some retailers hard-block server fetches (Amazon
// WAF, eBay 403, AliExpress/Alibaba). When the direct fetch is blocked, the
// page 404s/bot-blocks, OR the extraction comes back hollow (no title/price/
// image), we escalate to the OpenRouter Sonar URL-finder + url-fetcher path
// (packages/domain-lotting/src/lookup/*). Sonar finds an ALTERNATE, non-bot-
// blocked retailer product page for the same item; we server-fetch + parse
// that. The escalation is GATED behind ?allowAiFallback=1 so the mobile
// client makes exactly ONE request and the Worker does scrape→(maybe)AI
// internally. Without the param, behaviour is identical to before.
//
// Why server-side: a mobile client can't reliably fetch retailer pages
// itself (CORS, certificate pinning, bot detection signatures). The
// operator-web Cloudflare Worker is the right place — same-origin from
// the operator's perspective and we can rotate User-Agent strings.
// OPENROUTER_API_KEY is read server-side only (a Worker secret); it is
// NEVER sent to or invoked from the mobile client.
//
// Why no node-html-parser dep: regex + JSON.parse is sufficient for the
// structured-data signals we need, keeps the bundle slim, and works in
// the CF Worker's V8 isolate without native modules.
//
// Auth: cookie session OR Bearer token via verifyLottrAuth — same pattern
// as the rest of /api/lottr/* (lookup-code, scan-photo, etc).
//
// Phase 2 (next EAS build): an iOS Share Extension will POST to this same
// endpoint from the share sheet, so the contract is designed for both
// flows from day one.

import { lottingFetchHtml, lottingMirrorImage } from '@/lib/lotting-egress';
import { NextResponse } from 'next/server';
import { checkAiBudget } from '@/lib/ai-budget';
import {
  fetchOpenRouterLookup,
  isHardBlockedHost,
  setLottingConfig,
  hasLottingConfig,
  extractBrand,
  type OpenRouterListing,
  type OpenRouterSearchResult,
} from '@auction-platform/domain-lotting';
import { verifyLottrAuth } from '@/lib/lottr-auth';
import { isSafeScrapeUrl } from '@/lib/safe-scrape-url';
import {
  looksLikeImageUrl,
  rehostImportImage,
  rehostScrapedImages,
} from '@/lib/rehost-import-image';
import { egressConfigured, fetchViaEgress } from '@/lib/scrape-egress';
import { resolveCatalogImages } from '@/lib/catalog/resolve-catalog-images';
import { readScrapeCache, writeScrapeCache } from '@/lib/catalog/scrape-cache';
import type { SupabaseClient } from '@supabase/supabase-js';

// ─── Types ────────────────────────────────────────────────────────────────────

type ScrapedData = {
  title: string;
  msrp_cents: number | null;
  primary_image_url: string | null;
  additional_image_urls: string[];
  description: string | null;
  brand: string | null;
  upc: string | null;
  /** Amazon ASIN extracted from the URL path; null for non-Amazon URLs. */
  asin: string | null;
  /** schema.org itemCondition label ("New", "Used", etc); null when absent. */
  item_condition: string | null;
  /** Sibling/variant ASINs found in the Amazon twister (size/color variations).
   *  Informational — feeds the catalog. This fork's extractProduct does not yet
   *  parse the twister, so it is always []; kept on the type so the catalog
   *  write-through (CatalogScrapeData) contract is satisfied. */
  variant_asins: string[];
  /** Key product specs/attributes; null when none parsed. This fork's
   *  extractProduct does not yet parse spec tables, so it is always null; kept
   *  on the type for the catalog write-through contract. */
  specs: string | null;
};

/** Where the successful data came from:
 *   "direct"      — parsed straight from the pasted URL's HTML.
 *   "relay"       — pasted URL is a hard-block host (Amazon/eBay) fetched via
 *                   the egress chain (Web Unlocker → self-hosted relay), then
 *                   parsed.
 *   "ai_fallback" — pasted URL was blocked/empty/hollow; an alternate
 *                   retailer page found by Sonar was fetched + parsed.
 *   "catalog"     — served from the master catalog (product_lookups) by the
 *                   URL's retailer key: a prior scrape of the same item, so no
 *                   live fetch / Bright Data spend this round.
 */
type ScrapeSource = 'direct' | 'relay' | 'ai_fallback' | 'catalog';

type ScrapeResponse =
  | {
      ok: true;
      /** Normalised hostname of the page the data came from. For an AI
       *  fallback this is the ALTERNATE retailer's host, not the pasted
       *  one. */
      host: string;
      /** Provenance of `data` — see ScrapeSource. */
      source: ScrapeSource;
      data: ScrapedData;
      /** Non-fatal hints (e.g. "price_unavailable"). Mobile shows these as
       *  inline warnings on the import-review screen. */
      warnings: string[];
    }
  | {
      ok: false;
      error: string;
      /** True when a direct scrape produced nothing usable AND the caller
       *  did NOT pass ?allowAiFallback=1. Signals the client to retry the
       *  same URL with the flag set (one extra round-trip) rather than
       *  showing an empty import form. Absent/false on hard errors
       *  (bad_json, invalid_url, auth) where a retry won't help. */
      needs_fallback?: boolean;
    };

// ─── Host allowlist ───────────────────────────────────────────────────────────
//
// v1 default: ~15 major US retailers. Owner will revise scope post-merge.
// The isSafeScrapeUrl SSRF guard always runs first; this allowlist then gates
// which retailers we'll act on at all.
//
// NOTE on the hard-block hosts (Amazon, eBay, AliExpress, Alibaba): they
// remain on this ALLOWLIST so an operator can paste those links — but the
// POST handler routes them straight to the AI fallback (isHardBlockedHost,
// from domain-lotting/url-fetcher) instead of attempting a direct fetch that
// their WAF/anti-bot would block. This reconciles the route allowlist with
// url-fetcher.ts's BLOCKED_HOSTS so we never burn a doomed round-trip.
//
// Pattern: match any subdomain of the listed TLD cluster.

const ALLOWED_HOST_PATTERNS: RegExp[] = [
  /^(?:[\w-]+\.)?amazon\.(?:com|co\.uk|ca|com\.au|de|fr|it|es|in|com\.mx)$/i,
  /^(?:[\w-]+\.)?ebay\.(?:com|co\.uk|ca|com\.au|de|fr|it|es)$/i,
  /^(?:www\.)?google\.(?:com|co\.uk|ca|de|fr|it|es)$/i,
  /^(?:www\.)?wayfair\.com$/i,
  /^(?:www\.)?target\.com$/i,
  /^(?:www\.)?walmart\.com$/i,
  /^(?:www\.)?homedepot\.com$/i,
  /^(?:www\.)?lowes\.com$/i,
  /^(?:www\.)?bestbuy\.com$/i,
  /^(?:www\.)?costco\.com$/i,
  /^(?:www\.)?etsy\.com$/i,
  /^(?:www\.)?ikea\.com$/i,
  /^(?:www\.)?overstock\.com$/i,
  /^(?:[\w-]+\.)?aliexpress\.com$/i,
  /^(?:[\w-]+\.)?alibaba\.com$/i,
];

/** Returns true when the host is on the v1 allowlist. */
function isAllowedHost(hostname: string): boolean {
  return ALLOWED_HOST_PATTERNS.some((re) => re.test(hostname));
}

// ─── Source detection (host identification only) ──────────────────────────────
//
// Used to derive the `host` field in the response and to identify Amazon URLs
// for ASIN extraction. Does NOT gate the extraction path — all hosts use the
// same 4-rung universal extractor.

const GOOGLE_SHOPPING_HOST_RE = /^(?:www\.)?google\.(?:com|co\.uk|ca|de|fr|it|es)$/i;

function detectHost(url: string): { host: string; isAmazon: boolean; isGoogleSearch: boolean } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { host: '', isAmazon: false, isGoogleSearch: false };
  }
  const host = parsed.hostname.toLowerCase();
  const isAmazon = /^(?:[\w-]+\.)?amazon\./i.test(host);
  const isGoogleSearch =
    GOOGLE_SHOPPING_HOST_RE.test(host) &&
    (parsed.pathname.startsWith('/search') || parsed.searchParams.get('tbm') === 'shop');
  return { host, isAmazon, isGoogleSearch };
}

// ─── Short / share-link resolution ────────────────────────────────────────────
//
// Amazon's "Share" button emits a short link (a.co / amzn.to) and eBay's emits
// ebay.us / ebay.io — none of those hosts are on the retailer allowlist, so a
// pasted share link was rejected before the redirect to the real product page
// was ever followed. We resolve ONLY this hardcoded set of known Amazon/eBay
// shorteners to their canonical URL, then re-validate the result through the
// same SSRF + allowlist gates as any other URL — so an open-redirect can reach
// neither internal infrastructure nor an unsupported retailer.

const SHORT_URL_HOSTS = new Set([
  'a.co', 'amzn.to', 'amzn.com', 'amzn.eu',
  'ebay.us', 'ebay.io', 'ebay.to',
]);

function isShortUrlHost(hostname: string): boolean {
  return SHORT_URL_HOSTS.has(hostname.toLowerCase());
}

/** Follow a known Amazon/eBay shortener to its canonical URL. Returns the final
 *  URL after redirects, or null when the host isn't a known shortener or the
 *  request fails. Bounded: 5s timeout, the response BODY is never read (only
 *  res.url), and the caller re-validates the result before any scraping. */
async function resolveShortUrl(rawUrl: string): Promise<string | null> {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!isShortUrlHost(host)) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(rawUrl, {
      method: 'GET',
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
        Accept: 'text/html,application/xhtml+xml',
      },
      signal: controller.signal,
    });
    return res.url || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─── User-Agent rotation ──────────────────────────────────────────────────────
//
// Rotate between a few realistic desktop UA strings. Amazon in particular
// blocks bare-cf-fetch UAs but accepts these.

const UA_POOL = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
];

function pickUa(): string {
  return UA_POOL[Math.floor(Math.random() * UA_POOL.length)] ?? UA_POOL[0]!;
}

// ─── Utility helpers ──────────────────────────────────────────────────────────

export function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x2F;/g, '/')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function normalizeImages(input: string | string[] | undefined): string[] {
  if (!input) return [];
  const arr = Array.isArray(input) ? input : [input];
  return arr
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter((s): s is string => s.startsWith('http'));
}

// ─── JSON-LD extraction (Rung 1) ──────────────────────────────────────────────
//
// All major retailers embed structured product data in
// <script type="application/ld+json"> blocks. This is the most reliable
// signal — more stable than DOM selectors that retailers A/B-test constantly.

type LdProduct = {
  '@type'?: string | string[];
  name?: string;
  description?: string;
  image?: string | string[];
  brand?: string | { name?: string };
  gtin?: string;
  gtin12?: string;
  gtin13?: string;
  gtin14?: string;
  mpn?: string;
  sku?: string;
  offers?:
    | {
        price?: string | number;
        priceCurrency?: string;
        itemCondition?: string;
      }
    | Array<{ price?: string | number; itemCondition?: string }>;
};

export function extractJsonLdBlocks(html: string): unknown[] {
  const out: unknown[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const body = m[1]?.trim();
    if (!body) continue;
    try {
      const parsed = JSON.parse(body) as unknown;
      if (Array.isArray(parsed)) out.push(...parsed);
      else out.push(parsed);
    } catch {
      // Some retailers HTML-escape inside the script body; try unescaping
      // common entities and re-parsing.
      try {
        const unesc = body
          .replace(/&quot;/g, '"')
          .replace(/&amp;/g, '&')
          .replace(/&#x2F;/g, '/');
        const parsed = JSON.parse(unesc) as unknown;
        if (Array.isArray(parsed)) out.push(...parsed);
        else out.push(parsed);
      } catch {
        // best-effort — skip malformed blocks
      }
    }
  }
  return out;
}

export function findProduct(blocks: unknown[]): LdProduct | null {
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const obj = block as Record<string, unknown>;
    const t = obj['@type'];
    if (t === 'Product') return obj as LdProduct;
    if (Array.isArray(t) && t.includes('Product')) return obj as LdProduct;
    // Product is sometimes nested inside a @graph array (Google Shopping,
    // some Shopify themes).
    const graph = obj['@graph'];
    if (Array.isArray(graph)) {
      const inner = findProduct(graph);
      if (inner) return inner;
    }
  }
  return null;
}

function ldMsrpCents(p: LdProduct): number | null {
  const offers = p.offers;
  if (!offers) return null;
  const first = Array.isArray(offers) ? offers[0] : offers;
  if (!first) return null;
  const price = first.price;
  if (price == null) return null;
  const n = typeof price === 'number' ? price : parseFloat(String(price));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 100);
}

function ldBrand(p: LdProduct): string | null {
  if (!p.brand) return null;
  if (typeof p.brand === 'string') return p.brand.trim() || null;
  return p.brand.name?.trim() ?? null;
}

function ldUpc(p: LdProduct): string | null {
  return (
    p.gtin12?.trim() ||
    p.gtin13?.trim() ||
    p.gtin14?.trim() ||
    p.gtin?.trim() ||
    null
  );
}

function ldCondition(p: LdProduct): string | null {
  const offers = p.offers;
  const first = Array.isArray(offers) ? offers[0] : offers;
  if (!first?.itemCondition) return null;
  // schema.org URLs like https://schema.org/NewCondition → "New"
  const m = first.itemCondition.match(/(\w+)Condition/);
  return m?.[1] ?? null;
}

// ─── OpenGraph extraction (Rung 2) ────────────────────────────────────────────
//
// Parses <meta property="og:*" content="…"> and the product namespace
// <meta property="product:*" content="…"> (used by Wayfair, Facebook
// Shops, etc).

type OgData = {
  title: string | null;
  image: string | null;
  description: string | null;
  priceCents: number | null;
  brand: string | null;
};

export function extractOpenGraph(html: string): OgData {
  function meta(property: string): string | null {
    // Match both property= and name= variants; content can use either quote.
    const re = new RegExp(
      `<meta[^>]*(?:property|name)=["']${property}["'][^>]*content=["']([^"']+)["']`,
      'i',
    );
    let m = re.exec(html);
    if (m?.[1]) return decodeHtmlEntities(m[1].trim());
    // Also try content= before property=
    const re2 = new RegExp(
      `<meta[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']${property}["']`,
      'i',
    );
    m = re2.exec(html);
    return m?.[1] ? decodeHtmlEntities(m[1].trim()) : null;
  }

  const title = meta('og:title');
  const image = meta('og:image');
  const description = meta('og:description');

  // Price: try og:price:amount first, then product:price:amount
  const priceStr = meta('og:price:amount') ?? meta('product:price:amount');
  let priceCents: number | null = null;
  if (priceStr) {
    const n = parseFloat(priceStr.replace(/,/g, ''));
    if (Number.isFinite(n) && n > 0) priceCents = Math.round(n * 100);
  }

  const brand = meta('product:brand') ?? meta('og:brand');

  return { title, image, description, priceCents, brand };
}

// ─── Schema.org itemprop meta extraction (Rung 3) ─────────────────────────────
//
// Older sites and some product detail pages use microdata:
//   <meta itemprop="name" content="…">
//   <span itemprop="price" content="49.99">
//   <meta itemprop="image" content="https://…">

type SchemaMetaData = {
  title: string | null;
  image: string | null;
  description: string | null;
  priceCents: number | null;
  brand: string | null;
};

export function extractSchemaMeta(html: string): SchemaMetaData {
  function itemprop(name: string): string | null {
    // <meta itemprop="name" content="…">
    const re = new RegExp(
      `<meta[^>]*itemprop=["']${name}["'][^>]*content=["']([^"']+)["']`,
      'i',
    );
    let m = re.exec(html);
    if (m?.[1]) return decodeHtmlEntities(m[1].trim());
    // <… itemprop="name">content</…> — text-content variant
    const re2 = new RegExp(
      `itemprop=["']${name}["'][^>]*>([^<]{1,300})<`,
      'i',
    );
    m = re2.exec(html);
    return m?.[1] ? decodeHtmlEntities(m[1].trim()) : null;
  }

  const title = itemprop('name');
  const image = itemprop('image');
  const description = itemprop('description');
  const brand = itemprop('brand');

  const priceStr = itemprop('price');
  let priceCents: number | null = null;
  if (priceStr) {
    const n = parseFloat(priceStr.replace(/[$,]/g, ''));
    if (Number.isFinite(n) && n > 0) priceCents = Math.round(n * 100);
  }

  return { title, image, description, priceCents, brand };
}

// ─── HTML fallback extraction (Rung 4) ────────────────────────────────────────
//
// Last resort. Always populates at least a title (from <title>) and
// optionally an image (first <img> with src that starts with http and a
// reasonable src length suggesting it's a product image, not a 1px tracker).

type HtmlFallbackData = {
  title: string | null;
  image: string | null;
};

export function extractHtmlFallback(html: string): HtmlFallbackData {
  // <title>…</title>
  const titleM = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const rawTitle = titleM?.[1] ? decodeHtmlEntities(titleM[1].trim()) : null;

  // Strip common retailer suffixes to clean up the title
  const title = rawTitle
    ? rawTitle
        .replace(/\s+[-|:]\s+Amazon\.com.*$/i, '')
        .replace(/\s+[-|:]\s+eBay.*$/i, '')
        .replace(/\s+-\s+Google Shopping.*$/i, '')
        .replace(/\s+[-|:]\s+Walmart\.com.*$/i, '')
        .replace(/\s+[-|:]\s+Target.*$/i, '')
        .replace(/\s+[-|:]\s+Wayfair.*$/i, '')
        .trim() || null
    : null;

  // First <img src="https://…"> with a URL longer than 30 chars (skip tiny
  // tracker pixels and base64 data URIs).
  const imgRe = /<img[^>]+src=["'](https?:\/\/[^"']{30,})["']/gi;
  let imgM: RegExpExecArray | null;
  let image: string | null = null;
  while ((image === null) && (imgM = imgRe.exec(html)) !== null) {
    const src = imgM[1]?.trim();
    if (src && !src.includes('pixel') && !src.includes('spacer') && !src.includes('blank')) {
      image = src;
    }
  }

  return { title, image };
}

// ─── Universal product extractor (4-rung ladder) ─────────────────────────────
//
// Walks all four rungs and merges results: later rungs only fill fields that
// are still null/empty after earlier rungs. ASIN extraction is URL-pattern
// knowledge applied only for Amazon hostnames (not vendor logic).

export function extractProduct(
  html: string,
  url: string,
  isAmazon: boolean,
  warnings: string[],
): ScrapedData {
  // ── Rung 1: JSON-LD Product ──────────────────────────────────────────────
  const blocks = extractJsonLdBlocks(html);
  const ldProduct = findProduct(blocks);

  let title: string | null = ldProduct?.name?.trim() || null;
  let msrpCents: number | null = ldProduct ? ldMsrpCents(ldProduct) : null;
  let primaryImage: string | null = null;
  let additionalImages: string[] = [];
  let description: string | null = ldProduct?.description?.trim() || null;
  let brand: string | null = ldProduct ? ldBrand(ldProduct) : null;
  const upc: string | null = ldProduct ? ldUpc(ldProduct) : null;
  const itemCondition: string | null = ldProduct ? ldCondition(ldProduct) : null;

  if (ldProduct?.image) {
    const imgs = normalizeImages(ldProduct.image);
    primaryImage = imgs[0] ?? null;
    additionalImages = imgs.slice(1, 6);
  }

  // ── Rung 2: OpenGraph ────────────────────────────────────────────────────
  const og = extractOpenGraph(html);
  if (!title && og.title) title = og.title;
  if (!primaryImage && og.image) primaryImage = og.image;
  if (!description && og.description) description = og.description;
  if (msrpCents === null && og.priceCents !== null) msrpCents = og.priceCents;
  if (!brand && og.brand) brand = og.brand;

  // ── Rung 3: schema.org itemprop meta ────────────────────────────────────
  const sm = extractSchemaMeta(html);
  if (!title && sm.title) title = sm.title;
  if (!primaryImage && sm.image && sm.image.startsWith('http')) primaryImage = sm.image;
  if (!description && sm.description) description = sm.description;
  if (msrpCents === null && sm.priceCents !== null) msrpCents = sm.priceCents;
  if (!brand && sm.brand) brand = sm.brand;

  // ── Rung 4: HTML fallback ────────────────────────────────────────────────
  const fb = extractHtmlFallback(html);
  if (!title && fb.title) title = fb.title;
  if (!primaryImage && fb.image) primaryImage = fb.image;

  // ── Amazon-specific: ASIN from URL path (URL-pattern knowledge only) ─────
  let asin: string | null = null;
  if (isAmazon) {
    const asinM = url.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
    asin = asinM?.[1] ?? null;

    // Amazon-specific price fallback: a-offscreen screen-reader span
    if (msrpCents === null) {
      const off = html.match(/class=["']a-offscreen["'][^>]*>\$([\d,]+\.\d{2})</);
      if (off?.[1]) {
        const n = parseFloat(off[1].replace(/,/g, ''));
        if (Number.isFinite(n) && n > 0) msrpCents = Math.round(n * 100);
      }
    }

    // Amazon-specific title fallback: #productTitle element
    if (!title) {
      const tm = html.match(/id=["']productTitle["'][^>]*>([\s\S]*?)<\/[^>]+>/);
      if (tm?.[1]) title = decodeHtmlEntities(tm[1].trim());
    }

    // Amazon-specific image fallback: data-a-dynamic-image JSON map
    if (!primaryImage) {
      const lm = html.match(
        /id=["']landingImage["'][^>]+data-a-dynamic-image=["']([^"']+)["']/i,
      );
      if (lm?.[1]) {
        try {
          const map = JSON.parse(decodeHtmlEntities(lm[1])) as Record<string, unknown>;
          const keys = Object.keys(map);
          primaryImage = keys[0] ?? null;
          for (const k of keys.slice(1, 5)) additionalImages.push(k);
        } catch {
          // ignore
        }
      }
    }
  }

  // ── Warn on missing critical fields ──────────────────────────────────────
  if (!title) warnings.push('title_missing');
  if (msrpCents === null) warnings.push('price_unavailable');
  if (!primaryImage) warnings.push('image_missing');

  return {
    title: title || 'Imported product',
    msrp_cents: msrpCents,
    primary_image_url: primaryImage,
    additional_image_urls: additionalImages.slice(0, 6),
    description: description || null,
    // Markup brand wins; when the page didn't tag one, recover it from the
    // title via the brand dictionary (same fallback AI Photo Scan uses) so
    // Quick Lotting doesn't leave Brand blank on un-tagged pages.
    brand: brand || (title ? extractBrand(title) : null),
    upc,
    asin,
    item_condition: itemCondition,
    // This fork's extractProduct does not parse the Amazon twister or spec
    // tables; emit empty defaults so the value satisfies CatalogScrapeData.
    variant_asins: [],
    specs: null,
  };
}

// ─── Tunables ─────────────────────────────────────────────────────────────────

// Response-size cap: 2 MB. Protects against oversized pages stalling the
// Worker's memory and CPU budget. Applied while streaming the body.
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MB

// Outer timeout for the whole AI fallback (Sonar URL-find + url-fetch).
const AI_FALLBACK_TIMEOUT_MS = 8_000;

// Direct-fetch timeout + retry budget. AbortSignal.timeout(8000) caps each
// attempt; we retry once on a network/timeout error (2 tries total), mirroring
// the backoff shape in domain-lotting/src/ai/llm.ts (capped exponential).
const DIRECT_FETCH_TIMEOUT_MS = 8_000;
const DIRECT_FETCH_MAX_TRIES = 2;

// ─── False-success detection ──────────────────────────────────────────────────
//
// The root of the "shaky import" complaint: a direct scrape can return
// HTTP 200 with HTML that has NO usable product signal (anti-bot interstitial,
// SPA shell that renders client-side, consent wall, etc). extractProduct never
// throws — it returns title:"Imported product", everything else null. Returning
// that as ok:true shows the operator an empty form that looks like a success.
//
// A result is "hollow" when there's nothing worth importing: no real title
// (title is empty or the "Imported product" sentinel) AND no price AND no
// image. Such a result should escalate to the AI fallback (or, if the caller
// didn't opt in, signal needs_fallback) rather than be returned as success.
export function isHollowResult(data: ScrapedData): boolean {
  const hasRealTitle =
    !!data.title && data.title.trim() !== '' && data.title !== 'Imported product';
  const hasPrice = data.msrp_cents !== null;
  const hasImage = !!data.primary_image_url;
  return !hasRealTitle && !hasPrice && !hasImage;
}

// ─── Bot-block / captcha detection ──────────────────────────────────────────────
//
// A retailer can return HTTP 200 with a captcha/interstitial that carries no
// product data (Amazon "Robot Check", eBay/PerimeterX "Pardon Our
// Interruption", Cloudflare challenge). extractProduct can't tell that apart
// from a thin page, so we sniff for known sentinel strings and treat a match
// as "blocked" → escalate rather than return a hollow success.
//
// NOTE: /scrape-relay/src/block.ts keeps a parallel copy used by the relay
// itself; keep the two sentinel lists in sync when adding a signal.
const BLOCK_SENTINELS: readonly string[] = [
  'To discuss automated access to Amazon data please contact',
  'Robot Check',
  'Enter the characters you see below',
  'Type the characters you see in this image',
  '/errors/validateCaptcha',
  "Sorry, we just need to make sure you're not a robot",
  'api-services-support@amazon.com',
  'Pardon Our Interruption',
  'Please verify yourself',
  'px-captcha',
  'Access to this page has been denied',
  'Checking your browser before accessing',
  'cf-challenge',
  'captcha-delivery.com',
];

/** True when the HTML looks like a bot-block/captcha interstitial. Scans only
 *  the first ~200 KB — interstitials are small and front-load the signal. */
export function classifyBlock(html: string): { blocked: boolean; reason: string | null } {
  const head = html.length > 200_000 ? html.slice(0, 200_000) : html;
  for (const sentinel of BLOCK_SENTINELS) {
    if (head.includes(sentinel)) {
      return { blocked: true, reason: `sentinel:${sentinel.slice(0, 32)}` };
    }
  }
  return { blocked: false, reason: null };
}

// ─── AI fallback config wiring ────────────────────────────────────────────────
//
// Mirror the ensureConfigured() pattern from lookup-code/route.ts so
// fetchOpenRouterLookup can read OPENROUTER_API_KEY from the lotting config.
// The key is a Worker secret (server-side only) — never shipped to the client.
function ensureLottingConfigured(): boolean {
  if (hasLottingConfig()) return true;
  const openrouterKey = process.env['OPENROUTER_API_KEY'];
  if (!openrouterKey) return false;
  // 2026-07-10: route retailer page-fetches (stock images + prices)
  // through the unblocked egress chain — see lib/lotting-egress.ts.
  setLottingConfig({ openrouterKey, fetchHtml: lottingFetchHtml, mirrorImage: lottingMirrorImage });
  return true;
}

// ─── Seed extraction from a URL ───────────────────────────────────────────────
//
// To give Sonar the best shot at finding an alternate product page, seed it
// with whatever identifiers we can cheaply pull from the pasted URL +
// whatever the (failed/hollow) direct extraction managed to surface.

/** Pull an Amazon ASIN from any /dp/ or /gp/product/ URL path. */
function asinFromUrl(url: string): string | null {
  const m = url.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/i);
  return m?.[1] ?? null;
}

/** Pull a bare UPC/EAN/GTIN (8/12/13/14 digits) from a URL query string —
 *  some retailers put it in ?upc= / ?gtin= / ?id= style params. */
function upcFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    for (const key of ['upc', 'gtin', 'ean', 'sku']) {
      const v = u.searchParams.get(key);
      if (v && /^\d{8}$|^\d{12,14}$/.test(v.trim())) return v.trim();
    }
  } catch {
    // ignore
  }
  return null;
}

/** Derive a rough product title from the URL slug (last meaningful path
 *  segment), used only when we have no better signal to seed Sonar. */
function titleFromUrlSlug(url: string): string | null {
  try {
    const u = new URL(url);
    const segs = u.pathname.split('/').filter(Boolean);
    // Walk from the end, skip pure-id / pattern segments (/p/, /dp/, A-1234).
    for (let i = segs.length - 1; i >= 0; i--) {
      const seg = segs[i]!;
      if (/^[A-Z]?-?\d+$/i.test(seg)) continue; // bare id
      if (['p', 'dp', 'ip', 'pd', 'site', 'gp', 'product'].includes(seg.toLowerCase())) continue;
      const words = seg.replace(/[-_+]/g, ' ').replace(/\s+/g, ' ').trim();
      // Needs at least two words to be a plausible title (not a category).
      if (words.split(' ').length >= 2 && words.length >= 6) {
        return decodeHtmlEntities(words);
      }
    }
  } catch {
    // ignore
  }
  return null;
}

// ─── Map an OpenRouter listing → ScrapedData (AI fallback shape) ──────────────
//
// fetchOpenRouterLookup returns OpenRouterListing[] parsed from alternate
// retailer pages. Pick the best one (most fields populated, prefer one with an
// image) and map it onto the SAME ScrapedData contract the direct path returns,
// so the client sees one stable shape regardless of source. llm_msrp_cents
// (Tier-3 MSRP from Sonar's search context) backfills price when no fetched
// page exposed one.
function bestListing(listings: OpenRouterListing[]): OpenRouterListing | null {
  if (listings.length === 0) return null;
  const score = (l: OpenRouterListing): number =>
    (l.title ? 2 : 0) +
    (l.image_urls.length > 0 ? 2 : 0) +
    (l.msrp_cents !== null || l.asking_cents !== null ? 1 : 0);
  return [...listings].sort((a, b) => score(b) - score(a))[0] ?? null;
}

function listingToScrapedData(
  listing: OpenRouterListing,
  llmMsrpCents: number | null,
  seedUpc: string | null,
  seedAsin: string | null,
  warnings: string[],
): ScrapedData {
  const images = listing.image_urls.filter((u) => u.startsWith('http'));
  // MSRP precedence: the listing's own msrp_cents (retailer listPrice) →
  // its asking_cents (current price) → Sonar's context MSRP signal.
  const msrpCents = listing.msrp_cents ?? listing.asking_cents ?? llmMsrpCents;

  const title = listing.title?.trim() || null;
  if (!title) warnings.push('title_missing');
  if (msrpCents === null) warnings.push('price_unavailable');
  if (images.length === 0) warnings.push('image_missing');

  return {
    title: title || 'Imported product',
    msrp_cents: msrpCents,
    primary_image_url: images[0] ?? null,
    additional_image_urls: images.slice(1, 7),
    // Carry the parsed product description through (fetchProductPages reads it
    // from the page's JSON-LD / og:description). Previously hardcoded null, so
    // every web-search/AI-fallback import landed with a blank description.
    description: listing.description?.trim() || null,
    // OpenRouterListing carries no brand field; recover it from the title via
    // the brand dictionary (same fallback AI Photo Scan uses) instead of null.
    brand: extractBrand(title),
    upc: seedUpc,
    asin: seedAsin ?? extractAsinFromListingUrl(listing.url),
    item_condition: listing.condition && listing.condition !== 'Unknown' ? listing.condition : null,
    variant_asins: [],
    specs: null,
  };
}

// PHOTO fallback: when a scrape/AI result has no image but carries a UPC/ASIN,
// pull a stock photo from the platform catalog — the same resolver the mobile
// review card + web Quick Lot already use (catalog read-through → free
// identifier enrichment → self-warming write-back). Best-effort:
// resolveCatalogImages never throws. On a hit we set the primary image and
// clear the stale 'image_missing' warning; on a miss we leave that warning so
// the client can promote the operator's captured photo to primary + notify.
async function fillStockImageFromCatalog(
  data: ScrapedData,
  admin: SupabaseClient,
  operatorId: string,
  warnings: string[],
): Promise<void> {
  if (data.primary_image_url || (!data.upc && !data.asin)) return;
  const { imageUrls } = await resolveCatalogImages({
    admin,
    upc: data.upc,
    asin: data.asin,
    contributedByOperatorId: operatorId,
  });
  if (imageUrls.length === 0) return;
  data.primary_image_url = imageUrls[0] ?? null;
  data.additional_image_urls = [...data.additional_image_urls, ...imageUrls.slice(1)].slice(0, 6);
  const i = warnings.indexOf('image_missing');
  if (i !== -1) warnings.splice(i, 1);
}

/** ASIN from a listing URL (rare — Sonar is told to avoid Amazon, but the
 *  alternate page could still be an amazon mirror). */
function extractAsinFromListingUrl(url: string): string | null {
  return asinFromUrl(url);
}

// Budget-gate the (billed) Sonar AI fallback — mirrors lookup-code/route.ts.
// Direct scrapes are free and stay ungated; only the AI path checks budget.
// Returns a 402 ScrapeResponse when the operator is over budget, else null.
async function aiBudgetBlock(operatorId: string): Promise<NextResponse | null> {
  try {
    await checkAiBudget(operatorId);
    return null;
  } catch (err) {
    if ((err as Error).message === 'ai_budget_exceeded') {
      return NextResponse.json(
        { ok: false, error: 'ai_budget_exceeded' } satisfies ScrapeResponse,
        { status: 402 },
      );
    }
    throw err;
  }
}

// ─── Run the AI fallback ──────────────────────────────────────────────────────
//
// Seeds Sonar with the best identifiers we have, fetches alternate retailer
// pages, and maps the best result onto ScrapedData. Returns null when the
// fallback can't be run (no key) or finds nothing usable — the caller turns
// that into an ok:false / error response.
async function runAiFallback(
  pastedUrl: string,
  partial: ScrapedData | null,
  warnings: string[],
): Promise<{ data: ScrapedData; host: string } | null> {
  if (!ensureLottingConfigured()) return null;

  const seedAsin = asinFromUrl(pastedUrl);
  const seedUpc = partial?.upc ?? upcFromUrl(pastedUrl);
  const seedTitle = partial?.title && partial.title !== 'Imported product'
    ? partial.title
    : titleFromUrlSlug(pastedUrl);
  const seedBrand = partial?.brand ?? undefined;

  // Sonar needs at least one identifier to search on. If we have nothing —
  // no UPC, no title, no brand — there's nothing to query.
  if (!seedUpc && !seedTitle && !seedBrand && !seedAsin) return null;

  let result: OpenRouterSearchResult;
  try {
    // 8s ceiling on the whole Sonar+url-fetch path so a slow model doesn't
    // blow the Worker's request budget. fetchProductPages already applies a
    // per-URL timeout internally; this is the outer guard.
    result = await fetchOpenRouterLookup(
      {
        upc: seedUpc || undefined,
        // If we only have an ASIN, fold it into the title hint so Sonar can
        // still search on it (the query builder has no asin field).
        title: seedTitle || (seedAsin ? `ASIN ${seedAsin}` : undefined),
        brand: seedBrand,
      },
      AbortSignal.timeout(AI_FALLBACK_TIMEOUT_MS),
    );
  } catch {
    return null;
  }

  const listing = bestListing(result.active);
  if (!listing) {
    // No alternate page parsed. If Sonar still surfaced an MSRP from its
    // search context, return an MSRP-only result so the operator at least
    // gets a price anchor — better than a dead end.
    if (result.llm_msrp_cents != null && result.llm_msrp_cents > 0) {
      const data: ScrapedData = {
        title: seedTitle || 'Imported product',
        msrp_cents: result.llm_msrp_cents,
        primary_image_url: null,
        additional_image_urls: [],
        description: null,
        brand: seedBrand ?? null,
        upc: seedUpc,
        asin: seedAsin,
        item_condition: null,
        variant_asins: [],
        specs: null,
      };
      if (!seedTitle) warnings.push('title_missing');
      warnings.push('image_missing');
      warnings.push('ai_fallback_msrp_only');
      return { data, host: hostnameOf(pastedUrl) };
    }
    return null;
  }

  const data = listingToScrapedData(listing, result.llm_msrp_cents, seedUpc, seedAsin, warnings);
  warnings.push('ai_fallback_used');
  return { data, host: hostnameOf(listing.url) || hostnameOf(pastedUrl) };
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

// ─── POST handler ────────────────────────────────────────────────────────────

/** Outcome of a direct HTML fetch attempt. */
type DirectFetchResult =
  | { kind: 'ok'; html: string }
  | { kind: 'blocked'; status: number } // non-200 (likely bot-block)
  | { kind: 'bad_content_type'; contentType: string }
  | { kind: 'error'; message: string };

// Fetch a page's HTML with a strong browser-like header profile, an 8s
// per-attempt timeout, and a 2-try backoff on transient network/timeout
// errors. Header profile + Sec-Fetch-* mirror url-fetcher.ts so anti-bot
// middleware is less likely to reject us before serving the page.
async function fetchHtmlDirect(url: string): Promise<DirectFetchResult> {
  let lastErr = 'unknown';
  for (let attempt = 0; attempt < DIRECT_FETCH_MAX_TRIES; attempt++) {
    if (attempt > 0) {
      // Capped exponential backoff between tries (250ms, then 500ms…).
      await new Promise<void>((r) => setTimeout(r, Math.min(250 * 2 ** (attempt - 1), 2000)));
    }
    try {
      const upstream = await fetch(url, {
        headers: {
          'User-Agent': pickUa(),
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Site': 'none',
          'Sec-Fetch-User': '?1',
          'Upgrade-Insecure-Requests': '1',
          'Cache-Control': 'no-cache',
          Pragma: 'no-cache',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(DIRECT_FETCH_TIMEOUT_MS),
      });

      if (!upstream.ok) {
        // Non-200 won't change on retry (it's a block/404, not transient),
        // so return immediately and let the caller escalate to AI.
        return { kind: 'blocked', status: upstream.status };
      }

      const ct = upstream.headers.get('content-type') ?? '';
      if (!ct.includes('text/html') && !ct.includes('application/xhtml')) {
        return { kind: 'bad_content_type', contentType: ct.split(';')[0] ?? ct };
      }

      // Response-size cap: read up to MAX_RESPONSE_BYTES, abort the rest.
      const reader = upstream.body?.getReader();
      if (!reader) {
        return { kind: 'ok', html: await upstream.text() };
      }
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          chunks.push(value);
          totalBytes += value.byteLength;
          if (totalBytes >= MAX_RESPONSE_BYTES) {
            await reader.cancel();
            break;
          }
        }
      }
      const merged = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return { kind: 'ok', html: new TextDecoder().decode(merged) };
    } catch (err) {
      // Network error / timeout (AbortSignal.timeout → TimeoutError). These
      // are transient — retry until the budget is exhausted.
      lastErr = (err as Error).message.slice(0, 100);
    }
  }
  return { kind: 'error', message: lastErr };
}

// Fetch the page through the configured egress chain (Web Unlocker → relay),
// parse it, and — if it yields a real, non-blocked product — return the success
// response. Returns null when egress isn't configured / didn't yield usable
// data, so the caller falls through to the Sonar AI substitute. Used for
// hard-block hosts AND as a rescue when a direct fetch failed or came back
// hollow on any host.
async function tryEgress(
  url: string,
  isAmazon: boolean,
  host: string,
  auth: { admin: SupabaseClient; operatorId: string },
  warnings: string[],
): Promise<NextResponse | null> {
  if (!egressConfigured()) return null;
  const egress = await fetchViaEgress(url);
  if (egress.kind === 'ok') {
    const data = extractProduct(egress.html, egress.finalUrl, isAmazon, warnings);
    const block = classifyBlock(egress.html);
    if (!block.blocked && !isHollowResult(data)) {
      await fillStockImageFromCatalog(data, auth.admin, auth.operatorId, warnings);
      // Write-through: compound the master catalog so this URL is a free cache
      // hit next time. Best-effort — never blocks the response.
      // Rehost BEFORE the cache write so the catalog stores own-storage URLs —
      // the next hit for this URL is then free (no re-download, no duplicate
      // storage object).
      const hosted = await rehostScrapedImages(auth.operatorId, data);
      await writeScrapeCache(auth.admin, url, hosted);
      return NextResponse.json(
        { ok: true, host, source: 'relay', data: hosted, warnings } satisfies ScrapeResponse,
      );
    }
    warnings.push(block.blocked ? `egress_blocked:${block.reason}` : 'egress_hollow');
  } else {
    warnings.push(`egress_${egress.kind}:${egress.reason}`);
  }
  return null;
}

export async function POST(req: Request) {
  const auth = await verifyLottrAuth(req);
  if (!auth) {
    return NextResponse.json(
      { ok: false, error: 'not_authenticated' } satisfies ScrapeResponse,
      { status: 401 },
    );
  }
  // auth.operatorId is used for AI-budget gating (the billed Sonar fallback);
  // the direct scrape itself is operator-agnostic. We still require a valid
  // staff caller so this endpoint can't be used as an open SSRF vector.

  // ?allowAiFallback=1 — opt into the Sonar URL-finder escalation. When set,
  // a blocked/empty/hollow direct scrape transparently falls back to the AI
  // path IN THIS SAME REQUEST (one round-trip for the client). When unset,
  // behaviour is identical to before and a hollow scrape returns
  // needs_fallback:true so the client can decide to retry with the flag.
  const allowAiFallback =
    new URL(req.url).searchParams.get('allowAiFallback') === '1';

  let body: { url?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { ok: false, error: 'bad_json' } satisfies ScrapeResponse,
      { status: 400 },
    );
  }
  let url = body.url?.trim();
  if (!url || !isSafeScrapeUrl(url)) {
    return NextResponse.json(
      { ok: false, error: 'invalid_url' } satisfies ScrapeResponse,
      { status: 400 },
    );
  }

  // ── Direct image-URL fast path (tester recap 2026-07-08) ─────────────────
  // Staff paste image links (right-click "copy image address" from Google
  // Shopping / a retailer) expecting the picture to import as a stock photo.
  // Before this, an image URL fell through to the product-page scraper and
  // died in the AI fallback ("direct image URLs fail"). Detect it, rehost the
  // image into our own storage (so it passes the client + DB host allowlists
  // and can never rot), and return it as the primary image with no scrape.
  if (looksLikeImageUrl(url)) {
    const hosted = await rehostImportImage(auth.operatorId, url);
    if (!hosted.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: `image_import_failed — couldn't download that image (${hosted.error}). Save it to the device and add it from the gallery instead.`,
        } satisfies ScrapeResponse,
        { status: 502 },
      );
    }
    const data: ScrapedData = {
      title: '',
      msrp_cents: null,
      primary_image_url: hosted.url,
      additional_image_urls: [],
      description: null,
      brand: null,
      upc: null,
      asin: null,
      item_condition: null,
      variant_asins: [],
      specs: null,
    };
    return NextResponse.json(
      { ok: true, host: detectHost(url).host, source: 'direct', data, warnings: ['image_url_import'] } satisfies ScrapeResponse,
    );
  }

  // Resolve Amazon/eBay share/short links (a.co, amzn.to, ebay.us, …) to their
  // canonical product URL BEFORE the allowlist check, then re-validate. The
  // share button on those apps emits a shortener host that isn't itself on the
  // retailer allowlist, so the link used to be rejected before the redirect was
  // ever followed.
  const resolvedUrl = await resolveShortUrl(url);
  if (resolvedUrl && resolvedUrl !== url) {
    if (!isSafeScrapeUrl(resolvedUrl)) {
      return NextResponse.json(
        { ok: false, error: 'invalid_url' } satisfies ScrapeResponse,
        { status: 400 },
      );
    }
    url = resolvedUrl;
  }

  const { host, isAmazon, isGoogleSearch } = detectHost(url);

  if (isGoogleSearch) {
    return NextResponse.json(
      {
        ok: false,
        error: 'google_shopping_search_not_supported — open the product page and copy that URL',
      } satisfies ScrapeResponse,
      { status: 400 },
    );
  }

  const warnings: string[] = [];

  // ── Catalog read-through ──────────────────────────────────────────────────
  // Before spending a (paid) scrape, check the master catalog by this URL's
  // retailer key. A complete prior entry (title + image) returns instantly and
  // free — the same item is never re-scraped, and repeat pastes / cross-operator
  // scans compound the catalog instead of re-billing the egress provider.
  // Runs for ANY host (unknown retailers included) — a prior AI-fallback
  // result for the same URL is just as cacheable.
  {
    const cached = await readScrapeCache(auth.admin, url);
    if (cached) {
      return NextResponse.json(
        {
          ok: true,
          host,
          source: 'catalog',
          data: await rehostScrapedImages(auth.operatorId, cached),
          warnings: ['catalog_hit'],
        } satisfies ScrapeResponse,
      );
    }
  }

  // ── Off-list retailers → AI/web-search path (never direct-fetched) ────────
  // Field finding 2026-07-07: staff paste links from brand stores (dyson.com,
  // ninjakitchen.com, …) and got a hard "not on the supported retailer list"
  // refusal. Those pages are real products — the list only exists to bound
  // what our server will fetch DIRECTLY. Unknown hosts now route through the
  // same Sonar web-search fallback as the hard-blocked hosts: we never fetch
  // the page ourselves (no SSRF surface widened), the AI finds the product
  // data from the URL/slug instead. Two-stage contract preserved: without
  // ?allowAiFallback=1 this returns needs_fallback:true and the client
  // auto-retries with the flag (scrape-url.ts stage 2).
  if (!isAllowedHost(host)) {
    if (!allowAiFallback) {
      return NextResponse.json(
        {
          ok: false,
          error: `host_requires_ai_fallback — ${host} isn't a listed retailer; retry with ?allowAiFallback=1`,
          needs_fallback: true,
        } satisfies ScrapeResponse,
        { status: 422 },
      );
    }
    const overBudget = await aiBudgetBlock(auth.operatorId);
    if (overBudget) return overBudget;
    const ai = await runAiFallback(url, null, warnings);
    if (ai) {
      return NextResponse.json(
        { ok: true, host: ai.host, source: 'ai_fallback', data: await rehostScrapedImages(auth.operatorId, ai.data), warnings } satisfies ScrapeResponse,
      );
    }
    return NextResponse.json(
      {
        ok: false,
        error: `ai_fallback_failed — couldn't find product data for this ${host} link. Enter the details manually.`,
      } satisfies ScrapeResponse,
      { status: 502 },
    );
  }

  // ── Hard-block fast path ──────────────────────────────────────────────────
  // Amazon (WAF), eBay (403), AliExpress/Alibaba (anti-bot) hard-block
  // server-side fetches — a direct fetch is a guaranteed-wasted round-trip.
  // The host allowlist still ADMITS these (so the operator can paste an
  // Amazon link), but instead of a doomed direct fetch we go straight to the
  // AI path that finds an alternate, fetchable retailer page. (Reconciles
  // the route allowlist with url-fetcher.ts's BLOCKED_HOSTS.)
  if (isHardBlockedHost(host)) {
    // ── Egress chain (Web Unlocker → relay) for hard-block hosts ────────────
    // Fetches the canonical page directly (Web Unlocker handles Amazon / eBay /
    // AliExpress / Alibaba; the relay covers Amazon+eBay). On success returns
    // the real page; otherwise falls through to the Sonar substitute below.
    {
      const egressed = await tryEgress(url, isAmazon, host, auth, warnings);
      if (egressed) return egressed;
    }

    if (!allowAiFallback) {
      return NextResponse.json(
        {
          ok: false,
          error: `host_requires_ai_fallback — ${host} blocks direct scraping; retry with ?allowAiFallback=1`,
          needs_fallback: true,
        } satisfies ScrapeResponse,
        { status: 422 },
      );
    }
    const overBudget = await aiBudgetBlock(auth.operatorId);
    if (overBudget) return overBudget;
    const ai = await runAiFallback(url, null, warnings);
    if (ai) {
      return NextResponse.json(
        { ok: true, host: ai.host, source: 'ai_fallback', data: await rehostScrapedImages(auth.operatorId, ai.data), warnings } satisfies ScrapeResponse,
      );
    }
    return NextResponse.json(
      {
        ok: false,
        error: `ai_fallback_failed — couldn't find an alternate product page for this ${host} item. Enter the details manually.`,
      } satisfies ScrapeResponse,
      { status: 502 },
    );
  }

  // ── Direct fetch (hardened: 8s timeout + 2-try backoff + Sec-Fetch-*) ─────
  const fetched = await fetchHtmlDirect(url);

  // Direct fetch failed (block, bad content-type, network/timeout). Escalate
  // to AI when opted in; otherwise surface the error + needs_fallback so the
  // client can retry with the flag.
  if (fetched.kind !== 'ok') {
    const directError =
      fetched.kind === 'blocked'
        ? `upstream_${fetched.status} — the retailer page returned ${fetched.status}.`
        : fetched.kind === 'bad_content_type'
          ? `unsupported_content_type — expected text/html, got ${fetched.contentType}`
          : `fetch_failed — ${fetched.message}`;

    // Rescue via the egress chain (Web Unlocker) before the Sonar substitute —
    // it can fetch the real page on any host the direct attempt couldn't.
    if (fetched.kind !== 'bad_content_type') {
      const egressed = await tryEgress(url, isAmazon, host, auth, warnings);
      if (egressed) return egressed;
    }

    if (allowAiFallback) {
      const overBudget = await aiBudgetBlock(auth.operatorId);
      if (overBudget) return overBudget;
      const ai = await runAiFallback(url, null, warnings);
      if (ai) {
        return NextResponse.json(
          { ok: true, host: ai.host, source: 'ai_fallback', data: await rehostScrapedImages(auth.operatorId, ai.data), warnings } satisfies ScrapeResponse,
        );
      }
    }
    // bad_content_type is the one case a retry/AI can't help (it's an
    // image/pdf/json URL, not a product page) → no needs_fallback.
    const status = fetched.kind === 'bad_content_type' ? 422 : 502;
    return NextResponse.json(
      {
        ok: false,
        error: directError,
        ...(fetched.kind === 'bad_content_type' ? {} : { needs_fallback: true }),
      } satisfies ScrapeResponse,
      { status },
    );
  }

  // ── Parse the direct HTML ─────────────────────────────────────────────────
  const data = extractProduct(fetched.html, url, isAmazon, warnings);

  // ── False-success detection ───────────────────────────────────────────────
  // 200 OK but nothing usable: an anti-bot interstitial/captcha (detected by
  // sentinel strings) or a client-rendered SPA shell (hollow result). Don't
  // return a hollow "success" — escalate or signal needs_fallback.
  const directBlock = classifyBlock(fetched.html);
  if (directBlock.blocked) warnings.push(`direct_blocked:${directBlock.reason}`);
  if (isHollowResult(data) || directBlock.blocked) {
    // Rescue via the egress chain (Web Unlocker) before the Sonar substitute.
    {
      const egressed = await tryEgress(url, isAmazon, host, auth, warnings);
      if (egressed) return egressed;
    }
    if (allowAiFallback) {
      // Re-clear warnings collected from the hollow direct parse so the AI
      // result's warnings reflect what *it* actually found.
      const aiWarnings: string[] = [];
      const overBudget = await aiBudgetBlock(auth.operatorId);
      if (overBudget) return overBudget;
      const ai = await runAiFallback(url, data, aiWarnings);
      if (ai) {
        await fillStockImageFromCatalog(ai.data, auth.admin, auth.operatorId, aiWarnings);
        return NextResponse.json(
          { ok: true, host: ai.host, source: 'ai_fallback', data: await rehostScrapedImages(auth.operatorId, ai.data), warnings: aiWarnings } satisfies ScrapeResponse,
        );
      }
    }
    return NextResponse.json(
      {
        ok: false,
        error: 'no_product_data — the page returned 200 but no title, price, or image could be parsed.',
        needs_fallback: true,
      } satisfies ScrapeResponse,
      { status: 422 },
    );
  }

  await fillStockImageFromCatalog(data, auth.admin, auth.operatorId, warnings);
  // Rehost before the write-through so the catalog stores own-storage URLs.
  const hostedDirect = await rehostScrapedImages(auth.operatorId, data);
  await writeScrapeCache(auth.admin, url, hostedDirect);

  return NextResponse.json(
    { ok: true, host, source: 'direct', data: hostedDirect, warnings } satisfies ScrapeResponse,
  );
}
