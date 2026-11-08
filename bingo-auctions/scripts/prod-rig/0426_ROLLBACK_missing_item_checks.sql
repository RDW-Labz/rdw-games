-- ROLLBACK for 0426 (Missing Items). Drops only what 0426 created; no existing
-- object was changed by 0426. The check history in missing_item_checks is
-- lost — export the report CSV first if it matters. Lots written off or
-- flagged through the RPCs stay as they are (those changes were made by the
-- existing remove_lot_from_inventory / flagged_for_disposal paths).

BEGIN;
SET LOCAL lock_timeout = '3s';
DROP FUNCTION IF EXISTS public.missing_item_unsellable(uuid, text, text);
DROP FUNCTION IF EXISTS public.missing_item_confirm_missing(uuid, text);
DROP FUNCTION IF EXISTS public.missing_item_found(uuid, uuid, text);
DROP FUNCTION IF EXISTS public.missing_item_current_mark(uuid, uuid);
DROP FUNCTION IF EXISTS public.missing_items_report(boolean);
DROP FUNCTION IF EXISTS public.missing_item_found_since(uuid, timestamptz);
DROP TABLE IF EXISTS public.missing_item_checks;
COMMIT;
