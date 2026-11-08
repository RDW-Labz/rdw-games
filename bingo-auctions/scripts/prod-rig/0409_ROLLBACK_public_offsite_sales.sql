-- Rollback for 0409_public_offsite_sales.sql — standby only.
-- Revert operator-web / bidder-app code that calls public_offsite_sales() BEFORE running.
BEGIN;

DROP FUNCTION IF EXISTS public.public_offsite_sales();

COMMIT;
