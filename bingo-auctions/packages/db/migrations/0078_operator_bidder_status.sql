-- ============================================================================
-- operator_bidder_relations — per-operator bidder suspend + internal notes.
--
-- Operators can suspend a bidder from THEIR auctions only (does not affect
-- the bidder's access to other operators). Internal notes are private to the
-- operator's staff.
--
-- place_bid() is patched below to reject bids from suspended bidders.
--
-- NOTE: migration 0077 is reserved for charge_disputes (Phase 1 §1.3).
-- NOTE: the webhook-idempotency table requested in §1.4 is also numbered
--       0078 in the plan; rename that migration to 0079 when it ships.
-- ============================================================================

CREATE TABLE IF NOT EXISTS operator_bidder_relations (
  operator_id UUID NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  bidder_id   UUID NOT NULL REFERENCES bidders(id)   ON DELETE CASCADE,
  suspended_at     TIMESTAMPTZ,
  suspended_reason TEXT,
  internal_notes   TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (operator_id, bidder_id)
);

CREATE INDEX IF NOT EXISTS obr_operator_idx ON operator_bidder_relations (operator_id);
CREATE INDEX IF NOT EXISTS obr_bidder_idx   ON operator_bidder_relations (bidder_id);
CREATE INDEX IF NOT EXISTS obr_suspended_idx ON operator_bidder_relations (operator_id)
  WHERE suspended_at IS NOT NULL;

ALTER TABLE operator_bidder_relations ENABLE ROW LEVEL SECURITY;

-- Operator staff can read/write relations for their own operator.
CREATE POLICY obr_staff_select ON operator_bidder_relations
  FOR SELECT USING (operator_id = current_operator_id());

CREATE POLICY obr_staff_insert ON operator_bidder_relations
  FOR INSERT WITH CHECK (operator_id = current_operator_id());

CREATE POLICY obr_staff_update ON operator_bidder_relations
  FOR UPDATE USING (operator_id = current_operator_id())
             WITH CHECK (operator_id = current_operator_id());

-- ============================================================================
-- Auto-upsert an operator_bidder_relations row whenever place_bid succeeds.
-- Ensures every bidder who has ever bid on this operator's lots has a row we
-- can later suspend or annotate.
-- ============================================================================

CREATE OR REPLACE FUNCTION _ensure_operator_bidder_relation(
  p_operator_id UUID,
  p_bidder_id   UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO operator_bidder_relations (operator_id, bidder_id)
  VALUES (p_operator_id, p_bidder_id)
  ON CONFLICT (operator_id, bidder_id) DO NOTHING;
END;
$$;

-- ============================================================================
-- Patch place_bid() to:
--   1. Reject bids from bidders suspended by this operator.
--   2. Auto-upsert a relation row on every successful bid.
--
-- We re-create the function in-place — same signature as 0003_place_bid_fn.sql.
-- Only the two marked blocks are new; everything else is unchanged.
-- ============================================================================

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
  v_current_max_bid bids%ROWTYPE;
  v_new_current_cents BIGINT;
  v_leader_id UUID;
  v_new_bid_id UUID;
  v_auto_bid_id UUID;
  v_was_extended BOOLEAN := false;
  v_old_close_at TIMESTAMPTZ;
  v_outbid_bidder_id UUID;
  v_result place_bid_result;
  -- NEW: suspension check
  v_suspended BOOLEAN := false;
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

  -- 2. Lock the lot
  SELECT * INTO v_lot FROM lots WHERE id = p_lot_id FOR UPDATE;

  IF NOT FOUND THEN
    v_result := (false, 'lot_not_found', p_lot_id, NULL, NULL, NULL, false, NULL);
    RETURN v_result;
  END IF;

  SELECT * INTO v_auction FROM auctions WHERE id = v_lot.auction_id;

  -- NEW: suspension gate — reject if this bidder is suspended by this operator.
  SELECT (suspended_at IS NOT NULL) INTO v_suspended
  FROM operator_bidder_relations
  WHERE operator_id = v_auction.operator_id
    AND bidder_id   = v_bidder_id;

  IF v_suspended IS TRUE THEN
    v_result := (false, 'bidder_suspended', p_lot_id, v_lot.current_bid_cents,
                 v_lot.winner_bidder_id, v_lot.close_at, false, NULL);
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
    IF p_max_amount_cents < v_lot.starting_bid_cents THEN
      v_result := (false, 'below_starting_bid', p_lot_id, v_lot.current_bid_cents,
                   NULL, v_lot.close_at, false, NULL);
      RETURN v_result;
    END IF;
  ELSE
    IF p_max_amount_cents < v_lot.current_bid_cents + v_min_increment THEN
      v_result := (false, 'below_min_increment', p_lot_id, v_lot.current_bid_cents,
                   v_lot.winner_bidder_id, v_lot.close_at, false, NULL);
      RETURN v_result;
    END IF;
  END IF;

  -- 4. Look up existing leader's max
  SELECT b.* INTO v_current_max_bid
  FROM bids b
  WHERE b.lot_id = p_lot_id AND b.bidder_id = v_lot.winner_bidder_id
  ORDER BY b.placed_at DESC
  LIMIT 1;

  -- 5. Proxy duel resolution (unchanged from 0003)
  IF v_lot.winner_bidder_id IS NULL THEN
    v_new_current_cents := v_lot.starting_bid_cents;
    v_leader_id := v_bidder_id;
    v_outbid_bidder_id := NULL;

  ELSIF v_lot.winner_bidder_id = v_bidder_id THEN
    -- Re-raise own max
    v_new_current_cents := v_lot.current_bid_cents;
    v_leader_id := v_bidder_id;
    v_outbid_bidder_id := NULL;

  ELSIF p_max_amount_cents > v_current_max_bid.max_amount_cents THEN
    -- New bidder wins duel
    v_new_current_cents := LEAST(
      p_max_amount_cents,
      v_current_max_bid.max_amount_cents + v_min_increment
    );
    v_leader_id := v_bidder_id;
    v_outbid_bidder_id := v_lot.winner_bidder_id;

  ELSE
    -- Existing leader's max still dominates
    v_new_current_cents := LEAST(
      v_current_max_bid.max_amount_cents,
      p_max_amount_cents + v_min_increment
    );
    v_leader_id := v_lot.winner_bidder_id;
    v_outbid_bidder_id := v_bidder_id;
  END IF;

  -- 6. Insert bid(s)
  INSERT INTO bids (lot_id, bidder_id, amount_cents, max_amount_cents, is_auto, placed_at)
  VALUES (p_lot_id, v_bidder_id, v_new_current_cents, p_max_amount_cents, false, now())
  RETURNING id INTO v_new_bid_id;

  IF v_leader_id <> v_bidder_id AND v_current_max_bid.id IS NOT NULL THEN
    INSERT INTO bids (lot_id, bidder_id, amount_cents, max_amount_cents, is_auto, placed_at)
    VALUES (p_lot_id, v_leader_id, v_new_current_cents,
            v_current_max_bid.max_amount_cents, true, now())
    RETURNING id INTO v_auto_bid_id;
  END IF;

  -- 7. Soft-close extension
  v_old_close_at := v_lot.close_at;
  IF v_auction.format = 'standard' THEN
    DECLARE
      v_soft_close_secs BIGINT;
      v_extended_close TIMESTAMPTZ;
    BEGIN
      v_soft_close_secs := COALESCE(v_auction.default_soft_close_minutes, 3) * 60;
      v_extended_close  := now() + (v_soft_close_secs || ' seconds')::INTERVAL;
      IF v_extended_close > v_lot.close_at THEN
        v_was_extended := true;
        v_lot.close_at := v_extended_close;
      END IF;
    END;
  END IF;

  -- 8. Update lot
  UPDATE lots SET
    current_bid_cents = v_new_current_cents,
    current_bid_id    = v_new_bid_id,
    winner_bidder_id  = v_leader_id,
    bid_count         = bid_count + 1,
    close_at          = v_lot.close_at,
    updated_at        = now()
  WHERE id = p_lot_id;

  -- NEW: ensure relation row exists so the operator can later annotate this bidder.
  PERFORM _ensure_operator_bidder_relation(v_auction.operator_id, v_bidder_id);

  v_result := (
    true, 'ok', p_lot_id,
    v_new_current_cents, v_leader_id, v_lot.close_at,
    v_was_extended, v_outbid_bidder_id
  );
  RETURN v_result;
END;
$$;

-- ============================================================================
-- Platform-level operator billing columns.
-- Operators pay Cluer Holdings a monthly subscription through Stripe.
-- We track their Stripe customer + subscription IDs on the operators row.
-- ============================================================================

ALTER TABLE operators
  ADD COLUMN IF NOT EXISTS platform_stripe_customer_id     TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS platform_stripe_subscription_id TEXT UNIQUE;
