-- 0453 — sq-ft bidding, PR 3/11: the bidding engine. Per-unit place_bid;
-- old apps refused with an update message; standard bids unchanged.
--
-- WHY
--   Jared's request: tile/flooring pallets bid per square foot, whole pallet
--   sold as one lot. Spec: docs/state/SQFT-BIDDING-SPEC.md §4 (branch
--   docs/sqft-bidding-spec). Architecture (Braden): every stored amount stays
--   the TOTAL pallet price in cents; per-unit = total / lots.unit_qty is
--   display and entry only. Requires 0451 (auctions.bid_mode, lots.unit_qty).
--
-- WHAT (functions only — no table, trigger, index or data change)
--   1. place_bid(uuid, bigint) — the live body, unchanged, plus ONE block at
--      the top: a lot whose auction is bid_mode = 'per_unit' is refused with
--      reason = 'Bidding on this lot needs the latest BinGo app. Please update
--      to bid.' (owner wording 2026-10-26; old bundles show
--      "Bid rejected: <reason>"). Standard auctions never enter it.
--   2. NEW place_bid(uuid, bigint, integer p_unit_qty), NO default on
--      p_unit_qty (a 2-key PostgREST call can never resolve to it):
--        standard (or no auction / no lot) → RETURN place_bid(uuid, bigint):
--          the 2-arg engine itself, nothing copied.
--        per_unit → the live body plus spec §4: unit_qty_mismatch,
--          not_whole_cents_per_unit, lot_start_not_multiple,
--          per_unit_schedule_missing, lot_amounts_not_multiple (defensive);
--          increment = min_bid_increment_cents(current / q, the AUCTION's own
--          schedule) * q. Every other guard (auth, card, fees, pre-start,
--          shill, identity, suspension, unpaid invoice, status/closed, advisory
--          lock, self-raise GREATEST, proxy duel, auto rows, soft close, outbid
--          enqueue, relation upsert) is the live code, byte for byte.
--
-- BASE BODY PROVENANCE
--   Live place_bid(uuid,bigint) = 0263's CREATE OR REPLACE with 0350's
--   GREATEST patch (0350 rewrote one statement of the deployed body in place).
--   prosrc md5 7b6261a9548864b102f841546003db0d (md5 of the body text between the $function$ quotes),
--   = rig0431's master replay. 0263 itself restated 0221 (0216 self-raise,
--   0212, 0198, 0194, 0191, 0176, 0111, 0105, 0084, 0078). No migration after
--   0350 redefines place_bid. Generated, not hand-copied:
--   scripts/prod-rig/0453-rig/gen-0453.py (anchored edits that must each match
--   exactly once).
--
-- SAFETY
--   * Preflight refuses to run unless 0451's columns exist AND the live 2-arg
--     body md5 is 7b6261a9548864b102f841546003db0d (pre-0453) or a1572dfd7f88e8a58cbb5608d62f2604 (re-apply): it never
--     overwrites a place_bid it was not built from.
--   * Postflight checks the 2-arg body md5 is a1572dfd7f88e8a58cbb5608d62f2604, there are exactly
--     two overloads, and both carry the same EXECUTE grants.
--   * One transaction: both functions change together or not at all.
--
-- GRANTS
--   Same statement every place_bid migration has made: GRANT EXECUTE ... TO
--   authenticated. The 3-arg is created by the same role in the same schema,
--   so it gets the same CREATE FUNCTION defaults as the 2-arg; the postflight
--   fails the migration if the two ACLs differ.
--   The function-grants lint (scripts/check-function-grants.cjs) wants
--   REVOKE ... FROM PUBLIC on new functions. Not here, on purpose: the live
--   2-arg is {PUBLIC, anon, authenticated, service_role} today, and the
--   3-arg must match it (postflight). Both refuse a caller with no
--   auth.uid() ('not_authenticated'). Narrowing place_bid's grants is its own
--   change (0460, #587), not part of the engine swap.
-- lint:allow-public-execute public.place_bid same ACL as the live 2-arg; locked down in 0460
--
-- LOCKS (Rule 9)
--   CREATE OR REPLACE FUNCTION locks only the pg_proc row; no table lock.
--   A bid running during the swap finishes on the old body; the next uses the
--   new one. Window (owner): Wed 2026-10-28 05:00–07:00 CT, then one
--   standard-lot test bid by the owner's own test account.
--
-- Rollback: scripts/prod-rig/0453_ROLLBACK_sqft_place_bid_per_unit.sql
--   (drops the 3-arg, restores the exact pre-0453 2-arg body, md5-checked).
--
SET lock_timeout = '3s';

BEGIN;

-- ── 0. Preflight: fail loudly, change nothing ───────────────────────────────
DO $pre$
DECLARE
  v_md5 text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'auctions' AND column_name = 'bid_mode')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'lots' AND column_name = 'unit_qty') THEN
    RAISE EXCEPTION '0453: auctions.bid_mode / lots.unit_qty missing — apply 0451 first';
  END IF;

  SELECT md5(replace(prosrc, chr(13), '')) INTO v_md5
    FROM pg_proc WHERE oid = 'public.place_bid(uuid,bigint)'::regprocedure;
  IF v_md5 NOT IN ('7b6261a9548864b102f841546003db0d', 'a1572dfd7f88e8a58cbb5608d62f2604') THEN
    RAISE EXCEPTION '0453: live place_bid(uuid,bigint) body is not the 0263+0350 body this migration was built from (md5 %) — refusing to overwrite unseen code', v_md5;
  END IF;
END
$pre$;

-- ── 1. 2-arg place_bid: live body + per_unit refusal at the top ─────────────
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

  -- 0453 (sq-ft bidding 3/11): a lot in a per_unit auction is bid ONLY through
  -- the 3-arg place_bid(p_lot_id, p_max_amount_cents, p_unit_qty), which the
  -- updated apps call with the lot's unit_qty. An app bundle that predates
  -- per-unit pricing calls this 2-arg form and would bid a TOTAL on the
  -- standard ladder (not a whole number of cents per unit), so it is refused
  -- here, first thing, with a sentence old bundles show as-is
  -- ("Bid rejected: <reason>"). Standard auctions never enter this branch.
  IF EXISTS (
    SELECT 1
    FROM lots l
    JOIN auctions a ON a.id = l.auction_id
    WHERE l.id = p_lot_id
      AND a.bid_mode = 'per_unit'
  ) THEN
    v_result := (false, 'Bidding on this lot needs the latest BinGo app. Please update to bid.',
                 p_lot_id, NULL, NULL, NULL, false, NULL);
    RETURN v_result;
  END IF;

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

  -- =========================================================================
  -- 0221: PRE-START GATE + PREVIEW PRE-BIDDING
  -- Before this migration place_bid never consulted auctions.starts_at — the
  -- UIs hid the bid surface pre-start, but a direct RPC call could bid on a
  -- scheduled lot (and prematurely flip it 'live'). Now: bidding before
  -- starts_at is allowed ONLY when the operator opted the auction into
  -- preview pre-bidding (auctions.prebid_enabled).
  -- =========================================================================
  IF v_auction.starts_at > now() AND NOT COALESCE(v_auction.prebid_enabled, false) THEN
    v_result := (false, 'auction_not_started', p_lot_id, v_lot.current_bid_cents,
                 v_lot.winner_bidder_id, v_lot.close_at, false, NULL);
    RETURN v_result;
  END IF;

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
    SET max_amount_cents = GREATEST(max_amount_cents, p_max_amount_cents)
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
     AND v_auction.starts_at <= now()  -- 0221: no anti-snipe churn during preview
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
      status            = CASE WHEN status = 'scheduled' AND v_auction.starts_at <= now()
                               THEN 'live' ELSE status END, -- 0221: preview bids don't open the lot
      updated_at        = now()
    WHERE id = p_lot_id;
  END IF;

  PERFORM _ensure_operator_bidder_relation(v_auction.operator_id, v_bidder_id);

  -- 0263: enqueue the 'outbid' notification for the bidder who was just
  -- bumped out of the lead. This block existed in 0006 but was dropped when
  -- place_bid was rewritten in 0078 and was never restored across the
  -- 0084/0105/0111/0191/0194/0198/0212/0216/0221 rewrites — so no 'outbid'
  -- row was ever produced and BOTH the push and Resend email drains had
  -- nothing to send (a customer reported never getting an outbid email,
  -- 2026-07-13). v_outbid_bidder_id is NULL on the no-prior-leader and
  -- self-raise paths, so this only fires on a genuine competitive bump.
  -- target_user_id = bidder id (= auth.uid()); the email drain resolves the
  -- recipient via bidders.id and honors email_enabled.
  IF v_outbid_bidder_id IS NOT NULL THEN
    PERFORM enqueue_notification(
      'outbid',
      v_outbid_bidder_id,
      jsonb_build_object(
        'lot_id', p_lot_id,
        'lot_title', v_lot.title,
        'current_bid_cents', v_new_current_cents
      ),
      -- One outbid notification per (bidder, lot, current_price) — a
      -- proxy re-raise to the same price won't re-fire.
      'outbid:' || v_outbid_bidder_id || ':' || p_lot_id || ':' || v_new_current_cents::TEXT
    );
  END IF;

  v_result := (
    true, 'ok', p_lot_id,
    v_new_current_cents, v_leader_id, v_lot.close_at,
    v_was_extended, v_outbid_bidder_id
  );
  RETURN v_result;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.place_bid(UUID, BIGINT) TO authenticated;

-- ── 2. 3-arg place_bid: standard → 2-arg; per_unit → spec §4 ────────────────
CREATE OR REPLACE FUNCTION public.place_bid(p_lot_id uuid, p_max_amount_cents bigint, p_unit_qty integer)
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
  -- 0453 additions (per_unit only):
  v_bid_mode TEXT;  -- auctions.bid_mode of the lot's auction
  v_q        BIGINT; -- lots.unit_qty: every stored amount is a multiple of it
BEGIN
  -- =========================================================================
  -- 0453: STANDARD LOTS RUN THE 2-ARG ENGINE, UNCHANGED.
  -- Anything that is not a per_unit auction (standard, no auction, no lot)
  -- returns exactly what place_bid(p_lot_id, p_max_amount_cents) returns —
  -- same code, same locks, same rows. p_unit_qty is ignored for them. Only
  -- per_unit lots run the body below, which is the 2-arg body plus the
  -- per-unit rules marked 0453.
  -- =========================================================================
  SELECT a.bid_mode INTO v_bid_mode
    FROM lots l
    JOIN auctions a ON a.id = l.auction_id
   WHERE l.id = p_lot_id;

  IF v_bid_mode IS DISTINCT FROM 'per_unit' THEN
    RETURN public.place_bid(p_lot_id, p_max_amount_cents);
  END IF;

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

  -- 0453: re-read under the lock. If the auction stopped being per_unit
  -- between the read above and the lock, it is a standard lot now: hand it to
  -- the 2-arg engine (advisory xact locks are re-entrant; nothing has been
  -- written yet).
  IF v_auction.bid_mode IS DISTINCT FROM 'per_unit' THEN
    RETURN public.place_bid(p_lot_id, p_max_amount_cents);
  END IF;

  -- =========================================================================
  -- 0221: PRE-START GATE + PREVIEW PRE-BIDDING
  -- Before this migration place_bid never consulted auctions.starts_at — the
  -- UIs hid the bid surface pre-start, but a direct RPC call could bid on a
  -- scheduled lot (and prematurely flip it 'live'). Now: bidding before
  -- starts_at is allowed ONLY when the operator opted the auction into
  -- preview pre-bidding (auctions.prebid_enabled).
  -- =========================================================================
  IF v_auction.starts_at > now() AND NOT COALESCE(v_auction.prebid_enabled, false) THEN
    v_result := (false, 'auction_not_started', p_lot_id, v_lot.current_bid_cents,
                 v_lot.winner_bidder_id, v_lot.close_at, false, NULL);
    RETURN v_result;
  END IF;

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
  -- =========================================================================
  -- 0453: PER-UNIT RULES (spec §4). Stored amounts stay TOTALS in cents; every
  -- total on a per_unit lot is a whole multiple of q = lots.unit_qty, so
  -- per-unit = total / q is always a whole number of cents.
  --   1. q > 0 and q = p_unit_qty (the client priced the lot we hold)
  --   2. the max is a whole multiple of q
  --   3. the lot's starting bid is a whole multiple of q
  --   4. the auction carries its OWN per-unit ladder; the operator default is
  --      a whole-item ladder ($1 = $247 a raise on 247 sq ft) and is never used
  --   5. increment = per-unit step at (current / q), times q
  -- Then the unchanged start / increment checks and proxy duel below. Proxy
  -- terms: starting bid, maxes and v_min_increment are all multiples of q,
  -- so LEAST/GREATEST of their sums are too.
  -- =========================================================================
  v_q := v_lot.unit_qty;
  IF v_q IS NULL OR v_q <= 0 OR p_unit_qty IS NULL OR p_unit_qty <> v_q THEN
    v_result := (false, 'unit_qty_mismatch', p_lot_id, v_lot.current_bid_cents,
                 v_lot.winner_bidder_id, v_lot.close_at, false, NULL);
    RETURN v_result;
  END IF;

  IF p_max_amount_cents % v_q <> 0 THEN
    v_result := (false, 'not_whole_cents_per_unit', p_lot_id, v_lot.current_bid_cents,
                 v_lot.winner_bidder_id, v_lot.close_at, false, NULL);
    RETURN v_result;
  END IF;

  IF v_lot.starting_bid_cents IS NULL OR v_lot.starting_bid_cents % v_q <> 0 THEN
    v_result := (false, 'lot_start_not_multiple', p_lot_id, v_lot.current_bid_cents,
                 v_lot.winner_bidder_id, v_lot.close_at, false, NULL);
    RETURN v_result;
  END IF;

  -- A tier must apply at the current per-unit price, or min_bid_increment_cents
  -- would fall back to the whole-item legacy ladder.
  IF jsonb_typeof(v_auction.bid_increment_schedule) IS DISTINCT FROM 'array'
     OR NOT EXISTS (
       SELECT 1
       FROM jsonb_to_recordset(
              CASE WHEN jsonb_typeof(v_auction.bid_increment_schedule) = 'array'
                   THEN v_auction.bid_increment_schedule ELSE '[]'::jsonb END
            ) AS t(min_cents BIGINT, step_cents BIGINT)
       WHERE t.min_cents <= COALESCE(v_lot.current_bid_cents / v_q, 0)
         AND t.step_cents IS NOT NULL
     ) THEN
    v_result := (false, 'per_unit_schedule_missing', p_lot_id, v_lot.current_bid_cents,
                 v_lot.winner_bidder_id, v_lot.close_at, false, NULL);
    RETURN v_result;
  END IF;

  -- Defensive: the lot's price must already be a multiple (it always is when
  -- every bid came through this function; it is not if the auction was
  -- switched to per_unit after standard bids — PR 4's lock prevents that).
  IF v_lot.current_bid_cents % v_q <> 0 THEN
    v_result := (false, 'lot_amounts_not_multiple', p_lot_id, v_lot.current_bid_cents,
                 v_lot.winner_bidder_id, v_lot.close_at, false, NULL);
    RETURN v_result;
  END IF;

  v_min_increment := min_bid_increment_cents(
    v_lot.current_bid_cents / v_q,
    v_auction.bid_increment_schedule
  ) * v_q;

  IF v_min_increment IS NULL OR v_min_increment <= 0 THEN
    v_result := (false, 'per_unit_schedule_missing', p_lot_id, v_lot.current_bid_cents,
                 v_lot.winner_bidder_id, v_lot.close_at, false, NULL);
    RETURN v_result;
  END IF;

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

  -- 0453: defensive, as above — the leader's max must be a multiple of q.
  IF v_current_max_bid.max_amount_cents % v_q <> 0 THEN
    v_result := (false, 'lot_amounts_not_multiple', p_lot_id, v_lot.current_bid_cents,
                 v_lot.winner_bidder_id, v_lot.close_at, false, NULL);
    RETURN v_result;
  END IF;

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
    SET max_amount_cents = GREATEST(max_amount_cents, p_max_amount_cents)
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
     AND v_auction.starts_at <= now()  -- 0221: no anti-snipe churn during preview
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
      status            = CASE WHEN status = 'scheduled' AND v_auction.starts_at <= now()
                               THEN 'live' ELSE status END, -- 0221: preview bids don't open the lot
      updated_at        = now()
    WHERE id = p_lot_id;
  END IF;

  PERFORM _ensure_operator_bidder_relation(v_auction.operator_id, v_bidder_id);

  -- 0263: enqueue the 'outbid' notification for the bidder who was just
  -- bumped out of the lead. This block existed in 0006 but was dropped when
  -- place_bid was rewritten in 0078 and was never restored across the
  -- 0084/0105/0111/0191/0194/0198/0212/0216/0221 rewrites — so no 'outbid'
  -- row was ever produced and BOTH the push and Resend email drains had
  -- nothing to send (a customer reported never getting an outbid email,
  -- 2026-07-13). v_outbid_bidder_id is NULL on the no-prior-leader and
  -- self-raise paths, so this only fires on a genuine competitive bump.
  -- target_user_id = bidder id (= auth.uid()); the email drain resolves the
  -- recipient via bidders.id and honors email_enabled.
  IF v_outbid_bidder_id IS NOT NULL THEN
    PERFORM enqueue_notification(
      'outbid',
      v_outbid_bidder_id,
      jsonb_build_object(
        'lot_id', p_lot_id,
        'lot_title', v_lot.title,
        'current_bid_cents', v_new_current_cents
      ),
      -- One outbid notification per (bidder, lot, current_price) — a
      -- proxy re-raise to the same price won't re-fire.
      'outbid:' || v_outbid_bidder_id || ':' || p_lot_id || ':' || v_new_current_cents::TEXT
    );
  END IF;

  v_result := (
    true, 'ok', p_lot_id,
    v_new_current_cents, v_leader_id, v_lot.close_at,
    v_was_extended, v_outbid_bidder_id
  );
  RETURN v_result;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.place_bid(UUID, BIGINT, INTEGER) TO authenticated;

COMMENT ON FUNCTION public.place_bid(UUID, BIGINT, INTEGER) IS
  '0453: per-unit (sq ft) bidding. Standard lots: identical to '
  'place_bid(uuid,bigint) (it calls it). per_unit lots: p_unit_qty must equal '
  'lots.unit_qty; max, starting bid and increments are whole multiples of it; '
  'the auction''s own bid_increment_schedule is per unit. Amounts are totals.';

-- ── 3. Postflight: the result is what was proven on the rig ─────────────────
DO $post$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc
       WHERE oid = 'public.place_bid(uuid,bigint)'::regprocedure) <> 'a1572dfd7f88e8a58cbb5608d62f2604' THEN
    RAISE EXCEPTION '0453: 2-arg body after apply is not the proven body';
  END IF;
  IF (SELECT count(*) FROM pg_proc
       WHERE proname = 'place_bid' AND pronamespace = 'public'::regnamespace) <> 2 THEN
    RAISE EXCEPTION '0453: expected exactly two place_bid overloads';
  END IF;
  -- Same EXECUTE grants on both overloads (the 3-arg gets whatever the 2-arg
  -- has: CREATE FUNCTION's defaults plus the explicit GRANT above).
  IF EXISTS (
    (SELECT a.grantee, a.privilege_type FROM pg_proc p, aclexplode(p.proacl) a
      WHERE p.oid = 'public.place_bid(uuid,bigint)'::regprocedure
     EXCEPT
     SELECT a.grantee, a.privilege_type FROM pg_proc p, aclexplode(p.proacl) a
      WHERE p.oid = 'public.place_bid(uuid,bigint,integer)'::regprocedure)
    UNION ALL
    (SELECT a.grantee, a.privilege_type FROM pg_proc p, aclexplode(p.proacl) a
      WHERE p.oid = 'public.place_bid(uuid,bigint,integer)'::regprocedure
     EXCEPT
     SELECT a.grantee, a.privilege_type FROM pg_proc p, aclexplode(p.proacl) a
      WHERE p.oid = 'public.place_bid(uuid,bigint)'::regprocedure)
  ) THEN
    RAISE EXCEPTION '0453: 3-arg place_bid grants differ from the 2-arg';
  END IF;
END
$post$;

COMMIT;
