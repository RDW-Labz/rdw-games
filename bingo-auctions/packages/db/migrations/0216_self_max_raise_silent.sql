-- 0216 — self max-raise is silent (no visible bid, no soft-close extension)
--
-- Tester find (2026-07-02): already the high bidder at $1, raised their own
-- max to $5 in the final minute. Correct price behavior (stayed $1), but the
-- system ALSO: inserted a second visible bids row (bid history showed two
-- bids from the same person), bumped bid_count via the 0191 trigger, and
-- fired the anti-snipe extension (+3 min) even though nothing competitive
-- happened. Confusing at best; a self-extension lever at worst.
--
-- Change (place_bid step 5/6/7/8, everything else byte-identical to 0212's
-- live definition):
--   * When the caller is ALREADY the leader and has an existing bids row,
--     the raise UPDATEs that row's max_amount_cents in place instead of
--     inserting a new row. No new visible bid → the 0191 human-only
--     bid_count trigger doesn't fire (UPDATE, not INSERT) → history and
--     count are unchanged.
--   * The soft-close extension block is skipped for a self-raise — the
--     anti-snipe clock only moves on competitive action.
--   * The lot UPDATE is skipped too (price, leader, close_at, status all
--     unchanged by construction; skipping avoids nulling current_bid_id,
--     which COALESCE(v_auto_bid_id, v_new_bid_id) would have done).
--   * Fallback: leader with NO existing bids row (shouldn't happen, but
--     belt-and-suspenders) takes the old INSERT path unchanged.
--
-- Validation is intentionally untouched: a "raise" that doesn't clear
-- current + increment still returns below_min_increment exactly as before.

BEGIN;

CREATE OR REPLACE FUNCTION public.place_bid(p_lot_id uuid, p_max_amount_cents bigint)
 RETURNS place_bid_result
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  v_identity_threshold CONSTANT BIGINT := 50000;
  v_identity_verified_at TIMESTAMPTZ;
  -- 0104 additions:
  v_default_pm_id      TEXT;
  v_unpaid_fees_cents  BIGINT;
  -- 0194 addition: operator-default increment schedule (per-auction override
  -- wins via COALESCE below). NULL → legacy ladder inside min_bid_increment_cents.
  v_op_schedule JSONB;
  -- 0198 addition: when TRUE (platform_settings.payments_disabled) the §A/§B/§C
  -- *money* gates are skipped so the auction loop is testable without Stripe.
  v_payments_disabled BOOLEAN;
  -- 0212 addition: when TRUE (platform_settings.identity_verification_disabled)
  -- the §3.1b >= $500 identity gate is skipped (no KYC provider wired).
  v_identity_verification_disabled BOOLEAN;
  -- 0216 addition: TRUE when the caller is already the leader and merely
  -- raising their own max — handled as a silent in-place update.
  v_self_raise BOOLEAN := false;
BEGIN
  -- =========================================================================
  -- 0111 §A: Serialize all concurrent place_bid calls for THIS lot.
  -- pg_advisory_xact_lock is held until COMMIT/ROLLBACK. hashtext gives
  -- us a stable BIGINT from the UUID. This is strictly stronger than
  -- the existing SELECT ... FOR UPDATE on lots — it also prevents
  -- proxy-duel races against the bids table (step 4) without forcing
  -- us to FOR UPDATE every bids row we read.
  -- =========================================================================
  PERFORM pg_advisory_xact_lock(hashtext(p_lot_id::text));

  -- 1. Auth check
  IF v_bidder_id IS NULL THEN
    v_result := (false, 'not_authenticated', p_lot_id, NULL, NULL, NULL, false, NULL);
    RETURN v_result;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM bidders WHERE id = v_bidder_id) THEN
    v_result := (false, 'not_a_bidder', p_lot_id, NULL, NULL, NULL, false, NULL);
    RETURN v_result;
  END IF;

  -- 0198: resolve the no-Stripe test switch once, up front. The §A/§B/§C
  -- money gates below are skipped when this is TRUE.
  v_payments_disabled := payments_disabled();

  -- 0212: resolve the KYC switch once, up front. The §3.1b identity gate below
  -- is skipped when this is TRUE (no verification provider wired).
  v_identity_verification_disabled := identity_verification_disabled();

  -- =========================================================================
  -- 0104 §A: NO PAYMENT METHOD ON FILE
  -- =========================================================================
  SELECT default_payment_method_id, unpaid_fees_cents
    INTO v_default_pm_id, v_unpaid_fees_cents
    FROM bidders WHERE id = v_bidder_id;

  IF v_default_pm_id IS NULL AND NOT v_payments_disabled THEN
    v_result := (false, 'no_payment_method', p_lot_id, NULL, NULL, NULL, false, NULL);
    RETURN v_result;
  END IF;

  -- =========================================================================
  -- 0104 §B: UNPAID RELOT FEES
  -- =========================================================================
  IF v_unpaid_fees_cents > 0 AND NOT v_payments_disabled THEN
    v_result := (false, 'unpaid_fees', p_lot_id, NULL, NULL, NULL, false, NULL);
    RETURN v_result;
  END IF;

  -- 2. Lock the lot (UNCHANGED from 0084)
  SELECT * INTO v_lot FROM lots WHERE id = p_lot_id FOR UPDATE;

  IF NOT FOUND THEN
    v_result := (false, 'lot_not_found', p_lot_id, NULL, NULL, NULL, false, NULL);
    RETURN v_result;
  END IF;

  SELECT * INTO v_auction FROM auctions WHERE id = v_lot.auction_id;

  -- 0194: load the operator-default schedule. v_auction.bid_increment_schedule
  -- (the per-auction override) is already available on the rowtype because the
  -- ALTER above ran first; COALESCE(override, default) is computed at the call
  -- site below. NULL on both → min_bid_increment_cents uses the legacy ladder.
  SELECT bid_increment_schedule INTO v_op_schedule
    FROM operators WHERE id = v_auction.operator_id;

  -- §3.1a (0084): Shill-bidding guard
  IF EXISTS (
    SELECT 1
    FROM operator_users ou
    WHERE ou.user_id     = v_bidder_id
      AND ou.operator_id = v_auction.operator_id
  ) THEN
    RAISE EXCEPTION 'shill_bidding_forbidden: staff of this operator cannot bid on its own lots'
      USING ERRCODE = 'P0001';
  END IF;

  -- §3.1b (0084): Identity-verification threshold (server-side)
  -- 0212: skipped entirely when identity_verification_disabled (no KYC provider
  -- wired). Flip the flag FALSE to re-arm this gate once a provider exists.
  IF p_max_amount_cents >= v_identity_threshold AND NOT v_identity_verification_disabled THEN
    SELECT identity_verified_at INTO v_identity_verified_at
    FROM bidders
    WHERE id = v_bidder_id;

    IF v_identity_verified_at IS NULL THEN
      RAISE EXCEPTION 'identity_verification_required: bid amount meets or exceeds threshold; bidder must complete identity verification first'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- Suspension gate (UNCHANGED from 0084)
  SELECT (suspended_at IS NOT NULL) INTO v_suspended
  FROM operator_bidder_relations
  WHERE operator_id = v_auction.operator_id
    AND bidder_id   = v_bidder_id;

  IF v_suspended IS TRUE THEN
    v_result := (false, 'bidder_suspended', p_lot_id, v_lot.current_bid_cents,
                 v_lot.winner_bidder_id, v_lot.close_at, false, NULL);
    RETURN v_result;
  END IF;

  -- =========================================================================
  -- 0176 §C: PER-OPERATOR UNPAID-INVOICE BLOCK
  -- Block bidding when this bidder has an invoice still in the
  -- payment_failed_grace window AT THIS OPERATOR. The decline gives them a
  -- grace window (operators.auto_charge_grace_hours, default 48h) to fix
  -- their card; until they do, they can't keep bidding at the operator they
  -- owe. Scoped PER-OPERATOR by owner decision (2026-06-02): a grace invoice
  -- at one operator does not block bidding at another. The pre-existing
  -- unpaid_fees gate (0104 §B) remains global and covers the post-relist
  -- case. Reason 'unpaid_invoice' deep-links the bidder app to the invoice.
  -- 0198: skipped entirely in no-Stripe test mode (invoices are marked paid
  -- offline, so there are no genuine grace invoices to honor).
  -- =========================================================================
  IF NOT v_payments_disabled AND EXISTS (
    SELECT 1
    FROM invoices
    WHERE bidder_id   = v_bidder_id
      AND operator_id = v_auction.operator_id
      AND status      = 'payment_failed_grace'
  ) THEN
    v_result := (false, 'unpaid_invoice', p_lot_id, v_lot.current_bid_cents,
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
  -- 0194: increment now reads from the effective schedule
  -- COALESCE(auction override, operator default). NULL → legacy ladder.
  v_min_increment := min_bid_increment_cents(
    v_lot.current_bid_cents,
    COALESCE(v_auction.bid_increment_schedule, v_op_schedule)
  );

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

  -- 4. Look up existing leader's max (UNCHANGED from 0084; race covered
  -- by 0111 §A advisory lock above)
  SELECT b.* INTO v_current_max_bid
  FROM bids b
  WHERE b.lot_id = p_lot_id AND b.bidder_id = v_lot.winner_bidder_id
  ORDER BY b.placed_at DESC
  LIMIT 1;

  -- 5. Proxy duel resolution (self-raise branch reworked in 0216)
  IF v_lot.winner_bidder_id IS NULL THEN
    v_new_current_cents := v_lot.starting_bid_cents;
    v_leader_id := v_bidder_id;
    v_outbid_bidder_id := NULL;
  ELSIF v_lot.winner_bidder_id = v_bidder_id THEN
    v_new_current_cents := v_lot.current_bid_cents;
    v_leader_id := v_bidder_id;
    v_outbid_bidder_id := NULL;
    -- 0216: leader raising their own max. Silent path when there's an
    -- existing bids row to update; the (theoretical) rowless leader falls
    -- back to the old INSERT path below.
    v_self_raise := v_current_max_bid.id IS NOT NULL;
  ELSIF p_max_amount_cents > v_current_max_bid.max_amount_cents THEN
    v_new_current_cents := LEAST(
      p_max_amount_cents,
      v_current_max_bid.max_amount_cents + v_min_increment
    );
    v_leader_id := v_bidder_id;
    v_outbid_bidder_id := v_lot.winner_bidder_id;
  ELSE
    v_new_current_cents := LEAST(
      v_current_max_bid.max_amount_cents,
      p_max_amount_cents + v_min_increment
    );
    v_leader_id := v_lot.winner_bidder_id;
    v_outbid_bidder_id := v_bidder_id;
  END IF;

  -- 6. Record the bid.
  IF v_self_raise THEN
    -- 0216: in-place max update on the leader's latest row. UPDATE (not
    -- INSERT) so the 0191 human-only bid_count trigger doesn't fire and the
    -- visible history gains no row. placed_at is deliberately NOT bumped —
    -- step 4's ORDER BY placed_at DESC still resolves the same row, and the
    -- historical timeline stays truthful.
    UPDATE bids
    SET max_amount_cents = p_max_amount_cents
    WHERE id = v_current_max_bid.id;
  ELSE
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
  END IF;

  -- 7. Soft-close extension
  --
  -- 0111 §B: only enter the extension block when soft_close_minutes > 0.
  -- 0216: skipped entirely on a self-raise — the anti-snipe clock only
  -- moves on competitive action, not on the leader adjusting their own max.
  v_old_close_at := v_lot.close_at;
  IF NOT v_self_raise
     AND v_auction.format = 'standard'
     AND COALESCE(v_auction.soft_close_minutes, 0) > 0 THEN
    DECLARE
      v_soft_close_secs BIGINT;
      v_extended_close TIMESTAMPTZ;
    BEGIN
      v_soft_close_secs := v_auction.soft_close_minutes * 60;
      v_extended_close  := now() + (v_soft_close_secs || ' seconds')::INTERVAL;
      IF v_extended_close > v_lot.close_at THEN
        v_was_extended := true;
        v_lot.close_at := v_extended_close;
      END IF;
    END;
  END IF;

  -- 8. Update lot
  -- 0216: skipped on a self-raise — price, leader, close_at, and status are
  -- all unchanged by construction, and running it would null current_bid_id
  -- (no new bid row to COALESCE onto).
  IF NOT v_self_raise THEN
    UPDATE lots SET
      current_bid_cents = v_new_current_cents,
      current_bid_id    = COALESCE(v_auto_bid_id, v_new_bid_id),
      winner_bidder_id  = v_leader_id,
      close_at          = v_lot.close_at,
      status            = CASE WHEN status = 'scheduled' THEN 'live' ELSE status END,
      updated_at        = now()
    WHERE id = p_lot_id;
  END IF;

  PERFORM _ensure_operator_bidder_relation(v_auction.operator_id, v_bidder_id);

  v_result := (
    true, 'ok', p_lot_id,
    v_new_current_cents, v_leader_id, v_lot.close_at,
    v_was_extended, v_outbid_bidder_id
  );
  RETURN v_result;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.place_bid(UUID, BIGINT) TO authenticated;

COMMIT;
