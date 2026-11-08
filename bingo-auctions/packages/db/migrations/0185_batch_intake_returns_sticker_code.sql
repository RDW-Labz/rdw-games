-- migration 0185 — batch_intake_lot_to_bin returns sticker_code (display BRN at put-away)
--
-- WHY
-- ---
-- The batch + shelf-scan put-away screens render the lot identifier returned by
-- batch_intake_lot_to_bin. That RETURNS TABLE only carried `lot_code`, so those
-- result rows always showed BIN-NNNNNN even when the lot has a pre-stickered
-- label (sticker_code). Per the operator request ("staff/customers should see
-- the physical code on the box — BRN when present, else BIN"), the RPC now also
-- returns sticker_code so the client can render lotDisplayCode() consistently
-- with every other surface (mig #214 wired the .select()-based screens).
--
-- The single-lot path (intake_lot_to_bin) is NOT changed: single.tsx already
-- resolves the lot client-side (its resolveLot select gained sticker_code in
-- #214), so it shows the BRN from the resolved row. Only the batch RPC, which
-- does all resolution server-side for an array of scans, needed the extra column.
--
-- WHAT CHANGED vs 0175 (the prior definition)
-- -------------------------------------------
-- 1. Added `sticker_code TEXT` to the RETURNS TABLE (right after lot_code).
-- 2. Set `sticker_code := v_lot.sticker_code` at every RETURN NEXT that has a
--    matched lot (NULL on the not_lotted_yet miss). v_lot is `lots%ROWTYPE`
--    (SELECT *), so the column is already in hand — no extra query.
-- Everything else is reproduced VERBATIM from 0175: the
-- `#variable_conflict use_column` pragma (which also makes the new sticker_code
-- OUT param coexist with the lots.sticker_code column read at the resolver, the
-- same way `code`/`lot_code` already do), the qr_token→lot_code→sticker_code
-- resolution ladder, the W10 three-outcome branches, and the auth/operator guards.
--
-- A RETURNS TABLE signature change can't be done with CREATE OR REPLACE
-- ("cannot change return type of existing function"), so this DROPs then CREATEs
-- inside the migration transaction (atomic — concurrent callers see the old
-- definition until COMMIT, the new one after). REVOKE/GRANT are re-applied since
-- DROP removes them.
--
-- Risk: low. Pure additive column; all existing outcome codes + values unchanged.

BEGIN;

DROP FUNCTION IF EXISTS batch_intake_lot_to_bin(TEXT[], UUID);

CREATE FUNCTION batch_intake_lot_to_bin(
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

    IF v_lot.status <> 'pending_intake' AND v_lot.status <> 'in_inventory' THEN
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
  '0185 sticker_code column. Per-row three-outcome batch put-away. Code values: '
  'ok_intaked / ok_already_here / pending_move (ok=false; client confirms via '
  'confirm_move_lot_to_bin) / not_lotted_yet / lot_other_operator / '
  'lot_not_in_intake_state / update_failed. Returns sticker_code so the client '
  'can render lotDisplayCode (BRN else lot_code).';

-- Self-mark (matches the repo's plain-psql migration pattern, e.g. 0033 / 0184).
INSERT INTO _schema_migrations (filename, applied_by) VALUES
  ('0185_batch_intake_returns_sticker_code.sql', 'manual:0185')
ON CONFLICT (filename) DO NOTHING;

COMMIT;
