-- 0218 — is_safe_image_url: allow BinGo's OWN storage hostname
--
-- Root cause of tester round-5 "photos appear to save but vanish"
-- (2026-07-03, lots BIN-000235..238): the fork inherited ClovrBid's
-- is_safe_image_url() allowlist verbatim — it contains ClovrBid's storage
-- host (xgsujdzicnjenhqihovk.supabase.co) but NOT BinGo's
-- (npwseclcxcatjhgjrtwe.supabase.co). Camera captures upload to BinGo
-- storage fine (storage RLS is fork-correct), but the follow-up
-- lots.photo_urls UPDATE carries npwsec URLs → the CHECK constraint
-- rejects the whole write → photos exist in the bucket referencing nothing.
-- The client toast fires after the create flow has reset, so it read as
-- "saved" to staff.
--
-- CREATE OR REPLACE in place (same signature) so the CHECK constraint's
-- function OID is preserved — a rename+wrapper would leave the constraint
-- bound to the old body.
--
-- Verify after apply:
--   SELECT is_safe_image_url('https://npwseclcxcatjhgjrtwe.supabase.co/storage/v1/object/public/lot-photos/x/y.jpg');  -- true
--
-- Body below is the LIVE prod definition (pg_get_functiondef, 2026-07-03)
-- with the single host added.

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
    -- 0218: THIS project's own Supabase storage — where every staff camera
    -- capture lands. The fork inherited ClovrBid's allowlist verbatim, so
    -- BinGo's own storage host was REJECTED by the lots.photo_urls CHECK:
    -- uploads succeeded but the photo_urls write always failed (tester
    -- round-5 "photos appear to save but vanish", lots BIN-000235..238).
    -- The ClovrBid host below STAYS: fork-cloned lots + their relist
    -- children still carry those URLs through re-writes.
    'npwseclcxcatjhgjrtwe.supabase.co',
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
$function$;

COMMIT;
