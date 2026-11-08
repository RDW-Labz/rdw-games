-- ============================================================================
-- batch_intake_lot_to_bin — picker accumulates a cart of lots on the mobile
-- app, then scans ONE bin QR to commit them all at once.
--
-- Motivation: intake.tsx works great for single items but floor reality is
-- "I'm moving a whole cart into bin A-3-04." This RPC handles that case
-- atomically: the bin is validated once, each lot is resolved and updated
-- independently, and partial success is the designed outcome — one bad scan
-- on the cart doesn't block the rest.
--
-- Resolution order (mirrors intake_lot_to_bin from 0032 exactly):
--   1. lot_code (app-wide unique)
--   2. UUID (app-wide unique)
--   3. LPN (Amazon — unit-level, operator-scoped)
--   4. FNSKU (Amazon — per-listing, operator-scoped)
--   5. ASIN (Amazon — per-product, operator-scoped; prefer pending_intake)
--   6. external_code (operator-scoped catch-all — UPCs, SKUs, route stops)
--
-- Partial success design:
--   - Bin resolution failure → fast-fail with 0 result rows (nothing to do).
--   - Per-lot failure → that row gets ok=false + error code; the rest proceed.
--   - Each lot UPDATE is wrapped in a savepoint so a single bad row can't
--     roll back the entire batch.
--   - Result rows are returned in input order so the caller can zip them
--     back against their local list.
--
-- Security: SECURITY DEFINER, granted to authenticated only. Internally
-- validates that the caller has an operator_users row (any role — pickers
-- are the primary users but admin/manager are equally valid here).
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
  -- The bin must exist and belong to the caller's operator. We check this
  -- before touching any lots so the caller gets a clear error rather than
  -- a row-per-lot failure with the same bin_not_found code.
  SELECT * INTO v_bin FROM bins WHERE qr_token = p_bin_qr_token LIMIT 1;
  IF NOT FOUND THEN
    -- Return zero rows. The caller should surface "bin not found" to the
    -- operator and prompt a rescan of the bin QR.
    RETURN;
  END IF;

  SELECT operator_id INTO v_bin_op FROM warehouses WHERE id = v_bin.warehouse_id;
  IF v_bin_op IS DISTINCT FROM v_op_id THEN
    -- Also return zero rows — wrong-operator bin is a hard stop.
    RETURN;
  END IF;

  -- ── Per-lot loop ──────────────────────────────────────────────────────────
  v_idx := 1;
  FOREACH v_identifier IN ARRAY p_lot_identifiers LOOP
    v_id_clean := TRIM(v_identifier);
    v_lot      := NULL;

    -- 1. lot_code
    SELECT * INTO v_lot FROM lots WHERE lot_code = v_id_clean LIMIT 1;

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

    -- ── Bin warehouse mismatch (bin is valid for the operator but belongs
    --    to a different warehouse than the lot's declared warehouse_id).
    --    This is a soft warning — we still perform the intake because the
    --    bin's warehouse is authoritative (same logic as the single-lot RPC).
    --    We let it through and set the lot's warehouse_id from the bin. ──────

    -- ── Update the lot ────────────────────────────────────────────────────
    -- BEGIN/EXCEPTION in PL/pgSQL creates an implicit subtransaction that
    -- rolls back automatically on exception — no explicit SAVEPOINT needed
    -- (and SAVEPOINT/ROLLBACK syntax is rejected inside function bodies).
    -- This means a constraint violation on one row won't abort the batch.
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
