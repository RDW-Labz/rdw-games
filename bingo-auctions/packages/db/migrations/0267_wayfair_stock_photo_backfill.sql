-- ============================================================================
-- Migration 0267 — stock-photo backfill for ALL auction-eligible inventory
--
-- Owner request 2026-07-15: "only enrich our inventory that we can put into an
-- auction ... all new created lots should have better stock photos after new
-- enrichment process." The image-enrichment drain now has TWO paid tiers that
-- can serve a lot with no ASIN/UPC:
--   • Wayfair-SKU tier — SiteSKU/ProductSKU → wayfair.com PDP (accurate for
--     furniture), and
--   • title tier — URL-finder → page-fetch → vision-verify (general goods).
-- mig 0259 only enqueued lots created in the last 7 days. This migration feeds
-- the drain the rest of the CURRENT auction-eligible backlog so existing
-- listings get stock photos too.
--
-- SCOPE (deliberately bounded — the paid tiers cost real money per lookup):
--   • BinGo operator only.
--   • Auction-eligible statuses ONLY — inventory that can still go into (or is
--     in) an auction: draft, pending_intake, in_inventory, relisted, unsold,
--     scheduled, live. Terminal/settled lots (won, canceled, disposed) are
--     excluded — no point paying to enrich something a bidder already owns or
--     that's been thrown away.
--   • Usable title (≥ 8 chars) OR a Wayfair SKU — otherwise no tier can act.
--   • NO stock photo (nothing outside lot-photos staff captures; lot-photos/
--     rehost/ counts as stock). Same predicate as 0259.
--
-- COST: the drain caps paid lookups per tick (4 title + 6 Wayfair at a
-- 1-minute cadence), so this drains gradually over hours, not in a burst, and
-- costs $0 once the queue empties. The drain's own step-1 guard re-checks live
-- state, so re-enqueueing a lot that has since gained a photo is a cheap skip.
--
-- ON CONFLICT resets previously skipped/failed/succeeded jobs back to pending
-- (attempts=0) so lots the identifier-only drain dead-ended on
-- ('no_identifier') — including every photo-less Wayfair lot — get a fresh run
-- through the new Wayfair-SKU + title tiers.
-- ============================================================================

DO $$
DECLARE
  v_enqueued integer;
BEGIN
  WITH candidates AS (
    SELECT l.id, l.operator_id
    FROM lots l
    WHERE l.operator_id = '05775af4-adb7-4f0f-943e-94a91e17f60d'
      AND coalesce(l.status::text, '') IN (
        'draft', 'pending_intake', 'in_inventory',
        'relisted', 'unsold', 'scheduled', 'live'
      )
      -- Something a tier can act on: a usable title (title tier) or a Wayfair
      -- SKU (Wayfair-SKU tier).
      AND (
        length(btrim(coalesce(l.title, ''))) >= 8
        OR coalesce(l.site_sku, '') <> ''
        OR coalesce(l.product_sku, '') <> ''
      )
      -- No stock photo: every photo_url is a staff camera capture (lot-photos
      -- but NOT the /rehost/ re-hosted-stock subtree).
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

  RAISE NOTICE '0267: enqueued/reset % auction-eligible stock-photo backfill job(s)', v_enqueued;
END $$;
