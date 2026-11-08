-- 0377 — mark_lot_disposed refuses a scheduled/live lot that has bids.
--
-- mark_lot_disposed (0146) backs the aging report's "Remove from cycle" and the
-- worklist's Dispose button. It disposed a lot in ANY status, including a live
-- lot with bids: the lot left the sale mid-auction, its bidders were never
-- told (no notification kind exists for it), and a winner could be left
-- pointing at a disposed lot. remove_lot_from_inventory (0319) already refuses
-- this case with reason 'lot_live_with_bids'; this is the same check, in the
-- same place (after the lot row is locked), returning the same reason.
--
-- The rest of the function is the prod definition (2026-09-29) verbatim.
-- Grants are unchanged by CREATE OR REPLACE.
--
-- Rollback: re-create without the 0377 block (0146 / prod definition).

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.mark_lot_disposed(p_lot_id uuid, p_reason text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_caller    UUID := auth.uid();
  v_op_id     UUID;
  v_role      operator_user_role;
  v_lot       lots%ROWTYPE;
  v_clean_rsn TEXT := NULLIF(TRIM(COALESCE(p_reason, '')), '');
  v_bids      INT;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  END IF;

  SELECT operator_id, role INTO v_op_id, v_role
    FROM operator_users WHERE user_id = v_caller LIMIT 1;
  IF v_op_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_operator_staff');
  END IF;
  IF v_role NOT IN ('admin', 'manager') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'admin_or_manager_required');
  END IF;

  SELECT * INTO v_lot FROM lots WHERE id = p_lot_id FOR UPDATE;
  IF v_lot.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_not_found');
  END IF;
  IF v_lot.operator_id <> v_op_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_other_operator');
  END IF;
  IF v_lot.status = 'disposed' THEN
    RETURN jsonb_build_object('ok', true, 'idempotent', true, 'lot_id', p_lot_id);
  END IF;

  -- 0377: same rule as remove_lot_from_inventory (0319). A scheduled or live
  -- lot that has bids is in a running sale; disposing it would drop those
  -- bidders with no notice, and nothing can notify them yet.
  IF v_lot.status IN ('scheduled', 'live') THEN
    SELECT count(*)::INT INTO v_bids FROM bids WHERE lot_id = p_lot_id;
    IF v_bids > 0 THEN
      RETURN jsonb_build_object(
        'ok', false, 'reason', 'lot_live_with_bids', 'bids', v_bids);
    END IF;
  END IF;

  UPDATE lots
     SET status = 'disposed',
         flagged_for_disposal = TRUE,
         flagged_at = COALESCE(flagged_at, now()),
         flagged_reason = COALESCE(v_clean_rsn, 'manual disposal'),
         updated_at = now()
   WHERE id = p_lot_id;

  RETURN jsonb_build_object('ok', true, 'lot_id', p_lot_id);
END;
$function$;
