BEGIN;
DO $$
DECLARE
  v_batch CONSTANT uuid := 'bf0107e4-32d3-407e-b5e5-0cf7320b2751';
  v_bids bigint; v_lines bigint; v_pulled bigint;
BEGIN
  SELECT count(*) INTO v_bids FROM bids
   WHERE lot_id IN (SELECT id FROM lots WHERE lot_import_batch_id = v_batch);
  SELECT count(*) INTO v_lines FROM invoice_lots
   WHERE lot_id IN (SELECT id FROM lots WHERE lot_import_batch_id = v_batch);
  IF v_bids > 0 OR v_lines > 0 THEN
    RAISE EXCEPTION '0359: batch % now has % bid(s), % invoice line(s) — refusing to detach.',
      v_batch, v_bids, v_lines;
  END IF;

  WITH pulled AS (
    UPDATE lots SET status='in_inventory', auction_id=NULL, lot_number=NULL,
                    close_at=NULL, updated_at=now()
     WHERE lot_import_batch_id = v_batch AND auction_id IS NOT NULL
    RETURNING id
  ) SELECT count(*) INTO v_pulled FROM pulled;
  RAISE NOTICE '0359: detached % lot(s)', v_pulled;
END $$;
COMMIT;
