-- Rollback for 0449 (bidder insights: ZIP heat, segments, cohorts).
--
-- No columns, no tables — three SECURITY DEFINER functions only. Dropping
-- them is the entire rollback; nothing to export first and no data loss.
-- Safe any hour (Rule 9): the console report 404s/needs_migration-banners
-- like every other optional RPC (same pattern as the Bidders by ZIP report),
-- nothing else in the app calls these.

BEGIN;

DROP FUNCTION IF EXISTS public.operator_bidder_zip_heat(timestamptz, timestamptz, text);
DROP FUNCTION IF EXISTS public.operator_bidder_segments();
DROP FUNCTION IF EXISTS public.operator_bidder_segments_by_zip();
DROP FUNCTION IF EXISTS public.operator_bidder_cohorts(int, text);

COMMIT;
