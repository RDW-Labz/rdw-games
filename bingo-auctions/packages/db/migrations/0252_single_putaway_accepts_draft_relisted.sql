-- migration 0252 — SINGLE put-away + confirm-move accept draft/relisted lots
--
-- Tester recap 2026-07-09 §2: relot an item → Put Away fails with "That lot
-- is already past inventory state." Mig 0250 widened the status gate on
-- batch_intake_lot_to_bin only; the SINGLE put-away screen
-- (field-mobile put-away/single.tsx) calls intake_lot_to_bin, and the
-- move-confirmation modal calls confirm_move_lot_to_bin — both still had the
-- 0143/0160 two-status gate, so a relist child (status='draft', sticker
-- carried over per 0192/0213) was rejected.
--
-- WHAT CHANGED
-- ------------
-- 1. intake_lot_to_bin (0160 body reproduced verbatim otherwise):
--    • gate widened to pending_intake / in_inventory / draft / relisted
--    • non-pending_intake lot with NO current bin → placed directly,
--      LOCATION-ONLY (status preserved — flipping draft→in_inventory could
--      fight the relist pipeline), reason 'ok_intaked'
--    • already-binned lots keep the same same-bin / pending_move outcomes
-- 2. confirm_move_lot_to_bin (0143 body reproduced verbatim otherwise):
--    • move allowed from in_inventory / draft / relisted (location-only
--      UPDATE; status untouched, as before)
--
-- Mirrors 0250 exactly. Risk: low — additive statuses, outcome codes
-- unchanged.

BEGIN;

CREATE OR REPLACE FUNCTION public.intake_lot_to_bin(
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
  v_lot          lots%ROWTYPE;
  v_bin          bins%ROWTYPE;
  v_bin_operator UUID;
  v_id_clean     TEXT := TRIM(p_lot_identifier);
  v_old_bin_id   UUID;
  v_old_bin_code TEXT;
  v_result       intake_lot_result;
  v_find         jsonb;
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

  v_find := public._find_lot_by_scan(ARRAY[v_id_clean]);
  IF NOT (v_find->>'ok')::boolean THEN
    v_result := (false, 'not_lotted_yet', NULL, NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;

  SELECT * INTO v_lot FROM lots WHERE id = (v_find->'lot'->>'id')::UUID FOR UPDATE;
  IF v_lot.operator_id <> v_op_id THEN
    v_result := (false, 'lot_other_operator', NULL, NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;
  -- 0252: widened gate — draft + relisted (relot children / pre-sticker
  -- carryover) can now be put away. Anything auction-bound or sold rejects.
  IF v_lot.status NOT IN ('pending_intake', 'in_inventory', 'draft', 'relisted') THEN
    v_result := (false, 'lot_not_in_intake_state', v_lot.id, v_lot.lot_code, NULL, NULL, NULL);
    RETURN v_result;
  END IF;

  v_old_bin_id := v_lot.intake_bin_id;

  IF v_lot.status = 'pending_intake' THEN
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

  -- 0252: draft/relisted/in_inventory lot with no bin yet — place it
  -- directly. LOCATION-ONLY: status stays as-is.
  IF v_old_bin_id IS NULL THEN
    UPDATE lots
       SET intake_bin_id = v_bin.id,
           warehouse_id  = v_bin.warehouse_id,
           updated_at    = now()
     WHERE id = v_lot.id;
    v_result := (true, 'ok_intaked', v_lot.id, v_lot.lot_code, v_bin.code, v_bin.warehouse_id, NULL);
    RETURN v_result;
  END IF;

  IF v_old_bin_id IS NOT DISTINCT FROM v_bin.id THEN
    v_result := (true, 'ok_already_here', v_lot.id, v_lot.lot_code, v_bin.code, v_bin.warehouse_id, v_bin.code);
    RETURN v_result;
  END IF;

  SELECT code INTO v_old_bin_code FROM bins WHERE id = v_old_bin_id;
  v_result := (false, 'pending_move', v_lot.id, v_lot.lot_code, v_bin.code, v_bin.warehouse_id, v_old_bin_code);
  RETURN v_result;
END
$$;

REVOKE ALL ON FUNCTION public.intake_lot_to_bin(TEXT, UUID) FROM public;
GRANT EXECUTE ON FUNCTION public.intake_lot_to_bin(TEXT, UUID) TO authenticated;

COMMENT ON FUNCTION public.intake_lot_to_bin(TEXT, UUID) IS
  '0160 shared-resolver + 0252 draft/relisted accepted (location-only; '
  'status preserved for non-pending_intake). Outcome codes: ok_intaked / '
  'ok_already_here / pending_move / not_lotted_yet / lot_other_operator / '
  'lot_not_in_intake_state / bin_* / update_failed.';

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
  -- 0252: moves are location-only, so draft/relisted (relot children /
  -- pre-sticker carryover) may move bins too. Status is never touched here.
  IF v_lot.status NOT IN ('in_inventory', 'draft', 'relisted') THEN
    v_result := (false, 'lot_not_in_inventory_for_move', v_lot.id, v_lot.lot_code, NULL, NULL, NULL);
    RETURN v_result;
  END IF;

  v_old_bin_id := v_lot.intake_bin_id;
  SELECT code INTO v_old_bin_code FROM bins WHERE id = v_old_bin_id;

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
END
$$;

REVOKE ALL ON FUNCTION confirm_move_lot_to_bin(UUID, UUID) FROM public;
GRANT EXECUTE ON FUNCTION confirm_move_lot_to_bin(UUID, UUID) TO authenticated;

COMMENT ON FUNCTION confirm_move_lot_to_bin(UUID, UUID) IS
  '0143 outcome codes + 0252 draft/relisted accepted for location-only '
  'moves. Performs the UPDATE that intake_lot_to_bin held back on '
  'pending_move.';

COMMIT;
