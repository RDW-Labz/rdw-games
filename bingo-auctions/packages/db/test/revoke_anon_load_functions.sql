-- Test for mig 0430: anon cannot execute load_summary or create_draft_lot/24;
-- authenticated and service_role still can; PUBLIC still cannot.
-- The CI database may not carry Supabase's default privileges, so first grant
-- anon the way prod has it, then re-apply 0430's statements, then assert.
\set ON_ERROR_STOP on
-- Not wrapped in a transaction: 0430 has its own BEGIN/COMMIT. The CI database
-- is thrown away after the run.
GRANT EXECUTE ON FUNCTION public.load_summary(uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.create_draft_lot(uuid, text, text, text, uuid, lot_condition, bigint, bigint, text[], text, text, text, text, text, text, text, text, text, text, text, uuid, uuid, uuid, uuid) TO anon;
\i packages/db/migrations/0430_revoke_anon_load_functions.sql
DO $$
DECLARE v_fail TEXT := '';
BEGIN
  IF has_function_privilege('anon', 'public.load_summary(uuid)', 'EXECUTE') THEN v_fail := v_fail || E'\n  anon can execute load_summary'; END IF;
  IF has_function_privilege('anon', 'public.create_draft_lot(uuid, text, text, text, uuid, lot_condition, bigint, bigint, text[], text, text, text, text, text, text, text, text, text, text, text, uuid, uuid, uuid, uuid)', 'EXECUTE') THEN v_fail := v_fail || E'\n  anon can execute create_draft_lot/24'; END IF;
  IF has_function_privilege('public', 'public.load_summary(uuid)', 'EXECUTE') THEN v_fail := v_fail || E'\n  PUBLIC can execute load_summary'; END IF;
  IF NOT has_function_privilege('authenticated', 'public.load_summary(uuid)', 'EXECUTE') THEN v_fail := v_fail || E'\n  authenticated lost load_summary'; END IF;
  IF NOT has_function_privilege('authenticated', 'public.create_draft_lot(uuid, text, text, text, uuid, lot_condition, bigint, bigint, text[], text, text, text, text, text, text, text, text, text, text, text, uuid, uuid, uuid, uuid)', 'EXECUTE') THEN v_fail := v_fail || E'\n  authenticated lost create_draft_lot/24'; END IF;
  IF NOT has_function_privilege('service_role', 'public.load_summary(uuid)', 'EXECUTE') THEN v_fail := v_fail || E'\n  service_role lost load_summary'; END IF;
  IF v_fail <> '' THEN RAISE EXCEPTION 'revoke_anon_load_functions: FAILED%', v_fail; END IF;
  RAISE NOTICE 'revoke_anon_load_functions: all checks passed';
END
$$;
