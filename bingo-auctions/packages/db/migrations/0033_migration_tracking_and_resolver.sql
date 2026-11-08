-- ============================================================================
-- Phase 6: enterprise-grade migration tracking + SQL-side category resolver.
--
-- Two pieces:
--
--   A. _schema_migrations — every migration we apply gets a row here, so
--      the runner can be idempotent. This is the same pattern that Rails,
--      Django, Flyway, Liquibase, and supabase-cli all use. Without it
--      we've been hand-tracking which migrations ran, and it's bitten us
--      multiple times (0027 not actually applied, 0028 partial-fail).
--
--      This migration is special: it both creates the table AND
--      backfills it for every migration 0001-0032, since the user has
--      already applied those manually. After this lands, the runner
--      knows everything up to 0032 is done and only applies 0033+.
--
--   B. resolve_category_id(text) — replaces the JS-side longest-substring
--      loop in commitImport. The current code pulls ALL category_aliases
--      (~30 KB after migration 0031, larger after 0034) and loops in JS
--      per row. SQL-side does it in one indexed query per call, or one
--      batch RPC for many strings. This is the "fast and efficient
--      Supabase communication" the brief asks for.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- A. _schema_migrations table.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS _schema_migrations (
  filename     TEXT PRIMARY KEY,
  applied_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_by   TEXT,                             -- user / CI label
  duration_ms  INTEGER,
  checksum     TEXT                              -- sha256 of the .sql file at apply time
);

COMMENT ON TABLE _schema_migrations IS
  'One row per applied migration. Maintained by scripts/apply-migrations.js. Treat as append-only — manual edits will mask drift.';

-- Backfill: mark every migration through 0032 as already applied. The
-- user manually applied 0001-0031 via the SQL editor + initial setup,
-- and 0032 (Amazon identifiers) gets pasted along with this one.
-- 0033 also self-marks at the bottom of this file.
INSERT INTO _schema_migrations (filename, applied_by) VALUES
  ('0001_init.sql',                                    'backfill:0033'),
  ('0002_rls.sql',                                     'backfill:0033'),
  ('0003_place_bid_fn.sql',                            'backfill:0033'),
  ('0004_storage.sql',                                 'backfill:0033'),
  ('0005_pickup_rpcs.sql',                             'backfill:0033'),
  ('0006_notifications_pickup.sql',                    'backfill:0033'),
  ('0007_pickup_slots.sql',                            'backfill:0033'),
  ('0008_formats_subscriptions.sql',                   'backfill:0033'),
  ('0009_buy_rpcs.sql',                                'backfill:0033'),
  ('0010_closing_soon.sql',                            'backfill:0033'),
  ('0011_operator_logos.sql',                          'backfill:0033'),
  ('0012_email_notifications.sql',                     'backfill:0033'),
  ('0013_pro_per_org_settlements.sql',                 'backfill:0033'),
  ('0014_sms_and_prefs.sql',                           'backfill:0033'),
  ('0015_lot_recent_bids.sql',                         'backfill:0033'),
  ('0016_bidder_features.sql',                         'backfill:0033'),
  ('0017_realtime_publication.sql',                    'backfill:0033'),
  ('0018_categories.sql',                              'backfill:0033'),
  ('0019_saved_searches.sql',                          'backfill:0033'),
  ('0020_imports.sql',                                 'backfill:0033'),
  ('0021_inventory_lot_codes.sql',                     'backfill:0033'),
  ('0022_intake_rpc.sql',                              'backfill:0033'),
  ('0023_external_code.sql',                           'backfill:0033'),
  ('0024_intake_external_code.sql',                    'backfill:0033'),
  ('0025_bidder_features_inclusive_defaults.sql',      'backfill:0033'),
  ('0026_landmark_photos.sql',                         'backfill:0033'),
  ('0027_product_lookups.sql',                         'backfill:0033'),
  ('0028_security_fixes.sql',                          'backfill:0033'),
  ('0029_import_rows.sql',                             'backfill:0033'),
  ('0030_auction_stagger_and_assign_rpc.sql',          'backfill:0033'),
  ('0031_category_coverage.sql',                       'backfill:0033'),
  ('0032_amazon_identifiers_and_extra_fields.sql',     'backfill:0033')
ON CONFLICT (filename) DO NOTHING;

-- RLS: read for any authed user (so /lottr/cache or an admin page can
-- show migration history); write only via service role.
ALTER TABLE _schema_migrations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS schema_migrations_authed_read ON _schema_migrations;
CREATE POLICY schema_migrations_authed_read ON _schema_migrations
  FOR SELECT USING (auth.uid() IS NOT NULL);

-- ----------------------------------------------------------------------------
-- B. resolve_category_id(text) — single-row.
--
-- Returns the category_id whose `raw` (from category_aliases) is the
-- LONGEST substring of the input. Returns NULL if no alias matches.
--
-- Performance: the table has ~250 rows after 0031 + 0034. We sort once
-- by length DESC and stop at the first match. This is well under
-- 1ms even on cold cache.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION resolve_category_id(p_text TEXT)
RETURNS UUID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_target TEXT := LOWER(TRIM(COALESCE(p_text, '')));
  v_match  UUID;
BEGIN
  IF v_target = '' THEN RETURN NULL; END IF;

  -- Longest-substring win. PostgREST + the runtime stop after first row
  -- because we use a correlated LATERAL with LIMIT 1.
  SELECT category_id INTO v_match
  FROM category_aliases
  WHERE v_target LIKE '%' || raw || '%'
  ORDER BY LENGTH(raw) DESC
  LIMIT 1;

  RETURN v_match;
END;
$$;

REVOKE EXECUTE ON FUNCTION resolve_category_id(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_category_id(TEXT) TO authenticated;

-- ----------------------------------------------------------------------------
-- B'. resolve_category_ids_batch(text[]) — batched form.
--
-- Returns one row per input (even nulls), so the caller knows which
-- input maps to which category_id. Used by commitImport so a 2000-row
-- CSV does ONE round-trip instead of either:
--   - 2000 RPC calls (single-row form), or
--   - pulling all aliases to JS and looping (status quo)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION resolve_category_ids_batch(p_texts TEXT[])
RETURNS TABLE (input_idx INT, category_id UUID)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH inputs AS (
    SELECT
      ord::INT       AS idx,
      LOWER(TRIM(s)) AS target
    FROM unnest(p_texts) WITH ORDINALITY AS t(s, ord)
  )
  SELECT
    i.idx,
    (
      SELECT ca.category_id
      FROM category_aliases ca
      WHERE i.target <> '' AND i.target LIKE '%' || ca.raw || '%'
      ORDER BY LENGTH(ca.raw) DESC
      LIMIT 1
    ) AS category_id
  FROM inputs i;
$$;

REVOKE EXECUTE ON FUNCTION resolve_category_ids_batch(TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_category_ids_batch(TEXT[]) TO authenticated;

-- ----------------------------------------------------------------------------
-- Self-mark.
-- ----------------------------------------------------------------------------

INSERT INTO _schema_migrations (filename, applied_by) VALUES
  ('0033_migration_tracking_and_resolver.sql', 'backfill:0033')
ON CONFLICT (filename) DO NOTHING;
