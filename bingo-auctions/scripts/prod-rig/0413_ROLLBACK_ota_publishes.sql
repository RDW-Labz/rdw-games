-- Rollback for 0413_ota_publishes.sql — standby only.
-- Drops the OTA publish log table (health-check falls back to no publish context).

DROP TABLE IF EXISTS public.ota_publishes;
