-- ============================================================================
-- 0142_fix_batch_intake_ambiguous_lot_code.sql
--
-- HOTFIX 2026-05-25 — emergency: team blocked at warehouse 10:46 AM with
-- screenshot showing "Batch intake failed — column reference 'lot_code' is
-- ambiguous" during batch put-away.
--
-- Root cause: `batch_intake_lot_to_bin` (migration 0127) declares
--   `lot_code TEXT` as a RETURNS TABLE OUT parameter. Inside the function
--   body at line 107:
--     SELECT * INTO v_lot FROM lots WHERE lot_code = v_id_clean LIMIT 1;
--   PostgreSQL sees `lot_code` matching BOTH `lots.lot_code` (the column)
--   AND the OUT parameter, so PL/pgSQL refuses with the ambiguity error.
--
-- The bug only fires when the scanned identifier is a plain lot_code
-- string (e.g. "BRN4371747") — the qr_token branch at line 100 short-
-- circuits for UUID inputs, so this bug was invisible in pre-stickered
-- testing and only manifested live at the warehouse with legacy BRN codes.
--
-- Fix: column-qualify the lookup as `lots.lot_code = v_id_clean`. One line.
--      No other ambiguities exist in the function body (verified via grep
--      against the RETURNS TABLE column names: identifier, ok, code, lot_id,
--      lot_code, bin_code, error — only `lot_code` collides with a lots.*
--      column).
--
-- Risk: minimal. CREATE OR REPLACE on existing function with identical
--       signature. No schema change. Safe to apply while team is operating.
--
-- Reference: docs/state/HOTFIX-batch-putaway-2026-05-25.md
-- ============================================================================

CREATE OR REPLACE FUNCTION batch_intake_lot_to_bin(
  p_lot_identifiers TEXT[],
  p_bin_qr_token    UUID
)
RETURNS TABLE (
  identifier  TEXT,
  ok          BOOLEAN,
  code        TEXT,
  lot_id      UUID,
  lot_code    TEXT,
  bin_code    TEXT,
  error       TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_op_id       UUID;
  v_bin         bins%ROWTYPE;
  v_bin_op      UUID;
  v_lot         lots%ROWTYPE;
  v_id_clean    TEXT;
  v_idx         INT;
  v_identifier  TEXT;
BEGIN
  -- ── Auth ──────────────────────────────────────────────────────────────────
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  v_op_id := current_operator_id();
  IF v_op_id IS NULL THEN
    RAISE EXCEPTION 'not_operator_staff' USING ERRCODE = '42501';
  END IF;

  -- ── Resolve bin once — fail fast if the bin is invalid ───────────────────
  SELECT * INTO v_bin FROM bins WHERE qr_token = p_bin_qr_token LIMIT 1;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT operator_id INTO v_bin_op FROM warehouses WHERE id = v_bin.warehouse_id;
  IF v_bin_op IS DISTINCT FROM v_op_id THEN
    RETURN;
  END IF;

  -- ── Per-lot loop ──────────────────────────────────────────────────────────
  v_idx := 1;
  FOREACH v_identifier IN ARRAY p_lot_identifiers LOOP
    v_id_clean := TRIM(v_identifier);
    v_lot      := NULL;

    -- 0. qr_token (0127: pre-stickered sticker scan — UUID-safe).
    BEGIN
      SELECT * INTO v_lot FROM lots WHERE qr_token = v_id_clean::UUID;
    EXCEPTION WHEN invalid_text_representation THEN
      v_lot.id := NULL;
    END;

    -- 1. lot_code (0142 fix: column-qualified to avoid ambiguity with the
    --    RETURNS TABLE OUT parameter `lot_code TEXT`).
    IF v_lot.id IS NULL THEN
      SELECT * INTO v_lot FROM lots WHERE lots.lot_code = v_id_clean LIMIT 1;
    END IF;

    -- 2. UUID
    IF v_lot.id IS NULL THEN
      BEGIN
        SELECT * INTO v_lot FROM lots WHERE id = v_id_clean::UUID;
      EXCEPTION WHEN invalid_text_representation THEN
        v_lot.id := NULL;
      END;
    END IF;

    -- 3. LPN (Amazon — unit-level, operator-scoped)
    IF v_lot.id IS NULL THEN
      SELECT * INTO v_lot FROM lots
      WHERE operator_id = v_op_id AND lpn = v_id_clean
      LIMIT 1;
    END IF;

    -- 4. FNSKU (Amazon — per-listing, operator-scoped)
    IF v_lot.id IS NULL THEN
      SELECT * INTO v_lot FROM lots
      WHERE operator_id = v_op_id AND fnsku = v_id_clean
      LIMIT 1;
    END IF;

    -- 5. ASIN (Amazon — operator-scoped; prefer pending_intake lots when
    --    multiple lots share the same ASIN)
    IF v_lot.id IS NULL THEN
      SELECT * INTO v_lot FROM lots
      WHERE operator_id = v_op_id AND asin = v_id_clean
      ORDER BY (status = 'pending_intake') DESC, created_at DESC
      LIMIT 1;
    END IF;

    -- 6. external_code (operator-scoped catch-all)
    IF v_lot.id IS NULL THEN
      SELECT * INTO v_lot FROM lots
      WHERE operator_id = v_op_id AND external_code = v_id_clean
      LIMIT 1;
    END IF;

    -- ── Validate resolved lot ─────────────────────────────────────────────
    IF v_lot.id IS NULL THEN
      identifier := v_identifier;
      ok         := false;
      code       := 'lot_not_found';
      lot_id     := NULL;
      lot_code   := NULL;
      bin_code   := NULL;
      error      := 'No lot matched that identifier.';
      RETURN NEXT;
      v_idx := v_idx + 1;
      CONTINUE;
    END IF;

    IF v_lot.operator_id <> v_op_id THEN
      identifier := v_identifier;
      ok         := false;
      code       := 'lot_other_operator';
      lot_id     := v_lot.id;
      lot_code   := v_lot.lot_code;
      bin_code   := NULL;
      error      := 'Lot belongs to a different operator.';
      RETURN NEXT;
      v_idx := v_idx + 1;
      CONTINUE;
    END IF;

    IF v_lot.status <> 'pending_intake' AND v_lot.status <> 'in_inventory' THEN
      identifier := v_identifier;
      ok         := false;
      code       := 'lot_not_in_intake_state';
      lot_id     := v_lot.id;
      lot_code   := v_lot.lot_code;
      bin_code   := NULL;
      error      := 'Lot is past inventory state (status: ' || v_lot.status || ').';
      RETURN NEXT;
      v_idx := v_idx + 1;
      CONTINUE;
    END IF;

    -- ── Update the lot ────────────────────────────────────────────────────
    BEGIN
      UPDATE lots
      SET status        = 'in_inventory',
          intake_bin_id = v_bin.id,
          warehouse_id  = v_bin.warehouse_id,
          intake_at     = now(),
          updated_at    = now()
      WHERE id = v_lot.id;

      identifier := v_identifier;
      ok         := true;
      code       := 'ok';
      lot_id     := v_lot.id;
      lot_code   := v_lot.lot_code;
      bin_code   := v_bin.code;
      error      := NULL;
      RETURN NEXT;

    EXCEPTION WHEN OTHERS THEN
      identifier := v_identifier;
      ok         := false;
      code       := 'update_failed';
      lot_id     := v_lot.id;
      lot_code   := v_lot.lot_code;
      bin_code   := NULL;
      error      := SQLERRM;
      RETURN NEXT;
    END;

    v_idx := v_idx + 1;
  END LOOP;

  RETURN;
END;
$$;

REVOKE ALL ON FUNCTION batch_intake_lot_to_bin(TEXT[], UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION batch_intake_lot_to_bin(TEXT[], UUID) TO authenticated;
