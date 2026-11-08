-- Final state of the concurrency lots, ids → labels, no timestamps. Diffed
-- between the concurrent DB and its serial replay.
\set ON_ERROR_STOP 1
\pset format unaligned
\pset tuples_only on
SELECT 'LOT ' || l.lot_code || ' cur=' || coalesce(l.current_bid_cents::text, '-') || ' lead=' || coalesce(l.winner_bidder_id::text, '-')
       || ' bid_count=' || l.bid_count || ' cur_row=' || coalesce((SELECT b.bidder_id || '/' || b.amount_cents || '/' || b.is_auto FROM bids b WHERE b.id = l.current_bid_id), '-')
  FROM lots l WHERE l.lot_code IN ('S7', 'U8') ORDER BY 1;
SELECT 'BID ' || l.lot_code || ' ' || b.bidder_id || ' amt=' || b.amount_cents || ' max=' || b.max_amount_cents || ' auto=' || b.is_auto
  FROM bids b JOIN lots l ON l.id = b.lot_id WHERE l.lot_code IN ('S7', 'U8') ORDER BY 1;
SELECT 'NOTE ' || n.kind || ' ' || n.target_user_id || ' ' || (n.payload ->> 'current_bid_cents')
  FROM notifications_outbox n WHERE n.payload ->> 'lot_id' IN ('00000000-0000-0000-0000-000000000107', '00000000-0000-0000-0000-000000000208') ORDER BY 1;
-- invariants
SELECT 'INV U8 all multiples of 173: ' || coalesce(bool_and(b.amount_cents % 173 = 0 AND b.max_amount_cents % 173 = 0), true)
  FROM bids b WHERE b.lot_id = '00000000-0000-0000-0000-000000000208';
-- The live engine's step 4 picks the leader's max as their latest bids row by
-- placed_at (= now(), the TRANSACTION START). Under contention a later-
-- serialized transaction can carry an earlier placed_at, so step 4 can read a
-- stale (lower) max and the price can go DOWN. Pre-existing (0084..0263);
-- counted here, not caused by 0453 — the BEFORE rounds show it too.
SELECT 'PRICE_DROPS ' || l.lot_code || '=' ||
       (SELECT count(*) FROM rig_calls c
         WHERE c.lot_id = l.id AND c.ok
           AND c.cur < (SELECT max(p.cur) FROM rig_calls p WHERE p.lot_id = l.id AND p.ok AND p.seq < c.seq))
  FROM lots l WHERE l.lot_code IN ('S7', 'U8') ORDER BY 1;
SELECT 'INV ' || l.lot_code || ' leader holds the highest max: '
       || ((SELECT max(max_amount_cents) FROM bids b WHERE b.lot_id = l.id)
           = (SELECT b.max_amount_cents FROM bids b WHERE b.lot_id = l.id AND b.bidder_id = l.winner_bidder_id ORDER BY b.placed_at DESC LIMIT 1))
       || ', bid_count = human rows: ' || (l.bid_count = (SELECT count(*) FROM bids b WHERE b.lot_id = l.id AND NOT b.is_auto))
       || ', current row is the leader at the price: ' || ((SELECT b.bidder_id = l.winner_bidder_id AND b.amount_cents = l.current_bid_cents FROM bids b WHERE b.id = l.current_bid_id))
  FROM lots l WHERE l.lot_code IN ('S7', 'U8') ORDER BY l.lot_code;
