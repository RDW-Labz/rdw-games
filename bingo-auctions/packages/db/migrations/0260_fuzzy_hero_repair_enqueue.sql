-- 0260: Fuzzy-hero repair — enqueue title-tier enrichment for active lots
-- whose hero photo is a low-resolution rehosted copy.
--
-- Owner report 2026-07-10: "fuzzy images on our current inventory ready to
-- put in auctions." Audit findings (prod, 2026-07-11):
--   • 4,515 active-inventory lots with photos; 3,763 heroes are rehosted
--     copies (lot-photos/…/rehost/…).
--   • 702 of those stored files are < 30 KB — thumbnail-grade. Dominant
--     origin (556) is the legacy platform's S3 bucket, where the SOURCE
--     images are small: there is no bigger copy to re-download.
--   • 700 of the 702 have usable titles.
--
-- Repair: run them through the image-enrichment drain's paid title tier
-- (URL-finder → egress page-fetch → mirror → vision same-product verify).
-- The drain's stock-photo gate would normally skip these (a fuzzy rehost
-- copy still counts as a stock photo), so the jobs carry the
-- 'fuzzy_hero_repair' marker in `error`, which the drain recognizes: the
-- gate passes while the hero is still a /rehost/ URL, and the resolved
-- stock image PREPENDS — demoting the fuzzy copy to a supplementary slot.
--
-- Idempotent: re-running re-enqueues only jobs in a terminal state whose
-- lot still has a small rehosted hero.

DO $$
DECLARE
  v_enqueued integer;
BEGIN
  WITH small_hero_lots AS (
    SELECT l.id, l.operator_id
    FROM lots l
    JOIN storage.objects o
      ON o.bucket_id = 'lot-photos'
     AND o.name = split_part(l.photo_urls[1], '/lot-photos/', 2)
    WHERE l.operator_id = '05775af4-adb7-4f0f-943e-94a91e17f60d'
      AND l.status::text NOT IN ('sold','won','relisted','disposed','canceled','refunded','archived')
      AND l.photo_urls[1] LIKE '%/rehost/%'
      AND (o.metadata->>'size')::bigint < 30000
      AND length(btrim(coalesce(l.title, ''))) >= 8
  ),
  upserted AS (
    INSERT INTO image_enrichment_jobs (operator_id, target_table, target_id, error)
    SELECT s.operator_id, 'lots', s.id, 'fuzzy_hero_repair'
    FROM small_hero_lots s
    ON CONFLICT (target_table, target_id) DO UPDATE
      SET status = 'pending',
          attempts = 0,
          error = 'fuzzy_hero_repair',
          enqueued_at = now()
      WHERE image_enrichment_jobs.status IN ('skipped', 'failed', 'succeeded')
    RETURNING 1
  )
  SELECT count(*) INTO v_enqueued FROM upserted;

  RAISE NOTICE '0260: enqueued/reset % fuzzy-hero repair job(s)', v_enqueued;
END $$;
