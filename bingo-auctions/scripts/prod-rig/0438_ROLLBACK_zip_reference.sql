-- Rollback for 0438_zip_reference.sql — standby only.
--
-- Revert nothing in the app first: the console calls
-- operator_bidder_location_summary_by_place and falls back to 0434's
-- operator_bidder_location_summary when it is missing, and hides the city /
-- state filters and the GeoNames line. 0434's function is untouched by 0438.
--
-- Drops the GeoNames data (reloadable any time with
-- scripts/load-zip-reference.mjs --live). No personal data is lost.
-- Locks: a table nothing else references; any hour.

SET lock_timeout = '3s';

BEGIN;

DROP FUNCTION IF EXISTS public.operator_bidder_places();
DROP FUNCTION IF EXISTS public.operator_bidder_location_summary_by_place(timestamptz, timestamptz, uuid, text, text, text);
DROP TABLE IF EXISTS public.zip_reference;

COMMIT;
