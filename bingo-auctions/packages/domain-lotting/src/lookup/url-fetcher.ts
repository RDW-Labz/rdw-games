// Retailer product page fetcher + parser.
//
// Strategy: instead of asking Sonar to extract structured product data
// (which it does poorly — paraphrases pages, fabricates URLs, drops
// fields), use Sonar JUST to find canonical retailer product-page URLs.
// Then we fetch each URL ourselves and parse the HTML for the data we
// actually need: title, image, price, brand, MPN.
//
// Two extraction paths, in priority order:
//
//   1. JSON-LD schema.org Product markup
//      `<script type="application/ld+json">{ "@type": "Product", ... }</script>`
//      Most major retailers (Walmart, Home Depot, Target, Best Buy, Costco)
//      embed clean Product structured data including offers.price,
//      brand.name, sku/mpn, and image URLs. This is the gold path.
//
//   2. OpenGraph + Twitter Card meta tags
//      `<meta property="og:image" content="...">`, og:title, og:price:amount,
//      product:price:amount. Less reliable but every retailer has SOMETHING.
//      Fallback when JSON-LD isn't present.
//
// Amazon is the notable exception — they block datacenter IPs (including
// Cloudflare Worker) at the application layer and their product HTML
// strips most schema.org markup. fetchProductPage skips amazon.com hosts
// rather than wasting a network round-trip.
//
// All operations are best-effort: any fetch error / parse error / timeout
// returns null and the caller filters those out. The aggregator combines
// what comes back across multiple URLs.

import type { OpenRouterListing } from './openrouter';
import { getLottingConfig, hasLottingConfig } from '../config';

// 2026-07-10 (stock-image audit): prefer the host app's unblocked egress
// fetcher when one is configured (operator-web injects fetchViaEgress —
// Bright Data Web Unlocker → Playwright relay). The raw Worker fetch()
// below is bot-blocked by most retailer WAFs (datacenter IP), which is why
// scraped stock images landed on only ~1.6% of lots. With egress available
// even the hard-block hosts (Amazon/eBay) become fetchable — the ASIN
// resolver has fetched Amazon through this exact chain since mig 0152.
function configuredHtmlFetcher():
  | ((url: string) => Promise<{ html: string; finalUrl: string } | null>)
  | null {
  if (!hasLottingConfig()) return null;
  return getLottingConfig().fetchHtml ?? null;
}

// User-Agent rotation pool. Some retailers (Walmart in particular) flag
// repeated requests from the same UA as bot traffic and serve a 15KB
// stub-page instead of the real product HTML. Rotating across 5 modern
// browser UAs (Chrome desktop+mobile, Firefox, Safari, Chrome Linux)
// spreads the fingerprint enough to dodge that. Each fetch picks one
// at random — see `pickBrowserUA`.
const BROWSER_UAS = [
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:128.0) Gecko/20100101 Firefox/128.0',
];

function pickBrowserUA(): string {
  return BROWSER_UAS[Math.floor(Math.random() * BROWSER_UAS.length)]!;
}

const FETCH_TIMEOUT_MS = 5_000;

// Per-host pacing: minimum wait time between two fetches on the same
// host. 2.5s is enough to dodge Walmart's burst-detection rate-limiter
// (which fires after ~3 same-host requests within ~5s in our smoke
// matrix). Tracked in-memory; resets per Worker invocation, which is
// fine because typical product enrichment only hits each host 1-2x
// per request anyway.
const PER_HOST_MIN_DELAY_MS = 2_500;
const lastFetchByHost = new Map<string, number>();

async function paceHost(host: string): Promise<void> {
  const prev = lastFetchByHost.get(host) ?? 0;
  const since = Date.now() - prev;
  if (since < PER_HOST_MIN_DELAY_MS) {
    await new Promise((r) => setTimeout(r, PER_HOST_MIN_DELAY_MS - since));
  }
  lastFetchByHost.set(host, Date.now());
}

// Hosts we don't bother fetching:
//   - Amazon: WAF blocks Workers + datacenter IPs, returns JS-challenge HTML.
//   - eBay: returns 403 to server-side fetches (verified in 2026-05-15
//     smoke matrix — 100% failure rate across multiple UAs).
//   - AliExpress / Alibaba: non-US + aggressive anti-bot; documented
//     unsupported in the URL-finder prompt. Direct server fetch is a
//     doomed round-trip, so route these straight to the AI path too.
export const BLOCKED_HOSTS = new Set<string>([
  'amazon.com',
  'www.amazon.com',
  'smile.amazon.com',
  'ebay.com',
  'www.ebay.com',
  'm.ebay.com',
  'aliexpress.com',
  'www.aliexpress.com',
  'alibaba.com',
  'www.alibaba.com',
]);

// Match a hostname (not a full URL) against the hard-block list, including
// any subdomain of amazon.* / ebay.* / aliexpress.* / alibaba.* so locale
// hosts (amazon.co.uk, www.amazon.de, m.ebay.com, he.aliexpress.com …) and
// regional Amazon/eBay shards are all caught. Used by callers that have a
// bare hostname (e.g. the scrape-url route reconciling its allowlist).
const HARD_BLOCK_HOST_RE =
  /^(?:[\w-]+\.)*(?:amazon|ebay|aliexpress|alibaba)\.[a-z.]+$/i;

/**
 * True when a hostname is known to hard-block direct server fetches
 * (Amazon WAF, eBay 403, AliExpress/Alibaba anti-bot). Callers should
 * route these straight to the AI/URL-finder path instead of attempting a
 * doomed direct fetch.
 */
export function isHardBlockedHost(hostname: string): boolean {
  if (!hostname) return true;
  const h = hostname.toLowerCase();
  return BLOCKED_HOSTS.has(h) || HARD_BLOCK_HOST_RE.test(h);
}

function isBlocked(url: string): boolean {
  try {
    const u = new URL(url);
    return isHardBlockedHost(u.hostname.toLowerCase());
  } catch {
    return true;
  }
}

function retailerNameFromUrl(url: string): string {
  try {
    const h = new URL(url).hostname.toLowerCase();
    if (h.includes('walmart')) return 'Walmart';
    if (h.includes('homedepot') || h.includes('thdstatic')) return 'Home Depot';
    if (h.includes('lowes')) return "Lowe's";
    if (h.includes('target')) return 'Target';
    if (h.includes('bestbuy')) return 'Best Buy';
    if (h.includes('costco')) return 'Costco';
    if (h.includes('ebay')) return 'eBay';
    if (h.includes('bhphotovideo')) return 'B&H Photo';
    if (h.includes('newegg')) return 'Newegg';
    if (h.includes('mac.bid')) return 'MAC.BID';
    if (h.includes('nellisauction')) return 'Nellis';
    return h.replace(/^www\./, '');
  } catch {
    return 'unknown';
  }
}

// Strip nested JSON-LD wrappers and find every object/array entry with
// "@type": "Product". Schemas vary — some retailers nest products in
// "@graph" arrays, some have multiple Product nodes (parent + variants),
// some return arrays at the top level. Walk recursively.
function findProductNodes(node: unknown): Record<string, unknown>[] {
  if (!node) return [];
  if (Array.isArray(node)) {
    return node.flatMap(findProductNodes);
  }
  if (typeof node !== 'object') return [];
  const obj = node as Record<string, unknown>;
  const out: Record<string, unknown>[] = [];

  const t = obj['@type'];
  if (
    t === 'Product' ||
    t === 'IndividualProduct' ||
    (Array.isArray(t) && t.some((x) => x === 'Product' || x === 'IndividualProduct'))
  ) {
    out.push(obj);
  }

  // Walk children — schema.org commonly nests in @graph, mainEntity, hasPart,
  // isVariantOf, item, products, etc.
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      out.push(...findProductNodes(v));
    }
  }
  return out;
}

function priceFromOffer(offer: unknown): number | null {
  if (!offer) return null;
  if (Array.isArray(offer)) {
    // Pick the lowest price across an array (matches "starting at" UX).
    const prices = offer.map(priceFromOffer).filter((p): p is number => p !== null);
    if (prices.length === 0) return null;
    return Math.min(...prices);
  }
  if (typeof offer !== 'object') return null;
  const o = offer as Record<string, unknown>;
  // priceSpecification.price OR price directly
  if (o['priceSpecification']) {
    const p = priceFromOffer(o['priceSpecification']);
    if (p !== null) return p;
  }
  const raw = o['price'] ?? o['lowPrice'];
  if (raw == null) return null;
  const n = typeof raw === 'string' ? parseFloat(raw.replace(/[^0-9.]/g, '')) : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function imagesFromProduct(p: Record<string, unknown>): string[] {
  const img = p['image'];
  if (!img) return [];
  if (typeof img === 'string') return [img];
  if (Array.isArray(img)) {
    return img
      .map((x) => {
        if (typeof x === 'string') return x;
        if (x && typeof x === 'object') return (x as Record<string, unknown>)['url'] ?? '';
        return '';
      })
      .filter((s): s is string => typeof s === 'string' && s.startsWith('http'));
  }
  if (typeof img === 'object') {
    const u = (img as Record<string, unknown>)['url'];
    return typeof u === 'string' ? [u] : [];
  }
  return [];
}

// Match all <script type="application/ld+json">...</script> blocks. Greedy
// non-greedy `[\s\S]*?` to handle pretty-printed JSON with newlines.
const JSONLD_RE = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

// OpenGraph fallback patterns. Both common attribute orderings.
const OG_PATTERNS = {
  image: [
    /<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i,
    /<meta\s+content=["']([^"']+)["']\s+property=["']og:image["']/i,
  ],
  title: [
    /<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i,
    /<meta\s+content=["']([^"']+)["']\s+property=["']og:title["']/i,
  ],
  price: [
    /<meta\s+property=["']product:price:amount["']\s+content=["']([^"']+)["']/i,
    /<meta\s+property=["']og:price:amount["']\s+content=["']([^"']+)["']/i,
  ],
  description: [
    /<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i,
    /<meta\s+content=["']([^"']+)["']\s+property=["']og:description["']/i,
    /<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i,
  ],
};

function firstMatch(html: string, patterns: RegExp[]): string | null {
  for (const re of patterns) {
    const m = re.exec(html);
    if (m && m[1]) return m[1];
  }
  return null;
}

/**
 * Fetch a single retailer product page and parse it into an
 * OpenRouterListing. Returns null on any error (network, parse, blocked
 * host, no useful data). Callers should fan out across multiple URLs
 * and filter nulls.
 */
export async function fetchProductPage(url: string): Promise<OpenRouterListing | null> {
  if (!url || typeof url !== 'string') return null;
  if (!url.startsWith('https://') && !url.startsWith('http://')) return null;
  const egressFetch = configuredHtmlFetcher();
  // Without egress, hard-block hosts are a doomed round-trip; with it,
  // they're fetchable like anything else.
  if (!egressFetch && isBlocked(url)) return null;

  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return null; }

  let html: string | null = null;

  // Path A: unblocked egress (Bright Data / relay). Rotating residential
  // IPs — no per-host pacing needed, and the WAF-stub heuristics below
  // don't apply to what it returns.
  if (egressFetch) {
    const viaEgress = await egressFetch(url).catch(() => null);
    if (viaEgress && viaEgress.html.length > 0) {
      html = viaEgress.html.slice(0, 5 * 1024 * 1024);
    }
  }

  // Path B: direct Worker fetch — the original path; kept as the fallback
  // when egress is unconfigured, errored, or came back blocked/empty.
  if (html === null) {
    if (isBlocked(url)) return null;
    // Per-host pacing: avoid burst-detection rate-limiters (Walmart's
    // 15KB stub-page response in particular).
    await paceHost(host);

    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          // Rotating UA + realistic header set. Mirrors a real Chrome
          // navigation so anti-bot middleware doesn't reject us before
          // serving the page.
          'User-Agent': pickBrowserUA(),
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Site': 'none',
          'Upgrade-Insecure-Requests': '1',
        },
        signal: ctl.signal,
        redirect: 'follow',
      });
      if (!res.ok) return null;
      // Cap response to 5MB — retailers' product pages are typically 200-800KB.
      const buf = await res.arrayBuffer();
      if (buf.byteLength > 5 * 1024 * 1024) return null;
      // Walmart anti-bot stub page is exactly 15562 bytes — if we get
      // back something that small from a Walmart product URL, the page
      // is a challenge and og:image/JSON-LD will both be empty. Skip
      // the parse work.
      if (buf.byteLength < 20_000 && /(^|\.)walmart\.com$/.test(host)) return null;
      html = new TextDecoder('utf-8').decode(buf);
    } catch {
      return null;
    } finally {
      clearTimeout(t);
    }
  }

  // Path 1: JSON-LD schema.org Product
  let title: string | null = null;
  let brand: string | null = null;
  let mpn: string | null = null;
  let description: string | null = null;
  let askingDollars: number | null = null;
  let msrpDollars: number | null = null;
  const images: string[] = [];

  let m: RegExpExecArray | null;
  JSONLD_RE.lastIndex = 0;
  while ((m = JSONLD_RE.exec(html)) !== null) {
    const raw = (m[1] ?? '').trim();
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const products = findProductNodes(parsed);
    for (const p of products) {
      if (!title && typeof p['name'] === 'string') title = p['name'] as string;
      const b = p['brand'];
      if (!brand) {
        if (typeof b === 'string') brand = b;
        else if (b && typeof b === 'object') {
          const bn = (b as Record<string, unknown>)['name'];
          if (typeof bn === 'string') brand = bn;
        }
      }
      if (!mpn && typeof p['mpn'] === 'string') mpn = p['mpn'] as string;
      if (!mpn && typeof p['sku'] === 'string') mpn = p['sku'] as string;
      if (!description && typeof p['description'] === 'string') {
        const d = (p['description'] as string).trim();
        if (d.length > 0) description = d.slice(0, 2000);
      }
      if (askingDollars === null) askingDollars = priceFromOffer(p['offers']);
      // Some retailers expose "listPrice" or strikethrough as a separate field
      if (msrpDollars === null) {
        const lp = p['listPrice'] ?? p['msrp'] ?? p['suggestedRetailPrice'];
        if (lp != null) {
          const n = typeof lp === 'string' ? parseFloat(lp.replace(/[^0-9.]/g, '')) : Number(lp);
          if (Number.isFinite(n) && n > 0) msrpDollars = n;
        }
      }
      images.push(...imagesFromProduct(p));
    }
  }

  // Path 2: OpenGraph fallback
  if (!title) title = firstMatch(html, OG_PATTERNS.title);
  if (askingDollars === null) {
    const og = firstMatch(html, OG_PATTERNS.price);
    if (og) {
      const n = parseFloat(og.replace(/[^0-9.]/g, ''));
      if (Number.isFinite(n) && n > 0) askingDollars = n;
    }
  }
  // Amazon rarely exposes JSON-LD product images to non-browser fetches, but
  // the product page embeds the real hero in data-old-hires / the hiRes
  // image JSON / the landingImage tag. Try those BEFORE falling back to
  // og:image, which on bot-served Amazon pages is often the nav sprite
  // (tester round-5: lots.photo_urls[0] literally became
  // m.media-amazon.com/images/G/01/gno/sprites/nav-sprite-...png).
  if (images.length === 0 && /amazon\./i.test(url)) {
    const amazonPatterns = [
      /data-old-hires=["'](https:\/\/[^"']+)["']/i,
      /"hiRes"\s*:\s*"(https:\/\/[^"]+)"/i,
      /"large"\s*:\s*"(https:\/\/m\.media-amazon\.com\/images\/I\/[^"]+)"/i,
      /id=["']landingImage["'][^>]*\ssrc=["'](https:\/\/[^"']+)["']/i,
    ];
    for (const p of amazonPatterns) {
      const m = html.match(p);
      if (m?.[1]) {
        images.push(m[1]);
        break;
      }
    }
  }
  if (images.length === 0) {
    const ogImg = firstMatch(html, OG_PATTERNS.image);
    if (ogImg) images.push(ogImg);
  }
  if (!description) {
    const ogDesc = firstMatch(html, OG_PATTERNS.description);
    if (ogDesc) {
      const d = ogDesc.trim();
      if (d.length > 0) description = d.slice(0, 2000);
    }
  }

  // No useful data → skip
  if (!title && askingDollars === null && images.length === 0) return null;

  // Dedupe images, keep https only, and drop known NON-PRODUCT junk: nav
  // sprites, tracking pixels, placeholder/captcha art. Retailers serve these
  // to bot traffic in og:image position; without this filter they become the
  // lot's hero photo (tester round-5).
  const JUNK_IMAGE = /sprite|\/G\/01\/gno\/|pixel|1x1|spacer|placeholder|captcha|\.gif($|\?)/i;
  const dedupedImages = Array.from(
    new Set(images.filter((u) => u.startsWith('http') && !JUNK_IMAGE.test(u))),
  ).slice(0, 6);

  return {
    title: title ?? '',
    source: retailerNameFromUrl(url),
    asking_cents: askingDollars !== null ? Math.round(askingDollars * 100) : null,
    msrp_cents: msrpDollars !== null ? Math.round(msrpDollars * 100) : null,
    sold_cents: null,
    sold_at: null,
    condition: 'New',
    brand: brand ?? null,
    mpn: mpn ?? null,
    description: description ?? null,
    image_urls: dedupedImages,
    url,
  };
}

/**
 * Fetch many URLs in parallel with bounded concurrency, returning only
 * the successful parses. Concurrency cap of 3 keeps retailers from rate-
 * limiting us when one product has 5 retailers all hit at once.
 */
export async function fetchProductPages(urls: string[]): Promise<OpenRouterListing[]> {
  if (!urls || urls.length === 0) return [];
  const unique = Array.from(new Set(urls));
  const out: (OpenRouterListing | null)[] = new Array(unique.length).fill(null);

  const CONCURRENCY = 3;
  let cursor = 0;
  async function worker(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= unique.length) return;
      const u = unique[i];
      if (!u) continue;
      out[i] = await fetchProductPage(u).catch(() => null);
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, unique.length) }, () => worker()));
  return out.filter((x): x is OpenRouterListing => x !== null);
}
