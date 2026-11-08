-- 0395 — one line: clear the forfeit on PNK4822798 (lot BIN-027553) on invoice
--        a75d418a-d1c6-4cfd-b046-f0cf4c4e9d15, so staff can refund it.
--
-- The counter reported the item missing on 2026-10-05 at 16:38 CT (refund
-- queued, not yet resolved). At 18:00 CT the no-show sweep flipped the pickup to
-- forfeited and stamp_forfeited_invoice_lines() stamped this line forfeited too.
-- The refund form then greys a forfeited line out and the refund-items route
-- refuses it (lot_forfeited). The item was never the customer's to forfeit.
-- Read-only on prod 2026-10-06: this is the only unrefunded line in that state.
-- The code fix is 0393 + PR #429; this clears the one line that already happened.
--
-- Guarded: changes exactly this line, only while it is still forfeited, not
-- refunded, not picked up, and reported missing with the refund unresolved.
-- Anything else aborts. Logged in operator_audit_log (target_id = invoice id,
-- like refunds and forfeits). Rerun = NOTICE, no change.
-- Rollback: UPDATE invoice_lots SET forfeited_at = '<before_state.forfeited_at
-- from the audit row>' WHERE invoice_id = 'a75d418a-d1c6-4cfd-b046-f0cf4c4e9d15'
-- AND lot_id = (SELECT id FROM lots WHERE lot_code = 'BIN-027553');
-- Owner approval: Braden, 2026-10-06 ("yes, clear the forfeit on that one line. Log it.").

BEGIN;

DO $$
DECLARE
  v_inv  uuid := 'a75d418a-d1c6-4cfd-b046-f0cf4c4e9d15';
  v_lot  uuid;
  v_op   uuid;
  v_forf timestamptz;
  v_n    int;
BEGIN
  SELECT l.id INTO v_lot FROM lots l
   WHERE l.lot_code = 'BIN-027553' AND l.sticker_raw_upper = 'PNK4822798';
  IF v_lot IS NULL THEN
    RAISE NOTICE '0395: lot BIN-027553 / PNK4822798 not here, skipping';
    RETURN;
  END IF;

  SELECT il.forfeited_at, i.operator_id INTO v_forf, v_op
    FROM invoice_lots il JOIN invoices i ON i.id = il.invoice_id
   WHERE il.invoice_id = v_inv AND il.lot_id = v_lot
     AND il.forfeited_at IS NOT NULL
     AND il.refunded_at IS NULL
     AND il.picked_up_at IS NULL
     AND EXISTS (SELECT 1 FROM pickup_lot_outcomes o JOIN pickups p ON p.id = o.pickup_id
                  WHERE p.invoice_id = il.invoice_id AND o.lot_id = il.lot_id
                    AND o.outcome = 'missing' AND o.resolved_at IS NULL)
   FOR UPDATE OF il;
  IF v_forf IS NULL THEN
    IF EXISTS (SELECT 1 FROM invoice_lots WHERE invoice_id = v_inv AND lot_id = v_lot AND forfeited_at IS NULL) THEN
      RAISE NOTICE '0395: line is not forfeited (already applied?), nothing to do';
      RETURN;
    END IF;
    RAISE EXCEPTION '0395: line no longer matches (refunded, picked up, or missing report resolved) — aborting';
  END IF;

  UPDATE invoice_lots SET forfeited_at = NULL
   WHERE invoice_id = v_inv AND lot_id = v_lot AND forfeited_at = v_forf;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 1 THEN
    RAISE EXCEPTION '0395: expected 1 line, updated % — aborting', v_n;
  END IF;

  INSERT INTO operator_audit_log (operator_id, actor_user_id, action_type, target_id, before_state, after_state, reason_note)
  VALUES (v_op, NULL, 'invoice_line.forfeit_cleared', v_inv,
          jsonb_build_object('lot_id', v_lot, 'lot_code', 'BIN-027553', 'sticker', 'PNK4822798', 'forfeited_at', v_forf),
          jsonb_build_object('lot_id', v_lot, 'forfeited_at', NULL),
          'mig 0395: reported missing 2026-10-05 16:38 CT, auto-forfeited 18:00 CT by the no-show sweep; forfeit cleared so the missing item can be refunded. Approved by Braden 2026-10-06.');
END $$;

COMMIT;
