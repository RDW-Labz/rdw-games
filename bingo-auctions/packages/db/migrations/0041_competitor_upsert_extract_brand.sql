-- ============================================================================
-- 0041_competitor_upsert_extract_brand — wire extract_brand() into
--                                        upsert_competitor_lots_batch().
--
-- Recreates the upsert RPC from 0039 with one change:
--
--   brand column now uses COALESCE(payload_brand, extract_brand(payload_title))
--
-- This means the TS importer (import-competitor-lots.js) no longer needs to
-- run any TS-side brand inference — the SQL layer does it automatically at
-- insert time, in the same transaction, at zero additional round-trip cost.
--
-- On conflict the brand field is still part of the "stable" set (not
-- overwritten), so a second run of the same file will not clobber a brand
-- that was manually corrected after the first import.
--
-- Requires: 0039_competitor_lots_batch_upsert.sql (function exists to drop)
--           0040_extract_brand.sql (extract_brand function + brand_aliases)
-- ============================================================================

-- Drop the old function signature first.
DROP FUNCTION IF EXISTS upsert_competitor_lots_batch(jsonb);

CREATE OR REPLACE FUNCTION upsert_competitor_lots_batch(p_rows JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inserted  BIGINT := 0;
  v_updated   BIGINT := 0;
BEGIN
  -- ── Bulk upsert ─────────────────────────────────────────────────────────────
  -- Identical to 0039 except the brand column now falls back to extract_brand()
  -- when the payload brand is NULL. This enriches scraper rows and CSV imports
  -- where the source didn't include a brand column.
  WITH inserted_rows AS (
    INSERT INTO competitor_lots (
      source,
      source_id,
      title,
      description,
      brand,
      model,
      upc,
      category_raw,
      category_id,
      msrp_cents,
      current_bid_cents,
      final_bid_cents,
      bid_count,
      discount_pct,
      condition,
      location,
      state,
      closes_at,
      url,
      image_urls,
      raw_json,
      first_seen_at,
      last_seen_at,
      created_at,
      updated_at
    )
    SELECT
      (r->>'source')::TEXT,
      (r->>'source_id')::TEXT,
      (r->>'title')::TEXT,
      (r->>'description')::TEXT,
      -- Brand: use the payload value when present; otherwise derive from title.
      -- normalize_brand() strips sentinel values ("N/A", "null", etc.) before
      -- COALESCE so a sentinel in the payload doesn't block extraction.
      COALESCE(
        normalize_brand(r->>'brand'),
        extract_brand(r->>'title')
      ),
      (r->>'model')::TEXT,
      (r->>'upc')::TEXT,
      (r->>'category_raw')::TEXT,
      (r->>'category_id')::UUID,
      (r->>'msrp_cents')::BIGINT,
      (r->>'current_bid_cents')::BIGINT,
      (r->>'final_bid_cents')::BIGINT,
      (r->>'bid_count')::INTEGER,
      (r->>'discount_pct')::REAL,
      (r->>'condition')::TEXT,
      (r->>'location')::TEXT,
      (r->>'state')::TEXT,
      (r->>'closes_at')::TIMESTAMPTZ,
      (r->>'url')::TEXT,
      COALESCE(
        ARRAY(SELECT jsonb_array_elements_text(r->'image_urls')),
        '{}'::TEXT[]
      ),
      r->'raw_json',
      COALESCE((r->>'first_seen_at')::TIMESTAMPTZ, now()),
      COALESCE((r->>'last_seen_at')::TIMESTAMPTZ, now()),
      COALESCE((r->>'created_at')::TIMESTAMPTZ, now()),
      COALESCE((r->>'updated_at')::TIMESTAMPTZ, now())
    FROM jsonb_array_elements(p_rows) AS r

    ON CONFLICT (source, source_id) DO UPDATE SET
      -- "Live" fields: update on every re-scrape.
      current_bid_cents  = EXCLUDED.current_bid_cents,
      final_bid_cents    = EXCLUDED.final_bid_cents,
      bid_count          = EXCLUDED.bid_count,
      discount_pct       = EXCLUDED.discount_pct,
      last_seen_at       = EXCLUDED.last_seen_at,
      raw_json           = EXCLUDED.raw_json,
      updated_at         = now()
      -- "Stable" fields intentionally NOT updated on conflict:
      --   title, description, brand, model, upc, category_raw, category_id,
      --   msrp_cents, condition, location, state, closes_at, url,
      --   image_urls, first_seen_at, created_at.
      -- This preserves any manual brand corrections made after first import.

    RETURNING (xmax = 0) AS is_insert
  )
  SELECT
    COUNT(*) FILTER (WHERE is_insert),
    COUNT(*) FILTER (WHERE NOT is_insert)
  INTO v_inserted, v_updated
  FROM inserted_rows;

  RETURN jsonb_build_object(
    'inserted', v_inserted,
    'updated',  v_updated
  );
END;
$$;

COMMENT ON FUNCTION upsert_competitor_lots_batch(JSONB) IS
  'Batch upsert for competitor_lots. Brand falls back to extract_brand(title) when payload brand is NULL. Returns {inserted, updated}. Service-role only.';

-- ── Permissions ────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION upsert_competitor_lots_batch(JSONB) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION upsert_competitor_lots_batch(JSONB) TO service_role;

-- ── Self-mark ─────────────────────────────────────────────────────────────────

INSERT INTO _schema_migrations (filename, applied_by)
VALUES ('0041_competitor_upsert_extract_brand.sql', 'manual')
ON CONFLICT (filename) DO NOTHING;
