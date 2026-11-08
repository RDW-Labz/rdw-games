-- ROLLBACK for 0447_builder_collected_lots.sql: drops the function. The Auction
-- Builder then shows collected items again (it fails open), as before 0447.
SET lock_timeout = '3s';
DROP FUNCTION IF EXISTS public.builder_collected_lot_ids(uuid);
