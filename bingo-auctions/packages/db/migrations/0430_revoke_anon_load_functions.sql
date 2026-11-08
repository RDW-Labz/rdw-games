-- 0430 — take EXECUTE away from anon on the two functions 0428/0429 added.
--
-- PROPOSED number, pending Braden's OK. Not applied.
--
-- 0428/0429 revoked EXECUTE from PUBLIC, but Supabase's default privileges in
-- schema public also grant every new function to anon directly, so on prod
-- (checked 2026-10-20, read-only) anon still has EXECUTE on:
--   load_summary(uuid)                         (0429)
--   create_draft_lot(... 24 args incl p_load_id) (0428)
-- Neither leaks anything to anon today: load_summary raises 42501 without an
-- admin/manager of the load's operator (verified on prod with no identity),
-- and create_draft_lot/24 delegates to /23 which refuses a caller with no
-- operator. This makes the grants say what the functions mean: staff only.
--
-- Deliberately NOT touched: create_draft_lot /22 and /23 (pre-existing grants,
-- 0321 era; changing them is a separate decision), and the two 0428 trigger
-- functions (RETURNS trigger — not callable directly).
--
-- Locks: GRANT/REVOKE only. Any hour.
-- Rollback: scripts/prod-rig/0430_ROLLBACK_revoke_anon_load_functions.sql

BEGIN;

REVOKE EXECUTE ON FUNCTION public.load_summary(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.create_draft_lot(
  uuid, text, text, text, uuid, lot_condition, bigint, bigint, text[], text, text, text, text, text, text, text, text, text, text, text, uuid, uuid, uuid, uuid
) FROM anon;

-- Keep the intended callers explicit.
GRANT EXECUTE ON FUNCTION public.load_summary(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_draft_lot(
  uuid, text, text, text, uuid, lot_condition, bigint, bigint, text[], text, text, text, text, text, text, text, text, text, text, text, uuid, uuid, uuid, uuid
) TO authenticated, service_role;

COMMIT;
