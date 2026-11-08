-- ROLLBACK for 0445: restores the 0426 definitions of missing_item_found_since()
-- and missing_item_found() verbatim. Check rows written meanwhile stay.

SET lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.missing_item_found_since(p_lot_id uuid, p_since timestamptz)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT
    EXISTS (SELECT 1 FROM lots p
             WHERE p.id = p_lot_id AND p.intake_at IS NOT NULL AND p.intake_at > p_since)
    OR EXISTS (SELECT 1 FROM lot_location_events e
                WHERE e.lot_id = p_lot_id AND e.occurred_at > p_since)
    OR EXISTS (SELECT 1 FROM bin_assignments ba
                WHERE ba.lot_id = p_lot_id AND ba.assigned_at > p_since);
$function$;

COMMENT ON FUNCTION public.missing_item_found_since(uuid, timestamptz) IS
  '0426: the clearing rule of lots_block_relist_of_missing_item (0345), shared by the Missing Items report and RPCs.';

CREATE OR REPLACE FUNCTION public.missing_item_found(
  p_lot_id        uuid,
  p_bin_qr_token  uuid,
  p_note          text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid := auth.uid();
  v_op     uuid;
  v_lot    lots%ROWTYPE;
  v_mark   timestamptz;
  v_last   text;
  v_res    intake_lot_result;
  v_bin_id uuid;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  END IF;
  SELECT operator_id INTO v_op FROM operator_users WHERE user_id = v_caller LIMIT 1;
  IF v_op IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_operator_staff');
  END IF;

  SELECT * INTO v_lot FROM lots WHERE id = p_lot_id;
  IF v_lot.id IS NULL OR v_lot.operator_id <> v_op THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_not_found');
  END IF;
  IF v_lot.removal_kind IS NOT NULL THEN
    -- Written off already (disposed). Put-away does not bring a disposed lot
    -- back; re-lot it instead, the way any found item is.
    RETURN jsonb_build_object('ok', false, 'reason', 'already_removed_as_' || v_lot.removal_kind);
  END IF;

  v_mark := missing_item_current_mark(p_lot_id, v_op);
  IF v_mark IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_marked_missing');
  END IF;
  SELECT c.outcome INTO v_last FROM missing_item_checks c
   WHERE c.lot_id = p_lot_id AND c.checked_at >= v_mark
   ORDER BY c.checked_at DESC LIMIT 1;
  IF v_last = 'unsellable' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'marked_unsellable');
  END IF;

  -- The put-away itself, with every one of its own guards (bin revoked or
  -- retired, other operator's warehouse, …). 0354: a put-away onto the shelf
  -- it is already recorded on still writes a location event, so this clears
  -- 0345's block in every case.
  v_res := intake_lot_to_bin(v_lot.lot_code, p_bin_qr_token);
  IF NOT COALESCE(v_res.ok, false) THEN
    RETURN jsonb_build_object('ok', false, 'reason', COALESCE(v_res.reason, 'putaway_failed'));
  END IF;

  IF NOT missing_item_found_since(p_lot_id, v_mark) THEN
    -- Should be unreachable after a successful put-away; refuse rather than
    -- record a "found" the relist guard will not agree with.
    RAISE EXCEPTION 'missing_item_found: put-away of % did not clear the missing mark', v_lot.lot_code;
  END IF;

  SELECT id INTO v_bin_id FROM bins WHERE qr_token = p_bin_qr_token LIMIT 1;
  INSERT INTO missing_item_checks (operator_id, lot_id, outcome, note, bin_id, checked_by)
  VALUES (v_op, p_lot_id, 'found', NULLIF(btrim(COALESCE(p_note, '')), ''), v_bin_id, v_caller);

  RETURN jsonb_build_object('ok', true, 'lot_id', p_lot_id, 'bin_code', v_res.bin_code,
                            'putaway', v_res.reason);
END;
$function$;

COMMENT ON FUNCTION public.missing_item_found(uuid, uuid, text) IS
  '0426: Missing Items → Found. Puts the lot away via intake_lot_to_bin (clears 0345) and records the check.';

REVOKE EXECUTE ON FUNCTION public.missing_item_found(uuid, uuid, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.missing_item_found(uuid, uuid, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.missing_item_found(uuid, uuid, text) TO authenticated;
