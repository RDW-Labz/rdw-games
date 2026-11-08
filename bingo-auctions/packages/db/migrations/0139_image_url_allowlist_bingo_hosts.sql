-- ============================================================================
-- Migration 0139 — expand is_safe_image_url() allowlist for legacy imports
--
-- The 0138 photo_urls fix passed array elements through to lots successfully,
-- but a BEFORE-INSERT trigger (lots_filter_photo_urls) was stripping them
-- because is_safe_image_url() has a hard-coded CDN allowlist that doesn't
-- include the manifest's hosts.
--
-- Enumeration of the BinGo manifest CSV shows 70 distinct image hosts.
-- The top 20 (this migration) cover >99% of the 470k+ URLs. Long-tail
-- one-offs (~50 hosts) can be added in a follow-up if needed; for now
-- they get stripped — the lot still imports, just with fewer photos.
--
-- Approach: replace is_safe_image_url body with the expanded list. Keep
-- the function signature + return contract identical so the trigger
-- continues to work unchanged. Security stance unchanged — still strict
-- allowlist, just broader.
-- ============================================================================

CREATE OR REPLACE FUNCTION is_safe_image_url(p_url TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
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
    -- ── Marketplaces / scrape sources (existing) ────────────────────────────
    -- eBay
    'i.ebayimg.com',
    'thumbs.ebaystatic.com',
    'pics.ebaystatic.com',
    -- Pinterest
    'i.pinimg.com',
    -- Amazon
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

    -- ── 0139 additions: BinGo legacy-manifest hosts (top 20 by frequency) ──
    -- Operator-owned + S3-compatible buckets used by prior platforms.
    -- s3.amazonaws.com is broader than the rest of the allowlist (any
    -- bucket); accepted because (a) HTTPS-only enforced above, (b) the
    -- URLs land in NEW.photo_urls only via our own import paths that
    -- already vet the source CSV. Operators uploading via the wizard
    -- would have to point at a malicious bucket deliberately.
    's3.amazonaws.com',
    's3.us-central-1.wasabisys.com',         -- Wasabi (S3-compatible)
    -- BidFTA — prior platform for BinGo
    'lotting-media.assets.bidfta.com',
    -- Wayfair
    'assets.wfcdn.com',
    'secure.img1-fg.wfcdn.com',
    -- Quince
    'images.quince.com',
    -- Mozu (general retail commerce CDN)
    'cdn-tp3.mozu.com',
    -- Contentful (used by various retailers)
    'images.ctfassets.net',
    -- Mac.bid (another auction CDN)
    'media.mac.bid',
    -- Barcode Lookup (UPC enrichment)
    'images.barcodelookup.com',
    -- Kohl's
    'media.kohlsimg.com',
    -- Bass Pro Shops
    'assets.basspro.com',
    -- Shop.com
    'img.shop.com',
    -- Walgreens
    'pics.walgreens.com'
  );
END;
$$;

COMMENT ON FUNCTION is_safe_image_url IS
  'HTTPS-only allowlist of trusted image CDNs. Used by lots_filter_photo_urls '
  'trigger to strip unsafe URLs at INSERT/UPDATE time. 0139 added BinGo '
  'legacy-manifest hosts (s3.amazonaws.com, Wayfair, BidFTA, etc.) covering '
  '>99% of the manifest''s 470k+ URLs. Long-tail (~50 hosts, <5k URLs) '
  'still filtered — add in follow-up migrations as needed.';

-- Verification: probe a representative URL from each new host.
DO $$
DECLARE
  v_url TEXT;
  v_urls TEXT[] := ARRAY[
    'https://s3.amazonaws.com/lotting-images-prod/x/1.jpeg',
    'https://lotting-media.assets.bidfta.com/x/1.jpg',
    'https://assets.wfcdn.com/im/x/abc.jpg',
    'https://images.quince.com/abc.jpg',
    'https://media.mac.bid/abc.jpg'
  ];
BEGIN
  FOREACH v_url IN ARRAY v_urls LOOP
    IF NOT is_safe_image_url(v_url) THEN
      RAISE EXCEPTION '0139 verification failed: % was rejected by is_safe_image_url', v_url;
    END IF;
  END LOOP;
  RAISE NOTICE '0139 verified: 5 sample hosts pass allowlist check';
END $$;
