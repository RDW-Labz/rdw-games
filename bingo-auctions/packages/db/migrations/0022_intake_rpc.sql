-- ============================================================================
-- intake_lot_to_bin — picker scans an inventory item QR + a bin QR to
-- flip the lot from pending_intake → in_inventory and record where
-- it physically lives.
--
-- Why a new RPC vs. piggybacking on assign_lot_to_bin:
--   - assign_lot_to_bin is the post-auction staging flow. It writes
--     to bin_assignments (a different table) and notifies the bidder
--     that their item is ready for pickup. Different status, different
--     audience, different table.
--   - intake_lot_to_bin operates on the `lots` row itself (sets
--     intake_bin_id, intake_at, warehouse_id from the bin, flips
--     status). No bin_assignments row, no bidder notification.
--
-- Identifier flexibility:
--   - p_lot_identifier accepts either a UUID (the lot's primary key)
--     or a lot_code ("RDW-000123"). The intake label printer might
--     encode either; the picker doesn't care. We try lot_code first
--     since human-readable codes are easier to spot-check on labels.
--   - p_bin_qr_token is the bin's qr_token UUID, the same column the
--     existing assign_lot_to_bin uses.
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'intake_lot_result') THEN
    CREATE TYPE intake_lot_result AS (
      ok          BOOLEAN,
      reason      TEXT,
      lot_id      UUID,
      lot_code    TEXT,
      bin_code    TEXT,
      warehouse_id UUID
    );
  END IF;
END $$;

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

  -- Resolve the lot identifier — try lot_code first, then UUID.
  SELECT * INTO v_lot FROM lots
  WHERE lot_code = p_lot_identifier
  LIMIT 1;
  IF NOT FOUND THEN
    BEGIN
      SELECT * INTO v_lot FROM lots
      WHERE id = p_lot_identifier::UUID;
    EXCEPTION WHEN invalid_text_representation THEN
      v_lot := NULL;
    END;
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
    -- Already past inventory state. Don't silently overwrite a live
    -- lot's bin assignment.
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

  -- Flip the lot. warehouse_id is derived from the bin's warehouse,
  -- which is the authoritative source — operators told us at import
  -- time only as a hint.
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

REVOKE ALL ON FUNCTION intake_lot_to_bin(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION intake_lot_to_bin(TEXT, UUID) TO authenticated;
