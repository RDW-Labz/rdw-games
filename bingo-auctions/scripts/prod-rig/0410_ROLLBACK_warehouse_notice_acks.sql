-- Rollback for 0410_warehouse_notice_acks.sql — standby only.
-- Revert off-site notice gate UI first, or leave it — gate helpers fail open
-- when these RPCs are missing.
BEGIN;

DROP FUNCTION IF EXISTS public.has_acked_warehouse_notice(uuid);
DROP FUNCTION IF EXISTS public.ack_warehouse_notice(uuid);
DROP TABLE IF EXISTS public.warehouse_notice_acks;

COMMIT;
