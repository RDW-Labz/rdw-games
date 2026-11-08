-- Every 0454 guard case, AFTER 0454, on the full seed (standard + per_unit).
-- Each line prints PASS/FAIL; run.sh counts FAIL lines. Each statement is
-- its own transaction, like real calls.
\set ON_ERROR_STOP 1
\pset format unaligned
\pset tuples_only on
\i /work/sq4-0454/helpers.sql

CREATE FUNCTION pg_temp.is(p_label text, p_got text, p_want text) RETURNS text LANGUAGE sql AS
$$ SELECT CASE WHEN p_got IS NOT DISTINCT FROM p_want THEN 'PASS ' ELSE 'FAIL ' END
          || p_label || ': ' || coalesce(p_got, 'NULL') || CASE WHEN p_got IS DISTINCT FROM p_want THEN '  (want ' || coalesce(p_want, 'NULL') || ')' ELSE '' END $$;
CREATE FUNCTION pg_temp.assign(p_auc text, VARIADIC p_codes text[]) RETURNS text LANGUAGE sql AS
$$ SELECT format('SELECT string_agg(lot_code || ''#'' || lot_number, '','') FROM assign_lots_to_auction(%L, %L::uuid[])',
                 pg_temp.auc(p_auc), (SELECT array_agg(pg_temp.lot(c)) FROM unnest(p_codes) c)) $$;
CREATE FUNCTION pg_temp.relist(p_code text, p_auc text) RETURNS text LANGUAGE sql AS
$$ SELECT format('SELECT pg_temp.code(relist_lot_into_auction(%L, %L))', pg_temp.lot(p_code), pg_temp.auc(p_auc)) $$;
CREATE FUNCTION pg_temp.child(p_code text) RETURNS text LANGUAGE sql VOLATILE AS
$$ SELECT c.lot_code FROM lots c WHERE c.relisted_from_lot_id = pg_temp.lot(p_code) ORDER BY c.created_at DESC LIMIT 1 $$;
CREATE FUNCTION pg_temp.f(p_code text) RETURNS text LANGUAGE sql VOLATILE AS
$$ SELECT l.status || ' auc=' || coalesce(split_part(a.title, ' ', 1), '-') || ' start=' || l.starting_bid_cents
          || ' qty=' || coalesce(l.unit_qty::text, '-') || ' label=' || coalesce(l.unit_label, '-')
     FROM lots l LEFT JOIN auctions a ON a.id = l.auction_id WHERE l.lot_code = p_code $$;

SELECT pg_temp.who('admin');

\echo '--- 1. quantity and unit go together'
SELECT pg_temp.expect('Q1 qty without unit', $q$UPDATE lots SET unit_qty = 50 WHERE lot_code = 'SI4' RETURNING lot_code$q$, 'sqft_qty_label_pair');
SELECT pg_temp.expect('Q2 unit without qty', $q$UPDATE lots SET unit_label = 'sq ft' WHERE lot_code = 'SI4' RETURNING lot_code$q$, 'sqft_qty_label_pair');
SELECT pg_temp.expect('Q3 new lot with qty only', $q$INSERT INTO lots (operator_id, warehouse_id, title, lot_code, status, unit_qty)
  VALUES ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','Q3','Q3','in_inventory', 10) RETURNING lot_code$q$, 'sqft_qty_label_pair');
SELECT pg_temp.expect('Q4 both, lot in inventory', $q$UPDATE lots SET unit_qty = 50, unit_label = 'sq ft' WHERE lot_code = 'SI4' RETURNING lot_code$q$, 'ok');
SELECT pg_temp.expect('Q5 both cleared again', $q$UPDATE lots SET unit_qty = NULL, unit_label = NULL WHERE lot_code = 'SI4' RETURNING lot_code$q$, 'ok');
SELECT pg_temp.is('Q5 SI4 after', pg_temp.f('SI4'), 'in_inventory auc=- start=100 qty=- label=-');

\echo '--- 2. lock: no sq ft change once live, won, bid on, or auction live/closed'
SELECT pg_temp.expect('L1 UL1 live+bid: qty', $q$UPDATE lots SET unit_qty = 250 WHERE lot_code = 'UL1' RETURNING lot_code$q$, 'sqft_locked');
SELECT pg_temp.expect('L2 UL1 live+bid: unit', $q$UPDATE lots SET unit_label = 'sq m' WHERE lot_code = 'UL1' RETURNING lot_code$q$, 'sqft_locked');
SELECT pg_temp.expect('L3 UB1 bid, auction draft', $q$UPDATE lots SET unit_qty = 250 WHERE lot_code = 'UB1' RETURNING lot_code$q$, 'sqft_locked');
SELECT pg_temp.expect('L4 UU1 no bids, auction closed', $q$UPDATE lots SET unit_qty = 150 WHERE lot_code = 'UU1' RETURNING lot_code$q$, 'sqft_locked');
SELECT pg_temp.expect('L5 SL1 standard live+bid: add sq ft', $q$UPDATE lots SET unit_qty = 10, unit_label = 'sq ft' WHERE lot_code = 'SL1' RETURNING lot_code$q$, 'sqft_locked');
SELECT pg_temp.expect('L6 SB7 standard bid, auction scheduled: add sq ft', $q$UPDATE lots SET unit_qty = 10, unit_label = 'sq ft' WHERE lot_code = 'SB7' RETURNING lot_code$q$, 'sqft_locked');
SELECT pg_temp.expect('L7 message is plain', $q$UPDATE lots SET unit_qty = 250 WHERE lot_code = 'UL1' RETURNING lot_code$q$, 'The sq ft on this lot can''t change once it is live or has bids.');
SELECT pg_temp.is('L8 UL1 unchanged', pg_temp.f('UL1'), 'live auc=P3 start=1235 qty=247 label=sq ft');
SELECT pg_temp.expect('L9 UL1 title edit still fine', $q$UPDATE lots SET title = 'UL1 247 sq ft tile (edited)' WHERE lot_code = 'UL1' RETURNING lot_code$q$, 'ok');
SELECT pg_temp.expect('L10 US1 scheduled, no bids: qty 200 -> 250', $q$UPDATE lots SET unit_qty = 250 WHERE lot_code = 'US1' RETURNING starting_bid_cents::text$q$, 'ok');
SELECT pg_temp.is('L11 US1 keeps 10c/sq ft, total follows', pg_temp.f('US1'), 'scheduled auc=P2 start=2500 qty=250 label=sq ft');

\echo '--- 3. per_unit starting price stays a whole number of cents per unit'
SELECT pg_temp.expect('S1 UD1 start 12.36 (247 sq ft)', $q$UPDATE lots SET starting_bid_cents = 1236 WHERE lot_code = 'UD1' RETURNING lot_code$q$, 'sqft_start_not_whole');
SELECT pg_temp.expect('S2 message is plain', $q$UPDATE lots SET starting_bid_cents = 1236 WHERE lot_code = 'UD1' RETURNING lot_code$q$, 'A starting price of $12.36 doesn''t split evenly over 247 sq ft. Set a starting price per sq ft on the lot or the auction.');
SELECT pg_temp.expect('S3 UD1 start 24.70', $q$UPDATE lots SET starting_bid_cents = 2470 WHERE lot_code = 'UD1' RETURNING starting_bid_cents::text$q$, 'ok');
SELECT pg_temp.expect('S4 UD1 drop its sq ft while in P1', $q$UPDATE lots SET unit_qty = NULL, unit_label = NULL WHERE lot_code = 'UD1' RETURNING lot_code$q$, 'sqft_auction_needs_qty');
SELECT pg_temp.expect('S5 SD1 standard start 1.37 still fine', $q$UPDATE lots SET starting_bid_cents = 137 WHERE lot_code = 'SD1' RETURNING starting_bid_cents::text$q$, 'ok');

\echo '--- 4. mode match on assign (assign_lots_to_auction)'
SELECT pg_temp.expect('M1 per-unit UI1 -> standard A1', pg_temp.assign('A1', 'UI1'), 'sqft_lot_in_standard_auction');
SELECT pg_temp.expect('M2 message is plain', pg_temp.assign('A1', 'UI1'), 'This lot is priced per sq ft. It can only go in an auction priced per sq ft.');
SELECT pg_temp.expect('M3 standard SI1 -> per-unit P1', pg_temp.assign('P1', 'SI1'), 'sqft_auction_needs_qty');
SELECT pg_temp.expect('M4 message is plain', pg_temp.assign('P1', 'SI1'), 'This auction is priced per sq ft. Add the lot''s sq ft before it goes in.');
SELECT pg_temp.expect('M5 mixed batch UI5+SI2 -> P5', pg_temp.assign('P5', 'UI5', 'SI2'), 'sqft_auction_needs_qty');
SELECT pg_temp.is('M6 batch refused as a whole: UI5', pg_temp.f('UI5'), 'in_inventory auc=- start=800 qty=160 label=sq ft');
SELECT pg_temp.is('M6 batch refused as a whole: SI2', pg_temp.f('SI2'), 'in_inventory auc=- start=500 qty=- label=-');
SELECT pg_temp.expect('M7 UI1 (start not set) -> P1 (default 5c)', pg_temp.assign('P1', 'UI1'), 'ok');
SELECT pg_temp.is('M7 UI1 start = 5c x 247', pg_temp.f('UI1'), 'scheduled auc=P1 start=1235 qty=247 label=sq ft');
SELECT pg_temp.expect('M8 UI2 (own 5c) -> P5 (default 10c)', pg_temp.assign('P5', 'UI2'), 'ok');
SELECT pg_temp.is('M8 UI2 keeps its own start', pg_temp.f('UI2'), 'scheduled auc=P5 start=1235 qty=247 label=sq ft');
SELECT pg_temp.expect('M9 UI3 ($10.01 / 160) -> P2 (no default)', pg_temp.assign('P2', 'UI3'), 'sqft_start_not_whole');
SELECT pg_temp.expect('M10 UI3 -> P5 (default 10c)', pg_temp.assign('P5', 'UI3'), 'ok');
SELECT pg_temp.is('M10 UI3 start = 10c x 160', pg_temp.f('UI3'), 'scheduled auc=P5 start=1600 qty=160 label=sq ft');
SELECT pg_temp.expect('M11 UI4 (start not set, 100 sq ft) -> P2 (no default)', pg_temp.assign('P2', 'UI4'), 'ok');
SELECT pg_temp.is('M11 UI4 keeps $1.00 = 1c/sq ft (no default to use)', pg_temp.f('UI4'), 'scheduled auc=P2 start=100 qty=100 label=sq ft');
SELECT pg_temp.expect('M12 UI5 (own 5c) -> P2', pg_temp.assign('P2', 'UI5'), 'ok');
SELECT pg_temp.is('M12 UI5 keeps its own start', pg_temp.f('UI5'), 'scheduled auc=P2 start=800 qty=160 label=sq ft');
SELECT pg_temp.expect('M13 SI2 -> standard A1 (unchanged path)', pg_temp.assign('A1', 'SI2'), 'ok');

\echo '--- 5. mode match on direct inserts / updates (console new lot, any other path)'
SELECT pg_temp.expect('D1 insert per-unit lot into standard A1', $q$INSERT INTO lots (operator_id, warehouse_id, auction_id, title, lot_code, status, unit_qty, unit_label)
  VALUES ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000f1','D1','D1','draft', 247, 'sq ft') RETURNING lot_code$q$, 'sqft_lot_in_standard_auction');
SELECT pg_temp.expect('D2 insert standard lot into per-unit P1', $q$INSERT INTO lots (operator_id, warehouse_id, auction_id, title, lot_code, status)
  VALUES ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-000000000021','D2','D2','draft') RETURNING lot_code$q$, 'sqft_auction_needs_qty');
SELECT pg_temp.expect('D3 insert per-unit lot into P1, no start', $q$INSERT INTO lots (operator_id, warehouse_id, auction_id, title, lot_code, status, unit_qty, unit_label)
  VALUES ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-000000000021','D3','D3','draft', 300, 'sq ft') RETURNING starting_bid_cents::text$q$, 'ok 1500');
SELECT pg_temp.expect('D4 move standard SA6 into P1', $q$UPDATE lots SET auction_id = '00000000-0000-0000-0000-000000000021' WHERE lot_code = 'SA6' RETURNING lot_code$q$, 'sqft_auction_needs_qty');
SELECT pg_temp.expect('D5 move per-unit UD1 into standard A1', $q$UPDATE lots SET auction_id = '00000000-0000-0000-0000-0000000000f1' WHERE lot_code = 'UD1' RETURNING lot_code$q$, 'sqft_lot_in_standard_auction');
SELECT pg_temp.expect('D6 give SA6 (in standard A6) sq ft', $q$UPDATE lots SET unit_qty = 10, unit_label = 'sq ft' WHERE lot_code = 'SA6' RETURNING lot_code$q$, 'sqft_lot_in_standard_auction');
SELECT pg_temp.expect('D7 take UD1 out of P1 (always allowed)', $q$UPDATE lots SET auction_id = NULL, lot_number = NULL, status = 'in_inventory' WHERE lot_code = 'UD1' RETURNING lot_code$q$, 'ok');

\echo '--- 6. relist copies the sq ft; refuses a mismatch (desk 2-arg, staff-app 3-arg, into inventory, auto-relist)'
SELECT pg_temp.expect('R1 UU2 (160 sq ft) -> standard A1', pg_temp.relist('UU2', 'A1'), 'sqft_lot_in_standard_auction');
SELECT pg_temp.is('R1 UU2 untouched (relist rolled back)', pg_temp.f('UU2'), 'unsold auc=P4 start=800 qty=160 label=sq ft');
SELECT pg_temp.expect('R2 standard SU1 -> per-unit P1', pg_temp.relist('SU1', 'P1'), 'sqft_auction_needs_qty');
SELECT pg_temp.expect('R3 UU1 (160 sq ft) -> P1', pg_temp.relist('UU1', 'P1'), 'ok');
SELECT pg_temp.is('R3 child keeps 160 sq ft and its 5c start', pg_temp.f(pg_temp.child('UU1')), 'scheduled auc=P1 start=800 qty=160 label=sq ft');
SELECT pg_temp.expect('R4 UU2 -> inventory', format('SELECT pg_temp.code(relist_lot_into_auction(%L, NULL))', pg_temp.lot('UU2')), 'ok');
SELECT pg_temp.is('R4 child in inventory keeps 160 sq ft', pg_temp.f(pg_temp.child('UU2')), 'in_inventory auc=- start=800 qty=160 label=sq ft');
SELECT pg_temp.expect('R5 that child -> P2 via staff-app 3-arg', format('SELECT pg_temp.code(relist_lot_into_auction(%L, %L, NULL))', pg_temp.lot(pg_temp.child('UU2')), pg_temp.auc('P2')), 'ok');
SELECT pg_temp.is('R5 grandchild keeps 160 sq ft', pg_temp.f(pg_temp.child(pg_temp.child('UU2'))), 'scheduled auc=P2 start=800 qty=160 label=sq ft');
SELECT pg_temp.expect('R6 SU1 -> standard A1 (unchanged path)', pg_temp.relist('SU1', 'A1'), 'ok');
SELECT pg_temp.is('R6 standard child has no sq ft', pg_temp.f(pg_temp.child('SU1')), 'scheduled auc=A1 start=100 qty=- label=-');
SELECT pg_temp.expect('R7 child row that names its own sq ft keeps it', $q$INSERT INTO lots (operator_id, warehouse_id, title, lot_code, status, relisted_from_lot_id, unit_qty, unit_label)
  VALUES ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','R7','R7','in_inventory','00000000-0000-0000-0000-000000000213', 99, 'sq m') RETURNING unit_qty || ' ' || unit_label$q$, 'ok 99 sq m');
-- auto-relist: SU2/SU3/SU4 standard unsold; the soonest scheduled auction is A2 (standard).
SELECT pg_temp.who('none');
SELECT pg_temp.expect('R8 auto_relist runs', $q$SELECT (auto_relist_unsold_lots() - 'at')::text$q$, 'ok');
SELECT pg_temp.is('R8 standard SU2 auto-relisted into A2', pg_temp.f(pg_temp.child('SU2')), 'scheduled auc=A2 start=300 qty=- label=-');
-- Known gap (reported): auto-relist picks the soonest auction without looking at
-- bid_mode. A per-unit unsold lot whose soonest auction is standard is now
-- refused (counted 'failed', run continues) instead of relisted into the wrong mode.
SET session_replication_role = replica;
INSERT INTO lots (operator_id, warehouse_id, auction_id, title, lot_code, lot_number, status, starting_bid_cents, close_at, unit_qty, unit_label)
VALUES ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-000000000024','UU3 unsold 160 auto','UU3',3,'unsold',800, now(),160,'sq ft');
SET session_replication_role = origin;
SELECT pg_temp.is('R9 auto_relist: per-unit UU3 vs standard A2 = refused, run continues', (SELECT (auto_relist_unsold_lots() - 'at')::text), '{"failed": 1, "skipped": 0, "relisted": 0, "flagged_for_disposal": 0}');
SELECT pg_temp.is('R9 UU3 stays unsold', pg_temp.f('UU3'), 'unsold auc=P4 start=800 qty=160 label=sq ft');
SELECT pg_temp.who('admin');

\echo '--- 7. auctions.bid_mode lock'
SELECT pg_temp.expect('B1 P3 live -> standard', $q$UPDATE auctions SET bid_mode = 'standard' WHERE title LIKE 'P3 %' RETURNING bid_mode$q$, 'sqft_mode_locked');
SELECT pg_temp.expect('B2 message is plain', $q$UPDATE auctions SET bid_mode = 'standard' WHERE title LIKE 'P3 %' RETURNING bid_mode$q$, 'How this auction is priced (per sq ft or standard) can''t change once it is live.');
SELECT pg_temp.expect('B3 A4 closed -> per_unit', $q$UPDATE auctions SET bid_mode = 'per_unit' WHERE title LIKE 'A4 %' RETURNING bid_mode$q$, 'sqft_mode_locked');
SELECT pg_temp.expect('B4 A7 scheduled, a lot has a bid -> per_unit', $q$UPDATE auctions SET bid_mode = 'per_unit' WHERE title LIKE 'A7 %' RETURNING bid_mode$q$, 'can''t change once it has bids');
SELECT pg_temp.expect('B5 A6 draft with a standard lot -> per_unit', $q$UPDATE auctions SET bid_mode = 'per_unit' WHERE title LIKE 'A6 %' RETURNING bid_mode$q$, 'sqft_mode_lots_mismatch');
SELECT pg_temp.expect('B6 P5 draft with per-unit lots -> standard', $q$UPDATE auctions SET bid_mode = 'standard' WHERE title LIKE 'P5 %' RETURNING bid_mode$q$, 'sqft_mode_lots_mismatch');
SELECT pg_temp.expect('B6b P1 draft, UB1 has a bid -> standard', $q$UPDATE auctions SET bid_mode = 'standard' WHERE title LIKE 'P1 %' RETURNING bid_mode$q$, 'can''t change once it has bids');
SELECT pg_temp.expect('B7 A5 draft, empty -> per_unit', $q$UPDATE auctions SET bid_mode = 'per_unit' WHERE title LIKE 'A5 %' RETURNING bid_mode$q$, 'ok per_unit');
SELECT pg_temp.expect('B8 A5 back -> standard', $q$UPDATE auctions SET bid_mode = 'standard' WHERE title LIKE 'A5 %' RETURNING bid_mode$q$, 'ok standard');
SELECT pg_temp.expect('B9 P3 live, same bid_mode', $q$UPDATE auctions SET bid_mode = 'per_unit' WHERE title LIKE 'P3 %' RETURNING bid_mode$q$, 'ok per_unit');
SELECT pg_temp.expect('B10 P3 live, other edits fine', $q$UPDATE auctions SET title = 'P3 per sq ft live (edited)' WHERE title LIKE 'P3 %' RETURNING bid_mode$q$, 'ok per_unit');

\echo '--- 8. callers: staff through RLS (authenticated), bidder, anon'
SELECT pg_temp.who('admin');
SET ROLE authenticated;
SELECT pg_temp.expect('C1 staff admin (RLS) qty on live UL1', $q$UPDATE lots SET unit_qty = 250 WHERE lot_code = 'UL1' RETURNING lot_code$q$, 'sqft_locked');
SELECT pg_temp.expect('C2 staff admin (RLS) qty on US1 (no bids)', $q$UPDATE lots SET unit_qty = 200 WHERE lot_code = 'US1' RETURNING starting_bid_cents::text$q$, 'ok 2000');
RESET ROLE;
SELECT pg_temp.who('manager');
SET ROLE authenticated;
SELECT pg_temp.expect('C3 staff manager (RLS) per-unit -> standard A5', $q$UPDATE lots SET auction_id = '00000000-0000-0000-0000-0000000000f5' WHERE lot_code = 'UI2' RETURNING lot_code$q$, 'sqft_lot_in_standard_auction');
RESET ROLE;
SELECT pg_temp.who('b1');
SET ROLE authenticated;
SELECT pg_temp.expect('C4 bidder: UPDATE lots = 0 rows (RLS, as before)', $q$WITH u AS (UPDATE lots SET unit_qty = 1 WHERE lot_code = 'US1' RETURNING 1) SELECT count(*)::text FROM u$q$, 'ok 0');
SELECT pg_temp.expect('C5 bidder: UPDATE auctions = 0 rows', $q$WITH u AS (UPDATE auctions SET bid_mode = 'standard' WHERE title LIKE 'P1 %' RETURNING 1) SELECT count(*)::text FROM u$q$, 'ok 0');
RESET ROLE;
SELECT pg_temp.who('none');
SET ROLE anon;
SELECT pg_temp.expect('C6 anon: UPDATE lots = 0 rows', $q$WITH u AS (UPDATE lots SET unit_qty = 1 WHERE lot_code = 'US1' RETURNING 1) SELECT count(*)::text FROM u$q$, 'ok 0');
RESET ROLE;
SELECT pg_temp.is('C7 trigger functions not callable by PUBLIC', (SELECT string_agg(p.proname || '=' || coalesce(p.proacl::text, 'default'), ' ' ORDER BY p.proname) FROM pg_proc p WHERE p.proname IN ('lots_sqft_guard', 'auctions_sqft_mode_lock')),
  'auctions_sqft_mode_lock={postgres=X/postgres} lots_sqft_guard={postgres=X/postgres}');

\echo '--- 9. engine still agrees: a lot the guard let in is biddable per unit (0453 3-arg)'
SELECT pg_temp.who('b2');
SELECT pg_temp.is('E1 bid 10c/sq ft on UL1 (247)', (SELECT (r).ok || ' ' || (r).reason || ' ' || (r).current_bid_cents FROM (SELECT place_bid(pg_temp.lot('UL1'), 2470, 247) r) x), 'true ok 2470');
