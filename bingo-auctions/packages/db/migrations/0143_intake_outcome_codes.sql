-- migration 0143 — intake outcome codes + confirm_move RPC (W10)
--
-- Per docs/state/PLAN-field-mobile-restructure-2026-05-25.md W10:
--   Three outcomes the RPC supports today but the UI does not differentiate:
--     - Fresh intake  (pending_intake → in_inventory@BinX)
--     - Move          (in_inventory@BinA → scan to BinB)
--     - Same-bin      (in_inventory@BinA → scan to BinA)
--
--   Capture from-bin BEFORE UPDATE overwrites intake_bin_id.
--   Return distinct codes — ok_intaked / pending_move / ok_already_here —
--   and bin info for the move case.
--   New `confirm_move_lot_to_bin(p_lot_id, p_bin_qr_token)` RPC performs
--   the move only after the client confirms in a modal.
--
-- ── Why three codes instead of one ok ────────────────────────────────────
-- Real-world driver (plan W10 quote): "customers (or other workers)
-- physically move items in the warehouse and put them down somewhere
-- else. When a field worker scans that lot to put it away in a NEW bin,
-- the UI must show that the lot is already somewhere AND ask whether to
-- move it." Pre-W10, all three outcomes returned `ok` with the same
-- toast; operators had no signal that they were silently relocating a
-- lot that was already binned somewhere else.
--
-- ── ok-field convention (important for clients) ───────────────────────────
--   ok=true  + reason='ok_intaked'       — server moved status to in_inventory
--   ok=true  + reason='ok_already_here'  — no-op; lot already in this bin
--   ok=false + reason='pending_move'     — server did NOT move; client must
--                                          confirm via modal and call
--                                          confirm_move_lot_to_bin
--   ok=false + any other reason          — error
--
-- This means existing clients (intake.tsx + batch-put-away.tsx) that branch
-- only on `ok` will see pending_move as an "error" until they branch on
-- reason. W10-UI (Phase C task #101) adds the proper Yes/No modal.
--
-- ── Schema change: extend intake_lot_result composite type ────────────────
-- The type was created in 0022 as:
--   (ok BOOLEAN, reason TEXT, lot_id UUID, lot_code TEXT,
--    bin_code TEXT, warehouse_id UUID)
--
-- W10 adds `from_bin_code TEXT` so the pending_move outcome can return
-- BOTH the source bin (where the lot is now) and the destination bin
-- (where the worker wants to put it). bin_code remains the destination
-- (or current location on ok_already_here). from_bin_code is NULL for
-- ok_intaked + any error.
--
-- Adding an attribute requires DROPping any function that returns the
-- composite type first, then re-creating it. We do that in a single
-- transaction so there is no window where the function is missing.
--
-- ── Idempotency ───────────────────────────────────────────────────────────
-- All steps wrapped in DO-blocks or IF NOT EXISTS guards.

BEGIN;

-- ===========================================================================
-- 1. Extend intake_lot_result composite type
-- ===========================================================================
-- DROP the function that returns this type first; ALTER TYPE ... ADD ATTRIBUTE
-- fails if any function returns it. We re-create the function below.

DROP FUNCTION IF EXISTS intake_lot_to_bin(TEXT, UUID);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_attribute pa
    JOIN pg_type pt ON pa.attrelid = pt.typrelid
    WHERE pt.typname = 'intake_lot_result'
      AND pa.attname = 'from_bin_code'
      AND NOT pa.attisdropped
  ) THEN
    ALTER TYPE intake_lot_result ADD ATTRIBUTE from_bin_code TEXT;
  END IF;
END $$;

COMMENT ON TYPE intake_lot_result IS
  'Return shape for intake_lot_to_bin + confirm_move_lot_to_bin. '
  'W10 (mig 0143): adds from_bin_code so pending_move can return both '
  'the source bin (where lot currently is) and bin_code (destination). '
  'NULL on ok_intaked and any error.';

-- ===========================================================================
-- 2. intake_lot_to_bin (re-created with three-outcome branching)
-- ===========================================================================
-- Same resolution rules as W4 (qr_token | lot_code | sticker_code, with
-- not_lotted_yet fallback). Adds outcome branching after the lot resolves.

CREATE FUNCTION intake_lot_to_bin(
  p_lot_identifier TEXT,
  p_bin_qr_token   UUID
)
RETURNS intake_lot_result
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_op_id        UUID;
  v_op_code      TEXT;
  v_lot          lots%ROWTYPE;
  v_bin          bins%ROWTYPE;
  v_bin_operator UUID;
  v_id_clean     TEXT := TRIM(p_lot_identifier);
  v_sticker_full TEXT;
  v_old_bin_id   UUID;
  v_old_bin_code TEXT;
  v_result       intake_lot_result;
BEGIN
  IF auth.uid() IS NULL THEN
    v_result := (false, 'not_authenticated', NULL, NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;
  v_op_id := current_operator_id();
  IF v_op_id IS NULL THEN
    v_result := (false, 'not_operator_staff', NULL, NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;

  SELECT * INTO v_bin FROM bins
   WHERE qr_token = p_bin_qr_token AND qr_revoked_at IS NULL
   LIMIT 1;
  IF NOT FOUND THEN
    v_result := (false, 'bin_not_found_or_revoked', NULL, NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;
  IF v_bin.retired_at IS NOT NULL THEN
    v_result := (false, 'bin_retired', NULL, NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;
  SELECT operator_id INTO v_bin_operator FROM warehouses WHERE id = v_bin.warehouse_id;
  IF v_bin_operator <> v_op_id THEN
    v_result := (false, 'bin_other_operator', NULL, NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;

  -- Resolution (W4 tightened): qr_token → lot_code → sticker_code.
  BEGIN
    SELECT * INTO v_lot FROM lots WHERE qr_token = v_id_clean::UUID;
  EXCEPTION WHEN invalid_text_representation THEN v_lot.id := NULL; END;

  IF v_lot.id IS NULL THEN
    SELECT * INTO v_lot FROM lots WHERE lot_code = v_id_clean LIMIT 1;
  END IF;

  IF v_lot.id IS NULL AND v_id_clean NOT LIKE '%:%' THEN
    SELECT code INTO v_op_code FROM operators WHERE id = v_op_id;
    IF v_op_code IS NOT NULL THEN
      v_sticker_full := v_op_code || ':' || v_id_clean;
      SELECT * INTO v_lot FROM lots WHERE sticker_code = v_sticker_full LIMIT 1;
    END IF;
  END IF;

  IF v_lot.id IS NULL THEN
    v_result := (false, 'not_lotted_yet', NULL, NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;

  -- Lock the lot row; capture old bin BEFORE any UPDATE.
  SELECT * INTO v_lot FROM lots WHERE id = v_lot.id FOR UPDATE;
  IF v_lot.operator_id <> v_op_id THEN
    v_result := (false, 'lot_other_operator', NULL, NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;
  IF v_lot.status <> 'pending_intake' AND v_lot.status <> 'in_inventory' THEN
    v_result := (false, 'lot_not_in_intake_state', v_lot.id, v_lot.lot_code, NULL, NULL, NULL);
    RETURN v_result;
  END IF;

  v_old_bin_id := v_lot.intake_bin_id;

  -- Branch by outcome.
  IF v_lot.status = 'pending_intake' THEN
    -- Fresh intake: pending → in_inventory.
    UPDATE lots
       SET status        = 'in_inventory',
           intake_bin_id = v_bin.id,
           warehouse_id  = v_bin.warehouse_id,
           intake_at     = now(),
           updated_at    = now()
     WHERE id = v_lot.id;
    v_result := (true, 'ok_intaked', v_lot.id, v_lot.lot_code, v_bin.code, v_bin.warehouse_id, NULL);
    RETURN v_result;
  END IF;

  -- Status is in_inventory at this point.
  IF v_old_bin_id IS NOT DISTINCT FROM v_bin.id THEN
    -- Same bin: harmless duplicate scan. No DB change.
    v_result := (true, 'ok_already_here', v_lot.id, v_lot.lot_code, v_bin.code, v_bin.warehouse_id, v_bin.code);
    RETURN v_result;
  END IF;

  -- Different bin: needs user confirmation. Return WITHOUT updating.
  SELECT code INTO v_old_bin_code FROM bins WHERE id = v_old_bin_id;
  v_result := (false, 'pending_move', v_lot.id, v_lot.lot_code, v_bin.code, v_bin.warehouse_id, v_old_bin_code);
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION intake_lot_to_bin(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION intake_lot_to_bin(TEXT, UUID) TO authenticated;

COMMENT ON FUNCTION intake_lot_to_bin(TEXT, UUID) IS
  'W10 (mig 0143): three-outcome put-away. Returns ok_intaked for fresh '
  'pending_intake→in_inventory transitions; ok_already_here for no-op '
  'same-bin re-scans; pending_move (ok=false) when in_inventory + '
  'different bin — client must show a Move? modal and call '
  'confirm_move_lot_to_bin only on Yes. from_bin_code carries the '
  'source bin on pending_move and ok_already_here; NULL otherwise.';

-- ===========================================================================
-- 3. confirm_move_lot_to_bin (NEW) — performs the held-back move
-- ===========================================================================
-- Called by the put-away client after the operator taps Yes in the "this
-- lot is in BinA — move to BinB?" modal. Same resolution + auth rules as
-- intake_lot_to_bin. Performs the actual UPDATE that intake_lot_to_bin
-- held back on pending_move.

CREATE OR REPLACE FUNCTION confirm_move_lot_to_bin(
  p_lot_id       UUID,
  p_bin_qr_token UUID
)
RETURNS intake_lot_result
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_op_id        UUID;
  v_lot          lots%ROWTYPE;
  v_bin          bins%ROWTYPE;
  v_bin_operator UUID;
  v_old_bin_id   UUID;
  v_old_bin_code TEXT;
  v_result       intake_lot_result;
BEGIN
  IF auth.uid() IS NULL THEN
    v_result := (false, 'not_authenticated', NULL, NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;
  v_op_id := current_operator_id();
  IF v_op_id IS NULL THEN
    v_result := (false, 'not_operator_staff', NULL, NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;

  SELECT * INTO v_bin FROM bins
   WHERE qr_token = p_bin_qr_token AND qr_revoked_at IS NULL
   LIMIT 1;
  IF NOT FOUND THEN
    v_result := (false, 'bin_not_found_or_revoked', NULL, NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;
  IF v_bin.retired_at IS NOT NULL THEN
    v_result := (false, 'bin_retired', NULL, NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;
  SELECT operator_id INTO v_bin_operator FROM warehouses WHERE id = v_bin.warehouse_id;
  IF v_bin_operator <> v_op_id THEN
    v_result := (false, 'bin_other_operator', NULL, NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;

  SELECT * INTO v_lot FROM lots WHERE id = p_lot_id FOR UPDATE;
  IF v_lot.id IS NULL THEN
    v_result := (false, 'lot_not_found', NULL, NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;
  IF v_lot.operator_id <> v_op_id THEN
    v_result := (false, 'lot_other_operator', NULL, NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;
  IF v_lot.status <> 'in_inventory' THEN
    -- Move is only valid from in_inventory. If the lot isn't in_inventory
    -- the client should have called intake_lot_to_bin (fresh-intake path)
    -- instead.
    v_result := (false, 'lot_not_in_inventory_for_move', v_lot.id, v_lot.lot_code, NULL, NULL, NULL);
    RETURN v_result;
  END IF;

  v_old_bin_id := v_lot.intake_bin_id;
  SELECT code INTO v_old_bin_code FROM bins WHERE id = v_old_bin_id;

  -- Defensive: if somehow the same bin, treat as no-op (avoids accidental
  -- intake_at timestamp churn).
  IF v_old_bin_id IS NOT DISTINCT FROM v_bin.id THEN
    v_result := (true, 'ok_already_here', v_lot.id, v_lot.lot_code, v_bin.code, v_bin.warehouse_id, v_bin.code);
    RETURN v_result;
  END IF;

  UPDATE lots
     SET intake_bin_id = v_bin.id,
         warehouse_id  = v_bin.warehouse_id,
         intake_at     = now(),
         updated_at    = now()
   WHERE id = v_lot.id;

  v_result := (true, 'ok_moved', v_lot.id, v_lot.lot_code, v_bin.code, v_bin.warehouse_id, v_old_bin_code);
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION confirm_move_lot_to_bin(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION confirm_move_lot_to_bin(UUID, UUID) TO authenticated;

COMMENT ON FUNCTION confirm_move_lot_to_bin(UUID, UUID) IS
  'W10 (mig 0143): performs the bin-to-bin move that intake_lot_to_bin '
  'held back via pending_move. Client calls this only after the user '
  'confirms in the "this lot is in BinA, move to BinB?" modal.';

-- ===========================================================================
-- 4. batch_intake_lot_to_bin (extended with from_bin_code column)
-- ===========================================================================
-- The TABLE-return shape is per-function and has no global type to extend.
-- DROP + CREATE to add the new column. Behavior matches single-lot:
-- per-row outcome can be ok_intaked / ok_already_here / pending_move /
-- not_lotted_yet / etc.

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
  bin_code      TEXT,
  from_bin_code TEXT,
  error         TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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

  SELECT code INTO v_op_code FROM operators WHERE id = v_op_id;

  FOREACH v_identifier IN ARRAY p_lot_identifiers LOOP
    v_id_clean := TRIM(v_identifier);
    v_lot      := NULL;

    BEGIN
      SELECT * INTO v_lot FROM lots WHERE qr_token = v_id_clean::UUID;
    EXCEPTION WHEN invalid_text_representation THEN v_lot.id := NULL; END;

    IF v_lot.id IS NULL THEN
      SELECT * INTO v_lot FROM lots WHERE lot_code = v_id_clean LIMIT 1;
    END IF;

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
  'W10 (mig 0143): per-row three-outcome batch. Adds from_bin_code column '
  'to TABLE return. Code values: ok_intaked / ok_already_here / '
  'pending_move (ok=false; client confirms via confirm_move_lot_to_bin) / '
  'not_lotted_yet / lot_other_operator / lot_not_in_intake_state / '
  'update_failed.';

COMMIT;
