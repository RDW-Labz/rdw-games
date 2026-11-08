-- ============================================================================
-- packages/db/test/cron_functions_smoke.sql
--
-- CRON FUNCTION SMOKE TEST — runtime plan-error guard.
--
-- WHY THIS EXISTS
--   The `schema migrations` CI job only proves a migration APPLIES (its DDL
--   succeeds). It does NOT prove a plpgsql function RUNS: Postgres defers
--   planning of a function's embedded SQL until first execution, so a bad
--   column / table / alias reference inside a function body passes CREATE OR
--   REPLACE (and CI) but throws on the first real call.
--
--   That is exactly how mig 0182 shipped a broken auto_mark_pickup_no_show()
--   to prod (2026-06-04): it referenced `p.extended_pickup_days` (the pickups
--   alias) instead of `opp.` (operator_pro_plans). CI was green; the pg_cron
--   job then failed on every tick and only Sentry caught it, after deploy.
--
-- WHAT THIS DOES
--   Invokes EVERY pg_cron-registered command once against the freshly-migrated
--   (empty) CI database. Because planning happens on first execution, a
--   schema / alias error fires here even with zero rows. The job list is read
--   from cron.job — which the CI cron.schedule() stub now populates (see the
--   "Apply migrations" step in .github/workflows/ci.yml) — so this guard is
--   self-maintaining: any future cron.schedule(...) in a migration is covered
--   automatically, with no hand-kept list to drift.
--
-- PASS / FAIL CONTRACT
--   FAILS (RAISE EXCEPTION -> ON_ERROR_STOP halts psql -> CI red) ONLY on
--   schema / plan-class errors:
--     42703 undefined_column   42P01 undefined_table    42883 undefined_function
--     42704 undefined_object   42804 datatype_mismatch  42P02 undefined_parameter
--     42702 ambiguous_column   42725 ambiguous_function
--   TOLERATES (logs NOTICE, continues) every other error — those are
--   data-dependent behaviors on an empty DB, which this test does NOT assert.
--   Logic correctness still needs real fixture tests.
-- ============================================================================

DO $$
DECLARE
  r          record;
  v_checked  int := 0;
BEGIN
  FOR r IN
    SELECT DISTINCT jobname, command
    FROM cron.job
    WHERE command IS NOT NULL
  LOOP
    v_checked := v_checked + 1;
    BEGIN
      -- Runs in an implicit subtransaction: a caught error rolls back cleanly
      -- and the loop continues to the next job.
      EXECUTE r.command;
      RAISE NOTICE 'cron-smoke OK: % => %', COALESCE(r.jobname, '(unnamed)'), r.command;
    EXCEPTION
      WHEN undefined_column
        OR undefined_table
        OR undefined_function
        OR undefined_object
        OR datatype_mismatch
        OR undefined_parameter
        OR ambiguous_column
        OR ambiguous_function THEN
        RAISE EXCEPTION
          'cron-smoke FAIL: job "%" has a schema/plan error that would break it at runtime: % [SQLSTATE %]. Command: %',
          COALESCE(r.jobname, '(unnamed)'), SQLERRM, SQLSTATE, r.command;
      WHEN OTHERS THEN
        RAISE NOTICE
          'cron-smoke: job "%" raised a non-schema error (ignored — data-dependent on empty CI DB): % [SQLSTATE %]',
          COALESCE(r.jobname, '(unnamed)'), SQLERRM, SQLSTATE;
    END;
  END LOOP;

  -- Guard against a silent green: if cron.job is empty the cron.schedule() CI
  -- stub stopped recording jobs (regression in ci.yml) and this test would be
  -- a no-op. Fail loudly instead.
  IF v_checked = 0 THEN
    RAISE EXCEPTION
      'cron-smoke FAIL: cron.job is empty — the cron.schedule() CI stub recorded no jobs (check .github/workflows/ci.yml). Expected the lifecycle / no-show / relist jobs.';
  END IF;

  RAISE NOTICE 'cron-smoke: % cron command(s) checked, no schema/plan errors.', v_checked;
END $$;
