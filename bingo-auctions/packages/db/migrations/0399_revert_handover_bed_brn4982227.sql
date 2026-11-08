-- 0399 — undo a mistaken counter handover: BIN-029098 (BRN4982227, Deilyn bed)
--        on invoice 4372a705-1712-435a-ad8d-df65e1a9c003 goes back to "paid,
--        awaiting pickup", so it shows on Pickups and staff can check it out.
--
-- What happened: on 2026-10-05 at 13:48:34 CT the staff admin account
-- 404d0e6b (bingoauctions.jared@gmail.com, the shared admin login) recorded a
-- partial handover of BIN-029098 at the counter (audit pickup.partial_handover,
-- handed_over_codes ["BIN-029098"]). That stamped invoice_lots.picked_up_at,
-- and Pickups hides a line once it is stamped. The bed was never handed over.
-- On 2026-10-07 it is physically in the warehouse by checkout (Braden). The
-- stickerless copy BIN-029099 was disposed by 0396; that stays correct.
--
-- WHAT IT DOES: for this one line only, clears picked_up_at and picked_up_by,
-- and writes one operator_audit_log row (invoice_line.handover_reverted,
-- target = invoice) with the before values. No lot, invoice total, pickup or
-- payment changes. The pickup itself is still open (checked_in), so the line
-- reappears on it.
--
-- GUARDS (re-checked here; anything else aborts): invoice status paid or
-- partially_refunded and paid_at set; lot BIN-029098 status won, not disposed,
-- sticker BRN4982227; the line is not refunded and not forfeited; it is still
-- stamped handed over at exactly 2026-10-05 18:48:34.320071+00 by 404d0e6b;
-- the pickup is still checked_in. Rerun after success: NOTICE, no change.
--
-- ROLLBACK: 0399_ROLLBACK_revert_handover_bed_brn4982227.sql restores both
-- stamps from this file's audit row (standby branch).
-- WINDOW: one invoice line; fixes something broken for a waiting customer.
-- Any hour (CLAUDE.md Rule 9: "fix it now" for a bug actively costing money).

BEGIN;

DO $$
DECLARE
  v_inv  uuid := '4372a705-1712-435a-ad8d-df65e1a9c003';
  v_by   uuid := '404d0e6b-d3b4-445f-9ef4-b94679dc4ea9';
  v_at   timestamptz := '2026-10-05 18:48:34.320071+00';
  v_lot  uuid;
  v_op   uuid;
  v_n    int;
BEGIN
  SELECT l.id INTO v_lot FROM lots l
   WHERE l.lot_code = 'BIN-029098' AND l.sticker_raw_upper = 'BRN4982227';
  IF v_lot IS NULL THEN
    RAISE NOTICE '0399: BIN-029098 not here, skipping';
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM invoice_lots WHERE invoice_id = v_inv AND lot_id = v_lot AND picked_up_at IS NULL)
     AND EXISTS (SELECT 1 FROM operator_audit_log WHERE target_id = v_inv AND action_type = 'invoice_line.handover_reverted') THEN
    RAISE NOTICE '0399: already reverted, nothing to do';
    RETURN;
  END IF;

  SELECT i.operator_id INTO v_op
    FROM invoices i
    JOIN invoice_lots il ON il.invoice_id = i.id AND il.lot_id = v_lot
    JOIN lots l ON l.id = il.lot_id
   WHERE i.id = v_inv
     AND i.status::text IN ('paid', 'partially_refunded') AND i.paid_at IS NOT NULL
     AND l.status = 'won' AND l.removal_kind IS NULL AND l.deleted_at IS NULL
     AND il.refunded_at IS NULL AND il.forfeited_at IS NULL
     AND il.picked_up_at = v_at AND il.picked_up_by = v_by
     AND EXISTS (SELECT 1 FROM pickups p WHERE p.invoice_id = i.id AND p.status::text = 'checked_in')
   FOR UPDATE OF il;
  IF v_op IS NULL THEN
    RAISE EXCEPTION '0399: invoice/line/lot/pickup no longer match what was checked on 2026-10-07; nothing changed';
  END IF;

  INSERT INTO operator_audit_log (operator_id, actor_user_id, action_type, target_id, before_state, after_state, reason_note)
  VALUES (v_op, NULL, 'invoice_line.handover_reverted', v_inv,
          jsonb_build_object('lot_id', v_lot, 'lot_code', 'BIN-029098', 'sticker', 'BRN4982227', 'picked_up_at', v_at, 'picked_up_by', v_by),
          jsonb_build_object('lot_id', v_lot, 'picked_up_at', NULL, 'picked_up_by', NULL),
          'mig 0399: the 2026-10-05 13:48 CT counter handover of BIN-029098 was recorded in error; the bed is in the warehouse by checkout (2026-10-07). Back to awaiting pickup. Approved by Braden 2026-10-07.');

  UPDATE invoice_lots SET picked_up_at = NULL, picked_up_by = NULL
   WHERE invoice_id = v_inv AND lot_id = v_lot AND picked_up_at = v_at;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0399: expected 1 line, updated %; aborting', v_n;
  END IF;
END $$;

COMMIT;
