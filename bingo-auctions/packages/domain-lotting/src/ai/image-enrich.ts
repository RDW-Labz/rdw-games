// Image enrichment — cascade that fills lots.photo_urls with stock
// images for identified products.
//
// Cascade (cheapest → most expensive):
//   1. Open Food Facts (OFF) — free, no key, ~100% hit rate for the
//      consumer-goods manifests the operator scans (groceries, drinks,
//      snacks, tobacco, beauty). Adds `images.openfoodfacts.org` URLs.
//   2. URL-Finder + page-fetch — paid (~$0.04-0.06/call across 2-3
//      parallel finders). Reuses the SAME plumbing as the UPC/keyword
//      lookup path: Sonar/GPT-4o-Search finds retailer product page
//      URLs, then `fetchProductPages` fetches each page server-side
//      and extracts JSON-LD Product image + og:image meta tags. This
//      replaces the previous "ask Sonar for direct CDN URLs" approach
//      which empirically returned [] on consumer goods (per the
//      2026-05-15 stock-image smoke matrix — 3 working images out of
//      45 cells across multiple models/prompts; the others were either
//      empty responses or fabricated CDN URLs like
//      `i5.walmartimages.com/asr/1a2b3c4d5e6f7g8h9i0j.jpg`).
//
// All returned URLs pass through filterSafeImageUrls, which enforces
// the ALLOWED_IMAGE_HOSTS allowlist before persistence. Empty array on
// miss / outage / all hosts unsafe — never throws.
//
// Cost notes:
//   - OFF hit (typical for groceries / CPG with real UPCs): $0.
//   - OFF miss → URL-Finder + page-fetch: ~$0.04-0.06 (3 finders in
//     parallel; cached forever after on product_lookups.image_urls).
//   - Hit rate (2026-05-15 smoke matrix, 10 real intake products):
//     8/10 = 80% yielded at least one working stock image via the
//     page-fetch path. The 2 misses were one genuinely obscure
//     product with no retailer listings (Origami) and one prompt
//     issue (Konsait — URL-Finder returned search pages instead
//     of product pages; mitigated by the 2026-05-15 prompt update
//     in `lookup/openrouter.ts`).
//
// Public API (single function):
//
//   enrichImages({ brand, model, title, upc }) → string[]

import { filterSafeImageUrls } from '../normalize/images';
import { enrichImagesFromOpenFoodFacts } from './image-enrich-openfoodfacts';
import { fetchOpenRouterLookup } from '../lookup/openrouter';
import { getLottingConfig, hasLottingConfig } from '../config';
import { verifyImagesMatchProduct } from './image-verify';

export type ImageEnrichInput = {
  brand?: string | null;
  model?: string | null;
  title?: string | null;
  upc?: string | null;
  // Passed to the same-product vision gate so it can reject wrong-color images
  // using the authoritative color named in the description (2026-07-13).
  description?: string | null;
  // When true, run ONLY the free/instant Open Food Facts pass and skip the
  // ~$0.05 multi-second URL-Finder + page-fetch + verify pass. Used by the
  // interactive scan so it returns fast; the deferred background enrichment
  // does the full pass (2026-07-13 latency).
  skipWebSearch?: boolean;
  // Fail CLOSED on the same-product vision gate: attach ONLY images the gate
  // positively verified as this product; when the verifier can't run (null),
  // attach NOTHING (2026-07-14). Use on UNATTENDED paths (the per-minute
  // enrichment drain) where no human reviews the result before it becomes the
  // lot's hero — a flaky/failed verify must not let a wrong image (e.g. an
  // AirPods photo on a Google Pixel lot) auto-swap into the front slot. The
  // interactive scan leaves this false (fail open) because staff review the
  // candidate before saving.
  strict?: boolean;
};

const MAX_IMAGES_TO_RETURN = 3;

/**
 * Resolve up to 3 stock-image URLs for a product. Tries Open Food Facts
 * first (free), then falls back to the URL-Finder + page-fetch pipeline
 * shared with the UPC/keyword lookup path.
 *
 * Returns empty array on miss across both sources; never throws.
 *
 * Cost: $0 when OFF hits (typical case for CPG / liquidation manifests).
 * ~$0.04-0.06 when OFF misses and URL-Finder fires (3 parallel finders).
 * Callers MUST cache the result in product_lookups.image_urls so the
 * marginal cost on repeat scans drops to $0.
 *
 * Note: when called from scanPhoto's fallback path, this duplicates the
 * lookup-by-upc flow when both ran. The duplication is acceptable
 * because (a) the cache short-circuits the second call, and (b) the
 * lookup-by-upc path might have cache-hit a row with empty image_urls
 * (legacy data); enrichImages forces a fresh fetch attempt in that case.
 */
export async function enrichImages(input: ImageEnrichInput): Promise<string[]> {
  // ── Pass 1: Open Food Facts (free, instant, high coverage) ─────────────
  if (input.upc) {
    const offUrls = await enrichImagesFromOpenFoodFacts(input.upc).catch(() => [] as string[]);
    if (offUrls.length > 0) {
      const safe = filterSafeImageUrls(offUrls);
      const deduped = Array.from(new Set(safe));
      if (deduped.length > 0) return deduped.slice(0, MAX_IMAGES_TO_RETURN);
    }
  }

  // Interactive scan: OFF is free/instant, but the URL-Finder + page-fetch +
  // verify pass below is the ~$0.05 multi-second cost. Skip it here and let the
  // background enrichment pass fill photos afterward (2026-07-13 latency).
  if (input.skipWebSearch) return [];

  // ── Pass 2: URL-Finder + server-side page-fetch ────────────────────────
  // Reuses the exact pipeline the UPC/keyword lookup path uses. The Sonar
  // direct-image-URL approach was deleted 2026-05-15 after the smoke
  // matrix showed it returns [] on 42 of 45 cells (all real test products
  // — the 3 wins were eBay placeholder/missing-image PNGs). The pipeline
  // here calls fetchOpenRouterLookup which:
  //   1. Sonar (and/or gpt-4o-search) returns 3-6 retailer product page URLs.
  //   2. fetchProductPages fetches each URL with browser UA + per-host
  //      pacing, parses JSON-LD Product + og:image meta tags.
  //   3. Returns OpenRouterListing[] with populated image_urls.
  // We aggregate image_urls from every listing, filter through the
  // allowlist, dedupe, cap at MAX_IMAGES_TO_RETURN.
  const query: { upc?: string; title?: string; brand?: string; model?: string } = {};
  if (input.upc)   query.upc   = input.upc;
  if (input.brand) query.brand = input.brand;
  if (input.model) query.model = input.model;
  if (input.title) query.title = input.title;
  if (Object.keys(query).length === 0) return [];

  let result;
  try {
    result = await fetchOpenRouterLookup(query);
  } catch {
    return [];
  }

  // Aggregate image_urls from all returned listings. fetchProductPages
  // already deduplicates within each listing and caps at 6 per page;
  // we further dedupe across pages.
  const allImageUrls = Array.from(
    new Set(result.active.flatMap((listing) => listing.image_urls)),
  );

  // Allowlisted hosts can be attached directly (hotlink; the enrich()
  // thunk mirrors them into the stock-images bucket at lot-save time).
  const safe = filterSafeImageUrls(allImageUrls);

  // ── 2026-07-10 stock-image overhaul P1 ─────────────────────────────────
  // Page-vouched images on hosts NOT in the allowlist used to be silently
  // discarded — the biggest coverage leak in this pipeline (most smaller
  // retailers' og:image CDNs aren't listed). When the host app provides a
  // mirror hook (server-side, service-role client), download them into
  // OUR bucket instead and attach the storage URL we control. Cap the
  // attempts so a listing-heavy page can't trigger a download storm.
  const cfg = hasLottingConfig() ? getLottingConfig() : null;
  let candidates = safe;
  if (cfg?.mirrorImage) {
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

  // ── Same-product vision verification (quality gate) ────────────────────
  // One cheap gemini-flash-lite call over ALL candidates. Verdict `false`
  // drops the image. When the verifier can't run (null): the default fails
  // OPEN (keeps every candidate) so a flaky verifier never zeroes out coverage
  // on the staff-reviewed interactive path; `strict` fails CLOSED (attach
  // nothing) for unattended callers (the drain) where a wrong image would
  // silently auto-swap into the hero slot (2026-07-14).
  const verdicts = await verifyImagesMatchProduct(
    {
      title: input.title,
      brand: input.brand,
      model: input.model,
      upc: input.upc,
      description: input.description,
    },
    candidates,
  ).catch(() => null);
  const finalUrls = verdicts
    ? candidates.filter((_, i) => verdicts[i] === true)
    : input.strict
      ? []
      : candidates;

  return finalUrls.slice(0, MAX_IMAGES_TO_RETURN);
}
