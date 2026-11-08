-- ============================================================================
-- Migration 0191 — lots.bid_count = number of distinct HUMAN bids (single
--                  source of truth via the sync trigger)
--
-- ── The bug (confirmed on live prod) ────────────────────────────────────────
-- lots.bid_count DOUBLE-WRITES. Two independent mechanisms both maintain it,
-- so the stored value = (real bid rows) + (manual increment):
--
--   1. The AFTER INSERT/DELETE per-row trigger sync_lot_bid_count() (mig 0101)
--      recomputes  bid_count = count(*) FROM bids WHERE lot_id = ...  with NO
--      is_auto filter. This is authoritative on its own.
--
--   2. THREE writer functions ALSO manually bump bid_count in their
--      "UPDATE lots SET ..." immediately after inserting a bids row:
--        • place_bid()       bid_count + (2 when an auto-bid row was also
--                            inserted, else 1)   — mig 0176 (live def)
--        • buy_flat_price()  bid_count + 1        — mig 0009
--        • buy_dutch()       bid_count + 1        — mig 0009
--
--   Because the trigger fires AFTER the same statement's bids INSERT, and the
--   writer's UPDATE adds its own increment on top of the freshly-recomputed
--   value, the counter ends up inflated. (The 0101 header claimed the two
--   paths were "idempotent — recomputes to the same value"; that was wrong
--   because the writer's UPDATE runs the increment expression against the
--   row the trigger already corrected, so they STACK rather than agree.)
--
-- ── Live evidence ───────────────────────────────────────────────────────────
-- Lot BRN4371782 has exactly ONE human bid (is_auto = false) in the bids
-- table, yet lots.bid_count = 2 — the classic +1 (real) +1 (manual) drift.
--
-- ── Owner decision ──────────────────────────────────────────────────────────
-- "Bid Count" = number of DISTINCT HUMAN bids = count of bids rows with
-- is_auto = false. Auto/proxy rows (is_auto = true) are NOT counted: they are
-- system-generated counter-bids in a proxy duel, not separate bidder actions.
--
-- ── The fix ─────────────────────────────────────────────────────────────────
-- Make the trigger the SINGLE source of truth and count only human bids:
--   1. sync_lot_bid_count()  — recompute uses ... AND is_auto = false
--   2. place_bid()           — DELETE the manual "bid_count = bid_count + CASE
--                              WHEN v_auto_bid_id IS NOT NULL THEN 2 ELSE 1 END,"
--                              line from its step-8 UPDATE lots SET. Everything
--                              else (0084 shill/identity guards, 0104 §A/§B
--                              gates, 0176 §C unpaid-invoice gate, 0111
--                              advisory lock + soft-close, proxy math) is
--                              reproduced verbatim from the live 0176 def.
--   3. buy_flat_price()      — DELETE the manual "bid_count = bid_count + 1,"
--                              line from its UPDATE lots SET (mig 0009 body
--                              reproduced verbatim otherwise).
--   4. buy_dutch()           — DELETE the manual "bid_count = bid_count + 1,"
--                              line from its UPDATE lots SET (mig 0009 body
--                              reproduced verbatim otherwise).
--   5. Backfill public.lots so existing rows reflect the human-only count.
--
-- All three writers insert their primary bids row with is_auto = false, so the
-- trigger now counts that row as exactly 1 — correct. place_bid's optional
-- second row (the outbid leader's proxy bid) is is_auto = true and is
-- (correctly) NOT counted.
--
-- ── Safety: backfill scope ──────────────────────────────────────────────────
-- The backfill targets public.lots ONLY. Verified that
-- upsert_competitor_lots_batch() (latest def = mig 0041, supersedes 0039)
-- writes exclusively to the SEPARATE competitor_lots table (scraped market
-- intel), never to public.lots. Its bid_count is a column on competitor_lots
-- populated straight from the scraped payload and is untouched here. The
-- public.lots backfill is therefore safe and does not need to exclude any
-- scraped/competitor rows.
--
-- ── Safety: read-only consumers unchanged ───────────────────────────────────
-- • finalize_scheduled_no_bid_lots() (mig 0129) only READS bid_count
--   (SELECT id, bid_count ... ; IF COALESCE(v_lot.bid_count,0) = 0). No change
--   needed. A scheduled lot with zero HUMAN bids still reads 0 and is correctly
--   finalized as unsold. An auto-bid row can only exist as the paired proxy to
--   a human bid on the SAME lot, and that human bid is the event that flips
--   scheduled→live, so the function's "bid_count=0 ⇔ no bids ever" assumption
--   still holds under human-only counting.
--
-- • cancel_auction() (mig 0096) refuses to cancel an auction if any child lot
--   has bid_count > 0. This guard STAYS SAFE: every human bid still inserts a
--   non-auto row, so any lot with real bidder activity reads bid_count >= 1.
--   (The only rows that drop out of the count are is_auto = true proxy rows,
--   which never exist without a human bid on the same lot — so no lot with
--   genuine activity can fall to 0.)
--
-- ── Constraints honored ─────────────────────────────────────────────────────
-- The ONLY logic changes are: the trigger's is_auto filter, removal of the 3
-- manual increments, and the public.lots backfill. Proxy math, all guards,
-- soft-close, and advisory locking are reproduced verbatim. No BEGIN/COMMIT in
-- this file (the orchestrator wraps it in BEGIN/ROLLBACK for the dry-run, then
-- applies + self-marks _schema_migrations). CREATE OR REPLACE preserves each
-- function's existing ACL.
--
-- Bases reproduced:
--   sync_lot_bid_count()  ← 0101_integrity_triggers.sql
--   place_bid(uuid,bigint)← 0176_place_bid_block_unpaid_invoice.sql (live def)
--   buy_flat_price(uuid)  ← 0009_buy_rpcs.sql
--   buy_dutch(uuid,bigint)← 0009_buy_rpcs.sql
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. sync_lot_bid_count() — single source of truth, HUMAN bids only.
--    Reproduced verbatim from mig 0101; ONLY the recompute SELECT gains the
--    AND is_auto = false predicate.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION sync_lot_bid_count()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lot_id UUID;
BEGIN
  -- Trigger fires per row. NEW/OLD shape depends on op.
  IF TG_OP = 'INSERT' THEN
    v_lot_id := NEW.lot_id;
  ELSIF TG_OP = 'DELETE' THEN
    v_lot_id := OLD.lot_id;
  ELSE
    RETURN NULL;
  END IF;

  -- Recompute from canonical source. Single index scan via bids_lot_idx.
  -- 0191: count HUMAN bids only (is_auto = false). Auto/proxy rows are
  -- system-generated counter-bids, not distinct bidder actions.
  UPDATE lots
  SET bid_count = (SELECT count(*) FROM bids WHERE lot_id = v_lot_id AND is_auto = false)
  WHERE id = v_lot_id;

  RETURN NULL;  -- AFTER triggers ignore return
END;
$$;

-- The existing triggers (bids_sync_lot_bid_count_ins / _del, created in 0101)
-- already point at this function name. CREATE OR REPLACE swaps the body in
-- place; no trigger re-creation needed.

-- ----------------------------------------------------------------------------
-- 2. place_bid(uuid, bigint) — live def from mig 0176, with the manual
--    bid_count increment removed from the step-8 UPDATE lots SET. Every other
--    line (0084 guards, 0104 §A/§B, 0176 §C, 0111 lock + soft-close, proxy
--    math) is reproduced exactly.
-- ----------------------------------------------------------------------------
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
  -- 0191: removed the manual "bid_count = bid_count + CASE WHEN v_auto_bid_id
  -- IS NOT NULL THEN 2 ELSE 1 END," line. The AFTER INSERT trigger
  -- sync_lot_bid_count() already set bid_count to the correct human-only
  -- count (is_auto = false) when the bids row(s) above were inserted; the
  -- manual increment was double-counting on top of it.
  UPDATE lots SET
    current_bid_cents = v_new_current_cents,
    current_bid_id    = COALESCE(v_auto_bid_id, v_new_bid_id),
    winner_bidder_id  = v_leader_id,
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

-- ----------------------------------------------------------------------------
-- 3. buy_flat_price(uuid) — Last Chance buy-now. Reproduced verbatim from mig
--    0009; ONLY the manual "bid_count = bid_count + 1," line removed from the
--    UPDATE lots SET. The synthetic bids row is inserted with is_auto = false,
--    so the trigger now counts it as exactly 1.
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

  -- 0191: removed the manual "bid_count = bid_count + 1," line. The AFTER
  -- INSERT trigger sync_lot_bid_count() already counted the synthetic
  -- is_auto = false row above; the manual increment was double-counting.
  UPDATE lots SET
    current_bid_cents = v_lot.flat_price_cents,
    current_bid_id = v_bid_id,
    winner_bidder_id = v_user,
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

-- ----------------------------------------------------------------------------
-- 4. buy_dutch(uuid, bigint) — Dutch buy-now. Reproduced verbatim from mig
--    0009; ONLY the manual "bid_count = bid_count + 1," line removed from the
--    UPDATE lots SET. The synthetic bids row is inserted with is_auto = false,
--    so the trigger now counts it as exactly 1.
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

  -- 0191: removed the manual "bid_count = bid_count + 1," line. The AFTER
  -- INSERT trigger sync_lot_bid_count() already counted the synthetic
  -- is_auto = false row above; the manual increment was double-counting.
  UPDATE lots SET
    current_bid_cents = v_current_price,
    current_bid_id = v_bid_id,
    winner_bidder_id = v_user,
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

-- ----------------------------------------------------------------------------
-- 5. Backfill — recompute the human-only count for the rows that are WRONG.
--    Targets public.lots ONLY (competitor_lots is a separate table written by
--    upsert_competitor_lots_batch / mig 0041 and is untouched). SCOPED with
--    "WHERE bid_count IS DISTINCT FROM <count>" so it rewrites ONLY the rows
--    that actually differ — verified live: 25 of 91,695 lots. Without the
--    guard, a full-table UPDATE would fire the 6 BEFORE/AFTER triggers on lots
--    (set_updated_at, log_lot_status_change, filter_lot_photo_urls, ...) across
--    all 91k rows for no reason. Corrects the inflation (e.g. lot BRN4371782:
--    stored 2 → recomputes to 1).
-- ----------------------------------------------------------------------------
UPDATE public.lots l
SET bid_count = (SELECT count(*) FROM bids b WHERE b.lot_id = l.id AND b.is_auto = false)
WHERE l.bid_count IS DISTINCT FROM (SELECT count(*) FROM bids b WHERE b.lot_id = l.id AND b.is_auto = false);
