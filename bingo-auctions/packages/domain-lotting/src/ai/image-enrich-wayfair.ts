// Wayfair-SKU stock-image enrichment.
//
// WHY A DEDICATED PATH (2026-07-15 owner feedback):
// The generic title tier (enrichImages) leans on a search model to GUESS
// which retailer product page matches a free-text title. That works for
// sortable consumer goods (Amazon has the item) but is unreliable for
// Wayfair furniture — the title alone ("Sedgwick 3-Piece Sectional") is
// ambiguous across dozens of near-identical listings, so the wrong photo
// (or none) comes back. Wayfair returns carry an exact SKU (SiteSKU, the
// "W…" number printed on the FedEx return label, and ProductSKU), and
// Wayfair's own product page is the authoritative image source. This path
// goes straight from the SKU to wayfair.com — no search-model guessing.
//
// The manifest importer already round-trips these SKUs onto the lot
// (create_draft_lot p_site_sku / p_product_sku, mig 0188), so every new
// Wayfair QuickLot carries what this path needs.
//
// SAFETY: identical quality gate to enrichImages — filterSafeImageUrls +
// optional bucket-mirror for non-allowlisted hosts + the same-product
// vision verifier. `strict` fails CLOSED (attach nothing when the verifier
// can't run) for the unattended drain, so a wrong Wayfair page never
// auto-swaps into a lot's hero slot. Returns [] on any miss; never throws.

import { fetchProductPage } from '../lookup/url-fetcher';
import { searchSerp } from '../lookup/serp';
import { filterSafeImageUrls } from '../normalize/images';
import { getLottingConfig, hasLottingConfig } from '../config';
import { verifyImagesMatchProduct } from './image-verify';

export type WayfairImageInput = {
  /** Wayfair SiteSKU — the "W…" number printed on the return label. */
  siteSku?: string | null;
  /** Wayfair ProductSKU — the manufacturer/catalog SKU. */
  productSku?: string | null;
  title?: string | null;
  brand?: string | null;
  /** Lot description — feeds the color-aware same-product vision gate. */
  description?: string | null;
  /** Fail CLOSED on the vision gate (attach nothing when it can't run).
   *  Use on the unattended drain; the interactive scan leaves it false. */
  strict?: boolean;
};

const MAX_IMAGES = 3;
// A Wayfair SKU is alphanumeric with optional dashes. Guard against junk
// (empty, tracking numbers, huge blobs) becoming part of a fetched URL.
const SKU_RE = /^[A-Za-z0-9][A-Za-z0-9-]{2,31}$/;

/**
 * Candidate wayfair.com URLs for a SKU. Wayfair resolves a slug-less PDP by
 * the trailing SKU and 301-redirects to the canonical product page, and its
 * keyword search redirects straight to the PDP on an exact-SKU match — so
 * either shape lands on the real product page (the egress fetcher follows
 * redirects). Bad guesses are harmless: fetchProductPage returns null on a
 * 404/search-miss and the vision gate rejects any off-product image.
 */
export function wayfairPdpUrls(
  siteSku?: string | null,
  productSku?: string | null,
): string[] {
  const urls: string[] = [];
  const add = (raw?: string | null) => {
    const s = (raw ?? '').trim();
    if (!s || !SKU_RE.test(s)) return;
    const enc = encodeURIComponent(s);
    urls.push(`https://www.wayfair.com/-/pdp/-${enc}.html`);
    urls.push(`https://www.wayfair.com/keyword.php?keyword=${enc}`);
  };
  add(siteSku);
  if ((productSku ?? '').trim() && productSku !== siteSku) add(productSku);
  return Array.from(new Set(urls));
}

/**
 * Resolve up to 3 verified Wayfair stock-image URLs from a SKU. Requires an
 * egress fetcher (LottingConfig.fetchHtml — Bright Data Web Unlocker) since a
 * raw datacenter fetch of wayfair.com is WAF-blocked. Returns [] when no SKU,
 * no egress, or nothing survives the vision gate.
 */
export async function enrichWayfairImagesBySku(
  input: WayfairImageInput,
): Promise<string[]> {
  const siteSku = (input.siteSku ?? '').trim();
  const productSku = (input.productSku ?? '').trim();
  if (!siteSku && !productSku) return [];

  const cfg = hasLottingConfig() ? getLottingConfig() : null;
  // wayfair.com hard-blocks datacenter IPs; without egress the fetch is a
  // doomed round-trip. Bail rather than burn a request + vision call on it.
  if (!cfg?.fetchHtml) return [];

  const rawImages: string[] = [];

  // ── Pass 1: direct SKU → Wayfair PDP ──────────────────────────────────
  for (const url of wayfairPdpUrls(siteSku, productSku)) {
    if (rawImages.length >= 6) break;
    const listing = await fetchProductPage(url).catch(() => null);
    if (listing?.image_urls?.length) rawImages.push(...listing.image_urls);
  }

  // ── Pass 2: SERP fallback anchored to the SKU ─────────────────────────
  // Only when the direct PDP produced nothing — a SKU search on Google
  // Shopping surfaces the Wayfair listing (image + wayfair.com link) even
  // when the slug-less PDP shape misses.
  if (rawImages.length === 0) {
    const hits = await searchSerp(siteSku || productSku, 4).catch(() => []);
    for (const hit of hits) {
      for (const img of hit.product.image_urls) rawImages.push(img);
    }
  }

  if (rawImages.length === 0) return [];
  const allImageUrls = Array.from(new Set(rawImages));

  // ── Quality gate (identical to enrichImages) ──────────────────────────
  // Allowlisted hosts (secure.img1-fg.wfcdn.com, assets.wfcdn.com) attach
  // directly; other Wayfair image shards get mirrored into our bucket so the
  // lots_filter_photo_urls host trigger doesn't strip them.
  const safe = filterSafeImageUrls(allImageUrls);
  let candidates = safe;
  if (cfg.mirrorImage) {
    const unlisted = allImageUrls
      .filter((u) => /^https:\/\//i.test(u) && !safe.includes(u))
      .slice(0, 5);
    if (unlisted.length > 0) {
      const mirrored = await Promise.all(
        unlisted.map((u) => cfg.mirrorImage!(u).catch(() => null)),
      );
      candidates = Array.from(
        new Set([...safe, ...mirrored.filter((u): u is string => Boolean(u))]),
      );
    }
  }
  if (candidates.length === 0) return [];

  // Same-product vision verification. strict → attach only positively
  // verified images; fail closed when the verifier can't run.
  const verdicts = await verifyImagesMatchProduct(
    {
      title: input.title,
      brand: input.brand,
      description: input.description,
    },
    candidates,
  ).catch(() => null);
  const finalUrls = verdicts
    ? candidates.filter((_, i) => verdicts[i] === true)
    : input.strict
      ? []
      : candidates;

  return finalUrls.slice(0, MAX_IMAGES);
}
