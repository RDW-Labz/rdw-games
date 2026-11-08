-- Rollback for 0406_warehouse_active_and_customer_info.sql — standby only.
-- Revert operator-web / field-mobile code that reads these columns BEFORE running.
BEGIN;

ALTER TABLE public.warehouses DROP COLUMN IF EXISTS active;
ALTER TABLE public.warehouses DROP COLUMN IF EXISTS pickup_instructions;
ALTER TABLE public.warehouses DROP COLUMN IF EXISTS customer_notice;

COMMIT;
