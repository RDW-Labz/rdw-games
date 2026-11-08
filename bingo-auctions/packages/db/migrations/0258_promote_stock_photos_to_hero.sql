-- 0258: One-off data repair — promote stock photos to hero on recent lots.
--
-- Staff report 2026-07-10: "today's lots put the staff-taken photo as hero
-- photo instead of stock image." Root cause was useLotCreation's background
-- photo-upload patch writing photo_urls as [staff capture, ...stock] —
-- fixed forward in the app (PR #150, staff OTA 2026-07-11 00:44 UTC), but
-- lots created before that OTA still carry the wrong order.
--
-- This migration reorders photo_urls on affected lots: all non-staff-capture
-- URLs (retailer CDN / stock-images bucket = the imported stock photos)
-- move to the front, staff captures (lot-photos bucket) follow, relative
-- order preserved within each group. Matches the "imported = primary" rule
-- from the 2026-07-08 tester recap and the ordering photo.tsx already uses.
--
-- Scope: lots created in the last 7 days whose FIRST photo is a staff
-- capture but which carry at least one stock photo. 7 days (not 24h)
-- so any pre-report stragglers from this week get the same fix; closed
-- historical lots are left alone. Idempotent: after one pass, no lot
-- matches the WHERE clause anymore (first element is no longer a
-- lot-photos URL), so a re-run updates 0 rows.

DO $$
DECLARE
  v_updated integer;
BEGIN
  WITH affected AS (
    SELECT id, photo_urls
    FROM lots
    WHERE created_at > now() - interval '7 days'
      AND array_length(photo_urls, 1) > 1
      AND photo_urls[1] LIKE '%/storage/v1/object/public/lot-photos/%'
      AND EXISTS (
        SELECT 1 FROM unnest(photo_urls) u
        WHERE u NOT LIKE '%/storage/v1/object/public/lot-photos/%'
      )
  ),
  reordered AS (
    SELECT
      a.id,
      (
        SELECT array_agg(u ORDER BY is_staff, ord)
        FROM (
          SELECT
            u,
            ord,
            (u LIKE '%/storage/v1/object/public/lot-photos/%') AS is_staff
          FROM unnest(a.photo_urls) WITH ORDINALITY AS t(u, ord)
        ) x
      ) AS new_urls
    FROM affected a
  )
  UPDATE lots l
  SET photo_urls = r.new_urls
  FROM reordered r
  WHERE l.id = r.id
    AND l.photo_urls IS DISTINCT FROM r.new_urls;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RAISE NOTICE '0258: promoted stock photos to hero on % lot(s)', v_updated;
END $$;
