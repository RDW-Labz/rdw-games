// Image URL filtering / allowlist.
//
// Security boundary: ALL image URLs from external sources (eBay, OpenRouter,
// AI responses, scrapers) MUST pass through isSafeImageUrl() before storage.
// This closes the cross-tenant XSS / Referer-leak / image-decoder CVE surface
// identified in security audit finding M2.
//
// Authoritative source: this file. DB-side mirror: is_safe_image_url() in
// migration 0038_normalize_helpers.sql. Keep both lists in sync.
//
// To add a new retailer CDN:
//   1. Add the hostname here with a comment.
//   2. Add the same hostname to is_safe_image_url() in 0038_normalize_helpers.sql.
//   DO NOT use wildcard or subdomain patterns — every host must be explicit.

/**
 * Allowlist of trusted image CDN hostnames.
 * Only `https://` URLs pointing to one of these hosts will be stored.
 */
export const ALLOWED_IMAGE_HOSTS = new Set([
  // eBay
  'i.ebayimg.com',
  'thumbs.ebaystatic.com',
  'pics.ebaystatic.com',

  // Pinterest (product pins with retail images)
  'i.pinimg.com',

  // Amazon / AWS product images
  'm.media-amazon.com',
  'images-na.ssl-images-amazon.com',
  'images-eu.ssl-images-amazon.com',
  'images-fe.ssl-images-amazon.com',
  'ecx.images-amazon.com',         // legacy Amazon CDN, added in migration 0045

  // The Home Depot CDN
  'images.thdstatic.com',

  // Lowe's CDN
  'mobileimages.lowes.com',
  'images.lowes.com',

  // Walmart product images
  'i5.walmartimages.com',
  'i1.walmartimages.com',
  'i2.walmartimages.com',
  'i3.walmartimages.com',
  'i4.walmartimages.com',

  // Target / Scene7 CDN
  'target.scene7.com',

  // Best Buy product images
  'pisces.bbystatic.com',

  // Costco product images
  'mobilecontent.costco.com',

  // B&H Photo
  'static.bhphotovideo.com',

  // Newegg product images
  'c1.neweggimages.com',

  // Competitor auction CDNs (scraped via competitor_lots — read-only reference data)
  'media.mac.bid',           // MAC.BID
  'cdn.bidfta.com',          // BidFTA — pre-emptive
  'images.nellisauction.com', // Nellis — pre-emptive
  // Nellis actually serves most product thumbs out of Firebase Storage
  // (their app uploads user-captured photos there). Added 2026-05-13
  // after the importer dry-run showed ~800 nellis lots whose images
  // were dropped by allowlist filtering.
  'firebasestorage.googleapis.com',

  // BinGo Supabase Storage (project xgsujdzicnjenhqihovk).
  // Used by mobile Quick Lot + Scan to host user-captured photos.
  // Mirrored in is_safe_image_url() via migration 0045.
  'xgsujdzicnjenhqihovk.supabase.co',
  // BinGo Auctions Supabase Storage (project npwseclcxcatjhgjrtwe).
  // The DB mirror gained this in migration 0218 but this TS Set was
  // never synced, so isSafeImageUrl() rejected BinGo's own storage
  // URLs (staff captures, mirrored stock images) at the app layer.
  'npwseclcxcatjhgjrtwe.supabase.co',

  // Open Food Facts CDN (added 2026-05-11 alongside image-enrich-
  // openfoodfacts.ts). Open-data community catalog, ~100% coverage on
  // typical consumer-goods UPC scans. Mirrored in is_safe_image_url()
  // via migration 0069.
  'images.openfoodfacts.org',

  // Additional retailer CDNs surfaced by the stock-image smoke matrix
  // (2026-05-15). The URL-Finder + page-fetch path consistently extracts
  // og:image URLs from these retailer pages — broadening the allowlist
  // here closes the gap where a fetched-page-vouched image was discarded
  // by the strict filter. Mirror in is_safe_image_url() via the next
  // migration so DB-side enforcement stays in sync.
  //
  // Shopify CDN: used by 1000s of small retailers + manufacturer DTC
  // sites (e.g. Dr. Squatch, Creality, niche specialty stores). The
  // og:image from any Shopify store routes through here.
  'cdn.shopify.com',
  // Apple's official image CDN — covers AirPods / iPhone / Mac / etc.
  'store.storeimages.cdn-apple.com',
  // Ulta's product CDN — beauty/cosmetics
  'images.ulta.com',
  // Walgreens product CDN
  'pics.walgreens.com',
  // Sephora CDN
  'www.sephora.com',
  // CVS CDN
  'www.cvs.com',
  // Instacart product CDN (grocery stock images often only live here)
  'www.instacart.com',
  // Kohls / Macy's image CDNs
  'media.kohlsimg.com',
  'slimages.macys.com',
  // Chewy / Petco CDNs
  'image.chewy.com',
  'site.petco.com',
  // Tractor Supply
  'tractorsupply.scene7.com',
  // Best Buy alternate (pisces.bbystatic.com is already listed)
  // Manufacturer image CDNs the field actually surfaces
  'cdn-apple.com',
  // Open Food Facts has multiple sub-domains
  'world.openfoodfacts.org',
  'static.openfoodfacts.org',

  // ── 0139: BinGo legacy-manifest hosts — RESTORE TS↔DB SYNC ────────────────
  // The DB mirror is_safe_image_url() gained these in migration 0139 but this
  // TS Set was never updated in lockstep, so filterSafeImageUrls() silently
  // dropped Wayfair (+ other BinGo manifest) photos at the app/persistence
  // layer even though the DB allows them. secure.img1-fg.wfcdn.com alone backs
  // 10,586 BinGo import_rows. Hosts copied verbatim from is_safe_image_url().
  's3.amazonaws.com',
  's3.us-central-1.wasabisys.com',
  'lotting-media.assets.bidfta.com',
  'assets.wfcdn.com',                      // Wayfair assets CDN
  'secure.img1-fg.wfcdn.com',              // Wayfair product images (sharded)
  'images.quince.com',
  'cdn-tp3.mozu.com',
  'images.ctfassets.net',
  'images.barcodelookup.com',
  'assets.basspro.com',
  'img.shop.com',

  // ── 0161: image-enrichment package hosts (also mirrored in is_safe_image_url)
  'covers.openlibrary.org',                // Open Library: ISBN → book cover
  'coverartarchive.org',                   // MusicBrainz Cover Art Archive: UPC → album art

  // ── 0264: Google first-party product/image CDNs (2026-07-14) ──────────────
  // Apple's product CDN was allowlisted but Google's wasn't, so a Google Pixel
  // lot's correct Google-hosted stock photo was stripped while a wrong Apple-
  // hosted image survived. Mirrored in is_safe_image_url() via migration 0264.
  'lh3.googleusercontent.com',             // Google Store product images (Pixel/Nest/…)
  'store.google.com',                      // Google Store storefront
  'www.gstatic.com',                       // Google static product imagery
  'ssl.gstatic.com',
]);

/**
 * Returns `true` only for `https://` URLs whose hostname is on the explicit
 * allowlist. Any non-string, non-https, or unlisted-host value returns `false`.
 *
 * DB-side mirror: is_safe_image_url() in 0038_normalize_helpers.sql.
 */
export function isSafeImageUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    return ALLOWED_IMAGE_HOSTS.has(u.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Filter an array of unknown values down to only safe image URLs.
 * Order is preserved; duplicates are not removed (caller's responsibility).
 */
export function filterSafeImageUrls(urls: readonly unknown[]): string[] {
  const out: string[] = [];
  for (const u of urls) {
    if (isSafeImageUrl(u)) out.push(u);
  }
  return out;
}
