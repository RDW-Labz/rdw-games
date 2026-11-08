-- ============================================================================
-- 0039_competitor_lots_batch_upsert — server-side batch upsert RPC.
--
-- Provides a single Postgres RPC that accepts a JSONB array of competitor_lot
-- row payloads and performs a bulk INSERT ... ON CONFLICT DO UPDATE.
--
-- Why an RPC instead of individual upserts from the TS layer:
--   At 295k rows with batches of 5 000 that's 59 round-trips.  One RPC per
--   batch means the upsert logic runs inside a single Postgres transaction
--   per batch — no partial-batch state escapes on network error, and the
--   RETURNING aggregation gives accurate inserted-vs-updated counts without
--   a second SELECT.
--
-- Idempotency:
--   Re-running with the same payload is a no-op for the content columns.
--   The conflict target is (source, source_id). On conflict, only the
--   "live" fields (bid amounts, bid_count, last_seen_at, updated_at, raw_json)
--   are updated.  Stable fields (title, msrp_cents, first_seen_at, url,
--   image_urls) are NOT overwritten on conflict.  This means:
--     - A second run of an identical file → 0 real mutations (all xmax = 0
--       after Postgres deduplication, though Postgres counts them as "updated"
--       for our purposes; see the note on xmax below).
--     - A re-scrape with fresh bid amounts → bid_count / last_seen_at / raw_json
--       update cleanly.
--
-- Return shape:
--   { "inserted": N, "updated": M }
--   Postgres does not natively distinguish insert vs update in ON CONFLICT DO
--   UPDATE.  We use the xmax trick: xmax = 0 after a pure INSERT, xmax != 0
--   after an UPDATE (it holds the old transaction XID).  This is a well-known
--   Postgres idiom and works on all versions supported by Supabase.
--
-- Permissions:
--   REVOKE from PUBLIC (blocks anon/authenticated roles from calling directly).
--   GRANT to service_role only — the scraper/importer runs with the service key.
--
-- Payload field names must match the competitor_lots column names exactly.
-- Any unknown fields in the JSONB are silently ignored.
-- ============================================================================

-- Drop the function first so we can change the signature cleanly on re-runs.
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
  -- We INSERT from jsonb_array_elements and capture xmax to distinguish inserts
  -- from updates.  xmax = '0' means the row is freshly inserted; any other
  -- value means it was found and updated.
  --
  -- Field list is explicit (no SELECT *) so unknown JSONB keys are ignored and
  -- column ordering changes in the JSON payload don't cause silent mis-mappings.
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
      (r->>'brand')::TEXT,
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
      -- image_urls: stored as TEXT[] in Postgres.
      -- The JSONB payload carries it as a JSON array of strings.
      -- ARRAY(SELECT ...) is the cleanest cast without requiring a custom type.
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
      -- "Stable" fields intentionally NOT updated:
      --   title, description, brand, model, upc, category_raw, category_id,
      --   msrp_cents, condition, location, state, closes_at, url,
      --   image_urls, first_seen_at, created_at.
      -- Rationale: these are set at first-scrape and should not be clobbered
      -- by a re-scrape that might have degraded data.  If a correction is
      -- needed, use the --reapply-only flag on the importer which forces
      -- a full SET of all fields.

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
  'Batch upsert for competitor_lots. Accepts a JSONB array of row objects. Returns {inserted, updated}. Service-role only.';

-- ── Permissions ────────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION upsert_competitor_lots_batch(JSONB) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION upsert_competitor_lots_batch(JSONB) TO service_role;

-- ── Self-mark ─────────────────────────────────────────────────────────────────

INSERT INTO _schema_migrations (filename, applied_by)
VALUES ('0039_competitor_lots_batch_upsert.sql', 'manual')
ON CONFLICT (filename) DO NOTHING;
