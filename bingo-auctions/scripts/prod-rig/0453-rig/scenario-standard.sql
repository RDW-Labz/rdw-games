-- Standard-lot sequence. Run on identical seeds:
--   BEFORE 0453 with rig.fn=2, AFTER 0453 with rig.fn=2, AFTER 0453 with
--   rig.fn=3 (rig.qty NULL, and again with a junk qty). All outputs must be
--   byte-identical. Every statement is its own transaction (psql autocommit),
--   like real RPC calls.
\set ON_ERROR_STOP 1
\pset format unaligned
\pset tuples_only on
\i /w453/helpers.sql

CREATE TEMP TABLE out (n serial, line text);

-- S1: opening bid, proxy defence, outbid, self-raise up / "down", ties.
INSERT INTO out(line) SELECT pg_temp.bid('b1', 'S1', 50);     -- below_starting_bid
INSERT INTO out(line) SELECT pg_temp.bid('b1', 'S1', 1000);   -- opening: cur 100
INSERT INTO out(line) SELECT pg_temp.bid('b2', 'S1', 500);    -- proxy defence: b1 auto row at 600
INSERT INTO out(line) SELECT pg_temp.bid('b2', 'S1', 650);    -- below_min_increment (needs 700)
INSERT INTO out(line) SELECT pg_temp.bid('b2', 'S1', 1500);   -- outbids b1: cur 1100
INSERT INTO out(line) SELECT pg_temp.bid('b2', 'S1', 2000);   -- self-raise, silent
INSERT INTO out(line) SELECT pg_temp.bid('b2', 'S1', 1500);   -- self-"raise" lower: GREATEST keeps 2000
INSERT INTO out(line) SELECT pg_temp.bid('b2', 'S1', 1300);   -- also a self-raise; max stays 2000
INSERT INTO out(line) SELECT pg_temp.bid('b3', 'S1', 1900);   -- proxy defence: b2 auto row at 2000
INSERT INTO out(line) SELECT pg_temp.bid('b4', 'S1', 2200);   -- outbids b2: cur 2100
INSERT INTO out(line) SELECT pg_temp.bid('b3', 'S1', 2600);   -- outbids b4: cur 2300
INSERT INTO out(line) SELECT pg_temp.bid('staff', 'S1', 9000); -- shill: EXC
-- S2: gates.
INSERT INTO out(line) SELECT pg_temp.bid('anon', 'S2', 600);      -- not_authenticated
INSERT INTO out(line) SELECT pg_temp.bid('notbidder', 'S2', 600); -- not_a_bidder
INSERT INTO out(line) SELECT pg_temp.bid('nocard', 'S2', 600);    -- no_payment_method
INSERT INTO out(line) SELECT pg_temp.bid('grace', 'S2', 600);     -- unpaid_invoice
INSERT INTO out(line) SELECT pg_temp.bid('b1', 'NOPE', 600);      -- lot_not_found
INSERT INTO out(line) SELECT pg_temp.bid('b1', 'S4', 600);        -- auction_not_started
INSERT INTO out(line) SELECT pg_temp.bid('b1', 'S5', 600);        -- lot_closed
INSERT INTO out(line) SELECT pg_temp.bid('b1', 'S6', 600);        -- lot_not_biddable
INSERT INTO out(line) SELECT pg_temp.bid('b1', 'S2', 600);        -- ok
-- S3: soft close (30 s from close, 2-minute window).
INSERT INTO out(line) SELECT pg_temp.bid('b3', 'S3', 300);        -- ok, extended
INSERT INTO out(line) SELECT pg_temp.bid('b4', 'S3', 400);        -- ok, outbids b3, extended again
-- bidder-level unpaid fees gate
UPDATE bidders SET unpaid_fees_cents = 500 WHERE email = 'b4@example.test';
INSERT INTO out(line) SELECT pg_temp.bid('b4', 'S2', 5000);       -- unpaid_fees
UPDATE bidders SET unpaid_fees_cents = 0 WHERE email = 'b4@example.test';
-- suspension gate
INSERT INTO operator_bidder_relations (operator_id, bidder_id, suspended_at)
VALUES ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000e3', now())
ON CONFLICT (operator_id, bidder_id) DO UPDATE SET suspended_at = now();
INSERT INTO out(line) SELECT pg_temp.bid('b3', 'S2', 5000);       -- bidder_suspended
UPDATE operator_bidder_relations SET suspended_at = NULL WHERE bidder_id = '00000000-0000-0000-0000-0000000000e3';

-- ── snapshot ────────────────────────────────────────────────────────────────
SELECT 'CALL ' || n || ' ' || line FROM out ORDER BY n;
SELECT 'BID ' || pg_temp.lbl(lot_id) || ' ' || pg_temp.lbl(bidder_id) || ' amt=' || amount_cents
       || ' max=' || max_amount_cents || ' auto=' || is_auto
  FROM bids ORDER BY placed_at, is_auto, pg_temp.lbl(lot_id);
SELECT 'LOT ' || l.lot_code || ' status=' || l.status || ' cur=' || coalesce(l.current_bid_cents::text, '-')
       || ' lead=' || pg_temp.lbl(l.winner_bidder_id) || ' bid_count=' || l.bid_count
       || ' cur_bid_row=' || coalesce((SELECT pg_temp.lbl(b.bidder_id) || '/' || b.amount_cents || '/' || b.is_auto FROM bids b WHERE b.id = l.current_bid_id), '-')
       || ' close_moved=' || (l.close_at <> s.close_at)
       || ' close_in_min=' || CASE WHEN l.close_at <> s.close_at THEN round(extract(epoch FROM l.close_at - now()) / 60.0)::text ELSE '=' END
  FROM lots l JOIN rig_seed_close s ON s.id = l.id
 WHERE l.lot_code LIKE 'S%' ORDER BY l.lot_code;
SELECT 'NOTE ' || kind || ' to=' || pg_temp.lbl(target_user_id) || ' lot=' || pg_temp.lbl((payload ->> 'lot_id')::uuid)
       || ' cur=' || (payload ->> 'current_bid_cents')
  FROM notifications_outbox ORDER BY created_at, kind, target_user_id;
SELECT 'REL ' || pg_temp.lbl(bidder_id) || ' suspended=' || (suspended_at IS NOT NULL)
  FROM operator_bidder_relations ORDER BY 1;
SELECT 'SRC ' || s.kind || ' ' || s.client || ' ' || pg_temp.lbl(s.bidder_id) || ' ' || pg_temp.lbl(s.lot_id)
  FROM bid_sources s ORDER BY s.id;
SELECT 'COUNT bids=' || (SELECT count(*) FROM bids) || ' human=' || (SELECT count(*) FROM bids WHERE NOT is_auto)
       || ' sum_bid_count=' || (SELECT sum(bid_count) FROM lots) || ' sources=' || (SELECT count(*) FROM bid_sources);
