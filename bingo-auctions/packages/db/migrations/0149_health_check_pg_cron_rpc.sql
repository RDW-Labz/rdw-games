-- ============================================================================
-- Migration 0149: health_check_pg_cron_failures() RPC
--
-- The /api/cron/health-check route (every 5 min) needs to know how many
-- pg_cron jobs have FAILED recently, but supabase-js cannot query the `cron`
-- schema directly. Until this function exists the route returns
-- { pg_cron_check: 'rpc_missing' } and only logs a warning — i.e. a silently
-- failing pg_cron job (the 5s auction-close lifecycle, settlement sweeps, etc.)
-- would NOT page anyone. This RPC closes that gap so the health-check cron can
-- fire a Sentry exception when failures appear.
--
-- This is the function the health-check route's header comment refers to as
-- "migration 0085_health_check_rpc.sql" — that number was taken long ago; this
-- is its real home. SECURITY DEFINER + pinned search_path so the service_role
-- caller can read the cron schema without broad grants.
-- ============================================================================

CREATE OR REPLACE FUNCTION health_check_pg_cron_failures()
RETURNS integer
LANGUAGE sql
SECURITY DEFINER
SET search_path = cron, public
AS $$
  SELECT count(*)::integer
  FROM cron.job_run_details
  WHERE status = 'failed'
    AND start_time > now() - interval '15 minutes';
$$;

GRANT EXECUTE ON FUNCTION health_check_pg_cron_failures() TO service_role;
