-- migration 0264 — allow Google's first-party image CDNs
--
-- 2026-07-14: Apple's product CDN (store.storeimages.cdn-apple.com) is on the
-- image allowlist but Google's is not. A Google Pixel lot's correct Google-
-- hosted stock photo was therefore stripped at write by the lots_filter_
-- photo_urls trigger (which calls is_safe_image_url), while a wrong Apple-
-- hosted image survived. Add Google's store/product image hosts so first-party
-- Google product photos (Pixel, Nest, Chromecast, Fitbit) are storable, in
-- lockstep with ALLOWED_IMAGE_HOSTS in packages/domain-lotting/src/normalize/
-- images.ts.
--
-- This is a straight CREATE OR REPLACE of the CURRENT prod definition (dumped
-- via pg_get_functiondef) with four hosts appended — no existing host removed.

BEGIN;

CREATE OR REPLACE FUNCTION public.is_safe_image_url(p_url text)
 RETURNS boolean
 LANGUAGE plpgsql
 IMMUTABLE STRICT
 SET search_path TO 'public'
AS $function$
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
    'npwseclcxcatjhgjrtwe.supabase.co',
    -- ── Marketplaces / scrape sources ────────────────────────────────────────
    'i.ebayimg.com',
    'thumbs.ebaystatic.com',
    'pics.ebaystatic.com',
    'i.pinimg.com',
    'm.media-amazon.com',
    'images-na.ssl-images-amazon.com',
    'images-eu.ssl-images-amazon.com',
    'images-fe.ssl-images-amazon.com',
    'ecx.images-amazon.com',
    'images.thdstatic.com',
    'mobileimages.lowes.com',
    'images.lowes.com',
    'i5.walmartimages.com',
    'i1.walmartimages.com',
    'i2.walmartimages.com',
    'i3.walmartimages.com',
    'i4.walmartimages.com',
    'target.scene7.com',
    'pisces.bbystatic.com',
    'mobilecontent.costco.com',
    'static.bhphotovideo.com',
    'c1.neweggimages.com',
    -- ── Competitor auction CDNs (read-only reference data) ───────────────────
    'media.mac.bid',
    'cdn.bidfta.com',
    'images.nellisauction.com',
    -- ── Platform storage ─────────────────────────────────────────────────────
    'xgsujdzicnjenhqihovk.supabase.co',
    -- ── Open Food Facts ──────────────────────────────────────────────────────
    'images.openfoodfacts.org',
    'world.openfoodfacts.org',
    'static.openfoodfacts.org',
    -- ── 2026-05-15 stock-image overhaul ──────────────────────────────────────
    'firebasestorage.googleapis.com',
    'cdn.shopify.com',
    'store.storeimages.cdn-apple.com',
    'cdn-apple.com',
    'images.ulta.com',
    'pics.walgreens.com',
    'www.sephora.com',
    'www.cvs.com',
    'www.instacart.com',
    'media.kohlsimg.com',
    'slimages.macys.com',
    'image.chewy.com',
    'site.petco.com',
    'tractorsupply.scene7.com',
    -- ── BinGo legacy-manifest hosts ──────────────────────────────────────────
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
    -- ── Open Library + Cover Art Archive ─────────────────────────────────────
    'covers.openlibrary.org',
    'coverartarchive.org',
    -- ── 0264: Google first-party product/image CDNs (2026-07-14) ─────────────
    -- Google Store product photos (Pixel / Nest / Chromecast / Fitbit) are
    -- served from lh3.googleusercontent.com; store.google.com is the storefront
    -- host; gstatic serves Google's static product imagery.
    'lh3.googleusercontent.com',
    'store.google.com',
    'www.gstatic.com',
    'ssl.gstatic.com'
  );
END;
$function$;

COMMIT;
