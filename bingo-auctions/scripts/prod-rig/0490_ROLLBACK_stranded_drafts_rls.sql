-- ROLLBACK for 0490: restore the 2026-11-04 pre-state (RLS off, no anon/auth
-- grants). This deliberately reopens the advisor finding; use only to undo the
-- lockdown while keeping the 0382 snapshot readable by the roles that had it.
BEGIN;
SET LOCAL lock_timeout = '3s';

ALTER TABLE public._stranded_closed_auction_drafts_20260930 DISABLE ROW LEVEL SECURITY;

COMMIT;
