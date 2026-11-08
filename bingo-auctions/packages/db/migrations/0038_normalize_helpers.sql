-- ============================================================================
-- 0038_normalize_helpers — DB-side normalization functions.
--
-- These SQL functions mirror the canonical TypeScript normalizers in
-- packages/domain-lotting/src/normalize/ one-to-one. Having SQL versions
-- lets bulk staging→production merges run entirely in Postgres without
-- round-tripping through the TS layer (critical for the initial 295k+
-- competitor_lots bulk load).
--
-- Every function is CREATE OR REPLACE + IMMUTABLE (or STABLE where
-- appropriate) and SECURITY INVOKER by default — no privilege escalation.
--
-- Mirror of TS module → SQL function:
--   normalize/upc.ts        → normalize_upc(text)
--   normalize/text.ts       → normalize_brand(text)
--   normalize/money.ts      → parse_dollars_to_cents(text)
--   normalize/images.ts     → is_safe_image_url(text)
-- ============================================================================

-- ── normalize_upc(text) → text ───────────────────────────────────────────────
-- Strips all non-digit characters. Returns NULL unless the result is
-- exactly 8 (UPC-E), 12 (UPC-A), 13 (EAN-13), or 14 (GTIN-14) digits.
-- Always preserves leading zeros — do NOT zero-pad or expand UPC-E.
--
-- Mirror of: packages/domain-lotting/src/normalize/upc.ts → normalizeUpc()

CREATE OR REPLACE FUNCTION normalize_upc(p_raw TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT                              -- returns NULL immediately on NULL input
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT CASE
    WHEN LENGTH(digits) IN (8, 12, 13, 14) THEN digits
    ELSE NULL
  END
  FROM (
    SELECT regexp_replace(p_raw, '[^0-9]', '', 'g') AS digits
  ) sub;
$$;

COMMENT ON FUNCTION normalize_upc(TEXT) IS
  'Strip non-digits; return only if length is 8/12/13/14. Mirror of normalize/upc.ts normalizeUpc().';

-- ── normalize_brand(text) → text ─────────────────────────────────────────────
-- Trims surrounding whitespace. Returns NULL on empty string, "null",
-- "n/a", "none", or similar sentinel values that scrapers emit.
-- Preserves display-case (does not lowercase) — use lower(normalize_brand(x))
-- for case-insensitive comparison queries.
--
-- Mirror of: packages/domain-lotting/src/normalize/text.ts → normalizeBrand()

CREATE OR REPLACE FUNCTION normalize_brand(p_raw TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT CASE
    WHEN trimmed = ''
      OR lower(trimmed) IN ('null', 'n/a', 'na', 'none', 'unknown', '-', '--', 'n.a.', 'n.a')
    THEN NULL
    ELSE trimmed
  END
  FROM (
    SELECT trim(p_raw) AS trimmed
  ) sub;
$$;

COMMENT ON FUNCTION normalize_brand(TEXT) IS
  'Trim + null-sentinel guard. Does NOT lowercase — preserve display case. Mirror of normalize/text.ts normalizeBrand().';

-- ── parse_dollars_to_cents(text) → bigint ────────────────────────────────────
-- Strips $, commas, and whitespace from a dollar-amount string and converts
-- to integer cents (×100, rounded). Returns NULL for non-numeric input,
-- negative values, or overflow.
--
-- Examples:
--   "$1,234.56" → 123456
--   "1234.56"   → 123456
--   "1234"      → 123400
--   "free"      → NULL
--   ""          → NULL
--
-- Mirror of: packages/domain-lotting/src/normalize/money.ts → parseCents()

CREATE OR REPLACE FUNCTION parse_dollars_to_cents(p_raw TEXT)
RETURNS BIGINT
LANGUAGE plpgsql
IMMUTABLE
STRICT
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_cleaned TEXT;
  v_numeric NUMERIC;
BEGIN
  v_cleaned := regexp_replace(trim(p_raw), '[$,\s]', '', 'g');
  IF v_cleaned = '' OR v_cleaned = '-' THEN
    RETURN NULL;
  END IF;

  BEGIN
    v_numeric := v_cleaned::NUMERIC;
  EXCEPTION WHEN others THEN
    RETURN NULL;
  END;

  IF v_numeric < 0 OR v_numeric > 999999999 THEN
    RETURN NULL;
  END IF;

  RETURN ROUND(v_numeric * 100)::BIGINT;
END;
$$;

COMMENT ON FUNCTION parse_dollars_to_cents(TEXT) IS
  'Strip $/, convert to integer cents. NULL on garbage/negative. Mirror of normalize/money.ts parseCents().';

-- ── is_safe_image_url(text) → boolean ────────────────────────────────────────
-- Returns TRUE only for https:// URLs whose hostname is on the explicit
-- allowlist of trusted retailer/CDN hostnames. Mirrors the security boundary
-- from security audit finding M2 (cross-tenant XSS / Referer-leak /
-- image-decoder CVE surface).
--
-- To add a new CDN: add it to the CASE list below AND to ALLOWED_IMAGE_HOSTS
-- in packages/domain-lotting/src/normalize/images.ts. Keep both lists in
-- sync — the SQL function is authoritative for bulk DB-side ingest.
--
-- Mirror of: packages/domain-lotting/src/normalize/images.ts → isSafeImageUrl()

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
    -- The Home Depot
    'images.thdstatic.com',
    -- Lowe''s
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
    'images.nellisauction.com'
  );
END;
$$;

COMMENT ON FUNCTION is_safe_image_url(TEXT) IS
  'TRUE for https:// URLs on the retailer CDN allowlist. Security boundary: mirror of M2 fix in normalize/images.ts ALLOWED_IMAGE_HOSTS. Keep both lists in sync.';

-- ── Self-mark ────────────────────────────────────────────────────────────────

INSERT INTO _schema_migrations (filename, applied_by)
VALUES ('0038_normalize_helpers.sql', 'manual')
ON CONFLICT (filename) DO NOTHING;
