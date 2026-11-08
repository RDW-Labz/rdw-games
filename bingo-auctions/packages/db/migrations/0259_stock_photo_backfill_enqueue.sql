-- 0259: Stock-photo backfill — enqueue enrichment jobs for recent lots that
-- have no stock photo, and finish the 0258 reorder for rehosted stock images.
--
-- Owner request 2026-07-10: "could we scrub their listings now on those to
-- help fill stock photos?" The image-enrichment drain gained a paid
-- title-based tier (enrichImages: URL-finder → egress page-fetch →
-- mirror-to-bucket → vision same-product verify) that can now serve lots
-- with only a title+brand. This migration feeds it the backlog.
--
-- Part 1 — enqueue: one image_enrichment_jobs row per lot that
--   • was created in the last 7 days (the current sale cycle),
--   • has a usable title (≥ 8 chars),
--   • is not in a terminal status,
--   • has NO stock photo (nothing outside lot-photos staff captures —
--     lot-photos/rehost/ is re-hosted STOCK, so it counts as stock).
-- ON CONFLICT resets previously skipped/failed/succeeded jobs back to
-- pending (attempts=0) so lots the old identifier-only drain dead-ended
-- on ('no_identifier') get a fresh run through the title tier. The
-- drain's own step-1 guard re-checks live state, so double-enqueueing a
-- lot that has since gained a photo is a cheap no-op skip.
--
-- Part 2 — reorder fix: 0258 treated EVERY lot-photos URL as a staff
-- capture, but photo-rehost-drain parks re-hosted stock images at
-- lot-photos/{op}/rehost/{lot}/… — those are stock and belong in front.
-- Re-run the reorder with the /rehost/-aware predicate. Idempotent.

-- ── Part 1: enqueue backfill jobs ───────────────────────────────────────────

DO $$
DECLARE
  v_enqueued integer;
BEGIN
  WITH candidates AS (
    SELECT l.id, l.operator_id
    FROM lots l
    -- BinGo only — the title tier costs real money per lookup; demo-operator
    -- lots don't need it.
    WHERE l.operator_id = '05775af4-adb7-4f0f-943e-94a91e17f60d'
      AND l.created_at > now() - interval '7 days'
      AND length(btrim(coalesce(l.title, ''))) >= 8
      -- status is the lot_status ENUM — compare as text so the empty-string
      -- coalesce and any label drift can't blow up the cast.
      AND coalesce(l.status::text, '') NOT IN ('disposed', 'canceled', 'refunded')
      AND NOT EXISTS (
        SELECT 1 FROM unnest(coalesce(l.photo_urls, '{}')) u
        WHERE u NOT LIKE '%/storage/v1/object/public/lot-photos/%'
           OR u LIKE '%/lot-photos/%/rehost/%'
      )
  ),
  upserted AS (
    INSERT INTO image_enrichment_jobs (operator_id, target_table, target_id)
    SELECT c.operator_id, 'lots', c.id
    FROM candidates c
    ON CONFLICT (target_table, target_id) DO UPDATE
      SET status = 'pending',
          attempts = 0,
          error = NULL,
          enqueued_at = now()
      WHERE image_enrichment_jobs.status IN ('skipped', 'failed', 'succeeded')
    RETURNING 1
  )
  SELECT count(*) INTO v_enqueued FROM upserted;

  RAISE NOTICE '0259: enqueued/reset % stock-photo backfill job(s)', v_enqueued;
END $$;

-- ── Part 2: rehost-aware reorder (0258 follow-up) ───────────────────────────
-- Staff capture = lot-photos URL NOT under /rehost/. Everything else
-- (retailer CDN, stock-images bucket, lot-photos/rehost/) is stock and
-- sorts first; relative order preserved within each group.

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
      AND photo_urls[1] NOT LIKE '%/lot-photos/%/rehost/%'
      AND EXISTS (
        SELECT 1 FROM unnest(photo_urls) u
        WHERE u NOT LIKE '%/storage/v1/object/public/lot-photos/%'
           OR u LIKE '%/lot-photos/%/rehost/%'
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
            (
              u LIKE '%/storage/v1/object/public/lot-photos/%'
              AND u NOT LIKE '%/lot-photos/%/rehost/%'
            ) AS is_staff
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
  RAISE NOTICE '0259: rehost-aware reorder fixed % additional lot(s)', v_updated;
END $$;
