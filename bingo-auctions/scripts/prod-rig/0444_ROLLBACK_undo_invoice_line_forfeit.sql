-- ROLLBACK for 0444_undo_invoice_line_forfeit.sql. Drops the function; the
-- console's Undo forfeit button then gets an error and changes nothing.
--
-- Lines already un-forfeited through it stay as they are. To put one back,
-- read its audit row (action_type 'invoice_line.forfeit_undone', target_id =
-- invoice id) and restore before_state.forfeited_at on the line and
-- before_state.lot_status on the lot, by hand, only if the line has not since
-- been refunded or picked up.

SET lock_timeout = '3s';

DROP FUNCTION IF EXISTS public.undo_invoice_line_forfeit(uuid, uuid, text, text, text);
