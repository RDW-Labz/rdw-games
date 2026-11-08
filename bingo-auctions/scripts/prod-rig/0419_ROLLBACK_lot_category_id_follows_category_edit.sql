-- Rollback for 0419_lot_category_id_follows_category_edit.sql (standby only).
-- Restores the 0220 trigger function verbatim: fill category_id only when NULL.
-- Function replace only; the trigger itself is untouched (no lock on lots).

BEGIN;

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

COMMENT ON FUNCTION public.lots_autoresolve_category_id() IS NULL;

COMMIT;
