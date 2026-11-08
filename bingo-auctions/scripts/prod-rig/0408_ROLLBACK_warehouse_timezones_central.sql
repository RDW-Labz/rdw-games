-- Rollback for 0408_warehouse_timezones_central.sql — standby only.
-- Puts the two rows back on the (wrong) America/New_York default.
BEGIN;

UPDATE public.warehouses
   SET timezone = 'America/New_York',
       updated_at = now()
 WHERE id IN ('1aebb495-6cd6-4f6d-8595-86fec7106eb4',
              '5d85d8fa-e182-4a66-9f6b-38ad5067642f')
   AND timezone = 'America/Chicago';

COMMIT;
