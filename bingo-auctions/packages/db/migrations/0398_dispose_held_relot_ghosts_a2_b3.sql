-- footprint-exempt: disposes two lots with nothing physical behind them (a stickerless relot copy, and a stickered ghost whose item left with a buyer); guarded below; owner-approved, applied only after Jared confirms the boxes
-- 0398 — the two held items from the 2026-10-06 shelf check (split from 0397).
--
-- HOLD: apply only after Jared confirms that neither box is on its shelf
-- (7-16-02 holds 25 boxes, Right-04-11 holds 10; the check on 10/6 could not
-- yet say whether these two are among them).
--
--   A2: dispose copy BIN-021730 (no sticker). Its real lot BIN-021729
--       (TEA4957997) was handed over 2026-09-29. Shelf 7-16-02.
--   B3: dispose BIN-021034 (BRN4981331). Here the stickerless COPY BIN-021039
--       was the one sold and handed over 2026-10-02, so the stickered lot is the
--       ghost. Its sticker stays on the row and is named in the audit record.
--       Shelf Right-04-11.
--
-- GUARDS (any failure aborts and names the BIN):
--   BIN-021730: in_inventory, no sticker, 0 bids, not in an auction, no invoice
--     line, no relist child, same parent as BIN-021729, which is on an
--     invoice and handed over.
--   BIN-021034: in_inventory, sticker present, 0 bids, not in an auction, no
--     invoice line, no relist child, same parent as BIN-021039, which is on an
--     invoice and handed over.
-- Rerun after a successful apply: NOTICE, no change.
-- ROLLBACK: none. A removal is permanent (0319 lots_removal_is_terminal), and
-- neither lot has a box behind it. If a box does turn up, re-lot it.
-- WINDOW (Rule 9): staff-visible inventory rows only. Any time outside 18:00–22:00.

BEGIN;

DO $$
DECLARE
  v_bad  text[] := ARRAY[]::text[];
  v_done int;
  v_n    int;
  r      record;
BEGIN
  SELECT count(*) INTO v_done FROM lots
   WHERE lot_code IN ('BIN-021730', 'BIN-021034') AND removal_note LIKE '%mig 0398%';
  IF v_done = 2 THEN
    RAISE NOTICE '0398: already applied, nothing to do';
    RETURN;
  ELSIF v_done > 0 THEN
    RAISE EXCEPTION '0398: 1 of 2 lots already carries the 0398 tag; state is mixed, aborting';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM lots WHERE lot_code = 'BIN-021034') THEN
    RAISE NOTICE '0398: these lots are not in this database, skipping';
    RETURN;
  END IF;

  FOR r IN
    SELECT * FROM (VALUES ('BIN-021730', 'BIN-021729', false), ('BIN-021034', 'BIN-021039', true)) AS t(code, twin, stickered)
  LOOP
    IF NOT EXISTS (
         SELECT 1 FROM lots g JOIN lots w ON w.lot_code = r.twin AND w.relisted_from_lot_id = g.relisted_from_lot_id
          WHERE g.lot_code = r.code
            AND g.deleted_at IS NULL
            AND g.status = 'in_inventory'
            AND g.removal_kind IS NULL
            AND (g.sticker_code IS NOT NULL) = r.stickered
            AND coalesce(g.bid_count, 0) = 0
            AND g.auction_id IS NULL
            AND NOT EXISTS (SELECT 1 FROM bids b WHERE b.lot_id = g.id)
            AND NOT EXISTS (SELECT 1 FROM invoice_lots il WHERE il.lot_id = g.id)
            AND NOT EXISTS (SELECT 1 FROM lots k WHERE k.relisted_from_lot_id = g.id AND k.deleted_at IS NULL)
            AND EXISTS (SELECT 1 FROM invoice_lots il WHERE il.lot_id = w.id AND il.picked_up_at IS NOT NULL))
    THEN
      v_bad := v_bad || (r.code || ' (twin ' || r.twin || ')');
    END IF;
  END LOOP;
  PERFORM 1 FROM lots WHERE lot_code IN ('BIN-021730', 'BIN-021034') FOR UPDATE;
  IF array_length(v_bad, 1) IS NOT NULL THEN
    RAISE EXCEPTION '0398: precheck failed for %; nothing changed', array_to_string(v_bad, ', ');
  END IF;

  FOR r IN
    SELECT * FROM (VALUES
      ('BIN-021730', 'lot.disposed_duplicate_copy',
       'stickerless double-relot copy; its real lot BIN-021729 (TEA4957997) was handed over 2026-09-29; shelf 7-16-02'),
      ('BIN-021034', 'lot.disposed',
       'ghost of sticker BRN4981331: the item left with the buyer of copy BIN-021039 (handed over 2026-10-02); shelf Right-04-11')
    ) AS d(code, action, why)
  LOOP
    INSERT INTO operator_audit_log (operator_id, actor_user_id, action_type, target_id, before_state, after_state, reason_note)
    SELECT l.operator_id, NULL, r.action, l.id,
           jsonb_build_object('lot_code', l.lot_code, 'status', l.status, 'intake_bin_id', l.intake_bin_id, 'sticker', l.sticker_raw_upper, 'sticker_code', l.sticker_code),
           jsonb_build_object('status', 'disposed', 'removal_kind', 'other'),
           'mig 0398: ' || r.why || '; confirmed by Jared. Approved by Braden.'
      FROM lots l WHERE l.lot_code = r.code;
    UPDATE lots
       SET status               = 'disposed',
           removal_kind         = 'other',
           removed_at           = now(),
           removal_note         = r.why || '. mig 0398',
           flagged_for_disposal = TRUE,
           flagged_at           = COALESCE(flagged_at, now()),
           flagged_reason       = COALESCE(flagged_reason, 'removed: other'),
           updated_at           = now()
     WHERE lot_code = r.code AND status = 'in_inventory';
  END LOOP;

  SELECT count(*) INTO v_n FROM lots WHERE lot_code IN ('BIN-021730', 'BIN-021034') AND status = 'disposed' AND removal_note LIKE '%mig 0398%';
  IF v_n <> 2 THEN
    RAISE EXCEPTION '0398: expected 2 lots disposed, got %; aborting', v_n;
  END IF;
END $$;

COMMIT;
