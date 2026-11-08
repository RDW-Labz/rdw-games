-- ============================================================================
-- Migration 0104 — Auto-charge at auction close + 48h grace + $5 relot fee.
--
-- Background
-- ----------
-- Before this migration the bidder pays manually via PaymentSheet after
-- winning ("tap Pay" → /api/invoices/[id]/payment-intent). Standard for
-- early dev; wrong for a real auction marketplace because half the wins
-- go unpaid for days and operators can't trust their settlement balance.
--
-- New policy (set by ClovrBid for tomorrow's launch):
--   1. Bidder MUST save a card off-session BEFORE placing their first bid.
--   2. When a lot closes, the auction-engine attempts an off-session
--      PaymentIntent against the saved card. Funds settle to the operator
--      within seconds, no bidder interaction.
--   3. If the off-session charge fails, bidder gets 48 hours to update
--      their card and retry. Push + email notify.
--   4. After 48 hours of failure, the lot is auto-relisted (0097 flow)
--      and a $5 relot fee is added to bidders.unpaid_fees_cents. The
--      bidder cannot place new bids until they pay the outstanding
--      balance.
--   5. Operator subscriptions have a 7-day grace window on failed renewal
--      before the account is disabled (operators.lapse_at).
--
-- ADDITIVE ONLY. Schema additions + new tables + new RPCs + a trigger on
-- invoices to enqueue auto-charge jobs + a place_bid replacement that
-- preserves the 0084 body verbatim and injects two new guards.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. bidders: default payment method + unpaid fee balance
-- ---------------------------------------------------------------------------
-- default_payment_method_id is the Stripe `pm_…` we attach to the customer
-- during onboarding via SetupIntent. If NULL, the bidder hasn't completed
-- card-save and cannot bid (place_bid guard below).
--
-- unpaid_fees_cents is the live aggregate of unpaid bidder_fee_ledger rows.
-- place_bid reads this directly to keep the check cheap.

ALTER TABLE bidders
  ADD COLUMN IF NOT EXISTS default_payment_method_id TEXT,
  ADD COLUMN IF NOT EXISTS unpaid_fees_cents         BIGINT NOT NULL DEFAULT 0;

ALTER TABLE bidders
  DROP CONSTRAINT IF EXISTS bidders_unpaid_fees_nonneg;
ALTER TABLE bidders
  ADD CONSTRAINT bidders_unpaid_fees_nonneg CHECK (unpaid_fees_cents >= 0);

CREATE INDEX IF NOT EXISTS bidders_unpaid_fees_idx
  ON bidders (unpaid_fees_cents)
  WHERE unpaid_fees_cents > 0;

-- ---------------------------------------------------------------------------
-- 2. invoices: grace tracking + auto-charge attempt observability
-- ---------------------------------------------------------------------------
-- grace_until is non-NULL only when status='payment_failed_grace'. The
-- hourly cron flips to 'payment_failed_relisted' + applies the $5 fee
-- when grace_until < now().
--
-- auto_charge_attempt_count + last_auto_charge_at/_error are pure
-- observability — useful for dashboards + post-mortems.

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS grace_until                TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS auto_charge_attempt_count  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_auto_charge_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_auto_charge_error     TEXT;

CREATE INDEX IF NOT EXISTS invoices_grace_expiry_idx
  ON invoices (grace_until)
  WHERE status = 'payment_failed_grace' AND grace_until IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. New invoice_status values for the grace/relist flow
-- ---------------------------------------------------------------------------
-- Postgres allows ALTER TYPE ADD VALUE inside a transaction in 12+ as long
-- as the new value isn't referenced in the SAME transaction. The trigger
-- and place_bid we define below don't reference these values directly —
-- they're set by the cron + worker code at runtime.

ALTER TYPE invoice_status ADD VALUE IF NOT EXISTS 'payment_failed_grace';
ALTER TYPE invoice_status ADD VALUE IF NOT EXISTS 'payment_failed_relisted';

-- ---------------------------------------------------------------------------
-- 4. bidder_fee_ledger — audit history + receipt detail
-- ---------------------------------------------------------------------------
-- One row per fee event. When the bidder pays the outstanding balance
-- (POST /api/bidders/me/pay-fees), the SECURITY DEFINER RPC below sets
-- paid_at + paid_payment_intent_id on every unpaid row and zeros the
-- aggregate.

CREATE TABLE IF NOT EXISTS bidder_fee_ledger (
  id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  bidder_id               UUID NOT NULL REFERENCES bidders(id) ON DELETE CASCADE,
  invoice_id              UUID REFERENCES invoices(id) ON DELETE SET NULL,
  amount_cents            BIGINT NOT NULL CHECK (amount_cents > 0),
  reason                  TEXT NOT NULL CHECK (reason IN ('relot_fee')),
  paid_at                 TIMESTAMPTZ,
  paid_payment_intent_id  TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bidder_fee_ledger_bidder_unpaid_idx
  ON bidder_fee_ledger (bidder_id)
  WHERE paid_at IS NULL;

-- One fee per invoice — apply_relot_fee uses ON CONFLICT DO NOTHING on this.
CREATE UNIQUE INDEX IF NOT EXISTS bidder_fee_ledger_unique_per_invoice
  ON bidder_fee_ledger (invoice_id)
  WHERE invoice_id IS NOT NULL;

ALTER TABLE bidder_fee_ledger ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bidder_fee_ledger_own ON bidder_fee_ledger;
CREATE POLICY bidder_fee_ledger_own
  ON bidder_fee_ledger FOR SELECT
  USING (bidder_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 5. auto_charge_jobs — queue for the off-session PI worker
-- ---------------------------------------------------------------------------
-- A trigger on invoices INSERT enqueues one row per new invoice. The
-- /api/cron/auto-charge-drain endpoint reads next_attempt_at <= now()
-- in oldest-first order and calls Stripe. On terminal outcome the row
-- is deleted; intermediate failures bump next_attempt_at + attempt_count.

CREATE TABLE IF NOT EXISTS auto_charge_jobs (
  invoice_id       UUID PRIMARY KEY REFERENCES invoices(id) ON DELETE CASCADE,
  bidder_id        UUID NOT NULL REFERENCES bidders(id) ON DELETE CASCADE,
  next_attempt_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempt_count    INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS auto_charge_jobs_next_attempt_idx
  ON auto_charge_jobs (next_attempt_at);

-- ---------------------------------------------------------------------------
-- 6. Trigger on invoices: auto-enqueue auto-charge on new pending invoice
-- ---------------------------------------------------------------------------
-- Patches the auction-engine without rewriting build_invoices_for_auction.
-- Any INSERT into invoices with status='pending' and a bidder_id gets a
-- companion auto_charge_jobs row. This is safer than rewriting the
-- function because we don't have to know its exact column shape.
--
-- We DON'T enqueue on UPDATE — that would double-charge on legitimate
-- status flips (paid → refunded etc.). The bidder-driven manual retry
-- after grace-card-update inserts directly into auto_charge_jobs from
-- the route handler instead.

CREATE OR REPLACE FUNCTION trigger_enqueue_auto_charge()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'pending' AND NEW.bidder_id IS NOT NULL THEN
    INSERT INTO auto_charge_jobs (invoice_id, bidder_id, next_attempt_at)
    VALUES (NEW.id, NEW.bidder_id, now())
    ON CONFLICT (invoice_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS invoices_auto_charge_enqueue ON invoices;
CREATE TRIGGER invoices_auto_charge_enqueue
  AFTER INSERT ON invoices
  FOR EACH ROW
  EXECUTE FUNCTION trigger_enqueue_auto_charge();

-- ---------------------------------------------------------------------------
-- 7. apply_relot_fee — SECURITY DEFINER, called by grace-expiry cron
-- ---------------------------------------------------------------------------
-- Side effects (all in one tx):
--   - INSERT a row into bidder_fee_ledger (idempotent via unique index)
--   - Recompute bidders.unpaid_fees_cents from ledger (avoids drift)
-- Returns the new aggregate so the cron can log it.

CREATE OR REPLACE FUNCTION apply_relot_fee(
  p_invoice_id   UUID,
  p_amount_cents BIGINT DEFAULT 500
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bidder_id  UUID;
  v_new_total  BIGINT;
BEGIN
  SELECT bidder_id INTO v_bidder_id FROM invoices WHERE id = p_invoice_id;
  IF v_bidder_id IS NULL THEN
    RAISE EXCEPTION 'invoice % has no bidder', p_invoice_id;
  END IF;

  INSERT INTO bidder_fee_ledger (bidder_id, invoice_id, amount_cents, reason)
  VALUES (v_bidder_id, p_invoice_id, p_amount_cents, 'relot_fee')
  ON CONFLICT (invoice_id) WHERE invoice_id IS NOT NULL
  DO NOTHING;

  UPDATE bidders b
     SET unpaid_fees_cents = COALESCE(
       (SELECT SUM(amount_cents) FROM bidder_fee_ledger
         WHERE bidder_id = v_bidder_id AND paid_at IS NULL),
       0
     )
   WHERE b.id = v_bidder_id
   RETURNING unpaid_fees_cents INTO v_new_total;

  RETURN v_new_total;
END;
$$;

REVOKE ALL ON FUNCTION apply_relot_fee(UUID, BIGINT) FROM PUBLIC;
-- Called by service-role from the grace-expiry cron route. No
-- authenticated grant.

-- ---------------------------------------------------------------------------
-- 8. clear_paid_relot_fees — called after bidder pays their balance
-- ---------------------------------------------------------------------------
-- Marks all of the caller's unpaid ledger rows as paid + zeros the
-- aggregate. Invoked by the /api/bidders/me/pay-fees route after the
-- Stripe PI succeeds.

CREATE OR REPLACE FUNCTION clear_paid_relot_fees(
  p_payment_intent_id TEXT
)
RETURNS BIGINT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_bidder_id  UUID;
BEGIN
  v_bidder_id := auth.uid();
  IF v_bidder_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  UPDATE bidder_fee_ledger
     SET paid_at = now(),
         paid_payment_intent_id = p_payment_intent_id
   WHERE bidder_id = v_bidder_id AND paid_at IS NULL;

  UPDATE bidders SET unpaid_fees_cents = 0 WHERE id = v_bidder_id;

  RETURN 0;
END;
$$;

REVOKE ALL ON FUNCTION clear_paid_relot_fees(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION clear_paid_relot_fees(TEXT) TO authenticated;

-- ---------------------------------------------------------------------------
-- 9. place_bid — add two new guards (verbatim 0084 body, inserted guards)
-- ---------------------------------------------------------------------------
-- The 0084 function shape is preserved EXACTLY. Two new guards inserted
-- between the bidder-row existence check and the lot lock:
--   2a. no_payment_method   → bidder must save a card before bidding
--   2b. unpaid_fees         → bidder has unpaid relot fees
--
-- Both return the place_bid_result tuple (false, reason, lot_id, ...) so
-- the bidder app branches on `result.reason` like it does for the other
-- soft failures. The 'unpaid_fees_cents' is not in the tuple — the app
-- fetches it via GET /api/bidders/me on receiving the rejection.

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
  v_identity_threshold CONSTANT BIGINT := 50000;
  v_identity_verified_at TIMESTAMPTZ;
  -- 0104 additions:
  v_default_pm_id      TEXT;
  v_unpaid_fees_cents  BIGINT;
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

  -- =========================================================================
  -- 0104 §A: NO PAYMENT METHOD ON FILE
  -- New policy: every bidder must save a card via SetupIntent before
  -- placing their first bid. The bidder app gates the "Place bid" CTA
  -- on the lot detail screen; this is the authoritative server check.
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
  -- If a previous win failed off-session charge AND the bidder didn't
  -- update their card in 48h, a $5 fee was added to their balance.
  -- They must pay before bidding again. The bidder app shows a "Pay
  -- $X.XX in fees to bid" banner that opens /api/bidders/me/pay-fees.
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

  -- 4. Look up existing leader's max (UNCHANGED from 0084)
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

  -- 7. Soft-close extension (UNCHANGED from 0084)
  v_old_close_at := v_lot.close_at;
  IF v_auction.format = 'standard' THEN
    DECLARE
      v_soft_close_secs BIGINT;
      v_extended_close TIMESTAMPTZ;
    BEGIN
      v_soft_close_secs := COALESCE(v_auction.soft_close_minutes, 3) * 60;
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
$$;

GRANT EXECUTE ON FUNCTION place_bid(UUID, BIGINT) TO authenticated;

-- ---------------------------------------------------------------------------
-- 10. operators: subscription grace window column
-- ---------------------------------------------------------------------------
-- When the webhook handler observes customer.subscription.updated with
-- status='past_due', it stamps lapse_at = now() + 7 days. A daily cron
-- flips operators.status to 'subscription_lapsed' when lapse_at < now()
-- AND subscription is still past_due — but does NOT cancel in-flight
-- auctions (bidders aren't stranded). A successful renewal clears
-- lapse_at back to NULL.

ALTER TABLE operators
  ADD COLUMN IF NOT EXISTS lapse_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS operators_lapse_at_idx
  ON operators (lapse_at)
  WHERE lapse_at IS NOT NULL;
