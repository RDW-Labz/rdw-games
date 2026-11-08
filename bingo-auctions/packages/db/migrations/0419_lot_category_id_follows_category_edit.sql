-- 0419 — lots.category_id follows a category edit
--
-- Bug: editing a lot's category (console lot edit, PR #493; staff app
-- worklist edit) writes lots.category (text) only. The 0220 trigger
-- lots_autoresolve_category_id fires on UPDATE OF category but only filled
-- category_id when it was NULL, so the old category_id stayed. The bidder
-- app's browse filter keys on category_id, so the lot stayed listed under
-- its old category.
--
-- Fix: replace the trigger FUNCTION only. The existing trigger
-- (BEFORE INSERT OR UPDATE OF category ON lots, mig 0220) already fires on
-- exactly the updates we need, so no DROP/CREATE TRIGGER and no lock on
-- lots: CREATE OR REPLACE FUNCTION touches pg_proc only.
--
-- Behaviour:
--   INSERT: unchanged. Fill category_id from category only when NULL.
--   UPDATE where category changes AND the same UPDATE leaves category_id
--   unchanged (no caller sets both today; if one does, its explicit
--   category_id wins):
--     - new text resolves: category_id := the resolved id.
--     - new text empty/unresolvable: category_id := NULL only if the old id
--       was derived from the old text (it is now stale); otherwise keep it
--       (an id from the Quick Lot picker or the lot-categorize cron is not
--       tied to the text). NULL ids are re-filled by the lot-categorize cron.
--   UPDATE that does not change category: unchanged (old NULL-fill rule).
--
-- Backfill of already-stale rows: scripts/prod-rig/0419_backfill_lot_category_id.sql
-- (separate, run by hand).
-- Rollback: scripts/prod-rig/0419_ROLLBACK_lot_category_id_follows_category_edit.sql

BEGIN;

CREATE OR REPLACE FUNCTION public.lots_autoresolve_category_id()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_resolved uuid;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.category IS DISTINCT FROM OLD.category
     AND NEW.category_id IS NOT DISTINCT FROM OLD.category_id THEN
    v_resolved := public.resolve_lot_category_id(NEW.category);
    IF v_resolved IS NOT NULL THEN
      NEW.category_id := v_resolved;
    ELSIF OLD.category_id IS NOT NULL
          AND OLD.category_id IS NOT DISTINCT FROM public.resolve_lot_category_id(OLD.category) THEN
      NEW.category_id := NULL;
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.category_id IS NULL
     AND NEW.category IS NOT NULL
     AND btrim(NEW.category) <> '' THEN
    NEW.category_id := public.resolve_lot_category_id(NEW.category);
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.lots_autoresolve_category_id() IS
  '0220 + 0419: fills lots.category_id from the category text on INSERT when '
  'NULL, and re-resolves it on UPDATE when category changes (unless the same '
  'UPDATE sets category_id explicitly).';

COMMIT;
