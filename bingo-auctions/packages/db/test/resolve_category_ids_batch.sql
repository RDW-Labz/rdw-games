-- resolve_category_ids_batch.sql
--
-- Plain-psql assertion tests for resolve_category_ids_batch().
--
-- Why plain psql instead of pgTAP:
--   pgTAP requires a separate Postgres extension that is NOT shipped with
--   postgres:16-alpine (the CI image). Installing it requires building from
--   source or adding a custom image layer. The trade-off is not worth it for
--   the handful of RPC tests we need, so we use RAISE EXCEPTION for
--   assertions instead. Any RAISE EXCEPTION propagates an error that causes
--   psql with -v ON_ERROR_STOP=1 to exit non-zero, failing the CI step.
--
-- Scope:
--   resolve_category_ids_batch() — testable in CI because it is STABLE,
--   SECURITY DEFINER, and does NOT call auth.uid() or current_operator_id().
--   The postgres superuser in CI bypasses the REVOKE...FROM PUBLIC grant fence.
--
--   bulk_import_lots() — NOT tested here. It calls auth.uid() (line 257 of
--   0103_lot_qr_token_and_legacy_import.sql) and current_operator_id() —
--   both require a Supabase GoTrue session unavailable in CI vanilla Postgres.
--   TODO: pgTAP coverage for bulk_import_lots once a supabase-ci Docker
--         image (with GoTrue stubs) is added to the CI service config.
--
-- How to run manually (after `supabase start` or against CI postgres):
--   psql -h localhost -U postgres -v ON_ERROR_STOP=1 \
--     -f packages/db/test/resolve_category_ids_batch.sql
--
-- ---------------------------------------------------------------------------

BEGIN;

-- ---------------------------------------------------------------------------
-- Fixture: minimal categories + aliases
-- ---------------------------------------------------------------------------

-- We insert directly (not via RPC) because these tests exercise the resolver,
-- not the category management UI. Use a unique prefix to avoid collisions
-- with any seeded data.

INSERT INTO categories (id, name, slug) VALUES
  ('11111111-0000-0000-0000-000000000001'::uuid, 'Test Power Tools',  'test-power-tools'),
  ('11111111-0000-0000-0000-000000000002'::uuid, 'Test Kitchen',      'test-kitchen'),
  ('11111111-0000-0000-0000-000000000003'::uuid, 'Test Electronics',  'test-electronics')
ON CONFLICT DO NOTHING;

-- raw aliases stored lowercase (the resolver normalises input to lowercase before matching)
INSERT INTO category_aliases (category_id, raw) VALUES
  ('11111111-0000-0000-0000-000000000001'::uuid, 'power tools'),
  ('11111111-0000-0000-0000-000000000001'::uuid, 'tools'),
  ('11111111-0000-0000-0000-000000000002'::uuid, 'kitchen'),
  ('11111111-0000-0000-0000-000000000003'::uuid, 'electronics'),
  ('11111111-0000-0000-0000-000000000003'::uuid, 'tv')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- Test 1: exact alias match, case-insensitive
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_rows  RECORD;
  v_count INT := 0;
BEGIN
  FOR v_rows IN
    SELECT * FROM resolve_category_ids_batch(ARRAY['Power Tools'])
  LOOP
    v_count := v_count + 1;
    IF v_rows.input_idx <> 1 THEN
      RAISE EXCEPTION 'Test 1 FAIL: expected input_idx=1, got %', v_rows.input_idx;
    END IF;
    IF v_rows.category_id IS DISTINCT FROM '11111111-0000-0000-0000-000000000001'::uuid THEN
      RAISE EXCEPTION 'Test 1 FAIL: expected tools uuid, got %', v_rows.category_id;
    END IF;
  END LOOP;
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'Test 1 FAIL: expected 1 row, got %', v_count;
  END IF;
  RAISE NOTICE 'Test 1 PASS: exact alias match case-insensitive';
END;
$$;

-- ---------------------------------------------------------------------------
-- Test 2: longest-alias wins (power tools > tools)
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_cat UUID;
BEGIN
  SELECT category_id INTO v_cat
  FROM resolve_category_ids_batch(ARRAY['cordless power tools drill'])
  WHERE input_idx = 1;

  -- "power tools" (11 chars) > "tools" (5 chars) — should return power tools uuid
  IF v_cat IS DISTINCT FROM '11111111-0000-0000-0000-000000000001'::uuid THEN
    RAISE EXCEPTION 'Test 2 FAIL: longest alias should win. Got %', v_cat;
  END IF;
  RAISE NOTICE 'Test 2 PASS: longest-alias-wins';
END;
$$;

-- ---------------------------------------------------------------------------
-- Test 3: no match → category_id IS NULL
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_cat UUID;
BEGIN
  SELECT category_id INTO v_cat
  FROM resolve_category_ids_batch(ARRAY['zzzgibberishcategory'])
  WHERE input_idx = 1;

  IF v_cat IS NOT NULL THEN
    RAISE EXCEPTION 'Test 3 FAIL: expected NULL for unknown input, got %', v_cat;
  END IF;
  RAISE NOTICE 'Test 3 PASS: no match returns NULL';
END;
$$;

-- ---------------------------------------------------------------------------
-- Test 4: empty string input → category_id IS NULL (resolver skips empty target)
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_cat UUID;
BEGIN
  SELECT category_id INTO v_cat
  FROM resolve_category_ids_batch(ARRAY[''])
  WHERE input_idx = 1;

  IF v_cat IS NOT NULL THEN
    RAISE EXCEPTION 'Test 4 FAIL: expected NULL for empty string input, got %', v_cat;
  END IF;
  RAISE NOTICE 'Test 4 PASS: empty string input returns NULL';
END;
$$;

-- ---------------------------------------------------------------------------
-- Test 5: batch of 3 — correct ordinality preserved
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_tools     UUID;
  v_kitchen   UUID;
  v_none      UUID;
BEGIN
  SELECT category_id INTO v_tools   FROM resolve_category_ids_batch(ARRAY['power tools', 'kitchen', 'unknown99']) WHERE input_idx = 1;
  SELECT category_id INTO v_kitchen FROM resolve_category_ids_batch(ARRAY['power tools', 'kitchen', 'unknown99']) WHERE input_idx = 2;
  SELECT category_id INTO v_none    FROM resolve_category_ids_batch(ARRAY['power tools', 'kitchen', 'unknown99']) WHERE input_idx = 3;

  IF v_tools IS DISTINCT FROM '11111111-0000-0000-0000-000000000001'::uuid THEN
    RAISE EXCEPTION 'Test 5 FAIL: batch[0] tools uuid mismatch, got %', v_tools;
  END IF;
  IF v_kitchen IS DISTINCT FROM '11111111-0000-0000-0000-000000000002'::uuid THEN
    RAISE EXCEPTION 'Test 5 FAIL: batch[1] kitchen uuid mismatch, got %', v_kitchen;
  END IF;
  IF v_none IS NOT NULL THEN
    RAISE EXCEPTION 'Test 5 FAIL: batch[2] should be NULL, got %', v_none;
  END IF;
  RAISE NOTICE 'Test 5 PASS: batch ordinality preserved';
END;
$$;

-- ---------------------------------------------------------------------------
-- Test 6: row count matches input array length
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_count INT;
BEGIN
  SELECT COUNT(*) INTO v_count
  FROM resolve_category_ids_batch(ARRAY['a', 'b', 'c', 'd', 'e']);

  IF v_count <> 5 THEN
    RAISE EXCEPTION 'Test 6 FAIL: expected 5 rows for 5 inputs, got %', v_count;
  END IF;
  RAISE NOTICE 'Test 6 PASS: row count matches input array length';
END;
$$;

-- ---------------------------------------------------------------------------
-- Teardown — ROLLBACK isolates all fixture data from other tests/sessions
-- ---------------------------------------------------------------------------

ROLLBACK;
