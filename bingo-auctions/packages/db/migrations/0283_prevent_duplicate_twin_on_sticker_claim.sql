-- 0283 — prevent duplicate "twin" lots at sticker-claim time
--
-- Jared field report 2026-07-22: at pickup / Lot Lookup an item shows as
-- "Canceled" while the customer's Pickup Pass shows it sold & ready. Root
-- cause is a DUPLICATE TWIN: a go-live import lot (e.g. lot_code='BRN4374140',
-- still live) and a second lot that was lotted AGAIN for the SAME physical
-- item and claimed 'BRN4374140' as its sticker_code ('{op}:BRN4374140'). Two
-- live lots then answer to the same physical code, and lot_code-first
-- resolution surfaced the stale copy.
--
-- 0272's client-idempotency token already kills the *double-submit* twin (the
-- SAME create action firing twice). This migration closes the OTHER vector:
-- deliberately lotting an item that is ALREADY a live lot. The item that came
-- back should go through Relot (which retires its source — mig 0213), never a
-- second fresh lot.
--
-- FIX: claim_sticker_code (0141) and rebind_sticker_code (0249) already refuse
-- a full sticker_code that collides with another lot, but NEITHER checked
-- whether the RAW code equals a different LIVE lot's canonical lot_code — the
-- exact twin vector. Add that guard to both. New refusal reason
-- 'raw_code_is_live_lot_code' carries the other lot's id + code so the client
-- can point staff at the existing lot (open / Relot) instead of minting a twin.
--
-- Retired copies (canceled / relisted / disposed) and soft-deleted rows are
-- EXCLUDED so a discarded code can be legitimately reused, and so this never
-- collides with the relist carryover: relist_lot_into_auction binds its derived
-- '{op}:{legacy}' sticker by direct UPDATE (0213) and flips the source to
-- 'relisted' — it does NOT call these RPCs, and its source is retired anyway.
--
-- Additive & low-risk: the happy path (a genuinely new sticker on a fresh item)
-- is unchanged; only a raw code matching a live OTHER lot is now refused.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. claim_sticker_code — add the live-lot_code collision guard
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION claim_sticker_code(
  p_lot_id   UUID,
  p_raw_code TEXT
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_op_id          UUID;
  v_op_code        TEXT;
  v_lot            lots%ROWTYPE;
  v_other_lot      UUID;
  v_other_lot_code TEXT;
  v_clean_raw      TEXT := TRIM(p_raw_code);
  v_full_code      TEXT;
BEGIN
  v_op_id := current_operator_id();
  IF v_op_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_operator_staff');
  END IF;

  IF v_clean_raw IS NULL OR LENGTH(v_clean_raw) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'empty_raw_code');
  END IF;

  -- Sanity cap on raw length. The format CHECK on the column doesn't bound
  -- length explicitly; we cap here to keep the column workable. 200 chars
  -- is generous (a UUID is 36 chars, an LPN is < 30, an EAN-13 is 13).
  IF LENGTH(v_clean_raw) > 200 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'raw_code_too_long');
  END IF;

  -- Reject if the raw code itself contains a colon — that would create
  -- ambiguity between operator prefix and operator-chosen content.
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

  -- Already bound to this exact code? Idempotent success.
  IF v_lot.sticker_code = v_full_code THEN
    RETURN jsonb_build_object('ok', true, 'lot_id', p_lot_id,
      'sticker_code', v_full_code, 'idempotent', true);
  END IF;

  -- Bound to a DIFFERENT sticker_code? Reject. Re-binding would orphan the
  -- old physical sticker — caller must explicitly rotate (rebind_sticker_code).
  IF v_lot.sticker_code IS NOT NULL AND v_lot.sticker_code <> v_full_code THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'lot_already_has_different_sticker',
      'existing_sticker_code', v_lot.sticker_code
    );
  END IF;

  -- ── Duplicate-twin prevention (Jared 2026-07-22) ──────────────────────────
  -- Refuse when the RAW code is already the canonical lot_code of a DIFFERENT
  -- LIVE lot for this operator: that is the "lotted again as a new lot" vector
  -- that mints twins. The correct action for a returned/again-handled item is
  -- Relot (retires the source), never a second fresh lot. Retired
  -- (canceled/relisted/disposed) and soft-deleted rows are excluded so a freed
  -- code can be reused and so the 0213 relist carryover is untouched.
  SELECT id, lot_code INTO v_other_lot, v_other_lot_code
    FROM lots
    WHERE operator_id = v_op_id
      AND lot_code = v_clean_raw
      AND id <> p_lot_id
      AND deleted_at IS NULL
      AND status NOT IN ('canceled', 'relisted', 'disposed')
    LIMIT 1;
  IF v_other_lot IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'raw_code_is_live_lot_code',
      'other_lot_id', v_other_lot, 'other_lot_code', v_other_lot_code
    );
  END IF;

  -- Full sticker_code used by another lot? Reject.
  SELECT id INTO v_other_lot
    FROM lots
    WHERE sticker_code = v_full_code AND id <> p_lot_id
    LIMIT 1;
  IF v_other_lot IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'sticker_code_already_used',
      'other_lot_id', v_other_lot
    );
  END IF;

  -- Mark pool row claimed if a pre-printed sticker matches (only relevant
  -- when the raw code was a UUID from a mint_blank_qr_batch batch).
  UPDATE lot_sticker_pool
     SET claimed_at = COALESCE(claimed_at, now()),
         claimed_by_lot_id = COALESCE(claimed_by_lot_id, p_lot_id)
   WHERE sticker_code = v_full_code
     AND operator_id = v_op_id
     AND claimed_at IS NULL;

  -- Write the lot's sticker_code.
  UPDATE lots
     SET sticker_code = v_full_code,
         updated_at = now()
   WHERE id = p_lot_id;

  RETURN jsonb_build_object(
    'ok', true,
    'lot_id', p_lot_id,
    'sticker_code', v_full_code,
    'idempotent', false
  );
END;
$$;

REVOKE ALL ON FUNCTION claim_sticker_code(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION claim_sticker_code(UUID, TEXT) TO authenticated;

COMMENT ON FUNCTION claim_sticker_code(UUID, TEXT) IS
  'W2-bonus + 0283: bind an operator-chosen RAW physical sticker code to a lot. '
  'Server prefixes with `{caller.operator.code}:`. Idempotent on same code. '
  'Rejects rebinding to a different code (use rebind_sticker_code) and now '
  'rejects a raw code that is a DIFFERENT live lot''s lot_code '
  '(reason=raw_code_is_live_lot_code) to prevent duplicate twins.';

-- ---------------------------------------------------------------------------
-- 2. rebind_sticker_code — same live-lot_code collision guard
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
  v_op_id          UUID;
  v_op_code        TEXT;
  v_lot            lots%ROWTYPE;
  v_other_lot      UUID;
  v_other_lot_code TEXT;
  v_clean_raw      TEXT := TRIM(p_raw_code);
  v_full_code      TEXT;
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

  -- Duplicate-twin prevention (0283): the rebound code must not be a DIFFERENT
  -- live lot's canonical lot_code (see claim_sticker_code above).
  SELECT id, lot_code INTO v_other_lot, v_other_lot_code
    FROM lots
    WHERE operator_id = v_op_id
      AND lot_code = v_clean_raw
      AND id <> p_lot_id
      AND deleted_at IS NULL
      AND status NOT IN ('canceled', 'relisted', 'disposed')
    LIMIT 1;
  IF v_other_lot IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'raw_code_is_live_lot_code',
      'other_lot_id', v_other_lot, 'other_lot_code', v_other_lot_code);
  END IF;

  -- New full sticker_code must be unused by any other lot.
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

COMMENT ON FUNCTION public.rebind_sticker_code(UUID, TEXT) IS
  '0249 + 0283: rotate a PRE-AUCTION lot''s sticker_code (audit-logged). Now '
  'also refuses a raw code that is a DIFFERENT live lot''s lot_code '
  '(reason=raw_code_is_live_lot_code) to prevent duplicate twins.';

COMMIT;
