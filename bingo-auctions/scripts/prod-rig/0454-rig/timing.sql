-- Standard-lot cost of the 0454 trigger: same work BEFORE and AFTER.
-- Prints one line: assign_ms update_start_ms relist_ms insert_ms
--   assign: 500 in-inventory lots, one assign_lots_to_auction call
--   update: starting_bid_cents on 2000 lots (those 500 + 1500 in inventory), one UPDATE
--   relist: 300 unsold lots, one relist_lot_into_auction call each
--   insert: 2000 new lots straight into a draft auction, one INSERT
\set ON_ERROR_STOP 1
\pset format unaligned
\pset tuples_only on
SET session_replication_role = replica;
INSERT INTO lots (operator_id, warehouse_id, title, lot_code, status, starting_bid_cents)
SELECT '00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1', 'T' || g, 'TA' || g, 'in_inventory', 100 FROM generate_series(1, 2000) g;
INSERT INTO lots (operator_id, warehouse_id, auction_id, title, lot_code, lot_number, status, starting_bid_cents, close_at)
SELECT '00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000f4', 'U' || g, 'TU' || g, 100 + g, 'unsold', 100, now() FROM generate_series(1, 300) g;
SET session_replication_role = origin;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', false);

CREATE TEMP TABLE t (k text, ms numeric);
DO $$
DECLARE s timestamptz; ids uuid[]; r record;
BEGIN
  SELECT array_agg(id ORDER BY lot_code) INTO ids FROM (SELECT id, lot_code FROM lots WHERE lot_code LIKE 'TA%' ORDER BY lot_code LIMIT 500) x;
  s := clock_timestamp();
  PERFORM count(*) FROM assign_lots_to_auction('00000000-0000-0000-0000-0000000000f5', ids);
  INSERT INTO t VALUES ('assign', extract(epoch FROM clock_timestamp() - s) * 1000);
  s := clock_timestamp();
  UPDATE lots SET starting_bid_cents = 200 WHERE lot_code LIKE 'TA%';
  INSERT INTO t VALUES ('update', extract(epoch FROM clock_timestamp() - s) * 1000);
  s := clock_timestamp();
  FOR r IN SELECT id FROM lots WHERE lot_code LIKE 'TU%' ORDER BY lot_code LOOP
    PERFORM relist_lot_into_auction(r.id, '00000000-0000-0000-0000-0000000000f1');
  END LOOP;
  INSERT INTO t VALUES ('relist', extract(epoch FROM clock_timestamp() - s) * 1000);
  s := clock_timestamp();
  INSERT INTO lots (operator_id, warehouse_id, auction_id, title, lot_code, status, starting_bid_cents)
  SELECT '00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000f6', 'N' || g, 'TN' || g, 'draft', 100 FROM generate_series(1, 2000) g;
  INSERT INTO t VALUES ('insert', extract(epoch FROM clock_timestamp() - s) * 1000);
END $$;
SELECT string_agg(round(ms)::text, ' ' ORDER BY array_position(ARRAY['assign','update','relist','insert'], k)) FROM t;
