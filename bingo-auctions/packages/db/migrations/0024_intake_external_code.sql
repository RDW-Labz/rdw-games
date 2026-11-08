-- ============================================================================
-- intake_lot_to_bin v2 — also resolve by external_code.
--
-- Operators with pre-stickered inventory don't want to print our
-- RDW-000XYZ labels. They want to scan the existing supplier sticker
-- (a UPC, SKU, or whatever they mapped at import time as the
-- external_code).
--
-- Resolution order: lot_code, UUID, then external_code (per-operator
-- scoped — same SKU at two operators must NOT cross-resolve).
-- ============================================================================

CREATE OR REPLACE FUNCTION intake_lot_to_bin(
  p_lot_identifier TEXT,
  p_bin_qr_token   UUID
)
RETURNS intake_lot_result
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_op_id UUID;
  v_lot lots%ROWTYPE;
  v_bin bins%ROWTYPE;
  v_bin_operator UUID;
  v_result intake_lot_result;
BEGIN
  IF auth.uid() IS NULL THEN
    v_result := (false, 'not_authenticated', NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;

  v_op_id := current_operator_id();
  IF v_op_id IS NULL THEN
    v_result := (false, 'not_operator_staff', NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;

  -- Resolve the lot identifier in priority order:
  --   1. lot_code (app-wide unique, our primary)
  --   2. UUID (also app-wide unique)
  --   3. external_code, scoped to the calling operator
  SELECT * INTO v_lot FROM lots WHERE lot_code = p_lot_identifier LIMIT 1;
  IF NOT FOUND THEN
    BEGIN
      SELECT * INTO v_lot FROM lots WHERE id = p_lot_identifier::UUID;
    EXCEPTION WHEN invalid_text_representation THEN
      v_lot := NULL;
    END;
  END IF;
  IF v_lot.id IS NULL THEN
    -- external_code is operator-scoped; we need to filter by the
    -- caller's operator_id here so we don't cross-resolve to a
    -- different operator's lot with the same SKU.
    SELECT * INTO v_lot FROM lots
    WHERE operator_id = v_op_id AND external_code = p_lot_identifier
    LIMIT 1;
  END IF;
  IF v_lot.id IS NULL THEN
    v_result := (false, 'lot_not_found', NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;
  IF v_lot.operator_id <> v_op_id THEN
    v_result := (false, 'lot_other_operator', NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;
  IF v_lot.status <> 'pending_intake' AND v_lot.status <> 'in_inventory' THEN
    v_result := (false, 'lot_not_in_intake_state', v_lot.id, v_lot.lot_code, NULL, NULL);
    RETURN v_result;
  END IF;

  -- Resolve the bin QR token, then look up the operator separately —
  -- PL/pgSQL doesn't let us mix b.* into a record var with extra
  -- columns in a single INTO list.
  SELECT * INTO v_bin FROM bins WHERE qr_token = p_bin_qr_token LIMIT 1;
  IF NOT FOUND THEN
    v_result := (false, 'bin_not_found', v_lot.id, v_lot.lot_code, NULL, NULL);
    RETURN v_result;
  END IF;
  SELECT operator_id INTO v_bin_operator FROM warehouses WHERE id = v_bin.warehouse_id;
  IF v_bin_operator <> v_op_id THEN
    v_result := (false, 'bin_other_operator', v_lot.id, v_lot.lot_code, NULL, NULL);
    RETURN v_result;
  END IF;

  UPDATE lots
  SET status = 'in_inventory',
      intake_bin_id = v_bin.id,
      warehouse_id = v_bin.warehouse_id,
      intake_at = now(),
      updated_at = now()
  WHERE id = v_lot.id;

  v_result := (
    true,
    'ok',
    v_lot.id,
    v_lot.lot_code,
    v_bin.code,
    v_bin.warehouse_id
  );
  RETURN v_result;
END;
$$;
