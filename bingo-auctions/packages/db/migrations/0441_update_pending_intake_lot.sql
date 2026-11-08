-- 0441 — land #319's draft-edit-lane function, renumbered from 0357 (0357 is
-- taken in this repo by 0357_collected_item_invariant_monitor.sql).
--
-- WHAT
--
-- public.update_pending_intake_lot(uuid, text, text, text, text, text, uuid):
-- a narrow, loud edit lane for lots still pending_intake. A review surface
-- staffed by pickers needs to push a human's corrections onto a draft lot
-- before it is shelved. The only existing path is a direct UPDATE public.lots,
-- and lots_staff_update is admin/manager only — a picker's UPDATE does not
-- error, it matches zero rows and returns success. The reviewer sees "saved",
-- the lot keeps the wrong title, and that title goes to auction.
--
-- Five fields only (title, description, brand, model, category/category_id),
-- only while status = 'pending_intake'. NULL means "leave alone", not
-- "clear" — a review page sends only what the human actually changed. Every
-- rejection path RAISEs; nothing here silently no-ops. Not editable here:
-- price, condition, status, photos, operator, codes — those stay admin/manager.
--
-- WHY THIS MIGRATION, NOW
--
-- PR #319 (jmacluer-design/bingo-auctions) shipped this as migration 0357 and
-- it was already applied directly to prod (verified below) — the function has
-- been live since before this repo's own 0357 was taken by a different
-- migration (0357_collected_item_invariant_monitor.sql). This migration is
-- the owner-approved renumber to 0441 so the repo's migration history matches
-- what is actually running. On prod, CREATE OR REPLACE here is a no-op
-- re-statement of the exact live definition — it changes nothing. Nothing in
-- this repo calls the function yet (grepped apps/**, scripts/**: no hits) —
-- #319's staging seed, bootstrap script and plan doc are deliberately left
-- out of this PR; that inclusion decision is the owner's, not this change's.
--
-- PROD CHECK (read-only, 2026-10-21, via pg_get_functiondef + has_function_privilege)
--
-- MATCH. Live public.update_pending_intake_lot(uuid,text,text,text,text,text,uuid):
--   - body identical to PR #319's 0357 file, modulo two cosmetic artifacts of
--     pg_get_functiondef's reserialization: (a) the prod deploy path strips
--     "-- " comment lines from function bodies before applying, so the live
--     source has no inline comments — the executable statements match
--     character-for-character once comments are stripped from both sides;
--     (b) Postgres renders bare "DEFAULT NULL" parameter defaults back out as
--     "DEFAULT NULL::text" / "DEFAULT NULL::uuid" — same value, explicit cast.
--   - prosecdef = true (SECURITY DEFINER), proconfig = {search_path=public} —
--     matches the PR's SET search_path TO 'public'.
--   - has_function_privilege: anon = false, authenticated = true,
--     service_role = true, public = false — matches the PR's
--     REVOKE ALL ... FROM PUBLIC; REVOKE ALL ... FROM anon;
--     GRANT EXECUTE ... TO authenticated; GRANT EXECUTE ... TO service_role;
--
-- Since prod differs from nothing (exact match on substance), this migration
-- reproduces the live body and live grants verbatim rather than re-deriving
-- them from the PR file, per the rule that prod is the truth when the two
-- would ever disagree.
--
-- ROLLBACK
--
-- scripts/prod-rig/0441_ROLLBACK_update_pending_intake_lot.sql. Since this
-- function is live today, "rollback" is restoring the exact live definition —
-- identical to this migration's own CREATE OR REPLACE. There is no caller of
-- this function in this repo yet (nothing wired), so dropping would not break
-- an in-repo caller today, but the function is reachable right now by
-- `authenticated` on prod and may already have external/console callers this
-- repo's grep cannot see; the safe rollback is "restate the live def", not
-- "drop".

SET lock_timeout = '3s';

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

  -- Operator scoping is part of the lookup, so a lot belonging to someone else
  -- is indistinguishable from one that does not exist. Same message either way.
  SELECT * INTO v_lot
    FROM lots
   WHERE id = p_lot_id
     AND operator_id = v_caller_op
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'update_pending_intake_lot: lot % not found for this operator', p_lot_id
      USING ERRCODE = '42501';
  END IF;

  -- The whole point of the function. Once an item is shelved, scheduled or
  -- sold, its description is no longer a draft someone is still cleaning up.
  IF v_lot.status <> 'pending_intake' THEN
    -- display_code is a function over a lots row, not a column, so it takes the
    -- record rather than a field reference. It resolves the sticker code staff
    -- actually read off the item.
    RAISE EXCEPTION 'update_pending_intake_lot: % is %, not pending_intake — edit it from the operator console instead',
      COALESCE(public.display_code(v_lot), v_lot.lot_code, v_lot.id::text), v_lot.status
      USING ERRCODE = 'P0001';
  END IF;

  -- Nothing to do is worth saying out loud: a review page that posts an empty
  -- correction is a bug on the caller's side, and silence is what we are here
  -- to stop.
  IF p_title IS NULL AND p_description IS NULL AND p_brand IS NULL
     AND p_model IS NULL AND p_category IS NULL AND p_category_id IS NULL THEN
    RAISE EXCEPTION 'update_pending_intake_lot: no fields supplied'
      USING ERRCODE = 'P0001';
  END IF;

  -- title is NOT NULL on lots; an all-whitespace title would pass the constraint
  -- and produce an unreadable listing, so reject it here.
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

  -- Returning the post-state is not decoration: the caller can render what the
  -- database actually holds rather than echoing back what it hoped it sent.
  RETURN NEXT;
END;
$function$;

-- Self-guarding on auth.uid(), so anon gains nothing by holding EXECUTE — but
-- an unauthenticated role has no business reaching a write RPC at all.
REVOKE ALL ON FUNCTION public.update_pending_intake_lot(uuid, text, text, text, text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_pending_intake_lot(uuid, text, text, text, text, text, uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.update_pending_intake_lot(uuid, text, text, text, text, text, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_pending_intake_lot(uuid, text, text, text, text, text, uuid) TO service_role;
