-- Rollback for 0394, standby only. Puts back the 0392 body (no staff check) and
-- the anon/PUBLIC grants prod had on 2026-10-06. Run AFTER re-applying
-- 0392_relot_guard_counts_in_inventory_children.sql, which restores the body.
BEGIN;
GRANT EXECUTE ON FUNCTION public.relist_lot_into_auction(uuid, uuid) TO anon;
GRANT EXECUTE ON FUNCTION public.relist_lot_into_auction(uuid, uuid, uuid) TO PUBLIC, anon;
COMMIT;
