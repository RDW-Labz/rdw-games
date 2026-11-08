-- 0365 — repair the mis-mapped titles (and ASIN-in-FNSKU) of the
--        Liquidation.com manifest 21358222(Manifest).csv.
--
-- ── WHAT HAPPENED ────────────────────────────────────────────────────────────
-- The /imports/new wizard imported 13,506 rows on 2026-09-21. Two columns
-- mapped wrong:
--   • title  ← the manifest number. Every row's title is '21358222' (the
--     "Listing ID" column). The real product name is in raw_data->>'Description'
--     (present, non-empty, on all 13,506).
--   • fnsku  ← 80% got the real Amazon FNSKU (X00…), but 2,698 rows (20%) got
--     the ASIN fallback (B0…) instead. An ASIN in the fnsku slot is a false
--     scan key — the physical label carries no such barcode.
--
-- Rows are status='pending' and lot_id IS NULL (none lotted yet), so this is a
-- safe in-place rewrite with no downstream lot fallout.
--
-- ── WHAT THIS DOES ───────────────────────────────────────────────────────────
--   1. title ← left(btrim(Description), 500), only on the mis-mapped rows
--      (title = '21358222') and only where Description is non-empty (title is
--      NOT NULL, so an empty Description would violate — 0 rows are empty).
--   2. fnsku ← NULL only where it holds an ASIN (B0…). The real FNSKUs (X00…,
--      10,795 rows) are LEFT ALONE — they are the primary scan key.
--
-- ── WHAT THIS DELIBERATELY DOES NOT DO ───────────────────────────────────────
-- It does NOT re-run categorization. category_id is already 100% populated from
-- the manifest's own Amazon gl_ codes (gl_grocery→Food & Pantry, gl_shoes→Shoes,
-- …) and is mostly correct; it was resolved from category_raw, NOT the broken
-- title, so the title bug never touched it. Re-running resolve_category_id() off
-- the corrected title matches only 3,435 of 13,506 (25%) — a substring aliaser
-- on free-text names — so it would NULL ~10,000 good categories. Leaving them.
--
-- ── SCOPE / IDEMPOTENCY ──────────────────────────────────────────────────────
-- Scoped to this one import by filename, pending + unlotted rows only.
-- Re-runnable: the title clause only fires while title is still '21358222';
-- the fnsku clause only fires on remaining B0… values.

-- 1. Titles from the real Description.
UPDATE public.import_rows ir
SET title = left(btrim(ir.raw_data->>'Description'), 500)
FROM public.imports i
WHERE ir.import_id = i.id
  AND i.filename ILIKE '%21358222%'
  AND ir.status = 'pending'
  AND ir.lot_id IS NULL
  AND ir.title = '21358222'
  AND coalesce(btrim(ir.raw_data->>'Description'), '') <> '';

-- 2. Clear only the ASIN fallbacks from fnsku; keep the real X00 FNSKUs.
UPDATE public.import_rows ir
SET fnsku = NULL
FROM public.imports i
WHERE ir.import_id = i.id
  AND i.filename ILIKE '%21358222%'
  AND ir.status = 'pending'
  AND ir.lot_id IS NULL
  AND ir.fnsku LIKE 'B0%';

-- ── Verification ─────────────────────────────────────────────────────────────
DO $$
DECLARE bad_title int; asin_fnsku int;
BEGIN
  SELECT count(*) INTO bad_title
  FROM public.import_rows ir JOIN public.imports i ON i.id = ir.import_id
  WHERE i.filename ILIKE '%21358222%' AND ir.status='pending' AND ir.lot_id IS NULL
    AND ir.title = '21358222';
  SELECT count(*) INTO asin_fnsku
  FROM public.import_rows ir JOIN public.imports i ON i.id = ir.import_id
  WHERE i.filename ILIKE '%21358222%' AND ir.status='pending' AND ir.lot_id IS NULL
    AND ir.fnsku LIKE 'B0%';
  IF bad_title <> 0 THEN
    RAISE EXCEPTION '0365: % rows still titled 21358222', bad_title;
  END IF;
  IF asin_fnsku <> 0 THEN
    RAISE EXCEPTION '0365: % rows still carry an ASIN in fnsku', asin_fnsku;
  END IF;
  RAISE NOTICE '0365 verified: titles repaired, ASIN fallbacks cleared from fnsku';
END $$;
