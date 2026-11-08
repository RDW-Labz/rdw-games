-- 0226 — upgrade Wayfair CDN photo URLs to 800px (backfill + trigger)
--
-- Owner, 2026-07-05: "some images don't show and some seem a little blurry".
-- Diagnosis: ~61% of storefront lots hotlink retail-CDN images written by
-- the AI enrichment pipeline. The Wayfair ones (142 first-image lots across
-- assets.wfcdn.com + secure.img1-fg.wfcdn.com) embed the render size in the
-- URL path — e.g. resize-h300-w300^compr-r85 — i.e. literal 300px thumbnails
-- stretched into 600-800px slots. Verified from CI (unrestricted egress):
-- rewriting to resize-h800-w800 serves the same image at 4x the data
-- (9,953 -> 39,849 bytes on the sample), same 200/image/jpeg.
--
-- Amazon m.media-amazon.com URLs are NOT touched: the ._SL800_. variant was
-- probed byte-identical to the bare key — those sources have a native-size
-- ceiling a URL can't raise.
--
--   1. normalize_photo_urls(text[]): bumps any wfcdn resize-hN-wN with
--      N < 800 up to 800 (larger sizes left alone).
--   2. BEFORE INSERT/UPDATE OF photo_urls trigger on lots so every future
--      write path (enrichment drain, imports, manual edits) is covered.
--   3. Backfill of existing rows.
--
-- Idempotent: normalizing an already-800 URL is a no-op; trigger recreated
-- via DROP IF EXISTS; backfill only rewrites rows whose value changes.

BEGIN;

CREATE OR REPLACE FUNCTION public.normalize_photo_urls(p_urls text[])
RETURNS text[]
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_out text[];
  v_url text;
BEGIN
  IF p_urls IS NULL THEN
    RETURN NULL;
  END IF;
  v_out := ARRAY[]::text[];
  FOREACH v_url IN ARRAY p_urls LOOP
    IF v_url LIKE '%wfcdn.com%' THEN
      -- resize-hN-wN with N of 1-3 digits (i.e. <= 999). Only bump when the
      -- height is under 800: 1-2 digit numbers, or 3-digit numbers starting
      -- 1-7. 800+ and 4-digit sizes are left untouched.
      v_url := regexp_replace(
        v_url,
        'resize-h([1-9][0-9]?|[1-7][0-9]{2})-w([1-9][0-9]?|[1-7][0-9]{2})',
        'resize-h800-w800'
      );
    END IF;
    v_out := array_append(v_out, v_url);
  END LOOP;
  RETURN v_out;
END;
$$;

CREATE OR REPLACE FUNCTION public.lots_normalize_photo_urls()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.photo_urls IS NOT NULL THEN
    NEW.photo_urls := public.normalize_photo_urls(NEW.photo_urls);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS lots_normalize_photo_urls ON public.lots;
CREATE TRIGGER lots_normalize_photo_urls
  BEFORE INSERT OR UPDATE OF photo_urls ON public.lots
  FOR EACH ROW
  EXECUTE FUNCTION public.lots_normalize_photo_urls();

-- Backfill: only rows whose normalized value differs (keeps the UPDATE set
-- small and the migration re-runnable).
UPDATE public.lots
SET photo_urls = public.normalize_photo_urls(photo_urls)
WHERE photo_urls IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM unnest(photo_urls) AS u
    WHERE u LIKE '%wfcdn.com%'
      AND u ~ 'resize-h([1-9][0-9]?|[1-7][0-9]{2})-w'
  );

COMMIT;
