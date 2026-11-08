-- Rig-only helper for the concurrency proof. rig_bid() calls place_bid and,
-- in the SAME transaction (after place_bid took the per-lot advisory lock,
-- which is held to COMMIT), logs the call with a sequence number. Sequence
-- order is therefore the order in which the calls actually serialized on the
-- lot. replay-and-compare.sql re-runs the logged calls ONE AT A TIME in that
-- order on a fresh copy; identical results = the concurrent run behaved
-- exactly like a serial one (no lost update, no double leader, no torn proxy).
\set ON_ERROR_STOP 1
CREATE TABLE IF NOT EXISTS rig_calls (
  seq bigserial PRIMARY KEY, lot_id uuid, bidder_n int, amount bigint, qty int, nargs int,
  ok boolean, reason text, cur bigint, leader uuid, ext boolean, outbid uuid);

CREATE OR REPLACE FUNCTION rig_bid(p_lot uuid, p_b int, p_amt bigint, p_qty int, p_nargs int)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE r place_bid_result;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000e' || p_b, true);
  IF p_nargs = 3 THEN
    r := place_bid(p_lot, p_amt, p_qty);
  ELSE
    r := place_bid(p_lot, p_amt);
  END IF;
  INSERT INTO rig_calls (lot_id, bidder_n, amount, qty, nargs, ok, reason, cur, leader, ext, outbid)
  VALUES (p_lot, p_b, p_amt, p_qty, p_nargs, r.ok, r.reason, r.current_bid_cents,
          r.current_leader_id, r.was_extended, r.outbid_bidder_id);
END $$;
