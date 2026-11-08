-- 0419 backfill: re-point lots.category_id at the category their text resolves to.
--
-- Before 0419, editing lots.category left the old category_id in place, so
-- the bidder browse filter (keys on category_id) kept the lot under its old
-- category. 0419 fixes new edits; this fixes rows already stale.
--
-- Scope: lots whose category text resolves (resolve_lot_category_id, mig 0220)
-- to a category AND whose category_id differs from it. Lots whose text does
-- not resolve are left alone (their id may come from the Quick Lot picker or
-- the lot-categorize cron and is not tied to the text).
--
-- Writes category_id only, so the 0220/0419 trigger (UPDATE OF category)
-- does not fire. Row locks only, no table lock; still takes the row lock a
-- bid on that lot needs, so run it 05:00–07:00 CT (Rule 9), never 18–22.
--
-- WRITTEN, NOT RUN. Steps:
--   1. Run section 1 (read-only preview). Check the count matches the PR note.
--   2. Run section 2. It aborts if the row count moved by more than the
--      guard below; edit the guard to the preview count before running.
--   3. Re-run section 1: expect 0 rows.

-- ── 1. Preview (read-only) ────────────────────────────────────────────────
-- Resolve each DISTINCT text once: resolving per row timed out on prod
-- (2026-10-14, Management API statement timeout); MATERIALIZED keeps the
-- planner from inlining the CTE and re-running the resolver per row.
WITH d AS (
  SELECT DISTINCT l.category
  FROM public.lots l
  WHERE l.category IS NOT NULL
    AND btrim(l.category) <> ''
), m AS MATERIALIZED (
  SELECT d.category, public.resolve_lot_category_id(d.category) AS resolved
  FROM d
), r AS (
  SELECT l.id, l.lot_code, l.status, l.category, l.category_id, m.resolved
  FROM public.lots l
  JOIN m ON m.category = l.category
)
SELECT r.id, r.lot_code, r.status, r.category,
       old_c.slug AS old_slug, new_c.slug AS new_slug
FROM r
LEFT JOIN public.categories old_c ON old_c.id = r.category_id
LEFT JOIN public.categories new_c ON new_c.id = r.resolved
WHERE r.resolved IS NOT NULL
  AND r.category_id IS DISTINCT FROM r.resolved
ORDER BY (r.status = 'live') DESC, r.lot_code;

-- ── 2. Apply (transaction) ────────────────────────────────────────────────
BEGIN;

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '180s';

CREATE TEMP TABLE _0419_text ON COMMIT DROP AS
SELECT d.category, public.resolve_lot_category_id(d.category) AS resolved
FROM (
  SELECT DISTINCT l.category
  FROM public.lots l
  WHERE l.category IS NOT NULL
    AND btrim(l.category) <> ''
) d;

CREATE TEMP TABLE _0419_fix ON COMMIT DROP AS
SELECT l.id, l.category_id AS old_category_id, t.resolved AS new_category_id
FROM public.lots l
JOIN _0419_text t ON t.category = l.category;

DELETE FROM _0419_fix
WHERE new_category_id IS NULL
   OR old_category_id IS NOT DISTINCT FROM new_category_id;

DO $$
DECLARE
  v_n int;
  v_max int := 80;  -- preview 2026-10-14: 56 rows (1 live). Re-check before running.
BEGIN
  SELECT count(*) INTO v_n FROM _0419_fix;
  RAISE NOTICE '0419 backfill: % lots to re-point', v_n;
  IF v_n > v_max THEN
    RAISE EXCEPTION '0419 backfill: % rows exceeds guard %; re-run the preview', v_n, v_max;
  END IF;
END $$;

-- Before-image for the record (copy the output into the PR / ops log).
SELECT id, old_category_id, new_category_id FROM _0419_fix ORDER BY id;

UPDATE public.lots l
SET category_id = f.new_category_id
FROM _0419_fix f
WHERE l.id = f.id
  AND l.category_id IS NOT DISTINCT FROM f.old_category_id;  -- skip rows edited since capture

COMMIT;
