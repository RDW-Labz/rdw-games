-- ============================================================================
-- Buy-now RPCs for non-standard auction formats.
--
-- buy_flat_price(lot_id):
--   Last Chance: lot has flat_price_cents, status='scheduled'/'live',
--   no current_bid. First caller wins; we lock the lot row, set status='won',
--   record a synthetic bid at flat_price_cents, fire the won notification.
--
-- buy_dutch(lot_id, max_acceptable_cents):
--   Dutch: locks the lot, computes current price, asserts the caller is
--   willing to pay >= current price (prevents losing to a fast tick), then
--   finalizes at the current price. Same downstream as buy_flat_price.
--
-- Both are SECURITY DEFINER and use auth.uid() as the buyer.
-- ============================================================================

DROP TYPE IF EXISTS buy_result CASCADE;
CREATE TYPE buy_result AS (
  ok BOOLEAN,
  reason TEXT,
  lot_id UUID,
  final_price_cents BIGINT
);

-- ----------------------------------------------------------------------------
-- buy_flat_price (Last Chance)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION buy_flat_price(p_lot_id UUID)
RETURNS buy_result
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_lot lots%ROWTYPE;
  v_auction auctions%ROWTYPE;
  v_bid_id UUID;
  v_result buy_result;
BEGIN
  IF v_user IS NULL THEN
    v_result := (false, 'not_authenticated', p_lot_id, NULL);
    RETURN v_result;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM bidders WHERE id = v_user) THEN
    v_result := (false, 'not_a_bidder', p_lot_id, NULL);
    RETURN v_result;
  END IF;

  SELECT * INTO v_lot FROM lots WHERE id = p_lot_id FOR UPDATE;
  IF NOT FOUND THEN
    v_result := (false, 'lot_not_found', p_lot_id, NULL);
    RETURN v_result;
  END IF;
  IF v_lot.flat_price_cents IS NULL THEN
    v_result := (false, 'not_flat_price_lot', p_lot_id, NULL);
    RETURN v_result;
  END IF;
  IF v_lot.status NOT IN ('scheduled', 'live') THEN
    v_result := (false, 'lot_not_available', p_lot_id, v_lot.flat_price_cents);
    RETURN v_result;
  END IF;
  IF v_lot.winner_bidder_id IS NOT NULL THEN
    v_result := (false, 'already_sold', p_lot_id, v_lot.current_bid_cents);
    RETURN v_result;
  END IF;

  SELECT * INTO v_auction FROM auctions WHERE id = v_lot.auction_id;
  IF v_auction.format <> 'last_chance' THEN
    v_result := (false, 'wrong_format', p_lot_id, NULL);
    RETURN v_result;
  END IF;
  IF now() < v_auction.starts_at THEN
    v_result := (false, 'not_started', p_lot_id, v_lot.flat_price_cents);
    RETURN v_result;
  END IF;

  -- Record the synthetic bid + finalize.
  INSERT INTO bids (lot_id, bidder_id, amount_cents, max_amount_cents, is_auto)
  VALUES (p_lot_id, v_user, v_lot.flat_price_cents, v_lot.flat_price_cents, false)
  RETURNING id INTO v_bid_id;

  UPDATE lots SET
    current_bid_cents = v_lot.flat_price_cents,
    current_bid_id = v_bid_id,
    winner_bidder_id = v_user,
    bid_count = bid_count + 1,
    status = 'won',
    closed_at = now(),
    updated_at = now()
  WHERE id = p_lot_id;

  -- Won notification
  PERFORM enqueue_notification(
    'won',
    v_user,
    jsonb_build_object(
      'lot_id', p_lot_id,
      'lot_title', v_lot.title,
      'winning_bid_cents', v_lot.flat_price_cents,
      'auction_id', v_lot.auction_id
    ),
    'won:' || v_user || ':' || p_lot_id
  );

  v_result := (true, 'ok', p_lot_id, v_lot.flat_price_cents);
  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION buy_flat_price(UUID) TO authenticated;

-- ----------------------------------------------------------------------------
-- buy_dutch
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION buy_dutch(
  p_lot_id UUID,
  p_max_acceptable_cents BIGINT
)
RETURNS buy_result
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_lot lots%ROWTYPE;
  v_auction auctions%ROWTYPE;
  v_current_price BIGINT;
  v_bid_id UUID;
  v_result buy_result;
BEGIN
  IF v_user IS NULL THEN
    v_result := (false, 'not_authenticated', p_lot_id, NULL);
    RETURN v_result;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM bidders WHERE id = v_user) THEN
    v_result := (false, 'not_a_bidder', p_lot_id, NULL);
    RETURN v_result;
  END IF;

  SELECT * INTO v_lot FROM lots WHERE id = p_lot_id FOR UPDATE;
  IF NOT FOUND THEN
    v_result := (false, 'lot_not_found', p_lot_id, NULL);
    RETURN v_result;
  END IF;
  IF v_lot.dutch_start_cents IS NULL THEN
    v_result := (false, 'not_dutch_lot', p_lot_id, NULL);
    RETURN v_result;
  END IF;
  IF v_lot.status NOT IN ('scheduled', 'live') THEN
    v_result := (false, 'lot_not_available', p_lot_id, v_lot.current_bid_cents);
    RETURN v_result;
  END IF;
  IF v_lot.winner_bidder_id IS NOT NULL THEN
    v_result := (false, 'already_sold', p_lot_id, v_lot.current_bid_cents);
    RETURN v_result;
  END IF;

  SELECT * INTO v_auction FROM auctions WHERE id = v_lot.auction_id;
  IF v_auction.format <> 'dutch' THEN
    v_result := (false, 'wrong_format', p_lot_id, NULL);
    RETURN v_result;
  END IF;
  IF now() < v_auction.starts_at THEN
    v_result := (false, 'not_started', p_lot_id, NULL);
    RETURN v_result;
  END IF;

  v_current_price := compute_dutch_current_price(p_lot_id, now());

  -- Bidder rejects buying above their max — protects against a tick happening
  -- between the UI rendering and the click landing.
  IF v_current_price > p_max_acceptable_cents THEN
    v_result := (false, 'price_above_max', p_lot_id, v_current_price);
    RETURN v_result;
  END IF;

  INSERT INTO bids (lot_id, bidder_id, amount_cents, max_amount_cents, is_auto)
  VALUES (p_lot_id, v_user, v_current_price, p_max_acceptable_cents, false)
  RETURNING id INTO v_bid_id;

  UPDATE lots SET
    current_bid_cents = v_current_price,
    current_bid_id = v_bid_id,
    winner_bidder_id = v_user,
    bid_count = bid_count + 1,
    status = 'won',
    closed_at = now(),
    updated_at = now()
  WHERE id = p_lot_id;

  PERFORM enqueue_notification(
    'won',
    v_user,
    jsonb_build_object(
      'lot_id', p_lot_id,
      'lot_title', v_lot.title,
      'winning_bid_cents', v_current_price,
      'auction_id', v_lot.auction_id
    ),
    'won:' || v_user || ':' || p_lot_id
  );

  v_result := (true, 'ok', p_lot_id, v_current_price);
  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION buy_dutch(UUID, BIGINT) TO authenticated;
