-- Rollback for 0491: drop remove_lot_photo_urls(). Catalog lock only; no data
-- change. After this, the staff app's Save falls back to its previous photo
-- handling (the app keeps additions; removals need a newer build).
BEGIN;
SET LOCAL lock_timeout = '3s';

DROP FUNCTION IF EXISTS public.remove_lot_photo_urls(UUID, UUID, TEXT[]);

COMMIT;
