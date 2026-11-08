-- migration 0175 — fix batch_intake_lot_to_bin "column reference \"code\" is ambiguous"
--
-- Field report 2026-06-02 (screenshot): every batch / shelf-scan put-away
-- fails with:
--
--   Batch intake failed: column reference "code" is ambiguous
--
-- ── Root cause ─────────────────────────────────────────────────────────────
-- The W10 refactor (0143_intake_outcome_codes.sql) added TWO unqualified
-- `SELECT code INTO …` reads to the function body, and 0145 carried them
-- forward verbatim:
--
--   0145:103  SELECT code INTO v_op_code      FROM operators WHERE id = v_op_id;
--   0145:199  SELECT code INTO v_old_bin_code FROM bins      WHERE id = v_old_bin_id;
--
-- Both collide with the RETURNS TABLE OUT parameter `code TEXT`. Under the
-- default `variable_conflict = error`, PL/pgSQL refuses to guess and raises
-- "column reference \"code\" is ambiguous". The 0142/0145 hotfixes only
-- chased `lot_code` and explicitly missed `code` — so the operators lookup
-- at line 103 (which runs BEFORE the per-lot loop, on EVERY batch call)
-- throws unconditionally. Batch + shelf-scan have been fully broken since
-- 0143 reached prod.
--
-- ── Fix ──────────────────────────────────────────────────────────────────
-- Add `#variable_conflict use_column` as the first line of the function
-- body — the exact pattern used to fix the sibling single-lot resolver
-- `intake_lot_to_bin` in 0160_find_import_row_by_scan.sql. It tells
-- PL/pgSQL that any ambiguous identifier inside a SQL statement resolves to
-- the COLUMN, which is correct for both `SELECT code …` reads. All
-- variables are v_/p_-prefixed and OUT params are only ever assignment
-- targets (`code := …`), so use_column changes nothing else. This kills the
-- whole ambiguity class rather than qualifying one column at a time.
--
-- ── What's preserved from 0145 (verbatim) ──────────────────────────────────
-- Entire W10 three-outcome body (ok_intaked / ok_already_here /
-- pending_move / not_lotted_yet / lot_other_operator /
-- lot_not_in_intake_state / update_failed), the qr_token|lot_code|
-- sticker_code resolution ladder, the from_bin_code TABLE column, and the
-- already-qualified `lots.lot_code` WHERE. Only the pragma line is added.
--
-- ── Risk: minimal ──────────────────────────────────────────────────────────
-- CREATE OR REPLACE on an existing function, identical signature. No schema
-- change. Safe to apply while the team is operating (body swaps atomically,
-- no DDL lock churn).

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

  -- 0175: `code` resolves to operators.code (the column) thanks to the
  -- #variable_conflict use_column pragma above — no longer ambiguous with
  -- the `code` OUT param.
  SELECT code INTO v_op_code FROM operators WHERE id = v_op_id;

  FOREACH v_identifier IN ARRAY p_lot_identifiers LOOP
    v_id_clean := TRIM(v_identifier);
    v_lot      := NULL;

    -- 1. qr_token (UUID-safe)
    BEGIN
      SELECT * INTO v_lot FROM lots WHERE qr_token = v_id_clean::UUID;
    EXCEPTION WHEN invalid_text_representation THEN v_lot.id := NULL; END;

    -- 2. lot_code (column-qualified; redundant under use_column but kept
    --    for parity with 0145).
    IF v_lot.id IS NULL THEN
      SELECT * INTO v_lot FROM lots WHERE lots.lot_code = v_id_clean LIMIT 1;
    END IF;

    -- 3. sticker_code (W2-bonus operator-prefix)
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
          bin_code      := v_bin.code;
          from_bin_code := v_bin.code;
          error         := NULL;
          RETURN NEXT;
        ELSE
          -- 0175: `code` resolves to bins.code (the column) under
          -- use_column — was the second ambiguous read.
          SELECT code INTO v_old_bin_code FROM bins WHERE id = v_old_bin_id;
          identifier    := v_identifier;
          ok            := false;
          code          := 'pending_move';
          lot_id        := v_lot.id;
          lot_code      := v_lot.lot_code;
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
  'W10 (mig 0143) + 0145 lot_code re-qualification + 0175 use_column pragma '
  '(fixes "column reference code is ambiguous" on the operators/bins lookups). '
  'Per-row three-outcome batch put-away. Code values: ok_intaked / '
  'ok_already_here / pending_move (ok=false; client confirms via '
  'confirm_move_lot_to_bin) / not_lotted_yet / lot_other_operator / '
  'lot_not_in_intake_state / update_failed.';

COMMIT;
