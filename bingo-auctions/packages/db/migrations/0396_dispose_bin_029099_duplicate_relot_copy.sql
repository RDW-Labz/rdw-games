-- footprint-exempt: disposes one stickerless relot copy (BIN-029099) that inherited the parent's shelf, so the assert would refuse; owner-approved 2026-10-06 after the shelf check
-- 0396 — dispose BIN-029099, an extra copy that a double relot made of the
--        Deilyn bed (parent BIN-014047). The bed itself is BIN-029098.
--
-- On 2026-09-27 at 13:02:28 CT and again at 13:02:47 CT, someone relotted
-- BIN-014047. The first relot made BIN-029098, which took the sticker
-- BRN4982227. It was sold, paid on 10/4, and handed over at the counter on
-- 10/5 at 13:48 CT. A shelf check on 10/6 confirmed the bed is gone from shelf
-- Right-02-01. The second relot made BIN-029099. It has no sticker, no bids,
-- no invoice and no auction. It reads "in inventory" on the same shelf, but
-- there is nothing physical behind it, so anyone who sold it would be selling a
-- bed that has already left. The relot guard missed the double tap because it
-- did not count in_inventory children; 0392 fixes that.
--
-- WHAT THIS DOES: for this one lot only, it does the same as Remove from
-- inventory (0319): status disposed, removal_kind other, removed_at, a note,
-- and the disposal flag. It writes one operator_audit_log row with the reason
-- (lot.disposed_duplicate_copy, target = the lot).
-- It does not touch: BIN-029098, the parent, the customer's invoice (left as
-- is per Braden 2026-10-06), bins, or stickers.
--
-- GUARDED: every fact above is re-checked inside the transaction. If anything
-- differs, the migration aborts. A rerun after a successful apply is a NOTICE.
--
-- PHYSICAL FOOTPRINT (docs/PREFLIGHT.md): assert_no_physical_footprint() is
-- not called. It would refuse, because the copy inherited the parent's shelf
-- at relot. The lot lint flags this file for that reason, the same as 0382.
-- Owner sign-off: Braden 2026-10-06 ("Dispose BIN-029099 (the stickerless
-- copy) and log why"), after the shelf check.
--
-- Rollback: removal_kind is permanent (0319 trigger lots_removal_is_terminal),
-- so the way back is to put status and the flag back by hand, from the audit
-- row's before_state:
--   UPDATE lots SET status = 'in_inventory', flagged_for_disposal = false
--    WHERE id = 'a6c27c50-ae74-42ac-8d8f-5e6ba8cbf8bf';
-- Window (Rule 9): one inventory row that nobody can see in a sale. Any time
-- outside 18:00–22:00.

BEGIN;

DO $$
DECLARE
  v_id     uuid := 'a6c27c50-ae74-42ac-8d8f-5e6ba8cbf8bf';
  v_parent uuid := '462d04f1-eb2a-4561-b96d-04d50f80a723';
  v_real   uuid := 'dab0615a-95aa-494f-954c-c71fd7adc0e8';
  v_lot    lots%ROWTYPE;
  v_n      int;
BEGIN
  SELECT * INTO v_lot FROM lots WHERE id = v_id FOR UPDATE;
  IF v_lot.id IS NULL THEN
    RAISE NOTICE '0396: BIN-029099 not here, skipping';
    RETURN;
  END IF;
  IF v_lot.status = 'disposed' AND v_lot.removal_note LIKE 'duplicate relot copy%' THEN
    RAISE NOTICE '0396: already disposed, nothing to do';
    RETURN;
  END IF;

  IF NOT (v_lot.lot_code = 'BIN-029099'
          AND v_lot.status = 'in_inventory'
          AND v_lot.deleted_at IS NULL
          AND v_lot.sticker_code IS NULL
          AND v_lot.auction_id IS NULL
          AND v_lot.removal_kind IS NULL
          AND v_lot.relisted_from_lot_id = v_parent
          AND v_lot.bid_count = 0)
     OR EXISTS (SELECT 1 FROM bids WHERE lot_id = v_id)
     OR EXISTS (SELECT 1 FROM invoice_lots WHERE lot_id = v_id)
     OR EXISTS (SELECT 1 FROM lots WHERE relisted_from_lot_id = v_id AND deleted_at IS NULL)
     OR NOT EXISTS (
          SELECT 1 FROM lots r JOIN invoice_lots il ON il.lot_id = r.id
           WHERE r.id = v_real AND r.relisted_from_lot_id = v_parent
             AND r.sticker_raw_upper = 'BRN4982227' AND il.picked_up_at IS NOT NULL)
  THEN
    RAISE EXCEPTION '0396: BIN-029099 or its twin BIN-029098 no longer match what was checked on 2026-10-06; aborting';
  END IF;

  UPDATE lots
     SET status               = 'disposed',
         removal_kind         = 'other',
         removed_at           = now(),
         removal_note         = 'duplicate relot copy of BIN-014047 (double relot 2026-09-27 13:02 CT); the item is BIN-029098, sticker BRN4982227, handed over 2026-10-05. Mig 0396.',
         flagged_for_disposal = TRUE,
         flagged_at           = COALESCE(flagged_at, now()),
         flagged_reason       = COALESCE(flagged_reason, 'removed: duplicate relot copy'),
         updated_at           = now()
   WHERE id = v_id AND status = 'in_inventory';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0396: expected 1 lot, updated % — aborting', v_n;
  END IF;

  INSERT INTO operator_audit_log (operator_id, actor_user_id, action_type, target_id, before_state, after_state, reason_note)
  VALUES (v_lot.operator_id, NULL, 'lot.disposed_duplicate_copy', v_id,
          jsonb_build_object('lot_code', v_lot.lot_code, 'status', v_lot.status, 'intake_bin_id', v_lot.intake_bin_id,
                             'flagged_for_disposal', v_lot.flagged_for_disposal, 'relisted_from_lot_id', v_parent),
          jsonb_build_object('status', 'disposed', 'removal_kind', 'other', 'real_lot', 'BIN-029098'),
          'mig 0396: stickerless copy from a double relot of BIN-014047 (2026-09-27 13:02:28 and 13:02:47 CT). The bed is BIN-029098 (BRN4982227), handed over 2026-10-05 13:48 CT; shelf check 2026-10-06 found it gone. Approved by Braden 2026-10-06.');
END $$;

COMMIT;
