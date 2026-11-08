-- Rollback for 0429_load_summary.sql — standby only. Drops the read-only
-- function; nothing else depends on it in the database. The /loads/[id] page
-- shows "summary not available" when the function is missing.
BEGIN;
DROP FUNCTION IF EXISTS public.load_summary(uuid);
COMMIT;
