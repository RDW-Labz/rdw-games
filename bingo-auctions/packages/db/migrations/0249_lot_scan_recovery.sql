-- 0249 — lot scan-recovery RPCs: discard_lot + rebind_sticker_code
--
-- Tester recap 2026-07-08 §8: when the camera catches a nearby product UPC
-- instead of the pre-lot sticker, the lot is created with the wrong code and
-- staff have NO recovery — no delete, no rebind, no edit. The only fix was a
-- manager deleting it from the dashboard later, which also left duplicate /
-- orphan half-lots behind (§9). Owner decision 2026-07-08: staff can recover
-- without a manager PIN, as long as discards are SOFT (status='canceled') and
-- there's an audit trail of who/when.
--
-- Two staff-gated SECURITY DEFINER RPCs, both restricted to PRE-AUCTION lots
-- (pending_intake / in_inventory / draft) so nothing that's scheduled, live,
-- or sold can be touched from the lotting floor:
--
--   discard_lot(p_lot_id, p_reason)
--     status → 'canceled' (soft — row is kept; dashboard can still see it).
--     Appends operator_audit_log (action_type='lot_discarded', actor, before/
--     after status, reason).
--
--   rebind_sticker_code(p_lot_id, p_raw_code)
--     The "explicit rotate" claim_sticker_code's comment promised (0141:207).
--     Same validation as claim_sticker_code (length, colon, uniqueness,
--     operator prefix) but ALLOWS replacing an existing sticker_code.
--     Appends operator_audit_log (action_type='lot_sticker_rebound') with the
--     old + new codes. Also claims the matching lot_sticker_pool row.

BEGIN;

-- ---------------------------------------------------------------------------
-- discard_lot
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.discard_lot(
  p_lot_id UUID,
  p_reason TEXT DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_op_id UUID;
  v_lot   lots%ROWTYPE;
BEGIN
  v_op_id := current_operator_id();
  IF v_op_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_operator_staff');
  END IF;

  SELECT * INTO v_lot FROM lots WHERE id = p_lot_id;
  IF v_lot.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_not_found');
  END IF;
  IF v_lot.operator_id <> v_op_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_other_operator');
  END IF;

  -- Floor-recovery only: a lot that reached an auction (scheduled/live) or a
  -- buyer (won) must go through the console flows, not a lotting discard.
  IF v_lot.status NOT IN ('pending_intake', 'in_inventory', 'draft') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_not_discardable',
      'status', v_lot.status);
  END IF;

  UPDATE lots
     SET status = 'canceled', updated_at = now()
   WHERE id = p_lot_id;

  INSERT INTO operator_audit_log
    (operator_id, actor_user_id, action_type, target_id, before_state, after_state, reason_note)
  VALUES
    (v_op_id, auth.uid(), 'lot_discarded', p_lot_id,
     jsonb_build_object('status', v_lot.status, 'lot_code', v_lot.lot_code,
                        'sticker_code', v_lot.sticker_code, 'title', v_lot.title),
     jsonb_build_object('status', 'canceled'),
     COALESCE(NULLIF(TRIM(p_reason), ''), 'discarded from lotting'));

  RETURN jsonb_build_object('ok', true, 'lot_id', p_lot_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.discard_lot(UUID, TEXT) TO authenticated;

-- ---------------------------------------------------------------------------
-- rebind_sticker_code
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.rebind_sticker_code(
  p_lot_id   UUID,
  p_raw_code TEXT
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_op_id     UUID;
  v_op_code   TEXT;
  v_lot       lots%ROWTYPE;
  v_other_lot UUID;
  v_clean_raw TEXT := TRIM(p_raw_code);
  v_full_code TEXT;
BEGIN
  v_op_id := current_operator_id();
  IF v_op_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_operator_staff');
  END IF;

  IF v_clean_raw IS NULL OR LENGTH(v_clean_raw) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'empty_raw_code');
  END IF;
  IF LENGTH(v_clean_raw) > 200 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'raw_code_too_long');
  END IF;
  IF v_clean_raw LIKE '%:%' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'raw_code_contains_colon');
  END IF;

  SELECT code INTO v_op_code FROM operators WHERE id = v_op_id;
  IF v_op_code IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'operator_code_missing');
  END IF;

  v_full_code := v_op_code || ':' || v_clean_raw;

  SELECT * INTO v_lot FROM lots WHERE id = p_lot_id;
  IF v_lot.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_not_found');
  END IF;
  IF v_lot.operator_id <> v_op_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_other_operator');
  END IF;

  -- Same floor-recovery scope as discard_lot.
  IF v_lot.status NOT IN ('pending_intake', 'in_inventory', 'draft') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_not_editable',
      'status', v_lot.status);
  END IF;

  -- Idempotent for the same code.
  IF v_lot.sticker_code = v_full_code THEN
    RETURN jsonb_build_object('ok', true, 'lot_id', p_lot_id,
      'sticker_code', v_full_code, 'idempotent', true);
  END IF;

  -- New code must be unused by any other lot.
  SELECT id INTO v_other_lot
    FROM lots
    WHERE sticker_code = v_full_code AND id <> p_lot_id
    LIMIT 1;
  IF v_other_lot IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'sticker_code_already_used',
      'other_lot_id', v_other_lot);
  END IF;

  -- Claim the matching pre-printed pool row (if any), same as claim_sticker_code.
  UPDATE lot_sticker_pool
     SET claimed_at = COALESCE(claimed_at, now()),
         claimed_by_lot_id = COALESCE(claimed_by_lot_id, p_lot_id)
   WHERE sticker_code = v_full_code
     AND operator_id = v_op_id
     AND claimed_at IS NULL;

  UPDATE lots
     SET sticker_code = v_full_code, updated_at = now()
   WHERE id = p_lot_id;

  INSERT INTO operator_audit_log
    (operator_id, actor_user_id, action_type, target_id, before_state, after_state, reason_note)
  VALUES
    (v_op_id, auth.uid(), 'lot_sticker_rebound', p_lot_id,
     jsonb_build_object('sticker_code', v_lot.sticker_code),
     jsonb_build_object('sticker_code', v_full_code),
     'rebound from lotting scan recovery');

  RETURN jsonb_build_object('ok', true, 'lot_id', p_lot_id,
    'sticker_code', v_full_code, 'idempotent', false,
    'previous_sticker_code', v_lot.sticker_code);
END;
$$;

GRANT EXECUTE ON FUNCTION public.rebind_sticker_code(UUID, TEXT) TO authenticated;

COMMIT;
