-- ============================================================================
-- 0075_extend_image_allowlist_2026_05
--
-- Extends the SQL image-URL allowlist used by lots_filter_photo_urls
-- (0049) via is_safe_image_url() to mirror normalize/images.ts after
-- the 2026-05-15 stock-image overhaul (commit 9c0053f).
--
-- Why:
--   The companion commit (lottr: 80% stock-image hit rate + visible-MSRP
--   capture across pipeline) replaces the broken "ask Sonar for direct
--   image URLs" path with a URL-Finder → server-side page-fetch →
--   og:image / JSON-LD extraction pipeline. Working stock images turn
--   out to live on a much broader retailer-CDN footprint than the prior
--   allowlist covered. End-to-end smoke on 10 real intake products
--   (scripts/lottr-smoke/end-to-end-pipeline.mjs) yielded ≥1 working
--   image on 8/10 (80%); without this migration roughly half of those
--   would be dropped on persist because the new CDN hosts aren't on the
--   SQL-side allowlist.
--
-- Adds (15 new hosts):
--   firebasestorage.googleapis.com  — Nellis Auction + many DTC apps;
--                                     was already in images.ts but
--                                     missing from the SQL function
--                                     (drift between 0045 and 0049).
--   cdn.shopify.com                 — Thousands of small retailers +
--                                     manufacturer DTC stores
--                                     (Dr. Squatch, Creality, niche
--                                     specialty stores) route og:image
--                                     through here.
--   store.storeimages.cdn-apple.com — Apple's official product image
--                                     CDN. Hit on the AirPods test.
--   cdn-apple.com                   — Apple's parent CDN domain.
--   images.ulta.com                 — Ulta beauty/cosmetics
--                                     (1.4MB pages, og:image works).
--   pics.walgreens.com              — Walgreens pharmacy/CPG.
--   www.sephora.com                 — Sephora.
--   www.cvs.com                     — CVS.
--   www.instacart.com               — Grocery delivery; hosts og:image
--                                     URLs for thousands of CPG items.
--   media.kohlsimg.com              — Kohl's.
--   slimages.macys.com              — Macy's.
--   image.chewy.com                 — Chewy (pet supplies).
--   site.petco.com                  — Petco.
--   tractorsupply.scene7.com        — Tractor Supply.
--   world.openfoodfacts.org         — OFF i18n endpoint.
--   static.openfoodfacts.org        — OFF static assets endpoint.
--
-- All 15 hosts were observed in scripts/lottr-smoke/results/* serving
-- real product images for actual intake photos. The og:image values
-- come from RETAILER HTML we fetched ourselves — not from LLM
-- imagination — so the URLs that pass the upstream regex/HEAD checks
-- are real product imagery the auction listing can render.
--
-- Mirrors images.ts ALLOWED_IMAGE_HOSTS — both lists MUST stay in sync.
-- See packages/domain-lotting/src/normalize/images.ts.
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
    -- Competitor auction CDNs (read-only reference data via competitor_lots)
    'media.mac.bid',
    'cdn.bidfta.com',
    'images.nellisauction.com',
    -- 0045: BidWizOps Supabase Storage
    'xgsujdzicnjenhqihovk.supabase.co',
    -- 0069: Open Food Facts community catalog. Free, no key, ~100%
    -- coverage on common CPG / grocery / tobacco / beauty UPCs.
    'images.openfoodfacts.org',
    -- 0075: drift fix — was already in normalize/images.ts but never
    -- mirrored into SQL. Nellis Auction (+ many DTC apps that use
    -- Firebase) host product images here.
    'firebasestorage.googleapis.com',
    -- 0075: 2026-05-15 stock-image overhaul. All 15 hosts below were
    -- observed in the URL-Finder → page-fetch → og:image pipeline
    -- serving real product imagery for actual intake photos. See
    -- scripts/lottr-smoke/end-to-end-pipeline.mjs results from the
    -- 9c0053f commit for the empirical basis.
    'cdn.shopify.com',                       -- catch-all DTC stores
    'store.storeimages.cdn-apple.com',       -- Apple AirPods/iPhone/Mac
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
    'world.openfoodfacts.org',               -- OFF i18n endpoint
    'static.openfoodfacts.org'               -- OFF static assets
  );
END;
$$;

COMMENT ON FUNCTION is_safe_image_url(TEXT) IS
  'TRUE for https:// URLs on the retailer-CDN allowlist. Security boundary: mirror of M2 fix in normalize/images.ts ALLOWED_IMAGE_HOSTS. Keep both lists in sync. Last extended in 0075 (2026-05-15 stock-image overhaul: Shopify/Apple/Ulta/Walgreens/Instacart/Kohls/Macys/Chewy/Petco/TractorSupply/OFF-i18n plus Firebase Storage drift fix).';

-- ----------------------------------------------------------------------------
-- Backfill consistency check.
--
-- Existing product_lookups rows MAY have non-allowlist URLs in their
-- image_urls arrays — depending on whether the CHECK was enforced as a
-- column constraint or only as a trigger filter (it's trigger-based per
-- 0049). New rows go through lots_filter_photo_urls which calls
-- is_safe_image_url on insert/update. Old rows are unchanged on this
-- migration — they were filtered against the old allowlist at write
-- time.
--
-- We do NOT auto-clean existing rows here for two reasons:
--   1. Some rows may legitimately contain URLs that were on the
--      allowlist at write-time but have since been removed (unlikely
--      but theoretically possible — this migration only ADDS).
--   2. Re-validating every product_lookups row would lock the table
--      during migration. Cheaper to let stale rows naturally expire
--      via the cache TTL or get re-enriched on the next miss.
--
-- If you want to backfill explicitly, run:
--   UPDATE product_lookups SET image_urls = (
--     SELECT array_agg(u) FROM unnest(image_urls) AS u WHERE is_safe_image_url(u)
--   );
-- ...but it's not strictly necessary — the new hosts only matter for
-- FUTURE writes from the URL-Finder + page-fetch pipeline.
-- ----------------------------------------------------------------------------
