-- Rollback for 0489: drop append_lot_photo_url(). Catalog lock only; no data
-- change. After this, the staff app's photo PATCH falls back to its previous
-- error path (uploaded photos stay queued until a newer build ships).
BEGIN;
SET LOCAL lock_timeout = '3s';

DROP FUNCTION IF EXISTS public.append_lot_photo_url(UUID, UUID, TEXT);

COMMIT;
