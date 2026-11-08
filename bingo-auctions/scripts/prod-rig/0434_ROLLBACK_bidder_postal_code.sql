-- Rollback for 0434_bidder_postal_code.sql — standby only.
--
-- Revert the app first (or make sure the ZIP prompt build is not live): the app
-- fails soft when the RPCs/columns are missing (prompt hidden, profile ZIP
-- field shows nothing), but there is no reason to leave it calling them.
--
-- DESTRUCTIVE: dropping the columns deletes every ZIP bidders have given us.
-- Export first if they should be kept:
--   SELECT id, postal_code, postal_code_updated_at FROM public.bidders
--    WHERE postal_code IS NOT NULL;
--
-- Locks: DROP COLUMN / DROP TRIGGER take a brief ACCESS EXCLUSIVE on bidders
-- (metadata-only, no rewrite). Window: 05:00–07:00 CT, or any hour if 0434 is
-- actively breaking bidder writes.

SET lock_timeout = '3s';

BEGIN;

DROP FUNCTION IF EXISTS public.operator_bidder_zip_coverage();
DROP FUNCTION IF EXISTS public.operator_bidder_location_summary(timestamptz, timestamptz, uuid, text);
DROP FUNCTION IF EXISTS public.snooze_my_postal_code_prompt();
DROP FUNCTION IF EXISTS public.set_my_postal_code(text);

DROP TRIGGER IF EXISTS bidders_postal_code_guard ON public.bidders;
DROP FUNCTION IF EXISTS public._bidders_postal_code_guard();

ALTER TABLE public.bidders
  DROP CONSTRAINT IF EXISTS bidders_postal_code_format,
  DROP COLUMN IF EXISTS postal_code_prompt_after,
  DROP COLUMN IF EXISTS postal_code_prompt_count,
  DROP COLUMN IF EXISTS postal_code_updated_at,
  DROP COLUMN IF EXISTS postal_code;

COMMIT;
