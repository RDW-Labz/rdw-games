-- 0280 — audit_remove_lot(): clear a lot's shelf location during a bin audit
-- when the item is recorded in the bin but physically absent.
--
-- Counterpart to 0248 audit_relocate_lot ("Move here"). During a Bin Audit an
-- "expected / not yet scanned" item that isn't physically on the shelf needs a
-- one-tap way to drop it from the bin (staff report 2026-07-21: "if it shows an
-- item is on the shelf but it's not there we need an option to remove it").
--
-- Clears lots.intake_bin_id when it points at the audited bin, so the item stops
-- showing as stored there and becomes unlocated (findable via Lot Lookup with no
-- location) — a clear "where did this go?" follow-up signal. LOCATION-ONLY:
-- does NOT touch status, auction_id, bids, or invoices (same principle as 0248).
--
-- A missing STAGED-for-pickup item is a pickup-flow problem, not a shelf-inventory
-- one, so we do not clear staged bin_assignments here — the RPC returns ok:false
-- with a reason the UI can explain. Staff-gated SECURITY DEFINER, scoped to the
-- lot's operator; only clears a pointer that actually targets p_bin_id.

BEGIN;

CREATE OR REPLACE FUNCTION public.audit_remove_lot(p_lot_id uuid, p_bin_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_lot lots%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_lot FROM public.lots WHERE id = p_lot_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lot_not_found' USING ERRCODE = 'P0002';
  END IF;

  -- Caller must be staff of the lot's operator.
  IF NOT EXISTS (
    SELECT 1 FROM public.operator_users ou
    WHERE ou.user_id = v_uid AND ou.operator_id = v_lot.operator_id
  ) THEN
    RAISE EXCEPTION 'not_operator_staff' USING ERRCODE = '42501';
  END IF;

  -- Shelf case: the intake pointer targets the audited bin → clear it.
  IF p_bin_id IS NOT NULL AND v_lot.intake_bin_id IS NOT DISTINCT FROM p_bin_id THEN
    UPDATE public.lots
       SET intake_bin_id = NULL, updated_at = now()
     WHERE id = p_lot_id;
    RETURN json_build_object('ok', true, 'removed', 'intake', 'lot_id', p_lot_id);
  END IF;

  -- Staged-for-pickup in this bin → not a shelf-audit removal.
  IF EXISTS (
    SELECT 1 FROM public.bin_assignments ba
    WHERE ba.lot_id = p_lot_id AND ba.bin_id = p_bin_id AND ba.status = 'staged'
  ) THEN
    RETURN json_build_object('ok', false, 'reason', 'staged_for_pickup', 'lot_id', p_lot_id);
  END IF;

  -- Already moved / not recorded in this bin.
  RETURN json_build_object('ok', false, 'reason', 'not_in_bin', 'lot_id', p_lot_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.audit_remove_lot(uuid, uuid) TO authenticated;

COMMIT;
