-- Test for mig 0490: the 0382 snapshot table is service-role-only.
-- The CI database does not carry Supabase's default privileges, so first give
-- anon/authenticated/service_role the grants prod had/should keep, then apply
-- 0490, then assert. Not wrapped in a transaction: 0490 has its own BEGIN/COMMIT.
--
-- This test exercises the roles themselves, not just catalog flags (#737):
--   * anon/authenticated cannot SELECT or UPDATE while RLS is on, even after
--     SELECT/UPDATE are granted again (no policy = zero rows, zero updates);
--   * service_role (BYPASSRLS) and the table owner can still read the row;
--   * the documented rollback + a reapply keep the row and re-enable RLS.
-- A synthetic row is seeded and removed at the end; CI databases are throwaway.
\set ON_ERROR_STOP on
GRANT ALL ON public._stranded_closed_auction_drafts_20260930 TO anon, authenticated, service_role;
\i packages/db/migrations/0490_stranded_drafts_rls.sql

INSERT INTO public._stranded_closed_auction_drafts_20260930 (lot_id, target_status, row_data)
VALUES ('73737373-7373-4737-8373-737373737373', 'in_inventory', '{"test":"stranded_drafts_rls"}'::jsonb)
ON CONFLICT (lot_id) DO NOTHING;

DO $$
DECLARE v_fail TEXT := '';
BEGIN
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public._stranded_closed_auction_drafts_20260930'::regclass) THEN
    v_fail := v_fail || E'\n  RLS is disabled';
  END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = '_stranded_closed_auction_drafts_20260930') <> 0 THEN
    v_fail := v_fail || E'\n  unexpected policy on the snapshot table';
  END IF;
  IF has_table_privilege('anon', 'public._stranded_closed_auction_drafts_20260930', 'SELECT') THEN
    v_fail := v_fail || E'\n  anon can SELECT';
  END IF;
  IF has_table_privilege('anon', 'public._stranded_closed_auction_drafts_20260930', 'UPDATE') THEN
    v_fail := v_fail || E'\n  anon can UPDATE';
  END IF;
  IF has_table_privilege('authenticated', 'public._stranded_closed_auction_drafts_20260930', 'SELECT') THEN
    v_fail := v_fail || E'\n  authenticated can SELECT';
  END IF;
  IF has_table_privilege('authenticated', 'public._stranded_closed_auction_drafts_20260930', 'UPDATE') THEN
    v_fail := v_fail || E'\n  authenticated can UPDATE';
  END IF;
  IF NOT has_table_privilege('service_role', 'public._stranded_closed_auction_drafts_20260930', 'SELECT') THEN
    v_fail := v_fail || E'\n  service_role lost SELECT';
  END IF;
  IF (SELECT count(*) FROM public._stranded_closed_auction_drafts_20260930) <> 1 THEN
    v_fail := v_fail || E'\n  expected exactly the seeded snapshot row';
  END IF;
  IF v_fail <> '' THEN RAISE EXCEPTION 'stranded_drafts_rls: FAILED%', v_fail; END IF;
END
$$;

-- ── ordinary roles: no access at all after 0490's REVOKE ───────────────────
BEGIN;

SET LOCAL ROLE anon;
DO $$
DECLARE v_fail TEXT := '';
BEGIN
  BEGIN
    PERFORM 1 FROM public._stranded_closed_auction_drafts_20260930;
    v_fail := v_fail || E'\n  anon SELECT succeeded without a grant';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    UPDATE public._stranded_closed_auction_drafts_20260930 SET target_status = 'pending_intake';
    v_fail := v_fail || E'\n  anon UPDATE succeeded without a grant';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF v_fail <> '' THEN RAISE EXCEPTION 'stranded_drafts_rls anon pre-grant checks failed:%', v_fail; END IF;
END $$;
RESET ROLE;

SET LOCAL ROLE authenticated;
DO $$
DECLARE v_fail TEXT := '';
BEGIN
  BEGIN
    PERFORM 1 FROM public._stranded_closed_auction_drafts_20260930;
    v_fail := v_fail || E'\n  authenticated SELECT succeeded without a grant';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    UPDATE public._stranded_closed_auction_drafts_20260930 SET target_status = 'pending_intake';
    v_fail := v_fail || E'\n  authenticated UPDATE succeeded without a grant';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  IF v_fail <> '' THEN RAISE EXCEPTION 'stranded_drafts_rls authenticated pre-grant checks failed:%', v_fail; END IF;
END $$;
RESET ROLE;

-- ── even if a grant reappears, RLS with no policy hides and freezes rows ───
GRANT SELECT, UPDATE ON public._stranded_closed_auction_drafts_20260930 TO anon, authenticated;

SET LOCAL ROLE anon;
DO $$
DECLARE v_fail TEXT := ''; v_rows INT;
BEGIN
  SELECT count(*) INTO v_rows FROM public._stranded_closed_auction_drafts_20260930;
  IF v_rows <> 0 THEN v_fail := v_fail || format(E'\n  anon saw %s rows through RLS', v_rows); END IF;
  UPDATE public._stranded_closed_auction_drafts_20260930 SET target_status = 'pending_intake';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN v_fail := v_fail || format(E'\n  anon updated %s rows through RLS', v_rows); END IF;
  IF v_fail <> '' THEN RAISE EXCEPTION 'stranded_drafts_rls anon RLS checks failed:%', v_fail; END IF;
END $$;
RESET ROLE;

SET LOCAL ROLE authenticated;
DO $$
DECLARE v_fail TEXT := ''; v_rows INT;
BEGIN
  SELECT count(*) INTO v_rows FROM public._stranded_closed_auction_drafts_20260930;
  IF v_rows <> 0 THEN v_fail := v_fail || format(E'\n  authenticated saw %s rows through RLS', v_rows); END IF;
  UPDATE public._stranded_closed_auction_drafts_20260930 SET target_status = 'pending_intake';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN v_fail := v_fail || format(E'\n  authenticated updated %s rows through RLS', v_rows); END IF;
  IF v_fail <> '' THEN RAISE EXCEPTION 'stranded_drafts_rls authenticated RLS checks failed:%', v_fail; END IF;
END $$;
RESET ROLE;

-- service_role (BYPASSRLS) and the owner still reach the 0382 rollback data.
SET LOCAL ROLE service_role;
DO $$
DECLARE v_rows INT;
BEGIN
  SELECT count(*) INTO v_rows FROM public._stranded_closed_auction_drafts_20260930;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'stranded_drafts_rls: service_role saw % rows, want 1', v_rows; END IF;
END $$;
RESET ROLE;

DO $$
DECLARE v_rows INT;
BEGIN
  SELECT count(*) INTO v_rows FROM public._stranded_closed_auction_drafts_20260930;
  IF v_rows <> 1 THEN RAISE EXCEPTION 'stranded_drafts_rls: owner saw % rows, want 1', v_rows; END IF;
END $$;

COMMIT;

-- ── documented rollback + reapply must keep the rows and restore RLS ───────
\i scripts/prod-rig/0490_ROLLBACK_stranded_drafts_rls.sql
\i packages/db/migrations/0490_stranded_drafts_rls.sql

DO $$
DECLARE v_fail TEXT := ''; v_rows INT;
BEGIN
  SELECT count(*) INTO v_rows FROM public._stranded_closed_auction_drafts_20260930;
  IF v_rows <> 1 THEN
    v_fail := v_fail || format(E'\n  snapshot row lost across rollback/reapply (rows=%s)', v_rows);
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public._stranded_closed_auction_drafts_20260930'::regclass) THEN
    v_fail := v_fail || E'\n  RLS is off after reapply';
  END IF;
  IF has_table_privilege('anon', 'public._stranded_closed_auction_drafts_20260930', 'SELECT') THEN
    v_fail := v_fail || E'\n  anon regained SELECT after reapply';
  END IF;
  IF has_table_privilege('authenticated', 'public._stranded_closed_auction_drafts_20260930', 'SELECT') THEN
    v_fail := v_fail || E'\n  authenticated regained SELECT after reapply';
  END IF;
  IF v_fail <> '' THEN RAISE EXCEPTION 'stranded_drafts_rls rollback checks failed:%', v_fail; END IF;
  RAISE NOTICE 'stranded_drafts_rls: all checks passed';
END
$$;

DELETE FROM public._stranded_closed_auction_drafts_20260930
WHERE lot_id = '73737373-7373-4737-8373-737373737373';
