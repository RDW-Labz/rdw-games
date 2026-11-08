-- 0366 — soft-delete the 2026-09-21 catalog-misfire lots.
--
-- ── WHAT HAPPENED ────────────────────────────────────────────────────────────
-- On 2026-09-21 QuickLot scans of the 21358222 manifest missed the manifest and
-- fell through to the catalog/web lookup, which treated Amazon FNSKUs as product
-- identifiers and auto-created lots from invented data (FNSKU X004Z9D5K5 → "New
-- Balance 574, $99.99", a handheld fan). Every lot BinGo created that day went
-- this way: none are linked to a manifest row (import_row_id IS NULL). The
-- titles look plausible, so a wrong one cannot be told from a right one by eye —
-- the whole batch is suspect and is removed so the boxes can be re-scanned
-- through the fixed FNSKU/UPC path (#353, #354).
--
-- Safe to remove: verified on prod 2026-09-21 that of these lots, 0 are in an
-- auction, 0 have bids, 0 have a winner, 0 are scheduled/live. Nothing is in
-- front of a bidder and no money has touched them.
--
-- ── WHAT THIS DOES ───────────────────────────────────────────────────────────
-- SOFT delete only (sets lots.deleted_at). The affected ids are first captured
-- into public._catalog_misfire_20260921 so the action is fully REVERSIBLE and
-- auditable — the reversal at the bottom targets exactly this set.
--
-- Scoped by fixed predicate (operator, the calendar day in Central, no manifest
-- link, no auction/bid/winner, not live/scheduled). Idempotent: re-running
-- captures nothing new (ON CONFLICT) and re-deletes nothing (deleted_at guard).
-- A size assertion refuses to run if the captured set is outside 1..600, so a
-- predicate that ever widened cannot mass-delete silently.

CREATE TABLE IF NOT EXISTS public._catalog_misfire_20260921 (
  lot_id          uuid PRIMARY KEY,
  prev_status     lot_status  NOT NULL,
  captured_at     timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public._catalog_misfire_20260921 (lot_id, prev_status)
SELECT l.id, l.status
FROM public.lots l
WHERE l.operator_id   = '05775af4-adb7-4f0f-943e-94a91e17f60d'
  AND l.import_row_id IS NULL
  AND l.created_at >= '2026-09-21 00:00:00-05'::timestamptz
  AND l.created_at <  '2026-09-22 00:00:00-05'::timestamptz
  AND l.deleted_at    IS NULL
  AND l.auction_id    IS NULL
  AND COALESCE(l.bid_count, 0) = 0
  AND l.winner_bidder_id IS NULL
  AND l.status::text NOT IN ('scheduled', 'live')
ON CONFLICT (lot_id) DO NOTHING;

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM public._catalog_misfire_20260921;
  IF n < 1 OR n > 600 THEN
    RAISE EXCEPTION '0366: captured % rows — outside expected 1..600, aborting', n;
  END IF;
END $$;

UPDATE public.lots
SET deleted_at = now()
WHERE id IN (SELECT lot_id FROM public._catalog_misfire_20260921)
  AND deleted_at IS NULL;

-- Post-condition: nothing exposed to a bidder may be in the deleted set.
DO $$
DECLARE leaked int; total int;
BEGIN
  SELECT count(*) INTO leaked
  FROM public.lots l JOIN public._catalog_misfire_20260921 m ON m.lot_id = l.id
  WHERE l.auction_id IS NOT NULL OR COALESCE(l.bid_count,0) > 0 OR l.winner_bidder_id IS NOT NULL;
  IF leaked <> 0 THEN
    RAISE EXCEPTION '0366: % deleted lots are in an auction / have bids / a winner — investigate', leaked;
  END IF;
  SELECT count(*) INTO total FROM public._catalog_misfire_20260921;
  RAISE NOTICE '0366: soft-deleted % catalog-misfire lots; reversible via _catalog_misfire_20260921', total;
END $$;

-- ── REVERSAL (run by hand if a lot must come back) ───────────────────────────
--   UPDATE public.lots SET deleted_at = NULL
--   WHERE id IN (SELECT lot_id FROM public._catalog_misfire_20260921)
--     AND deleted_at IS NOT NULL;
