-- migration 0176 — block bidding while a bidder has an unpaid invoice
--
-- Field request 2026-06-02: "On auction sites I have used it auto blocks you
-- from bidding once you have an unpaid invoice; once settled you can bid
-- again." Owner decision (2026-06-02): scope is PER-OPERATOR — a grace
-- invoice at Operator A blocks bidding at Operator A only, not everywhere.
--
-- ── The gap ────────────────────────────────────────────────────────────────
-- place_bid (live def = 0084 security guards + 0104 grace-enum gates + 0111
-- concurrency/soft-close) already blocks two cases:
--   • 0104 §A  no_payment_method  (default_payment_method_id IS NULL)
--   • 0104 §B  unpaid_fees        (bidders.unpaid_fees_cents > 0)
-- But unpaid_fees_cents is only incremented AFTER the grace window expires
-- and the lot is relisted (the relot fee, apply_relot_fee). So during the
-- 48h payment_failed_grace window the bidder can keep bidding despite owing
-- on a just-declined invoice. This adds that missing gate.
--
-- ── The fix ──────────────────────────────────────────────────────────────
-- New gate §C: block when the bidder has any invoice in
-- 'payment_failed_grace' AT THIS OPERATOR (per-operator, by owner decision).
-- Returns reason 'unpaid_invoice'; the bidder app maps it to a deep-link to
-- the open invoice so they can pay and resume. Placed right after the
-- per-operator suspension gate (both need v_auction.operator_id, loaded at
-- the "SELECT * INTO v_auction" above). The global unpaid_fees gate is left
-- exactly as-is (it covers the post-relist case).
--
-- ── Verbatim preservation ──────────────────────────────────────────────────
-- The function body below is the EXACT live definition pulled from prod via
-- pg_get_functiondef('place_bid(uuid,bigint)') on 2026-06-02 — every 0084
-- shill/identity guard, 0104 §A/§B gate, and 0111 advisory-lock + soft-close
-- block is reproduced unchanged. The ONLY addition is the §C block. Per the
-- project "no shortcuts" rule, nothing else is touched. CREATE OR REPLACE
-- preserves the existing ACL (EXECUTE granted to authenticated).
--
-- ── Risk: low ──────────────────────────────────────────────────────────────
-- CREATE OR REPLACE, identical signature place_bid(uuid,bigint). No schema
-- change. Adds one EXISTS gate that fails closed (blocks a bid) only for a
-- bidder who genuinely has a grace invoice at the same operator.

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

  -- =========================================================================
  -- 0104 §A: NO PAYMENT METHOD ON FILE
  -- =========================================================================
  SELECT default_payment_method_id, unpaid_fees_cents
    INTO v_default_pm_id, v_unpaid_fees_cents
    FROM bidders WHERE id = v_bidder_id;

  IF v_default_pm_id IS NULL THEN
    v_result := (false, 'no_payment_method', p_lot_id, NULL, NULL, NULL, false, NULL);
    RETURN v_result;
  END IF;

  -- =========================================================================
  -- 0104 §B: UNPAID RELOT FEES
  -- =========================================================================
  IF v_unpaid_fees_cents > 0 THEN
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
  IF p_max_amount_cents >= v_identity_threshold THEN
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
  -- =========================================================================
  IF EXISTS (
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

  -- 4. Look up existing leader's max (UNCHANGED from 0084; race covered
  -- by 0111 §A advisory lock above)
  SELECT b.* INTO v_current_max_bid
  FROM bids b
  WHERE b.lot_id = p_lot_id AND b.bidder_id = v_lot.winner_bidder_id
  ORDER BY b.placed_at DESC
  LIMIT 1;

  -- 5. Proxy duel resolution (UNCHANGED from 0084)
  IF v_lot.winner_bidder_id IS NULL THEN
    v_new_current_cents := v_lot.starting_bid_cents;
    v_leader_id := v_bidder_id;
    v_outbid_bidder_id := NULL;
  ELSIF v_lot.winner_bidder_id = v_bidder_id THEN
    v_new_current_cents := v_lot.current_bid_cents;
    v_leader_id := v_bidder_id;
    v_outbid_bidder_id := NULL;
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

  -- 6. Insert bid(s) (UNCHANGED from 0084)
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
  --
  -- 0111 §B: only enter the extension block when soft_close_minutes > 0.
  -- Setting soft_close_minutes = 0 is now an authoritative opt-out, not
  -- a no-op that still flips v_was_extended = true on the last bid.
  v_old_close_at := v_lot.close_at;
  IF v_auction.format = 'standard'
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

  -- 8. Update lot (UNCHANGED from 0084)
  UPDATE lots SET
    current_bid_cents = v_new_current_cents,
    current_bid_id    = COALESCE(v_auto_bid_id, v_new_bid_id),
    winner_bidder_id  = v_leader_id,
    bid_count         = bid_count + CASE WHEN v_auto_bid_id IS NOT NULL THEN 2 ELSE 1 END,
    close_at          = v_lot.close_at,
    status            = CASE WHEN status = 'scheduled' THEN 'live' ELSE status END,
    updated_at        = now()
  WHERE id = p_lot_id;

  PERFORM _ensure_operator_bidder_relation(v_auction.operator_id, v_bidder_id);

  v_result := (
    true, 'ok', p_lot_id,
    v_new_current_cents, v_leader_id, v_lot.close_at,
    v_was_extended, v_outbid_bidder_id
  );
  RETURN v_result;
END;
$function$;

COMMIT;
