-- min_bid_increment_cents.sql
--
-- Plain-psql assertion tests for public.min_bid_increment_cents(current_cents,
-- schedule) — the schedule-aware bid-increment ladder shipped in
-- 0194_configurable_bid_increments.sql (BID-3).
--
-- These EXACTLY mirror the TypeScript cases in
--   packages/shared/src/bidding.test.ts
-- (LEGACY_CASES + SCHEDULE_CASES). The same expected numbers appear in BOTH so
-- the SQL function and its client mirror can be cross-checked. If you change a
-- boundary or a step here, change it there too (and vice versa).
--
-- Why plain psql instead of pgTAP:
--   pgTAP requires a separate Postgres extension NOT shipped with
--   postgres:16-alpine (the CI image). We use RAISE EXCEPTION for assertions
--   instead — any RAISE EXCEPTION propagates an error that makes psql with
--   -v ON_ERROR_STOP=1 exit non-zero, failing the CI step.
--
-- Why this RPC is testable in plain CI Postgres:
--   min_bid_increment_cents() is LANGUAGE sql IMMUTABLE, does NOT call
--   auth.uid() / current_operator_id(), and touches NO tables (the schedule is
--   an argument). So it runs against vanilla Postgres with no Supabase stack
--   and no fixtures.
--
-- How to run manually (after `supabase start` or against CI postgres):
--   psql -h localhost -U postgres -v ON_ERROR_STOP=1 \
--     -f packages/db/test/min_bid_increment_cents.sql
--
-- ---------------------------------------------------------------------------

BEGIN;

-- ---------------------------------------------------------------------------
-- Test 1 — (a) NULL schedule → LEGACY LADDER (verbatim back-compat).
--   null/<500→100, <2500→100, <10000→200, <25000→500, <100000→1000,
--   <500000→2500, else→5000.
-- Mirrors bidding.test.ts LEGACY_CASES exactly.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  -- {current_cents, expected_step}. -1 in col 1 is a sentinel for SQL NULL.
  cases   BIGINT[][] := ARRAY[
    ARRAY[-1::BIGINT, 100],   -- NULL current
    ARRAY[100,    100],
    ARRAY[600,    100],
    ARRAY[3000,   200],
    ARRAY[12000,  500],
    ARRAY[30000,  1000],
    ARRAY[150000, 2500],
    ARRAY[600000, 5000]
  ];
  i       INT;
  v_cur   BIGINT;
  v_exp   BIGINT;
  v_got   BIGINT;
BEGIN
  FOR i IN 1 .. array_length(cases, 1) LOOP
    v_cur := cases[i][1];
    v_exp := cases[i][2];
    IF v_cur = -1 THEN v_cur := NULL; END IF;

    -- 1-arg signature (DEFAULT NULL schedule) — proves the legacy call still works.
    v_got := min_bid_increment_cents(v_cur);
    IF v_got IS DISTINCT FROM v_exp THEN
      RAISE EXCEPTION 'Test 1 FAIL (1-arg): current=% expected=% got=%',
        COALESCE(v_cur::text, 'NULL'), v_exp, v_got;
    END IF;

    -- explicit NULL schedule — same result.
    v_got := min_bid_increment_cents(v_cur, NULL);
    IF v_got IS DISTINCT FROM v_exp THEN
      RAISE EXCEPTION 'Test 1 FAIL (NULL sched): current=% expected=% got=%',
        COALESCE(v_cur::text, 'NULL'), v_exp, v_got;
    END IF;
  END LOOP;
  RAISE NOTICE 'Test 1 PASS: NULL schedule returns the legacy ladder';
END;
$$;

-- ---------------------------------------------------------------------------
-- Test 2 — (b) sample tiered schedule. Greatest min_cents <= current wins.
--   schedule = [{0,50},{1000,100},{2000,500},{10000,1000}]
-- Mirrors bidding.test.ts SCHEDULE_CASES exactly.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  sched   JSONB := '[
    {"min_cents": 0,     "step_cents": 50},
    {"min_cents": 1000,  "step_cents": 100},
    {"min_cents": 2000,  "step_cents": 500},
    {"min_cents": 10000, "step_cents": 1000}
  ]'::jsonb;
  cases   BIGINT[][] := ARRAY[
    ARRAY[0::BIGINT, 50],
    ARRAY[999,    50],
    ARRAY[1000,   100],
    ARRAY[1999,   100],
    ARRAY[2000,   500],
    ARRAY[9999,   500],
    ARRAY[10000,  1000],
    ARRAY[50000,  1000]
  ];
  i       INT;
  v_cur   BIGINT;
  v_exp   BIGINT;
  v_got   BIGINT;
BEGIN
  FOR i IN 1 .. array_length(cases, 1) LOOP
    v_cur := cases[i][1];
    v_exp := cases[i][2];
    v_got := min_bid_increment_cents(v_cur, sched);
    IF v_got IS DISTINCT FROM v_exp THEN
      RAISE EXCEPTION 'Test 2 FAIL: current=% expected=% got=%', v_cur, v_exp, v_got;
    END IF;
  END LOOP;
  RAISE NOTICE 'Test 2 PASS: sample tiered schedule resolves greatest-min-wins';
END;
$$;

-- ---------------------------------------------------------------------------
-- Test 3 — (c) empty array → LEGACY LADDER (same as NULL).
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  cases   BIGINT[][] := ARRAY[
    ARRAY[-1::BIGINT, 100],   -- NULL current
    ARRAY[100,    100],
    ARRAY[600,    100],
    ARRAY[3000,   200],
    ARRAY[12000,  500],
    ARRAY[30000,  1000],
    ARRAY[150000, 2500],
    ARRAY[600000, 5000]
  ];
  i       INT;
  v_cur   BIGINT;
  v_exp   BIGINT;
  v_got   BIGINT;
BEGIN
  FOR i IN 1 .. array_length(cases, 1) LOOP
    v_cur := cases[i][1];
    v_exp := cases[i][2];
    IF v_cur = -1 THEN v_cur := NULL; END IF;
    v_got := min_bid_increment_cents(v_cur, '[]'::jsonb);
    IF v_got IS DISTINCT FROM v_exp THEN
      RAISE EXCEPTION 'Test 3 FAIL (empty array): current=% expected=% got=%',
        COALESCE(v_cur::text, 'NULL'), v_exp, v_got;
    END IF;
  END LOOP;
  RAISE NOTICE 'Test 3 PASS: empty array returns the legacy ladder';
END;
$$;

-- ---------------------------------------------------------------------------
-- Test 4 — schedule whose lowest tier floor is ABOVE current → legacy ladder.
--   current=600 is below the only tier's min_cents=1000 → no tier matches →
--   legacy ladder (600 < 2500 → 100). Matches the TS "above-only" case.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_got BIGINT;
BEGIN
  v_got := min_bid_increment_cents(600, '[{"min_cents": 1000, "step_cents": 999}]'::jsonb);
  IF v_got IS DISTINCT FROM 100 THEN
    RAISE EXCEPTION 'Test 4 FAIL: above-only tier should fall back to ladder=100, got %', v_got;
  END IF;
  RAISE NOTICE 'Test 4 PASS: no-matching-tier falls back to the legacy ladder';
END;
$$;

-- ---------------------------------------------------------------------------
-- Test 5 — IMMUTABLE preserved. A literal-arg call must be foldable; we assert
-- the function is marked IMMUTABLE in the catalog (provolatile = 'i').
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_volatile "char";
BEGIN
  SELECT provolatile INTO v_volatile
  FROM pg_proc
  WHERE proname = 'min_bid_increment_cents'
    AND pronamespace = 'public'::regnamespace
    AND pronargs = 2;
  IF v_volatile IS DISTINCT FROM 'i' THEN
    RAISE EXCEPTION 'Test 5 FAIL: min_bid_increment_cents must be IMMUTABLE (provolatile=i), got %', v_volatile;
  END IF;
  RAISE NOTICE 'Test 5 PASS: min_bid_increment_cents is IMMUTABLE';
END;
$$;

-- ---------------------------------------------------------------------------
-- Teardown — ROLLBACK isolates everything (we only read; nothing to clean up).
-- ---------------------------------------------------------------------------

ROLLBACK;
