-- migration 0250 — put-away accepts draft/relisted lots (pre-sticker recovery)
--
-- Pickup-day recap 2026-07-08 §5, owner decision: "Accept relisted/draft items
-- at put-away." A relisted lot's child starts in status='draft' with the
-- physical pre-sticker carried over (0213), so scanning that box at put-away
-- errored lot_not_in_intake_state while the same code resolved fine in
-- lotting — the "tote gave an error" inconsistency.
--
-- WHAT CHANGED vs 0185 (the live definition)
-- ------------------------------------------
-- 1. Status gate widened: pending_intake / in_inventory (as before) + draft +
--    relisted are now accepted. Everything else (scheduled/live/won/…) still
--    returns lot_not_in_intake_state.
-- 2. Placement is LOCATION-ONLY for non-pending_intake statuses: a draft/
--    relisted lot keeps its status (flipping draft→in_inventory could fight
--    the relist flow); only pending_intake still flips to in_inventory.
--    A draft/relisted/in_inventory lot with NO current bin is placed directly
--    (ok_intaked); one already in a different bin goes through the existing
--    pending_move → confirm_move_lot_to_bin confirmation.
-- Everything else is reproduced VERBATIM from 0185: use_column pragma, the
-- qr_token→lot_code→sticker_code resolution ladder, auth/operator guards,
-- RETURNS TABLE shape, outcome codes.
--
-- CREATE OR REPLACE (same signature/return type as 0185 — no DROP needed).
-- Risk: low. Additive statuses; all existing outcome paths unchanged.

BEGIN;

CREATE OR REPLACE FUNCTION batch_intake_lot_to_bin(
  p_lot_identifiers TEXT[],
  p_bin_qr_token    UUID
)
RETURNS TABLE (
  identifier    TEXT,
  ok            BOOLEAN,
  code          TEXT,
  lot_id        UUID,
  lot_code      TEXT,
  sticker_code  TEXT,
  bin_code      TEXT,
  from_bin_code TEXT,
  error         TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_op_id        UUID;
  v_op_code      TEXT;
  v_bin          bins%ROWTYPE;
  v_bin_op       UUID;
  v_lot          lots%ROWTYPE;
  v_id_clean     TEXT;
  v_sticker_full TEXT;
  v_old_bin_id   UUID;
  v_old_bin_code TEXT;
  v_identifier   TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  v_op_id := current_operator_id();
  IF v_op_id IS NULL THEN
    RAISE EXCEPTION 'not_operator_staff' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_bin FROM bins WHERE qr_token = p_bin_qr_token LIMIT 1;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  SELECT operator_id INTO v_bin_op FROM warehouses WHERE id = v_bin.warehouse_id;
  IF v_bin_op IS DISTINCT FROM v_op_id THEN
    RETURN;
  END IF;

  -- `code` resolves to operators.code (the column) under the use_column pragma.
  SELECT code INTO v_op_code FROM operators WHERE id = v_op_id;

  FOREACH v_identifier IN ARRAY p_lot_identifiers LOOP
    v_id_clean := TRIM(v_identifier);
    v_lot      := NULL;

    -- 1. qr_token (UUID-safe)
    BEGIN
      SELECT * INTO v_lot FROM lots WHERE qr_token = v_id_clean::UUID;
    EXCEPTION WHEN invalid_text_representation THEN v_lot.id := NULL; END;

    -- 2. lot_code (column-qualified; redundant under use_column but kept
    --    for parity with 0175).
    IF v_lot.id IS NULL THEN
      SELECT * INTO v_lot FROM lots WHERE lots.lot_code = v_id_clean LIMIT 1;
    END IF;

    -- 3. sticker_code (W2-bonus operator-prefix). `sticker_code` in this WHERE
    --    resolves to the COLUMN under use_column (not the new OUT param).
    IF v_lot.id IS NULL AND v_op_code IS NOT NULL AND v_id_clean NOT LIKE '%:%' THEN
      v_sticker_full := v_op_code || ':' || v_id_clean;
      SELECT * INTO v_lot FROM lots WHERE sticker_code = v_sticker_full LIMIT 1;
    END IF;

    IF v_lot.id IS NULL THEN
      identifier    := v_identifier;
      ok            := false;
      code          := 'not_lotted_yet';
      lot_id        := NULL;
      lot_code      := NULL;
      sticker_code  := NULL;
      bin_code      := NULL;
      from_bin_code := NULL;
      error         := 'No lot matched — create a draft in Lotting first.';
      RETURN NEXT;
      CONTINUE;
    END IF;

    IF v_lot.operator_id <> v_op_id THEN
      identifier    := v_identifier;
      ok            := false;
      code          := 'lot_other_operator';
      lot_id        := v_lot.id;
      lot_code      := v_lot.lot_code;
      sticker_code  := v_lot.sticker_code;
      bin_code      := NULL;
      from_bin_code := NULL;
      error         := 'Lot belongs to a different operator.';
      RETURN NEXT;
      CONTINUE;
    END IF;

    -- 0250: widened gate — draft + relisted (pre-sticker carryover lots) can
    -- now be put away. Anything auction-bound or sold still rejects.
    IF v_lot.status NOT IN ('pending_intake', 'in_inventory', 'draft', 'relisted') THEN
      identifier    := v_identifier;
      ok            := false;
      code          := 'lot_not_in_intake_state';
      lot_id        := v_lot.id;
      lot_code      := v_lot.lot_code;
      sticker_code  := v_lot.sticker_code;
      bin_code      := NULL;
      from_bin_code := NULL;
      error         := 'Lot is past inventory state (status: ' || v_lot.status || ').';
      RETURN NEXT;
      CONTINUE;
    END IF;

    -- W10: branch by outcome.
    BEGIN
      IF v_lot.status = 'pending_intake' THEN
        UPDATE lots
        SET status        = 'in_inventory',
            intake_bin_id = v_bin.id,
            warehouse_id  = v_bin.warehouse_id,
            intake_at     = now(),
            updated_at    = now()
        WHERE id = v_lot.id;

        identifier    := v_identifier;
        ok            := true;
        code          := 'ok_intaked';
        lot_id        := v_lot.id;
        lot_code      := v_lot.lot_code;
        sticker_code  := v_lot.sticker_code;
        bin_code      := v_bin.code;
        from_bin_code := NULL;
        error         := NULL;
        RETURN NEXT;
      ELSIF v_lot.intake_bin_id IS NULL THEN
        -- 0250: draft/relisted/in_inventory lot with no bin yet — place it
        -- directly. LOCATION-ONLY: status stays as-is (flipping draft →
        -- in_inventory could fight the relist pipeline).
        UPDATE lots
        SET intake_bin_id = v_bin.id,
            warehouse_id  = v_bin.warehouse_id,
            updated_at    = now()
        WHERE id = v_lot.id;

        identifier    := v_identifier;
        ok            := true;
        code          := 'ok_intaked';
        lot_id        := v_lot.id;
        lot_code      := v_lot.lot_code;
        sticker_code  := v_lot.sticker_code;
        bin_code      := v_bin.code;
        from_bin_code := NULL;
        error         := NULL;
        RETURN NEXT;
      ELSE
        v_old_bin_id := v_lot.intake_bin_id;
        IF v_old_bin_id IS NOT DISTINCT FROM v_bin.id THEN
          identifier    := v_identifier;
          ok            := true;
          code          := 'ok_already_here';
          lot_id        := v_lot.id;
          lot_code      := v_lot.lot_code;
          sticker_code  := v_lot.sticker_code;
          bin_code      := v_bin.code;
          from_bin_code := v_bin.code;
          error         := NULL;
          RETURN NEXT;
        ELSE
          -- `code` resolves to bins.code (the column) under use_column.
          SELECT code INTO v_old_bin_code FROM bins WHERE id = v_old_bin_id;
          identifier    := v_identifier;
          ok            := false;
          code          := 'pending_move';
          lot_id        := v_lot.id;
          lot_code      := v_lot.lot_code;
          sticker_code  := v_lot.sticker_code;
          bin_code      := v_bin.code;
          from_bin_code := v_old_bin_code;
          error         := 'Lot is in ' || COALESCE(v_old_bin_code, '?') || ' — confirm move.';
          RETURN NEXT;
        END IF;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      identifier    := v_identifier;
      ok            := false;
      code          := 'update_failed';
      lot_id        := v_lot.id;
      lot_code      := v_lot.lot_code;
      sticker_code  := v_lot.sticker_code;
      bin_code      := NULL;
      from_bin_code := NULL;
      error         := SQLERRM;
      RETURN NEXT;
    END;
  END LOOP;

  RETURN;
END;
$$;

REVOKE ALL ON FUNCTION batch_intake_lot_to_bin(TEXT[], UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION batch_intake_lot_to_bin(TEXT[], UUID) TO authenticated;

COMMENT ON FUNCTION batch_intake_lot_to_bin(TEXT[], UUID) IS
  'W10 (mig 0143) + 0145 lot_code re-qualification + 0175 use_column pragma + '
  '0185 sticker_code column + 0250 draft/relisted accepted (location-only; '
  'status preserved for non-pending_intake). Per-row three-outcome batch '
  'put-away. Code values: ok_intaked / ok_already_here / pending_move '
  '(ok=false; client confirms via confirm_move_lot_to_bin) / not_lotted_yet / '
  'lot_other_operator / lot_not_in_intake_state / update_failed.';

COMMIT;
