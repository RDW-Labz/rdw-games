-- ============================================================================
-- Migration 0161 — extend is_safe_image_url() for image-enrichment package
--
-- The new packages/image-enrichment package probes four free image sources:
--   1. Amazon ASIN probe           → images-na.ssl-images-amazon.com (already in 0139)
--   2. Open Food Facts             → images.openfoodfacts.org (already in 0069/0139)
--   3. Open Library book covers    → covers.openlibrary.org (NEW)
--   4. MusicBrainz Cover Art Arch. → coverartarchive.org (NEW)
--
-- The lots_filter_photo_urls BEFORE INSERT/UPDATE trigger strips any URL
-- not passing is_safe_image_url(), so Open Library and Cover Art Archive
-- URLs would silently vanish on persist without this migration.
--
-- Amazon and OFF were already present; only two new hosts are added here.
--
-- Approach: CREATE OR REPLACE with the full expanded list (same pattern as
-- all prior allowlist migrations). Signature + return contract unchanged.
-- ============================================================================

CREATE OR REPLACE FUNCTION is_safe_image_url(p_url TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
STRICT
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_host TEXT;
BEGIN
  IF p_url NOT LIKE 'https://%' THEN
    RETURN FALSE;
  END IF;

  v_host := lower(
    split_part(
      substring(p_url FROM 9),
      '/',
      1
    )
  );

  RETURN v_host IN (
    -- ── Marketplaces / scrape sources ────────────────────────────────────────
    -- eBay
    'i.ebayimg.com',
    'thumbs.ebaystatic.com',
    'pics.ebaystatic.com',
    -- Pinterest
    'i.pinimg.com',
    -- Amazon / AWS
    'm.media-amazon.com',
    'images-na.ssl-images-amazon.com',
    'images-eu.ssl-images-amazon.com',
    'images-fe.ssl-images-amazon.com',
    'ecx.images-amazon.com',                 -- 0045: legacy Amazon CDN
    -- The Home Depot
    'images.thdstatic.com',
    -- Lowe's
    'mobileimages.lowes.com',
    'images.lowes.com',
    -- Walmart
    'i5.walmartimages.com',
    'i1.walmartimages.com',
    'i2.walmartimages.com',
    'i3.walmartimages.com',
    'i4.walmartimages.com',
    -- Target
    'target.scene7.com',
    -- Best Buy
    'pisces.bbystatic.com',
    -- Costco
    'mobilecontent.costco.com',
    -- B&H Photo
    'static.bhphotovideo.com',
    -- Newegg
    'c1.neweggimages.com',

    -- ── Competitor auction CDNs (read-only reference data) ───────────────────
    'media.mac.bid',
    'cdn.bidfta.com',
    'images.nellisauction.com',

    -- ── Platform storage ─────────────────────────────────────────────────────
    -- 0045: BidWizOps Supabase Storage
    'xgsujdzicnjenhqihovk.supabase.co',

    -- ── Open Food Facts (0069) ────────────────────────────────────────────────
    'images.openfoodfacts.org',
    'world.openfoodfacts.org',               -- 0075: OFF i18n endpoint
    'static.openfoodfacts.org',              -- 0075: OFF static assets

    -- ── 0075: 2026-05-15 stock-image overhaul ────────────────────────────────
    'firebasestorage.googleapis.com',        -- Nellis + DTC Firebase apps
    'cdn.shopify.com',                       -- catch-all DTC stores
    'store.storeimages.cdn-apple.com',       -- Apple products
    'cdn-apple.com',                         -- Apple parent CDN
    'images.ulta.com',                       -- Ulta beauty
    'pics.walgreens.com',                    -- Walgreens pharmacy/CPG
    'www.sephora.com',                       -- Sephora
    'www.cvs.com',                           -- CVS
    'www.instacart.com',                     -- Instacart grocery
    'media.kohlsimg.com',                    -- Kohl's
    'slimages.macys.com',                    -- Macy's
    'image.chewy.com',                       -- Chewy pet supplies
    'site.petco.com',                        -- Petco
    'tractorsupply.scene7.com',              -- Tractor Supply

    -- ── 0139: BinGo legacy-manifest hosts ────────────────────────────────────
    's3.amazonaws.com',
    's3.us-central-1.wasabisys.com',
    'lotting-media.assets.bidfta.com',
    'assets.wfcdn.com',
    'secure.img1-fg.wfcdn.com',
    'images.quince.com',
    'cdn-tp3.mozu.com',
    'images.ctfassets.net',
    'images.barcodelookup.com',
    'assets.basspro.com',
    'img.shop.com',

    -- ── 0161: image-enrichment package — Open Library + Cover Art Archive ────
    -- Open Library book cover service (ISBN → cover image).
    -- Returns a 1×1 placeholder for missing covers; the package rejects
    -- those via Content-Length < 2 KB check before the URL ever reaches persist.
    'covers.openlibrary.org',
    -- MusicBrainz Cover Art Archive (UPC → music album art).
    -- Two-step lookup: MB search gives release ID → CAA front-500 HEAD.
    'coverartarchive.org'
  );
END;
$$;

COMMENT ON FUNCTION is_safe_image_url(TEXT) IS
  'TRUE for https:// URLs on the retailer-CDN allowlist. Security boundary: '
  'mirror of normalize/images.ts ALLOWED_IMAGE_HOSTS. Keep both lists in sync. '
  'Last extended in 0161 (image-enrichment: Open Library + Cover Art Archive).';

-- Verification: probe a representative URL for each new 0161 host.
DO $$
DECLARE
  v_url  TEXT;
  v_urls TEXT[] := ARRAY[
    'https://covers.openlibrary.org/b/isbn/9780306406157-L.jpg',
    'https://coverartarchive.org/release/abc-123/front-500'
  ];
BEGIN
  FOREACH v_url IN ARRAY v_urls LOOP
    IF NOT is_safe_image_url(v_url) THEN
      RAISE EXCEPTION '0161 verification failed: % was rejected by is_safe_image_url', v_url;
    END IF;
  END LOOP;
  RAISE NOTICE '0161 verified: covers.openlibrary.org and coverartarchive.org pass allowlist check';
END $$;
