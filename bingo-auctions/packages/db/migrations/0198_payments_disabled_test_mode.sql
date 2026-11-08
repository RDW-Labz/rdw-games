-- ============================================================================
-- Migration 0198 — PAYMENTS_DISABLED test-mode (durable no-Stripe switch)
--
-- ── Why ──────────────────────────────────────────────────────────────────────
-- The platform Stripe account was terminated. While we pick a new processor we
-- still need the full auction → win → (paid) → pickup loop to be TESTABLE end-
-- to-end WITHOUT any live card movement. The wall today is server-side:
-- place_bid() rejects with reason='no_payment_method' when the bidder has no
-- saved card, and the only "add a card" path hits stripe.setupIntents.create on
-- the dead account (500) — so a tester can never get a card on file, never bids,
-- and can't reach a test auction.
--
-- This migration adds ONE durable, DB-backed switch that the whole stack reads:
--   • place_bid() (this file) — skips the §A/§B/§C *money* gates when the
--     switch is ON, so bidders bid without a card. (Because the bidder app only
--     routes to "add card" REACTIVELY on a no_payment_method rejection, making
--     place_bid accept means the app needs NO change — no bidder OTA.)
--   • auto-charge worker (apps/operator-web/src/lib/cron/auto-charge-drain.ts)
--     — marks settled invoices 'paid' OFFLINE instead of charging.
--   • setup-intent route — short-circuits instead of 500-ing on the dead acct.
-- Operators can also mark an invoice paid offline from the invoice page (a
-- permanent cash-at-pickup feature, not test-only).
--
-- ── The switch ───────────────────────────────────────────────────────────────
-- A singleton platform_settings row + a STABLE payments_disabled() helper.
-- DB-backed (not env) ON PURPOSE: the authoritative gate is a DB function
-- (place_bid), which cannot read a Worker env var — but it CAN read this table.
-- One source of truth, toggled at runtime with a single UPDATE (Management API),
-- no redeploy. Seeded FALSE so applying this migration is a ZERO-behavior-change
-- no-op until we deliberately flip it on for a test window.
--
-- ── place_bid faithful reproduction ──────────────────────────────────────────
-- The function body is the EXACT live def from 0194_configurable_bid_increments
-- (which itself faithfully reproduced 0191 + 0176 §C + 0111 + 0104 §A/§B + 0084
-- guards + the 0194 schedule threading). The ONLY edits, per the project
-- "no shortcuts / verbatim preservation" rule:
--   1. new DECLARE  v_payments_disabled BOOLEAN;
--   2. SELECT payments_disabled() INTO v_payments_disabled;  (once, up front)
--   3. §A  no_payment_method  gate → `AND NOT v_payments_disabled`
--   4. §B  unpaid_fees        gate → `AND NOT v_payments_disabled`
--   5. §C  unpaid_invoice     gate → `NOT v_payments_disabled AND EXISTS(...)`
-- Everything else (advisory lock, shill/identity guards, suspension, increment
-- schedule, proxy-duel math, soft-close, bid_count-via-trigger) is byte-for-byte
-- from 0194. Signature unchanged: place_bid(uuid,bigint) → place_bid_result.
--
-- Plain statements (no BEGIN/COMMIT, no self-mark): the orchestrator wraps this
-- in BEGIN/ROLLBACK for the dry-run, then applies + records _schema_migrations.
-- CREATE OR REPLACE preserves place_bid's existing ACL.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- a. platform_settings — singleton. `id` is a boolean PK fixed to TRUE via the
--    CHECK, so at most one row can ever exist. Seeded with payments_disabled
--    = FALSE (normal Stripe path). RLS enabled with NO policies: anon/
--    authenticated are denied direct access; the service-role key (workers /
--    Management API) bypasses RLS, and payments_disabled() is SECURITY DEFINER
--    so place_bid + any RPC caller can read the value without a table grant.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.platform_settings (
  id                BOOLEAN PRIMARY KEY DEFAULT TRUE,
  payments_disabled BOOLEAN NOT NULL DEFAULT FALSE,
  note              TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT platform_settings_singleton CHECK (id = TRUE)
);

INSERT INTO public.platform_settings (id, payments_disabled, note)
VALUES (
  TRUE,
  FALSE,
  'Singleton. Set payments_disabled=true to run the full loop WITHOUT a live card processor (bidding skips the card gate; invoices are marked paid offline). Toggle deliberately; default off.'
)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;

-- ----------------------------------------------------------------------------
-- b. payments_disabled() — the single read point. STABLE (table read, no
--    side-effects). SECURITY DEFINER so it's readable from SECURITY DEFINER
--    callers (place_bid) and from anon/authenticated RPC without a table grant.
--    Fail-safe: COALESCE to FALSE if the row is somehow missing → defaults to
--    the normal Stripe path, never silently disables payments by accident.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.payments_disabled()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
  SELECT COALESCE((SELECT payments_disabled FROM public.platform_settings WHERE id = TRUE), FALSE);
$$;

GRANT EXECUTE ON FUNCTION public.payments_disabled() TO authenticated, anon, service_role;

-- ----------------------------------------------------------------------------
-- c. place_bid(uuid, bigint) — faithful 0194 def + the 5 flag edits noted in
--    the header. The 3 gated blocks are §A / §B / §C; everything else verbatim.
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
  -- 0194 addition: operator-default increment schedule (per-auction override
  -- wins via COALESCE below). NULL → legacy ladder inside min_bid_increment_cents.
  v_op_schedule JSONB;
  -- 0198 addition: when TRUE (platform_settings.payments_disabled) the §A/§B/§C
  -- *money* gates are skipped so the auction loop is testable without Stripe.
  v_payments_disabled BOOLEAN;
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

-- Re-assert the GRANT (CREATE OR REPLACE preserves the ACL; re-asserted for
-- parity with 0194/0191's live def).
GRANT EXECUTE ON FUNCTION public.place_bid(UUID, BIGINT) TO authenticated;
