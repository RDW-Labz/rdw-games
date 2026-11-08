-- 0490 — lock down the leftover 0382 snapshot table
--
-- Security (issue #731, Grok 2026-11-04). Supabase's security advisor flagged
-- public._stranded_closed_auction_drafts_20260930 as critical: 215 rows of
-- lot snapshots with RLS disabled. 0382 already revoked anon/authenticated
-- grants, but a table without RLS is still one grant/default-privilege change
-- away from being readable by the anon key.
--
-- Prod read 2026-11-04 (scripts/prod-rig/0731-preflight.sql):
--   rows 215, relrowsecurity false, relforcerowsecurity false, 0 policies,
--   no dependent views, no dependent functions, grants only postgres and
--   service_role. Repo grep: nothing reads it; the only readers are the 0382
--   rollback and its one-off verify scripts.
--
-- Decision: keep the rows (they are the 0382 reversal snapshot) but make them
-- service-role-only. RLS on with no policies means anon/authenticated see and
-- change nothing even if a grant reappears. The table owner (postgres) and
-- service_role (BYPASSRLS) still reach it, so the 0382 rollback keeps working.
-- Not FORCE ROW LEVEL SECURITY: that would also block the owner running that
-- rollback. No data is deleted or moved.
--
-- Idempotent: ENABLE RLS and REVOKE are safe to re-run. No table lock beyond
-- the catalog update; 215 rows and no app reader.
-- Rollback: scripts/prod-rig/0490_ROLLBACK_stranded_drafts_rls.sql

BEGIN;
SET LOCAL lock_timeout = '3s';

ALTER TABLE public._stranded_closed_auction_drafts_20260930 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public._stranded_closed_auction_drafts_20260930 FROM PUBLIC, anon, authenticated;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class
    WHERE oid = 'public._stranded_closed_auction_drafts_20260930'::regclass
      AND relrowsecurity
  ) THEN
    RAISE EXCEPTION '0490: RLS is still disabled on the 0382 snapshot table';
  END IF;
END $$;

COMMIT;
