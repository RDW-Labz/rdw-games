-- 0220 — lots.category_id auto-resolve (trigger + backfill)
--
-- Tester 2026-07-04 (evening): the /browse filter rail showed 0 for every
-- category while the grid showed hundreds of lots. Diagnosis against prod:
-- 900 storefront-visible lots, 899 carrying an Amazon-style category STRING
-- ("Home & Kitchen › Furniture" ×326, …) but category_id NULL on ALL of
-- them — the BRN/sticker lotting path stores the text and never resolves it
-- to an id (mig 0178 fixed only the CSV bulk-import path). Everything that
-- keys on lots.category_id (browse rail counts, category filter click-
-- throughs, category pages, mobile browse) sees nothing.
--
-- Fix, all DB-side so every lot-creation path is covered:
--   1. Add the high-value aliases the resolver was missing. The biggest
--      bucket ("… › Furniture", 326 lots) had NO 'furniture' alias and fell
--      back to the 'home & kitchen' prefix → kitchen-dining. Longest-alias-
--      wins ordering (resolver, 0184) handles precedence.
--   2. resolve_lot_category_id(text): LEAF-FIRST resolution — try the last
--      '›' segment (the specific part of an Amazon path), fall back to the
--      full string. Leaf-first lands lots in real leaf categories
--      (hardware, plumbing, hand-tools, patio-furniture…), and the web
--      rail's parent roll-up (PR #39) surfaces them under their parents.
--   3. BEFORE INSERT/UPDATE trigger on lots: resolve category_id whenever a
--      category string is present and category_id is NULL. A manually
--      chosen category_id always wins (trigger only fills NULL).
--   4. Backfill every existing NULL-category_id lot with a usable string —
--      not just storefront-visible ones; inventory/drafts get fixed too.
--
-- Idempotent: CREATE OR REPLACE + ON CONFLICT DO NOTHING + backfill scoped
-- to category_id IS NULL. Re-running is a no-op.

BEGIN;

-- ── 1. Missing aliases ────────────────────────────────────────────────────────
INSERT INTO public.category_aliases (raw, category_id, source, confidence)
SELECT v.raw, c.id, 'mig-0220-amazon-leaf', 1.0
FROM (VALUES
  ('furniture',              'furniture'),
  ('bedding',                'bedroom'),
  ('home décor',             'paint-decor'),
  ('home decor',             'paint-decor'),
  ('wall art',               'paint-decor'),
  ('storage & organization', 'storage-organization'),
  ('office furniture',       'office-school')
) AS v(raw, slug)
JOIN public.categories c ON c.slug = v.slug
ON CONFLICT (raw) DO NOTHING;

-- ── 2. Single-string resolver, leaf-first ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.resolve_lot_category_id(p_category text)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_segments text[];
  v_leaf     text;
  v_id       uuid;
BEGIN
  IF p_category IS NULL OR btrim(p_category) = '' THEN
    RETURN NULL;
  END IF;

  -- Last '›' segment = the most specific part of an Amazon-style path.
  v_segments := regexp_split_to_array(p_category, '›');
  v_leaf := btrim(v_segments[array_upper(v_segments, 1)]);

  IF v_leaf <> '' AND v_leaf <> btrim(p_category) THEN
    SELECT r.category_id INTO v_id
    FROM public.resolve_category_ids_batch(ARRAY[v_leaf]) r
    WHERE r.category_id IS NOT NULL
    LIMIT 1;
    IF v_id IS NOT NULL THEN
      RETURN v_id;
    END IF;
  END IF;

  SELECT r.category_id INTO v_id
  FROM public.resolve_category_ids_batch(ARRAY[btrim(p_category)]) r
  WHERE r.category_id IS NOT NULL
  LIMIT 1;
  RETURN v_id;
END;
$$;

-- ── 3. Auto-resolve trigger ───────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.lots_autoresolve_category_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.category_id IS NULL
     AND NEW.category IS NOT NULL
     AND btrim(NEW.category) <> '' THEN
    NEW.category_id := public.resolve_lot_category_id(NEW.category);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS lots_autoresolve_category_id ON public.lots;
CREATE TRIGGER lots_autoresolve_category_id
  BEFORE INSERT OR UPDATE OF category ON public.lots
  FOR EACH ROW
  EXECUTE FUNCTION public.lots_autoresolve_category_id();

-- ── 4. Backfill existing rows ─────────────────────────────────────────────────
-- Updates category_id only (not category), so the trigger above (UPDATE OF
-- category) does not re-fire on these rows.
UPDATE public.lots l
SET category_id = public.resolve_lot_category_id(l.category)
WHERE l.category_id IS NULL
  AND l.category IS NOT NULL
  AND btrim(l.category) <> ''
  AND public.resolve_lot_category_id(l.category) IS NOT NULL;

COMMIT;
