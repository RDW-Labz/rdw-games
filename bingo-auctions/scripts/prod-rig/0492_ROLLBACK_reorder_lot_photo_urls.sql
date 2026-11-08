-- Rollback for 0492: drop reorder_lot_photo_urls(). Catalog lock only; no data
-- change. After this, the staff app's Save keeps adding and removing photos but
-- cannot persist a "Make Hero" reorder until a newer build ships.
BEGIN;
SET LOCAL lock_timeout = '3s';

DROP FUNCTION IF EXISTS public.reorder_lot_photo_urls(UUID, UUID, TEXT[]);

COMMIT;
