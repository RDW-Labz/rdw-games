-- 0196_fix_find_import_row_by_scan_overload.sql
--
-- P0 (prod, applied 2026-06-06 via Management API): QuickLot manifest scans
-- silently produced bare "Quick lot — <code>" lots for EVERY Auto-detect scan.
--
-- Root cause: the 2-arg overload find_import_row_by_scan(text[], text) declared
-- p_kind with DEFAULT 'auto', which made a 1-arg invocation ambiguous against
-- the standalone 1-arg overload find_import_row_by_scan(text[]):
--   * PostgREST 1-arg call → 300 PGRST203 "could not choose the best candidate"
--   * The 2-arg 'auto' branch self-delegates via a 1-arg call → 42725
--     "function find_import_row_by_scan(text[]) is not unique"
-- The field-mobile app calls the 2-arg form with p_kind = session.scanFieldKind
-- (default 'auto'), so the RPC threw, the client catch{} swallowed it, and the
-- scan fell through to a no-match bare lot. find_import_row_by_tracking() (also
-- a 1-arg caller) was broken identically.
--
-- Fix: drop the DEFAULT so the two overloads have DISJOINT parameter sets:
--   * 1-arg call  → multi-column matcher (the prior 'auto' behaviour, unchanged)
--   * 2-arg call  → scoped matcher
-- Behaviour is identical; only the resolution ambiguity is removed. We recreate
-- the 2-arg function from its own live definition (regexp-stripping the default)
-- so the body stays byte-for-byte what 0190 shipped, then re-grant EXECUTE.
-- A RAISE EXCEPTION guard fails the migration loudly if the default survives.

DO $mig$
DECLARE
  v_def  text;
  v_args text;
BEGIN
  SELECT pg_get_functiondef('public.find_import_row_by_scan(text[],text)'::regprocedure)
    INTO v_def;

  DROP FUNCTION public.find_import_row_by_scan(text[], text);

  v_def := regexp_replace(v_def, 'p_kind\s+text\s+DEFAULT\s+''auto''::text', 'p_kind text');
  EXECUTE v_def;

  SELECT pg_get_function_arguments('public.find_import_row_by_scan(text[],text)'::regprocedure)
    INTO v_args;
  IF v_args ILIKE '%DEFAULT%' THEN
    RAISE EXCEPTION '0196: p_kind default not removed (args=%)', v_args;
  END IF;
END
$mig$;

GRANT EXECUTE ON FUNCTION public.find_import_row_by_scan(text[], text)
  TO anon, authenticated, service_role;
