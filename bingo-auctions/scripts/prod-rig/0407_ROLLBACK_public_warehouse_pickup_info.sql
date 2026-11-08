-- Rollback for 0407_public_warehouse_pickup_info.sql — standby only.
-- Revert bidder-app / operator-web off-site pickup UI first, or leave it —
-- fetchWarehousePickup returns null when the RPC is missing.
BEGIN;

DROP FUNCTION IF EXISTS public.public_warehouse_pickup_info(uuid);

COMMIT;
