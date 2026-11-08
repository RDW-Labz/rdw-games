-- footprint-exempt: records one shelf-checked lot (BIN-031005) as missing; guarded below; owner-approved 2026-10-08
-- 0403 — BIN-031005 (TEA4841964, item 23) is missing after all.
--
-- 0397 (applied 2026-10-08 11:52 CT) left the stickered BIN-031005 in inventory
-- on shelf 12-12-01 because the box was reported found. Jared now confirms it is
-- not there. Record it the way 0352 records a box that can't be found: status
-- disposed, removal_kind 'missing'. That takes it out of rotation; if the box
-- turns up, staff re-lot it (the normal found path). Its copies BIN-031006 and
-- BIN-031438 were already disposed by 0397.
--
-- GUARDS (anything else aborts): BIN-031005 exists, not deleted, status
-- in_inventory, sticker TEA4841964, no removal recorded, 0 bids (bids table and
-- bid_count), not in any auction, no invoice line, no live relist child.
-- One operator_audit_log row (lot.marked_missing). Rerun after success: NOTICE.
-- ROLLBACK: none by SQL (0319 makes a removal permanent); a found box is re-lotted.
-- WINDOW: one inventory row nobody can see in a sale; any time outside 18:00–22:00.

BEGIN;

DO $$
DECLARE
  v_lot lots%ROWTYPE;
  v_n   int;
BEGIN
  SELECT * INTO v_lot FROM lots WHERE lot_code = 'BIN-031005' FOR UPDATE;
  IF v_lot.id IS NULL THEN
    RAISE NOTICE '0403: BIN-031005 not here, skipping';
    RETURN;
  END IF;
  IF v_lot.status = 'disposed' AND v_lot.removal_kind::text = 'missing' AND v_lot.removal_note LIKE '%mig 0403%' THEN
    RAISE NOTICE '0403: already applied, nothing to do';
    RETURN;
  END IF;
  IF v_lot.deleted_at IS NOT NULL
     OR v_lot.status <> 'in_inventory'
     OR v_lot.removal_kind IS NOT NULL
     OR v_lot.sticker_raw_upper IS DISTINCT FROM 'TEA4841964'
     OR coalesce(v_lot.bid_count, 0) <> 0
     OR v_lot.auction_id IS NOT NULL
     OR EXISTS (SELECT 1 FROM bids b WHERE b.lot_id = v_lot.id)
     OR EXISTS (SELECT 1 FROM invoice_lots il WHERE il.lot_id = v_lot.id)
     OR EXISTS (SELECT 1 FROM lots k WHERE k.relisted_from_lot_id = v_lot.id AND k.deleted_at IS NULL AND k.status::text NOT IN ('disposed', 'canceled'))
  THEN
    RAISE EXCEPTION '0403: BIN-031005 no longer matches (status %, auction %, removal %); nothing changed',
      v_lot.status, v_lot.auction_id, v_lot.removal_kind;
  END IF;

  INSERT INTO operator_audit_log (operator_id, actor_user_id, action_type, target_id, before_state, after_state, reason_note)
  VALUES (v_lot.operator_id, NULL, 'lot.marked_missing', v_lot.id,
          jsonb_build_object('lot_code', v_lot.lot_code, 'status', v_lot.status, 'intake_bin_id', v_lot.intake_bin_id, 'sticker', v_lot.sticker_raw_upper),
          jsonb_build_object('status', 'disposed', 'removal_kind', 'missing'),
          'mig 0403: item 23 box (TEA4841964) not on shelf 12-12-01 after all (Jared, 2026-10-08). Approved by Braden 2026-10-08.');

  UPDATE lots
     SET status               = 'disposed',
         removal_kind         = 'missing',
         removed_at           = now(),
         removal_note         = 'not found on shelf 12-12-01 (item 23, Jared 2026-10-08). mig 0403',
         flagged_for_disposal = TRUE,
         flagged_at           = COALESCE(flagged_at, now()),
         flagged_reason       = COALESCE(flagged_reason, 'removed: missing'),
         updated_at           = now()
   WHERE id = v_lot.id AND status = 'in_inventory';
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0403: expected 1 lot, updated %; aborting', v_n;
  END IF;
END $$;

COMMIT;
