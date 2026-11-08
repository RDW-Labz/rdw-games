-- Per-unit cases, AFTER 0453 only. Each call is its own transaction; every
-- check RAISEs (psql ON_ERROR_STOP) on a mismatch, so reaching the end = pass.
\set ON_ERROR_STOP 1
\pset format unaligned
\pset tuples_only on
\i /w453/helpers.sql

CREATE FUNCTION pg_temp.chk(p_line text, p_expect text) RETURNS text LANGUAGE plpgsql AS $$
BEGIN
  IF position(p_expect IN p_line) = 0 THEN
    RAISE EXCEPTION 'FAIL: got [%], expected to contain [%]', p_line, p_expect;
  END IF;
  RETURN 'PASS ' || p_line;
END $$;

-- ── old-app refusal: the 2-arg on a per_unit lot ─────────────────────────────
DO $$
DECLARE r place_bid_result;
BEGIN
  r := pg_temp.r2('b1', 'U1', 1235);
  IF r.ok OR r.reason IS DISTINCT FROM 'Bidding on this lot needs the latest BinGo app. Please update to bid.'
     OR r.current_bid_cents IS NOT NULL OR r.current_leader_id IS NOT NULL OR r.was_extended IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL 2-arg refusal: %', r;
  END IF;
  -- The old bundle's PlaceBidSheet renders `Bid rejected: ${reason}`:
  RAISE NOTICE 'old app shows: Bid rejected: %', r.reason;
  -- refused before auth: an anonymous caller gets the same sentence
  r := pg_temp.r2('anon', 'U1', 1235);
  IF r.reason IS DISTINCT FROM 'Bidding on this lot needs the latest BinGo app. Please update to bid.' THEN
    RAISE EXCEPTION 'FAIL 2-arg refusal (anon): %', r;
  END IF;
END $$;
SELECT 'PASS 2-arg per_unit refusal: no bid rows written = ' || (count(*) = 0) FROM bids WHERE lot_id = pg_temp.lot('U1');

-- ── U1: 247 sq ft, start $0.05/sq ft = $12.35, ladder $0.10/sq ft = $24.70 ──
SELECT pg_temp.chk(pg_temp.bid3('b1', 'U1', 1235, 246),  'false unit_qty_mismatch');
SELECT pg_temp.chk(pg_temp.bid3('b1', 'U1', 1235, NULL), 'false unit_qty_mismatch');
SELECT pg_temp.chk(pg_temp.bid3('b1', 'U1', 1236, 247),  'false not_whole_cents_per_unit');
SELECT pg_temp.chk(pg_temp.bid3('b1', 'U1', 988, 247),   'false below_starting_bid');          -- $0.04
SELECT pg_temp.chk(pg_temp.bid3('b1', 'U1', 1235, 247),  'true ok cur=1235 lead=b1');          -- $12.35
SELECT pg_temp.chk(pg_temp.bid3('b2', 'U1', 2470, 247),  'false below_min_increment cur=1235'); -- $0.10 < $0.15
SELECT pg_temp.chk(pg_temp.bid3('b2', 'U1', 3705, 247),  'true ok cur=3705 lead=b2 ext=false outbid=b1'); -- $0.15 = 12.35 + 24.70
SELECT pg_temp.chk(pg_temp.bid3('b1', 'U1', 12350, 247), 'true ok cur=6175 lead=b1 ext=false outbid=b2'); -- max $0.50; proxy 3705+2470
SELECT pg_temp.chk(pg_temp.bid3('b2', 'U1', 9880, 247),  'true ok cur=12350 lead=b1 ext=false outbid=b2'); -- $0.40 → b1 defends at 9880+2470
SELECT pg_temp.chk(pg_temp.bid3('b3', 'U1', 12350+247, 247), 'false below_min_increment');     -- $0.51 < $0.60
SELECT pg_temp.chk(pg_temp.bid3('b3', 'U1', 14820, 247), 'true ok cur=14820 lead=b3 ext=false outbid=b1'); -- $0.60: 12350+2470
-- leader self-raise (silent) and a lower "raise" (GREATEST keeps it)
SELECT pg_temp.chk(pg_temp.bid3('b3', 'U1', 24700, 247), 'true ok cur=14820 lead=b3 ext=false outbid=-');  -- max $1.00
SELECT pg_temp.chk(pg_temp.bid3('b3', 'U1', 17290, 247), 'true ok cur=14820 lead=b3 ext=false outbid=-');  -- $0.70, lower
SELECT 'PASS self-raise kept max ' || max_amount_cents FROM bids
 WHERE lot_id = pg_temp.lot('U1') AND bidder_id = (SELECT id FROM auth.users WHERE email = 'b3@example.test')
 ORDER BY placed_at DESC LIMIT 1;
DO $$ BEGIN
  IF (SELECT max_amount_cents FROM bids WHERE lot_id = pg_temp.lot('U1')
        AND bidder_id = (SELECT id FROM auth.users WHERE email = 'b3@example.test')
      ORDER BY placed_at DESC LIMIT 1) <> 24700 THEN RAISE EXCEPTION 'FAIL self-raise GREATEST'; END IF;
END $$;
SELECT pg_temp.chk(pg_temp.bid3('b4', 'U1', 17290, 247), 'true ok cur=19760 lead=b3 ext=false outbid=b4'); -- b3 defends: 17290+2470

-- gates still apply on the per-unit path (same code as the 2-arg)
SELECT pg_temp.chk(pg_temp.bid3('anon',      'U2', 800, 160), 'false not_authenticated');
SELECT pg_temp.chk(pg_temp.bid3('notbidder', 'U2', 800, 160), 'false not_a_bidder');
SELECT pg_temp.chk(pg_temp.bid3('nocard',    'U2', 800, 160), 'false no_payment_method');
SELECT pg_temp.chk(pg_temp.bid3('grace',     'U2', 800, 160), 'false unpaid_invoice');
SELECT pg_temp.chk(pg_temp.bid3('staff',     'U2', 800, 160), 'EXC shill_bidding_forbidden');

-- ── U2: 160 sq ft, $0.05 → $8.00 start, $0.10 → $16.00 steps ─────────────────
SELECT pg_temp.chk(pg_temp.bid3('b1', 'U2', 640, 160),  'false below_starting_bid');
SELECT pg_temp.chk(pg_temp.bid3('b1', 'U2', 8000, 160), 'true ok cur=800 lead=b1');           -- max $0.50
SELECT pg_temp.chk(pg_temp.bid3('b2', 'U2', 4800, 160), 'true ok cur=6400 lead=b1 ext=false outbid=b2'); -- $0.30 + $0.10

-- ── config errors ────────────────────────────────────────────────────────────
SELECT pg_temp.chk(pg_temp.bid3('b1', 'U3', 1235, 247), 'false lot_start_not_multiple');   -- start 1000 % 247
SELECT pg_temp.chk(pg_temp.bid3('b1', 'U4', 1235, 247), 'false unit_qty_mismatch');        -- lot has no qty
SELECT pg_temp.chk(pg_temp.bid3('b1', 'U4', 1235, NULL), 'false unit_qty_mismatch');
SELECT pg_temp.chk(pg_temp.bid3('b1', 'U5', 1235, 247), 'false per_unit_schedule_missing'); -- no auction ladder
-- operator default ladder must NOT stand in for a missing auction ladder
UPDATE operators SET bid_increment_schedule = '[{"min_cents":0,"step_cents":5}]' WHERE id = '00000000-0000-0000-0000-0000000000a1';
SELECT pg_temp.chk(pg_temp.bid3('b1', 'U5', 1235, 247), 'false per_unit_schedule_missing');
UPDATE operators SET bid_increment_schedule = NULL WHERE id = '00000000-0000-0000-0000-0000000000a1';
-- a ladder whose lowest tier starts above the current per-unit price would
-- fall back to the whole-item legacy ladder: refused instead
UPDATE auctions SET bid_increment_schedule = '[{"min_cents":100,"step_cents":5}]' WHERE id = '00000000-0000-0000-0000-0000000000f4';
SELECT pg_temp.chk(pg_temp.bid3('b1', 'U5', 1235, 247), 'false per_unit_schedule_missing');
UPDATE auctions SET bid_increment_schedule = '{"not":"an array"}' WHERE id = '00000000-0000-0000-0000-0000000000f4';
SELECT pg_temp.chk(pg_temp.bid3('b1', 'U5', 1235, 247), 'false per_unit_schedule_missing');
UPDATE auctions SET bid_increment_schedule = '[{"min_cents":0,"step_cents":0}]' WHERE id = '00000000-0000-0000-0000-0000000000f4';
SELECT pg_temp.chk(pg_temp.bid3('b1', 'U5', 1235, 247), 'false per_unit_schedule_missing'); -- zero step
SELECT 'PASS config errors wrote no bid rows: ' || (count(*) = 0) FROM bids WHERE lot_id IN (pg_temp.lot('U3'), pg_temp.lot('U4'), pg_temp.lot('U5'));

-- ── U6: tiered per-unit ladder, q = 100: $0.05 below $0.50/unit, $0.10 from it
SELECT pg_temp.chk(pg_temp.bid3('b1', 'U6', 10000, 100), 'true ok cur=500 lead=b1');                       -- max $1.00
SELECT pg_temp.chk(pg_temp.bid3('b2', 'U6', 4000, 100),  'true ok cur=4500 lead=b1 ext=false outbid=b2');   -- 0.40+0.05
SELECT pg_temp.chk(pg_temp.bid3('b2', 'U6', 6000, 100),  'true ok cur=6500 lead=b1 ext=false outbid=b2');   -- at 0.45: step 0.05
SELECT pg_temp.chk(pg_temp.bid3('b2', 'U6', 7000, 100),  'false below_min_increment cur=6500');             -- at 0.65: step 0.10 → 7500
SELECT pg_temp.chk(pg_temp.bid3('b2', 'U6', 7500, 100),  'true ok cur=8500 lead=b1 ext=false outbid=b2');

-- ── U7: soft close on a per_unit lot (30 s from close, 2-minute window) ──────
SELECT pg_temp.chk(pg_temp.bid3('b1', 'U7', 1235, 247), 'true ok cur=1235 lead=b1 ext=true');

-- ── X1: standard auction with standard bids, then flipped to per_unit ───────
-- (PR 4's lock trigger will forbid the flip; until then the engine refuses
-- rather than mix non-multiples into per-unit math)
SELECT pg_temp.chk(pg_temp.bid3('b1', 'X1', 1000, NULL), 'true ok cur=100 lead=b1');   -- 3-arg, standard: delegated
UPDATE auctions SET bid_mode = 'per_unit', bid_increment_schedule = '[{"min_cents":0,"step_cents":5}]'
 WHERE id = '00000000-0000-0000-0000-0000000000f6';
UPDATE lots SET unit_qty = 7, starting_bid_cents = 70 WHERE lot_code = 'X1';
SELECT pg_temp.chk(pg_temp.bid3('b2', 'X1', 7000, 7), 'false lot_amounts_not_multiple');      -- current 100 % 7
UPDATE lots SET current_bid_cents = 140 WHERE lot_code = 'X1';                                 -- price ok, leader max 1000 % 7 ≠ 0
SELECT pg_temp.chk(pg_temp.bid3('b2', 'X1', 7000, 7), 'false lot_amounts_not_multiple');
DO $$ BEGIN
  IF (pg_temp.r2('b2', 'X1', 7000)).reason <> 'Bidding on this lot needs the latest BinGo app. Please update to bid.' THEN
    RAISE EXCEPTION 'FAIL flipped lot via 2-arg not refused';
  END IF;
END $$;

-- ── invariants on every per_unit lot ─────────────────────────────────────────
DO $$
DECLARE v_bad int;
BEGIN
  SELECT count(*) INTO v_bad
    FROM bids b JOIN lots l ON l.id = b.lot_id JOIN auctions a ON a.id = l.auction_id
   WHERE a.bid_mode = 'per_unit' AND l.lot_code <> 'X1'
     AND (b.amount_cents % l.unit_qty <> 0 OR b.max_amount_cents % l.unit_qty <> 0);
  IF v_bad > 0 THEN RAISE EXCEPTION 'FAIL % per-unit bid rows not a multiple of unit_qty', v_bad; END IF;
  SELECT count(*) INTO v_bad FROM lots l JOIN auctions a ON a.id = l.auction_id
   WHERE a.bid_mode = 'per_unit' AND l.lot_code <> 'X1' AND l.current_bid_cents % l.unit_qty <> 0;
  IF v_bad > 0 THEN RAISE EXCEPTION 'FAIL % per-unit lots with a non-multiple price', v_bad; END IF;
  SELECT count(*) INTO v_bad FROM lots l
   WHERE l.bid_count <> (SELECT count(*) FROM bids b WHERE b.lot_id = l.id AND NOT b.is_auto);
  IF v_bad > 0 THEN RAISE EXCEPTION 'FAIL % lots where bid_count <> human bid rows', v_bad; END IF;
  SELECT count(*) INTO v_bad FROM bids b
   WHERE NOT b.is_auto AND NOT EXISTS (SELECT 1 FROM bid_sources s WHERE s.bid_id = b.id);
  IF v_bad > 0 THEN RAISE EXCEPTION 'FAIL % human bids without a bid_sources row (0446 trigger)', v_bad; END IF;
END $$;
SELECT 'PASS invariants: every per-unit amount, max and price is a multiple of unit_qty; bid_count = human rows; every human bid has a bid_sources row';

-- ── snapshot ────────────────────────────────────────────────────────────────
SELECT 'BID ' || pg_temp.lbl(lot_id) || ' ' || pg_temp.lbl(bidder_id) || ' amt=' || amount_cents
       || ' max=' || max_amount_cents || ' auto=' || is_auto
       || coalesce(' per_unit=' || (amount_cents::numeric / l.unit_qty / 100)::numeric(10,2), '')
  FROM bids b JOIN lots l ON l.id = b.lot_id WHERE l.lot_code LIKE 'U%' ORDER BY b.placed_at, b.is_auto;
SELECT 'LOT ' || lot_code || ' q=' || coalesce(unit_qty::text, '-') || ' cur=' || coalesce(current_bid_cents::text, '-')
       || ' lead=' || pg_temp.lbl(winner_bidder_id) || ' bid_count=' || bid_count
  FROM lots WHERE lot_code LIKE 'U%' OR lot_code = 'X1' ORDER BY lot_code;
SELECT 'NOTE ' || kind || ' to=' || pg_temp.lbl(target_user_id) || ' lot=' || pg_temp.lbl((payload ->> 'lot_id')::uuid)
       || ' cur=' || (payload ->> 'current_bid_cents')
  FROM notifications_outbox WHERE pg_temp.lbl((payload ->> 'lot_id')::uuid) LIKE 'U%' ORDER BY created_at, target_user_id;

-- ── close + invoice on per-unit lots: totals flow through unchanged ─────────
-- every lot of auctions f3 and f5 comes due (the invoice build waits for a
-- whole auction to close)
UPDATE lots SET close_at = now() - interval '1 second' WHERE lot_code IN ('U1', 'U2', 'U3', 'U4', 'U6', 'U7');
SELECT 'FINALIZE won=' || (finalize_due_lots() ->> 'won');
UPDATE build_invoice_jobs SET run_at = now() - interval '1 second';
SELECT drain_build_invoice_jobs() \g /dev/null
SELECT 'INVOICE_LOT ' || l.lot_code || ' winner=' || pg_temp.lbl(i.bidder_id) || ' winning=' || il.winning_bid_cents
       || ' = ' || (il.winning_bid_cents / l.unit_qty) || 'c x ' || l.unit_qty || ' exact=' || (il.winning_bid_cents % l.unit_qty = 0)
       || ' invoice_status=' || i.status
  FROM invoice_lots il JOIN lots l ON l.id = il.lot_id JOIN invoices i ON i.id = il.invoice_id
 WHERE l.lot_code IN ('U1', 'U2', 'U6', 'U7') ORDER BY l.lot_code;
SELECT 'INVOICE ' || pg_temp.lbl(bidder_id) || ' subtotal=' || subtotal_cents || ' premium=' || buyer_premium_cents
       || ' tax=' || tax_cents || ' total=' || total_cents || ' status=' || status
  FROM invoices WHERE auction_id IN ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000f5')
 ORDER BY 1;
