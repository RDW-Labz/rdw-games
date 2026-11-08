-- STANDBY ONLY, never merge into packages/db/migrations. Rollback for 0436:
-- drops fill_bidder_postal_code_if_empty. Rig-tested 2026-10-21
-- (scripts/__tests__/fill-bidder-zip-0436.test.mjs).
-- ZIPs the function already filled stay (they are the bidder's own billing ZIP);
-- each is listed in operator_audit_log, action_type 'bidder.postal_code_from_card'.
-- The operator-web card-save route ignores a missing function (PGRST202/42883),
-- so this is safe before or after reverting that code.
-- Apply: copy to packages/db/migrations/ on a never-merge standby branch, then
--   gh workflow run apply-migration.yml --ref <standby-branch> -f mode=rerun -f file=0436_ROLLBACK_fill_bidder_postal_code_from_card.sql
SET lock_timeout = '3s';
DROP FUNCTION IF EXISTS public.fill_bidder_postal_code_if_empty(uuid, text);
