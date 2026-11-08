-- ============================================================================
-- 0084_place_bid_security_guards.sql
--
-- Adds two server-side security guards to place_bid() required by
-- LAUNCH_PLAN.md §3.1a (shill-bidding prevention) and §3.1b (identity-
-- verification threshold enforcement).
--
-- §3.1a — Shill-bidding guard
--   An operator's own staff members (anyone with a row in operator_users for
--   the lot's operator) must not be able to bid on that operator's lots.
--   Market manipulation via shill bids is illegal under 18 U.S.C. § 1343 and
--   violates the platform's terms. Staff CAN bid on OTHER operators' lots —
--   only same-operator bids are blocked.
--
-- §3.1b — Identity-verification threshold (server-side)
--   The bidder app enforces IDENTITY_VERIFICATION_THRESHOLD_CENTS client-side,
--   but a hostile client can strip that check and call place_bid() directly via
--   the Supabase REST API. The server must reject bids at or above
--   50 000 cents ($500) from bidders with identity_verified_at IS NULL.
--   Source of truth for the threshold: packages/shared/src/constants.ts
--   IDENTITY_VERIFICATION_THRESHOLD_CENTS = 500_00 = 50000.
--
-- Implementation notes:
--   • Both guards are inserted at the top of the function body, BEFORE the
--     suspension check, lot-status check, and amount validation — a clean
--     RETURN path for auth-level rejections.
--   • We use RAISE ... USING ERRCODE = 'P0001' (a reserved user-defined class)
--     with a unique message prefix so callers can pattern-match on the message
--     text. PostgreSQL does not expose a way to register custom SQLSTATE codes
--     without a compiled extension, so the conventional approach is distinct
--     message prefixes within the P0001 class.
--   • The function is fully re-emitted (same pattern as 0078) so it is safe to
--     run without the preceding migrations being in the session.
--   • Return type, parameter names, and GRANT are unchanged.
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
  v_suspended BOOLEAN := false;
  -- §3.1b: server-side identity-verification threshold (cents)
  -- Must match packages/shared/src/constants.ts IDENTITY_VERIFICATION_THRESHOLD_CENTS
  v_identity_threshold CONSTANT BIGINT := 50000;
  v_identity_verified_at TIMESTAMPTZ;
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

  -- =========================================================================
  -- §3.1a: SHILL-BIDDING GUARD
  --
  -- Reject when the calling bidder is a staff member (operator_users row) of
  -- the same operator that owns this lot. Staff at OTHER operators are allowed.
  -- This check runs before any bid logic so no lot state is touched.
  -- =========================================================================
  IF EXISTS (
    SELECT 1
    FROM operator_users ou
    WHERE ou.user_id     = v_bidder_id
      AND ou.operator_id = v_auction.operator_id
  ) THEN
    RAISE EXCEPTION 'shill_bidding_forbidden: staff of this operator cannot bid on its own lots'
      USING ERRCODE = 'P0001';
  END IF;

  -- =========================================================================
  -- §3.1b: IDENTITY-VERIFICATION THRESHOLD GUARD (server-side)
  --
  -- If p_max_amount_cents meets or exceeds the threshold and the bidder has
  -- not completed identity verification, reject. The client-side check in the
  -- bidder app is a UX convenience only; this is the authoritative gate.
  -- =========================================================================
  IF p_max_amount_cents >= v_identity_threshold THEN
    SELECT identity_verified_at INTO v_identity_verified_at
    FROM bidders
    WHERE id = v_bidder_id;

    IF v_identity_verified_at IS NULL THEN
      RAISE EXCEPTION 'identity_verification_required: bid amount meets or exceeds threshold; bidder must complete identity verification first'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- =========================================================================
  -- END security guards — remainder is unchanged from 0078
  -- =========================================================================

  -- Suspension gate — reject if this bidder is suspended by this operator.
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

  -- 5. Proxy duel resolution
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
  -- When B loses the duel, v_new_current_cents = p_max_amount_cents + increment which
  -- would exceed p_max_amount_cents and violate the bids CHECK constraint. Use B's actual
  -- max as amount_cents when they do not take the lead (same as 0003_place_bid_fn.sql).
  INSERT INTO bids (lot_id, bidder_id, amount_cents, max_amount_cents, is_auto, placed_at)
  VALUES (
    p_lot_id, v_bidder_id,
    CASE WHEN v_leader_id = v_bidder_id THEN v_new_current_cents
         ELSE p_max_amount_cents END,
    p_max_amount_cents,
    false, now()
  )
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
      -- soft_close_minutes lives on auctions (per-auction override).
      -- The PER-OPERATOR default `default_soft_close_minutes` is on the
      -- operators table — auction creation copies it onto the auction.
      -- Migration 0078 had a typo here that referenced the operator-side
      -- column on the v_auction record, which silently failed before the
      -- standard format was exercised end-to-end. Caught by mega-sim.
      v_soft_close_secs := COALESCE(v_auction.soft_close_minutes, 3) * 60;
      v_extended_close  := now() + (v_soft_close_secs || ' seconds')::INTERVAL;
      IF v_extended_close > v_lot.close_at THEN
        v_was_extended := true;
        v_lot.close_at := v_extended_close;
      END IF;
    END;
  END IF;

  -- 8. Update lot
  -- status transitions scheduled→live on the first bid (when there was no prior leader).
  UPDATE lots SET
    current_bid_cents = v_new_current_cents,
    current_bid_id    = COALESCE(v_auto_bid_id, v_new_bid_id),
    winner_bidder_id  = v_leader_id,
    bid_count         = bid_count + CASE WHEN v_auto_bid_id IS NOT NULL THEN 2 ELSE 1 END,
    close_at          = v_lot.close_at,
    status            = CASE WHEN status = 'scheduled' THEN 'live' ELSE status END,
    updated_at        = now()
  WHERE id = p_lot_id;

  -- Ensure relation row exists so the operator can later annotate this bidder.
  PERFORM _ensure_operator_bidder_relation(v_auction.operator_id, v_bidder_id);

  v_result := (
    true, 'ok', p_lot_id,
    v_new_current_cents, v_leader_id, v_lot.close_at,
    v_was_extended, v_outbid_bidder_id
  );
  RETURN v_result;
END;
$$;

-- GRANT is idempotent; preserve original grant from 0003_place_bid_fn.sql.
GRANT EXECUTE ON FUNCTION place_bid(UUID, BIGINT) TO authenticated;
