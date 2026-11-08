-- 0248 — audit_relocate_lot(): location-only "move this lot to this bin"
--
-- Backs the Bin Audit "Move here" correction (pickup-day recap 2026-07-08).
-- When the audit finds an item physically in a bin that the system records
-- elsewhere, staff can correct the SYSTEM record to match reality with one tap.
--
-- LOCATION-ONLY BY DESIGN. This changes ONLY where the lot is recorded:
--   • if the lot has an active staged pickup assignment → move that
--     bin_assignment to the new bin;
--   • otherwise → repoint lots.intake_bin_id.
-- It deliberately does NOT touch lots.status, auction_id, bids, or invoices.
-- A lot's location is independent of its auction listing and the buyer's
-- invoice, so relocating an on-auction or won item is safe: the auction keeps
-- running unchanged and the customer's invoice is unaffected. (This is why we
-- do NOT reuse batch_intake_lot_to_bin, which flips a pending_intake lot to
-- in_inventory — that would be a status change, not a pure relocate.)
--
-- Staff-gated SECURITY DEFINER, scoped to the lot's operator + a bin in that
-- operator's warehouses (a picker can't move a lot into someone else's bin).

BEGIN;

CREATE OR REPLACE FUNCTION public.audit_relocate_lot(p_lot_id uuid, p_bin_id uuid)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_lot lots%ROWTYPE;
  v_bin_operator uuid;
  v_moved text;
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

  -- Target bin must belong to the same operator (via its warehouse).
  SELECT w.operator_id INTO v_bin_operator
  FROM public.bins b
  JOIN public.warehouses w ON w.id = b.warehouse_id
  WHERE b.id = p_bin_id;

  IF v_bin_operator IS NULL OR v_bin_operator <> v_lot.operator_id THEN
    RAISE EXCEPTION 'bin_not_in_operator' USING ERRCODE = '42501';
  END IF;

  -- Move the staged pickup assignment if there is one; else the intake pointer.
  UPDATE public.bin_assignments
     SET bin_id = p_bin_id
   WHERE lot_id = p_lot_id AND status = 'staged';

  IF FOUND THEN
    v_moved := 'staged';
  ELSE
    UPDATE public.lots
       SET intake_bin_id = p_bin_id, updated_at = now()
     WHERE id = p_lot_id;
    v_moved := 'intake';
  END IF;

  RETURN json_build_object('ok', true, 'moved', v_moved, 'lot_id', p_lot_id, 'bin_id', p_bin_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.audit_relocate_lot(uuid, uuid) TO authenticated;

COMMIT;
