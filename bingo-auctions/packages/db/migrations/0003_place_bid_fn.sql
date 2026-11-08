-- ============================================================================
-- place_bid() — the transactional bid function
--
-- Behaviors:
--  1. Row-locks the lot to serialize concurrent bids.
--  2. Validates bidder, lot status, lot timing, and minimum-increment.
--  3. Resolves proxy/max bidding against the existing leader.
--  4. Soft-close: extends close_at if bid lands inside the soft-close window.
--  5. Inserts at most two bids:
--       - the new bidder's bid (clamped to win the duel by min increment), AND
--       - if the existing leader's max still beats the new bidder, an auto-bid
--         from the existing leader at min(their_max, new_max + min_increment).
--  6. Updates lots.current_bid_cents / current_bid_id / bid_count / close_at.
--  7. Returns the resulting state for the caller to react to.
--
-- Tie-breaking: when both bidders have the same max, the FIRST bidder (the
-- one who placed their max earlier) wins, at the second bidder's max amount.
-- This is the BidFTA / eBay convention.
-- ============================================================================

-- Minimum bid increment table. Industry-standard "step ladder."
CREATE OR REPLACE FUNCTION min_bid_increment_cents(current_cents BIGINT)
RETURNS BIGINT
LANGUAGE SQL
IMMUTABLE
AS $$
  SELECT CASE
    WHEN current_cents IS NULL OR current_cents < 500    THEN 100      -- $1
    WHEN current_cents < 2500    THEN 100                              -- $1
    WHEN current_cents < 10000   THEN 200                              -- $2
    WHEN current_cents < 25000   THEN 500                              -- $5
    WHEN current_cents < 100000  THEN 1000                             -- $10
    WHEN current_cents < 500000  THEN 2500                             -- $25
    ELSE 5000                                                          -- $50
  END;
$$;

-- Result type
DROP TYPE IF EXISTS place_bid_result CASCADE;
CREATE TYPE place_bid_result AS (
  ok BOOLEAN,
  reason TEXT,
  lot_id UUID,
  current_bid_cents BIGINT,
  current_leader_id UUID,
  close_at TIMESTAMPTZ,
  was_extended BOOLEAN,
  outbid_bidder_id UUID
);

CREATE OR REPLACE FUNCTION place_bid(
  p_lot_id UUID,
  p_max_amount_cents BIGINT
)
RETURNS place_bid_result
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bidder_id UUID := auth.uid();
  v_lot lots%ROWTYPE;
  v_auction auctions%ROWTYPE;
  v_min_increment BIGINT;
  v_current_max_bid bids%ROWTYPE;     -- existing leader's true max
  v_new_current_cents BIGINT;
  v_leader_id UUID;
  v_new_bid_id UUID;
  v_auto_bid_id UUID;
  v_was_extended BOOLEAN := false;
  v_old_close_at TIMESTAMPTZ;
  v_outbid_bidder_id UUID;
  v_result place_bid_result;
BEGIN
  -- 1. Auth check
  IF v_bidder_id IS NULL THEN
    v_result := (false, 'not_authenticated', p_lot_id, NULL, NULL, NULL, false, NULL);
    RETURN v_result;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM bidders WHERE id = v_bidder_id) THEN
    v_result := (false, 'not_a_bidder', p_lot_id, NULL, NULL, NULL, false, NULL);
    RETURN v_result;
  END IF;

  -- 2. Lock the lot row for the duration of this transaction
  SELECT * INTO v_lot FROM lots WHERE id = p_lot_id FOR UPDATE;

  IF NOT FOUND THEN
    v_result := (false, 'lot_not_found', p_lot_id, NULL, NULL, NULL, false, NULL);
    RETURN v_result;
  END IF;

  IF v_lot.status NOT IN ('scheduled', 'live') THEN
    v_result := (false, 'lot_not_biddable', p_lot_id, v_lot.current_bid_cents,
                 v_lot.winner_bidder_id, v_lot.close_at, false, NULL);
    RETURN v_result;
  END IF;

  IF now() >= v_lot.close_at THEN
    v_result := (false, 'lot_closed', p_lot_id, v_lot.current_bid_cents,
                 v_lot.winner_bidder_id, v_lot.close_at, false, NULL);
    RETURN v_result;
  END IF;

  -- 3. Validate amount
  v_min_increment := min_bid_increment_cents(v_lot.current_bid_cents);

  IF v_lot.current_bid_cents IS NULL THEN
    -- First bid must meet starting bid
    IF p_max_amount_cents < v_lot.starting_bid_cents THEN
      v_result := (false, 'below_starting_bid', p_lot_id, v_lot.current_bid_cents,
                   NULL, v_lot.close_at, false, NULL);
      RETURN v_result;
    END IF;
  ELSE
    -- Subsequent bid must meet current + min_increment
    IF p_max_amount_cents < v_lot.current_bid_cents + v_min_increment THEN
      v_result := (false, 'below_min_increment', p_lot_id, v_lot.current_bid_cents,
                   v_lot.winner_bidder_id, v_lot.close_at, false, NULL);
      RETURN v_result;
    END IF;
  END IF;

  -- 4. Look up the existing leader's max (may not exist if first bid)
  SELECT b.* INTO v_current_max_bid
  FROM bids b
  WHERE b.lot_id = p_lot_id AND b.bidder_id = v_lot.winner_bidder_id
  ORDER BY b.placed_at DESC
  LIMIT 1;

  -- 5. Resolve the proxy duel
  IF v_lot.winner_bidder_id IS NULL THEN
    -- No prior leader: new bidder takes the lot at starting_bid_cents
    v_new_current_cents := v_lot.starting_bid_cents;
    v_leader_id := v_bidder_id;
    v_outbid_bidder_id := NULL;

  ELSIF v_lot.winner_bidder_id = v_bidder_id THEN
    -- Same bidder raising their own max: keep current visible bid, just update max
    v_new_current_cents := v_lot.current_bid_cents;
    v_leader_id := v_bidder_id;
    v_outbid_bidder_id := NULL;

  ELSIF p_max_amount_cents > v_current_max_bid.max_amount_cents THEN
    -- New bidder beats the existing max: new bidder leads at
    -- min(p_max, existing_max + min_increment)
    v_new_current_cents := LEAST(
      p_max_amount_cents,
      v_current_max_bid.max_amount_cents + v_min_increment
    );
    v_leader_id := v_bidder_id;
    v_outbid_bidder_id := v_lot.winner_bidder_id;

  ELSE
    -- New bidder cannot beat existing max: existing leader stays, but
    -- visible price rises to min(existing_max, p_max + min_increment).
    -- Tie at equal max: existing leader wins (placed_at convention).
    v_new_current_cents := LEAST(
      v_current_max_bid.max_amount_cents,
      p_max_amount_cents + v_min_increment
    );
    v_leader_id := v_lot.winner_bidder_id;
    v_outbid_bidder_id := v_bidder_id;
  END IF;

  -- 6. Insert the new bidder's bid (always — even if they didn't take the lead,
  -- their max is still recorded for future proxy duels)
  INSERT INTO bids (lot_id, bidder_id, amount_cents, max_amount_cents, is_auto)
  VALUES (
    p_lot_id, v_bidder_id,
    CASE WHEN v_leader_id = v_bidder_id THEN v_new_current_cents
         ELSE p_max_amount_cents END,
    p_max_amount_cents,
    false
  )
  RETURNING id INTO v_new_bid_id;

  -- 7. If the existing leader is still leading (because their max beat the new
  -- max), insert an auto-bid from them at the new visible price
  IF v_leader_id <> v_bidder_id AND v_lot.winner_bidder_id IS NOT NULL THEN
    INSERT INTO bids (lot_id, bidder_id, amount_cents, max_amount_cents, is_auto)
    VALUES (
      p_lot_id,
      v_lot.winner_bidder_id,
      v_new_current_cents,
      v_current_max_bid.max_amount_cents,
      true
    )
    RETURNING id INTO v_auto_bid_id;
  END IF;

  -- 8. Soft-close: extend close_at if we're inside the window
  v_old_close_at := v_lot.close_at;
  SELECT * INTO v_auction FROM auctions WHERE id = v_lot.auction_id;

  IF v_auction.soft_close_minutes > 0 AND
     v_lot.close_at - now() < make_interval(mins => v_auction.soft_close_minutes) THEN
    v_lot.close_at := now() + make_interval(mins => v_auction.soft_close_minutes);
    v_was_extended := true;
  END IF;

  -- 9. Update the lot row
  UPDATE lots SET
    current_bid_cents = v_new_current_cents,
    current_bid_id = COALESCE(v_auto_bid_id, v_new_bid_id),
    winner_bidder_id = v_leader_id,
    bid_count = bid_count + CASE WHEN v_auto_bid_id IS NOT NULL THEN 2 ELSE 1 END,
    close_at = v_lot.close_at,
    status = CASE WHEN status = 'scheduled' THEN 'live' ELSE status END,
    updated_at = now()
  WHERE id = p_lot_id;

  -- 10. Done — return the resulting state
  v_result := (true, 'ok', p_lot_id, v_new_current_cents, v_leader_id,
               v_lot.close_at, v_was_extended, v_outbid_bidder_id);
  RETURN v_result;
END;
$$;

-- Allow authenticated users to call this. The function itself rejects callers
-- who aren't bidders.
GRANT EXECUTE ON FUNCTION place_bid(UUID, BIGINT) TO authenticated;

-- ============================================================================
-- finalize_lot() — called by the BullMQ closeLot worker
--
-- Idempotent: if the lot is already closed, returns the existing winner.
-- If the close_at has been extended (soft-close), returns reason='reschedule'
-- so the worker can re-enqueue itself.
-- ============================================================================

DROP TYPE IF EXISTS finalize_lot_result CASCADE;
CREATE TYPE finalize_lot_result AS (
  ok BOOLEAN,
  reason TEXT,
  lot_id UUID,
  status lot_status,
  close_at TIMESTAMPTZ,
  winner_bidder_id UUID,
  winning_bid_cents BIGINT
);

CREATE OR REPLACE FUNCTION finalize_lot(p_lot_id UUID)
RETURNS finalize_lot_result
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lot lots%ROWTYPE;
  v_result finalize_lot_result;
BEGIN
  SELECT * INTO v_lot FROM lots WHERE id = p_lot_id FOR UPDATE;

  IF NOT FOUND THEN
    v_result := (false, 'lot_not_found', p_lot_id, NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;

  -- Already closed (idempotent)
  IF v_lot.status IN ('won', 'unsold', 'canceled') THEN
    v_result := (true, 'already_closed', p_lot_id, v_lot.status, v_lot.close_at,
                 v_lot.winner_bidder_id, v_lot.current_bid_cents);
    RETURN v_result;
  END IF;

  -- Close was extended after the worker was scheduled — reschedule
  IF now() < v_lot.close_at THEN
    v_result := (false, 'reschedule', p_lot_id, v_lot.status, v_lot.close_at,
                 v_lot.winner_bidder_id, v_lot.current_bid_cents);
    RETURN v_result;
  END IF;

  -- Finalize
  IF v_lot.winner_bidder_id IS NOT NULL THEN
    UPDATE lots SET
      status = 'won',
      closed_at = now(),
      updated_at = now()
    WHERE id = p_lot_id;

    v_result := (true, 'won', p_lot_id, 'won'::lot_status, v_lot.close_at,
                 v_lot.winner_bidder_id, v_lot.current_bid_cents);
  ELSE
    UPDATE lots SET
      status = 'unsold',
      closed_at = now(),
      updated_at = now()
    WHERE id = p_lot_id;

    v_result := (true, 'unsold', p_lot_id, 'unsold'::lot_status, v_lot.close_at,
                 NULL, NULL);
  END IF;

  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION finalize_lot(UUID) TO service_role;
