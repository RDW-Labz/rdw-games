-- ============================================================================
-- Migration 0408 — Dodge City and Springdale run on Central time
--
-- Both rows were created with the column default, America/New_York
-- (0001_init.sql). Dodge City, KS (Ford County) and Springdale, AR are both
-- Central. Read from prod 2026-10-12:
--
--   Dodge City  1aebb495-6cd6-4f6d-8595-86fec7106eb4  KS  America/New_York  2 auctions, 4 lots
--   Springdale  5d85d8fa-e182-4a66-9f6b-38ad5067642f  AR  America/New_York  0 auctions, 0 lots
--
-- Effect: times shown for these two warehouses (auction ends, pickup by,
-- pickup hours on passes) render one hour earlier than before, which is the
-- correct local time. Stored timestamps do not change. Harrison is already
-- America/Chicago and is not touched.
--
-- Data only. Guarded on the current value, so a re-run or a row someone has
-- already fixed is a no-op. The column default is left alone (separate change).
-- ============================================================================

BEGIN;

UPDATE public.warehouses
   SET timezone = 'America/Chicago',
       updated_at = now()
 WHERE id IN ('1aebb495-6cd6-4f6d-8595-86fec7106eb4',  -- Dodge City, KS
              '5d85d8fa-e182-4a66-9f6b-38ad5067642f')  -- Springdale, AR
   AND timezone = 'America/New_York';

COMMIT;
