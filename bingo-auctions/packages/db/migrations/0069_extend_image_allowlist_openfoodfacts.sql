-- ============================================================================
-- 0069_extend_image_allowlist_openfoodfacts
--
-- Adds `images.openfoodfacts.org` to the SQL image allowlist used by
-- the lots_filter_photo_urls trigger (0049) via is_safe_image_url()
-- (0038/0045).
--
-- Why:
--   Sonar image enrichment (image-enrich.ts) was burning ~$0.005-0.01
--   per scan returning empty arrays for consumer goods — Sonar can't
--   reliably extract direct retailer-CDN URLs from web pages. The new
--   image-enrich-openfoodfacts module hits the free Open Food Facts
--   API (no key, no rate limit) which has ~100% coverage for typical
--   liquidation manifest items (grocery, drinks, snacks, tobacco,
--   beauty, household goods).
--
--   OFF returns URLs like
--     https://images.openfoodfacts.org/images/products/004/900/004/2566/front_en.108.400.jpg
--
--   The trigger silently strips any URL not on the allowlist, so this
--   host MUST be added or every OFF image gets stripped on persist.
--
-- Cost note:
--   Pre-0069: every scan paid Sonar ~$0.005-0.01 for empty results.
--   Post-0069: OFF hits return 3 URLs for $0; Sonar only fires on OFF
--   miss. Typical CPG scan now costs ~$0 for image enrichment.
--
-- Mirrors images.ts ALLOWED_IMAGE_HOSTS — both lists must stay in sync.
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
    -- coverage on common CPG / grocery / tobacco / beauty UPCs. Used
    -- by image-enrich-openfoodfacts.ts to fill stock images.
    'images.openfoodfacts.org'
  );
END;
$$;

COMMENT ON FUNCTION is_safe_image_url(TEXT) IS
  'TRUE for https:// URLs on the retailer CDN allowlist. Security boundary: mirror of M2 fix in normalize/images.ts ALLOWED_IMAGE_HOSTS. Keep both lists in sync. Last extended in 0069 (Open Food Facts).';
