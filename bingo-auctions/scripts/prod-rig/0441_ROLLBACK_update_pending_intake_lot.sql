-- Rollback for 0441_update_pending_intake_lot.sql — standby only.
--
-- This function is live on prod TODAY (verified by direct pg_get_functiondef
-- read, 2026-10-21 — see 0441's own header) and was live before this repo's
-- 0441 migration ever existed: migration 0441 is a renumbered CREATE OR
-- REPLACE re-statement of what is already running, not a new deploy.
--
-- Because of that, "rollback" here is NOT "DROP FUNCTION". Dropping it would
-- remove a function that is reachable right now by the `authenticated` role
-- on prod and may already have external callers this repo's grep cannot see
-- (console builds, Lotter-side service code, ad-hoc RPC calls from a review
-- tool). This repo's own apps/scripts have ZERO references to
-- update_pending_intake_lot as of this PR (grepped apps/**, packages/**,
-- scripts/**, docs/**, seeds/**, supabase/**: no hits) — nothing in-repo is
-- wired to it yet — but "nothing in-repo calls it" is not the same claim as
-- "nothing calls it", and the function's own SECURITY DEFINER + auth.uid()
-- guard is what the real Lotter/putaway integration (PR #319, not yet merged)
-- is designed to call once wired.
--
-- So the rollback restores the exact live definition verbatim — functionally
-- a no-op against prod, same as the forward migration. If 0441 is ever
-- reverted after some OTHER change had altered the function in between, this
-- is what puts prod back to the state verified live on 2026-10-21.

BEGIN;

CREATE OR REPLACE FUNCTION public.update_pending_intake_lot(
  p_lot_id      uuid,
  p_title       text DEFAULT NULL,
  p_description text DEFAULT NULL,
  p_brand       text DEFAULT NULL,
  p_model       text DEFAULT NULL,
  p_category    text DEFAULT NULL,
  p_category_id uuid DEFAULT NULL
)
RETURNS TABLE(
  out_id          uuid,
  out_lot_code    text,
  out_title       text,
  out_description text,
  out_brand       text,
  out_model       text,
  out_category    text,
  out_category_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller_uid UUID;
  v_caller_op  UUID;
  v_lot        lots%ROWTYPE;
BEGIN
  v_caller_uid := auth.uid();
  IF v_caller_uid IS NULL THEN
    RAISE EXCEPTION 'update_pending_intake_lot: not authenticated'
      USING ERRCODE = '28000';
  END IF;

  v_caller_op := current_operator_id();
  IF v_caller_op IS NULL THEN
    RAISE EXCEPTION 'update_pending_intake_lot: caller is not operator staff'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_lot
    FROM lots
   WHERE id = p_lot_id
     AND operator_id = v_caller_op
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'update_pending_intake_lot: lot % not found for this operator', p_lot_id
      USING ERRCODE = '42501';
  END IF;

  IF v_lot.status <> 'pending_intake' THEN
    RAISE EXCEPTION 'update_pending_intake_lot: % is %, not pending_intake — edit it from the operator console instead',
      COALESCE(public.display_code(v_lot), v_lot.lot_code, v_lot.id::text), v_lot.status
      USING ERRCODE = 'P0001';
  END IF;

  IF p_title IS NULL AND p_description IS NULL AND p_brand IS NULL
     AND p_model IS NULL AND p_category IS NULL AND p_category_id IS NULL THEN
    RAISE EXCEPTION 'update_pending_intake_lot: no fields supplied'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_title IS NOT NULL AND btrim(p_title) = '' THEN
    RAISE EXCEPTION 'update_pending_intake_lot: title cannot be blank'
      USING ERRCODE = 'P0001';
  END IF;

  UPDATE lots
     SET title       = COALESCE(btrim(p_title), lots.title),
         description = COALESCE(p_description, lots.description),
         brand       = COALESCE(p_brand,       lots.brand),
         model       = COALESCE(p_model,       lots.model),
         category    = COALESCE(p_category,    lots.category),
         category_id = COALESCE(p_category_id, lots.category_id)
   WHERE lots.id = v_lot.id
  RETURNING lots.id, lots.lot_code, lots.title, lots.description,
            lots.brand, lots.model, lots.category, lots.category_id
    INTO out_id, out_lot_code, out_title, out_description,
         out_brand, out_model, out_category, out_category_id;

  RETURN NEXT;
END;
$function$;

REVOKE ALL ON FUNCTION public.update_pending_intake_lot(uuid, text, text, text, text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_pending_intake_lot(uuid, text, text, text, text, text, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.update_pending_intake_lot(uuid, text, text, text, text, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_pending_intake_lot(uuid, text, text, text, text, text, uuid) TO service_role;

COMMIT;
