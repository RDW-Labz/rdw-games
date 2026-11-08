-- 0279_lot_attribution_and_photo_dedup.sql
--
-- Two fixes from the 2026-07-21 field-feedback batch. Both are implemented as a
-- single BEFORE INSERT OR UPDATE trigger on `lots` rather than by re-emitting
-- create_draft_lot — a trigger is lower-risk (no hand-transcription of a
-- 200-line SECURITY DEFINER RPC onto prod) AND more complete (it also covers the
-- raw `update({ photo_urls })` write paths — the enrich mirror, worklist, and
-- operator-web direct insert — that an RPC-only change would miss).
--
-- (#3) Worker Productivity showed 0 lots. The dashboard/workers report only
-- counted CSV-manifest-imported lots (lots.import_row_id), but field-mobile
-- lotting mints lots via create_draft_lot, which never set import_row_id, and
-- there was NO staff-attribution column on lots at all (verified 2026-07-21:
-- all 3,888 recent lots have import_row_id = NULL). Add lots.lotted_by and
-- stamp it with the acting user on insert. create_draft_lot is SECURITY
-- DEFINER, but auth.uid() reads the request JWT claim (session-level, not
-- affected by the definer), so inside the trigger it is the real staff caller.
-- When per-worker PIN login lands, the client can pass an explicit lotted_by
-- (the trigger only fills it when NULL); today auth.uid() = the signed-in staff.
--
-- (#5) Duplicate photos. The Amazon / web-scrape enrich merge repeats the hero
-- image URL (Amazon returns it again in additional_image_urls), and nothing
-- de-duped it at any layer (filterSafeImageUrls explicitly preserves dupes,
-- create_draft_lot passes the array through, the existing photo-url trigger only
-- drops unsafe hosts). So a lot persisted the same URL several times and it
-- rendered as multiple identical "STOCK" thumbnails. Dedup photo_urls
-- order-preserving (first occurrence wins, so the hero at index 0 stays hero) on
-- every write. There is never a valid reason to store the same URL twice.

BEGIN;

ALTER TABLE lots ADD COLUMN IF NOT EXISTS lotted_by uuid REFERENCES auth.users(id);

COMMENT ON COLUMN lots.lotted_by IS
  '0279: staff user who created this lot (auth.uid() at insert time, via trigger). '
  'Powers the Worker Productivity report. NULL for lots created before 0279 and for '
  'non-authenticated inserts (service-role backfills / manifest import).';

CREATE OR REPLACE FUNCTION public.lots_attribution_and_photo_dedup()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  -- #3: stamp the creating staff user once, on insert. COALESCE so an explicit
  -- value (e.g. a future PIN-selected worker id) is never overwritten.
  IF TG_OP = 'INSERT' AND NEW.lotted_by IS NULL THEN
    NEW.lotted_by := auth.uid();
  END IF;

  -- #5: order-preserving dedup of photo_urls (first occurrence wins). Runs on
  -- INSERT and UPDATE so it also cleans the enrich-mirror / worklist raw updates,
  -- not just create_draft_lot. Skip the no-op cases (null / 0 / 1 element).
  IF NEW.photo_urls IS NOT NULL AND array_length(NEW.photo_urls, 1) > 1 THEN
    SELECT array_agg(u ORDER BY ord)
      INTO NEW.photo_urls
      FROM (
        SELECT u, MIN(ord) AS ord
          FROM unnest(NEW.photo_urls) WITH ORDINALITY AS t(u, ord)
         GROUP BY u
      ) d;
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.lots_attribution_and_photo_dedup() IS
  '0279: BEFORE INSERT OR UPDATE on lots. Stamps lotted_by = auth.uid() on insert '
  '(Worker Productivity attribution) and order-preserving-dedups photo_urls on every '
  'write (kills duplicate STOCK thumbnails from the Amazon/scrape enrich merge).';

DROP TRIGGER IF EXISTS trg_lots_attribution_and_photo_dedup ON lots;
CREATE TRIGGER trg_lots_attribution_and_photo_dedup
  BEFORE INSERT OR UPDATE ON lots
  FOR EACH ROW
  EXECUTE FUNCTION public.lots_attribution_and_photo_dedup();

COMMIT;
