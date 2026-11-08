-- ============================================================================
-- 0045_extend_image_allowlist
--
-- Extends is_safe_image_url() (originally created in 0038) with two more
-- allowlisted hosts that surfaced during the R2 photo-URL safety audit:
--
--   - xgsujdzicnjenhqihovk.supabase.co
--       Our project's Supabase Storage bucket. Quick Lot's
--       takePhotoAfterScan path uploads captured photos to lot-photos
--       and then writes the public URL onto lots.photo_urls. Without
--       allowlisting, the new persistence-layer filter from R2.1 would
--       strip those legitimately-captured photos.
--
--   - ecx.images-amazon.com
--       Legacy Amazon product image CDN. Real production data already
--       contains a small number of rows referencing this host; new
--       inserts hitting AI lookup paths can also surface it. Adding
--       so we don't strip historically-valid URLs.
--
-- TS-side mirror: packages/domain-lotting/src/normalize/images.ts
-- (ALLOWED_IMAGE_HOSTS). Updated in the same commit so SQL and TS agree.
--
-- Idempotent: CREATE OR REPLACE replaces the previous function body
-- without dropping it. Safe to re-run.
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
  -- Must start with https://
  IF p_url NOT LIKE 'https://%' THEN
    RETURN FALSE;
  END IF;

  -- Extract hostname: strip "https://", take up to the first "/" or end.
  v_host := lower(
    split_part(
      substring(p_url FROM 9),   -- strip 'https://'
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
    -- Competitor auction CDNs (scraped via competitor_lots — read-only reference data)
    'media.mac.bid',
    'cdn.bidfta.com',
    'images.nellisauction.com',
    -- 0045: BidWizOps Supabase Storage (project xgsujdzicnjenhqihovk)
    -- Used by mobile Quick Lot + Scan to store user-captured photos.
    'xgsujdzicnjenhqihovk.supabase.co'
  );
END;
$$;

COMMENT ON FUNCTION is_safe_image_url(TEXT) IS
  'TRUE for https:// URLs on the retailer CDN allowlist. Security boundary: mirror of M2 fix in normalize/images.ts ALLOWED_IMAGE_HOSTS. Keep both lists in sync. Last extended in 0045.';
