-- 0302 — audit_relocate_lot(): stop stranding pending_intake lots
--
-- ── The bug (reported 2026-07-29, lot BIN-001300 / sticker BRN:BRN4982038) ──
--
-- Staff found lots showing "Pending intake" in the operator UI while ALSO
-- showing a shelf location ("Bin Right-01-03"). Under the documented workflow
-- that is impossible: the only way to get a location is Put Away, and Put Away
-- flips pending_intake -> in_inventory in the same UPDATE.
--
-- Put Away was never the writer. `audit_relocate_lot` (mig 0248) was.
--
-- The Bin Audit screen ("Move here", apps/field-mobile/.../layout/bins/audit.tsx)
-- calls this RPC when staff scan an item in a bin that the system doesn't
-- record there. A lot that was lotted but never put away has
-- intake_bin_id = NULL, so the audit reads it as "extra / misplaced" and offers
-- "Move here". Tapping it ran:
--
--     UPDATE lots SET intake_bin_id = p_bin_id, updated_at = now()
--
-- — bin set, `status` / `warehouse_id` / `intake_at` untouched. The lot keeps
-- status pending_intake with a bin, warehouse_id NULL and intake_at NULL. That
-- exact fingerprint matched 84 lots in prod (every other status had
-- warehouse_id populated); the backfill is mig 0303.
--
-- Consequences: the item shows as still-needing-intake on the Inventory screen
-- forever, and its lot page renders a location with no warehouse ("— · Bin
-- Right-01-03"). It also never logs a lot_status_history row, so the lot
-- timeline shows only "Created" — which is why this went unnoticed for weeks.
-- Re-running Put Away by hand fixes one lot at a time (that is what staff did
-- on 2026-07-29), but the audit will keep minting new ones until this is fixed.
--
-- ── The fix ────────────────────────────────────────────────────────────────
--
-- Adopt the convention mig 0273/0295 already established for all three putaway
-- RPCs, verbatim: "pending_intake still flips to in_inventory; every other
-- status is location-only and its auction state is left untouched."
--
--   1. `warehouse_id` is ALWAYS synced to the target bin's warehouse. It is
--      derivable from the bin, so letting it drift (or stay NULL) is never
--      correct. This also closes a latent cross-warehouse bug: relocating a lot
--      into another warehouse's bin previously left warehouse_id pointing at
--      the old warehouse. (0 such rows in prod today — single-warehouse
--      operator — so this is prevention, not repair.)
--
--   2. `pending_intake` -> `in_inventory` + `intake_at = now()`. A staff member
--      standing at the shelf with the item in hand IS a put-away; recording the
--      shelf but not the intake was the defect. The `lots_status_history`
--      trigger picks the transition up automatically, so these now appear on
--      the lot timeline like any other binning.
--
-- Everything else is unchanged and deliberately so: lots in any other status
-- stay location-only (no status/auction/invoice writes), and a staged pickup
-- assignment still takes precedence over the intake pointer.

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
  v_bin bins%ROWTYPE;
  v_bin_operator uuid;
  v_moved text;
  v_intaked boolean := false;
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
  SELECT * INTO v_bin FROM public.bins WHERE id = p_bin_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bin_not_in_operator' USING ERRCODE = '42501';
  END IF;

  SELECT w.operator_id INTO v_bin_operator
  FROM public.warehouses w WHERE w.id = v_bin.warehouse_id;

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
    IF v_lot.status = 'pending_intake' THEN
      -- 0302: "Move here" on a never-put-away lot IS a put-away. Mirrors
      -- intake_lot_to_bin (mig 0273/0295) so the two paths agree.
      UPDATE public.lots
         SET intake_bin_id = p_bin_id,
             warehouse_id  = v_bin.warehouse_id,
             status        = 'in_inventory',
             intake_at     = now(),
             updated_at    = now()
       WHERE id = p_lot_id;
      v_intaked := true;
    ELSE
      -- LOCATION-ONLY for every other status. warehouse_id follows the bin;
      -- status / auction_id / bids / invoices are untouched.
      UPDATE public.lots
         SET intake_bin_id = p_bin_id,
             warehouse_id  = v_bin.warehouse_id,
             updated_at    = now()
       WHERE id = p_lot_id;
    END IF;
    v_moved := 'intake';
  END IF;

  RETURN json_build_object(
    'ok', true,
    'moved', v_moved,
    'intaked', v_intaked,
    'lot_id', p_lot_id,
    'bin_id', p_bin_id
  );
END;
$$;

GRANT EXECUTE ON FUNCTION public.audit_relocate_lot(uuid, uuid) TO authenticated;

COMMIT;
