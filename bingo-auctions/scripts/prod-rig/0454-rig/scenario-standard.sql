-- Standard-lot flows, run on identical seeds BEFORE 0454 and AFTER 0454.
-- The output must be byte-identical. Every statement is its own transaction
-- (psql autocommit), like real RPC / console calls.
-- First the per_unit rows are removed, so this copy has the shape prod has
-- today (0 per_unit auctions, 0 lots with unit_qty).
\set ON_ERROR_STOP 1
\pset format unaligned
\pset tuples_only on
\i /work/sq4-0454/helpers.sql

SET session_replication_role = replica;
DELETE FROM bids WHERE lot_id IN (SELECT id FROM lots WHERE unit_qty IS NOT NULL);
DELETE FROM lots WHERE unit_qty IS NOT NULL;
DELETE FROM auctions WHERE bid_mode = 'per_unit';
SET session_replication_role = origin;

CREATE TEMP TABLE out (n serial, line text);
CREATE TEMP TABLE kids (step text, id uuid);

-- 1. Console "new lot" straight into a draft auction; one into inventory.
INSERT INTO out(line) SELECT pg_temp.try('new lot in A1', format($q$INSERT INTO lots (operator_id, warehouse_id, auction_id, title, lot_code, status, starting_bid_cents)
  VALUES ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1', %L, 'SN1 new', 'SN1', 'draft', 700) RETURNING lot_code$q$, pg_temp.auc('A1')));
INSERT INTO out(line) SELECT pg_temp.try('new lot, inventory', $q$INSERT INTO lots (operator_id, warehouse_id, title, lot_code, status, starting_bid_cents)
  VALUES ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1', 'SN2 new', 'SN2', 'in_inventory', 100) RETURNING lot_code$q$);

-- 2. Builder assign (assign_lots_to_auction), admin and manager.
SELECT pg_temp.who('admin');
INSERT INTO out(line) SELECT pg_temp.try('assign SI1+SI2 -> A2', format('SELECT string_agg(lot_code || ''#'' || lot_number, '','') FROM assign_lots_to_auction(%L, ARRAY[%L,%L]::uuid[])', pg_temp.auc('A2'), pg_temp.lot('SI1'), pg_temp.lot('SI2')));
INSERT INTO out(line) SELECT pg_temp.try('assign SI3 -> A1', format('SELECT string_agg(lot_code || ''#'' || lot_number, '','') FROM assign_lots_to_auction(%L, ARRAY[%L]::uuid[])', pg_temp.auc('A1'), pg_temp.lot('SI3')));
INSERT INTO out(line) SELECT pg_temp.try('assign SD1 (already in one)', format('SELECT string_agg(lot_code, '','') FROM assign_lots_to_auction(%L, ARRAY[%L]::uuid[])', pg_temp.auc('A1'), pg_temp.lot('SD1')));
INSERT INTO out(line) SELECT pg_temp.try('assign SI5 -> A3 live', format('SELECT string_agg(lot_code, '','') FROM assign_lots_to_auction(%L, ARRAY[%L]::uuid[])', pg_temp.auc('A3'), pg_temp.lot('SI5')));
SELECT pg_temp.who('manager');
INSERT INTO out(line) SELECT pg_temp.try('assign SI4 -> A5 (manager)', format('SELECT string_agg(lot_code || ''#'' || lot_number, '','') FROM assign_lots_to_auction(%L, ARRAY[%L]::uuid[])', pg_temp.auc('A5'), pg_temp.lot('SI4')));

-- 3. Lot edits: starting price, title, a same-value auction_id, a same-value unit_qty/unit_label.
INSERT INTO out(line) SELECT pg_temp.try('SD1 start 250', $q$UPDATE lots SET starting_bid_cents = 250 WHERE lot_code = 'SD1' RETURNING starting_bid_cents::text$q$);
INSERT INTO out(line) SELECT pg_temp.try('SD1 title', $q$UPDATE lots SET title = 'SD1 renamed' WHERE lot_code = 'SD1' RETURNING title$q$);
INSERT INTO out(line) SELECT pg_temp.try('SD1 auction_id = auction_id', $q$UPDATE lots SET auction_id = auction_id WHERE lot_code = 'SD1' RETURNING lot_code$q$);
INSERT INTO out(line) SELECT pg_temp.try('SI5 qty/label NULL again', $q$UPDATE lots SET unit_qty = NULL, unit_label = NULL WHERE lot_code = 'SI5' RETURNING lot_code$q$);
INSERT INTO out(line) SELECT pg_temp.try('SL1 (live) start 150', $q$UPDATE lots SET starting_bid_cents = 150 WHERE lot_code = 'SL1' RETURNING starting_bid_cents::text$q$);

-- 4. Take a lot out of its auction.
INSERT INTO out(line) SELECT pg_temp.try('SI4 out of A5', $q$UPDATE lots SET auction_id = NULL, lot_number = NULL, status = 'in_inventory' WHERE lot_code = 'SI4' RETURNING lot_code$q$);

-- 5. Relists: desk 2-arg into an auction and into inventory, staff-app 3-arg, refused one.
SELECT pg_temp.who('admin');
INSERT INTO out(line) SELECT pg_temp.try('relist SU1 -> A1', format('SELECT pg_temp.code(relist_lot_into_auction(%L, %L))', pg_temp.lot('SU1'), pg_temp.auc('A1')));
INSERT INTO out(line) SELECT pg_temp.try('relist SU4 -> inventory', format('SELECT pg_temp.code(relist_lot_into_auction(%L, NULL))', pg_temp.lot('SU4')));
INSERT INTO out(line) SELECT pg_temp.try('relot SU3 -> A2 (3-arg)', format('SELECT pg_temp.code(relist_lot_into_auction(%L, %L, NULL))', pg_temp.lot('SU3'), pg_temp.auc('A2')));
INSERT INTO out(line) SELECT pg_temp.try('relist SL1 (live)', format('SELECT pg_temp.code(relist_lot_into_auction(%L, %L))', pg_temp.lot('SL1'), pg_temp.auc('A1')));
INSERT INTO out(line) SELECT pg_temp.try('relist SU1 again', format('SELECT pg_temp.code(relist_lot_into_auction(%L, %L))', pg_temp.lot('SU1'), pg_temp.auc('A1')));

-- 6. Auto-relist cron (SU2 is the only unsold lot left).
SELECT pg_temp.who('none');
INSERT INTO out(line) SELECT pg_temp.try('auto_relist', $q$SELECT (auto_relist_unsold_lots() - 'at')::text$q$);

-- 7. Duplicate (staff app), a bid on a standard lot.
SELECT pg_temp.who('admin');
INSERT INTO out(line) SELECT pg_temp.try('duplicate SI5', format('SELECT (duplicate_lot(%L) ? ''lot_id'')::text', pg_temp.lot('SI5')));
SELECT pg_temp.who('b2');
INSERT INTO out(line) SELECT pg_temp.try('bid SL1 2-arg', format('SELECT (r).ok || '' '' || (r).reason || '' '' || (r).current_bid_cents FROM (SELECT place_bid(%L, 1000) r) x', pg_temp.lot('SL1')));
INSERT INTO out(line) SELECT pg_temp.try('bid SL1 3-arg', format('SELECT (r).ok || '' '' || (r).reason || '' '' || (r).current_bid_cents FROM (SELECT place_bid(%L, 1500, NULL) r) x', pg_temp.lot('SL1')));

-- 8. Auction edits: title, a same-value bid_mode, draft -> scheduled.
INSERT INTO out(line) SELECT pg_temp.try('A5 title', $q$UPDATE auctions SET title = 'A5 renamed' WHERE title = 'A5 std draft empty' RETURNING title$q$);
INSERT INTO out(line) SELECT pg_temp.try('A3 (live) bid_mode = standard', $q$UPDATE auctions SET bid_mode = 'standard' WHERE title = 'A3 std live' RETURNING bid_mode$q$);
INSERT INTO out(line) SELECT pg_temp.try('A1 -> scheduled', $q$UPDATE auctions SET status = 'scheduled' WHERE title = 'A1 std draft' RETURNING status::text$q$);

-- Results, then the final state of every lot and auction.
SELECT 'CALL ' || line FROM out ORDER BY n;
SELECT 'LOT ' || pg_temp.lotrow(lot_code) FROM lots ORDER BY lot_code;
SELECT 'AUC ' || split_part(title, ' ', 1) || ' ' || status || ' ' || bid_mode || ' ' || coalesce(unit_start_cents::text, '-') FROM auctions ORDER BY title;
SELECT 'COUNT lots=' || (SELECT count(*) FROM lots) || ' bids=' || (SELECT count(*) FROM bids)
    || ' status_history=' || (SELECT count(*) FROM lot_status_history);
