-- ============================================================================
-- Migration 0194 — configurable bid-increment schedules (BID-3)
--
-- ── What this adds ───────────────────────────────────────────────────────────
-- Operator-default + per-auction-override increment ladders. Today the minimum
-- bid increment is a single hard-coded ladder (the "LEGACY LADDER" below) baked
-- into min_bid_increment_cents(). This migration makes that ladder configurable
-- per operator (operators.bid_increment_schedule) with an optional per-auction
-- override (auctions.bid_increment_schedule), while staying 100% back-compatible.
--
-- ── Schedule shape ───────────────────────────────────────────────────────────
-- A schedule is a JSONB array of tiers, ascending by min_cents:
--     [{"min_cents": <int>, "step_cents": <int>}, ...]
-- The increment for a given current_cents = the step_cents of the tier with the
-- GREATEST min_cents that is <= COALESCE(current_cents, 0). The first tier is
-- expected to have min_cents = 0 so every current_cents >= 0 resolves to a tier.
--
-- ── Precedence (resolved by the place_bid caller, not by this function) ──────
--   effective schedule for a lot = COALESCE(auction.bid_increment_schedule,
--                                            operator.bid_increment_schedule)
-- Per-auction override wins; else the operator default; else NULL.
--
-- ── Back-compat: NULL schedule = today's EXACT behavior ──────────────────────
-- When the effective schedule is NULL / empty array / malformed (no usable
-- tier), min_bid_increment_cents() falls back to the LEGACY LADDER verbatim —
-- byte-identical to the live 0003/0191 body. Existing operators and auctions
-- have a NULL schedule (the ALTER adds the column with NO default), so there is
-- ZERO behavior change until an operator explicitly sets one.
--
-- ── IMMUTABLE preserved ──────────────────────────────────────────────────────
-- min_bid_increment_cents() stays LANGUAGE sql IMMUTABLE. jsonb_to_recordset()
-- is itself IMMUTABLE and the function does NO table access — the schedule is
-- passed in as an argument. The new DEFAULT NULL on the 2nd arg keeps the
-- existing 1-arg signature min_bid_increment_cents(bigint) working for any
-- caller that doesn't pass a schedule.
--
-- ── Only caller in the engine ────────────────────────────────────────────────
-- place_bid() is the ONLY function that consults min_bid_increment_cents to set
-- the bid floor + proxy step. It is reproduced here FAITHFULLY from the live def
-- (0191_bid_count_human_only.sql) — all 0084 shill/identity guards, the 0104
-- §A/§B no-card / unpaid-fees gates, the 0176 §C unpaid-invoice gate, the 0111
-- advisory lock + soft-close opt-out, the proxy-duel math, and the 0191
-- bid_count removal are unchanged. The ONLY edits are: a new v_op_schedule
-- declare, a SELECT to load the operator default, and threading the COALESCE
-- (auction-override, operator-default) schedule into the single
-- min_bid_increment_cents() call.
--
-- ── LEGACY LADDER (the NULL fallback, identical in SQL + packages/shared) ────
--   current_cents IS NULL or < 500 -> 100 ; < 2500 -> 100 ; < 10000 -> 200 ;
--   < 25000 -> 500 ; < 100000 -> 1000 ; < 500000 -> 2500 ; else -> 5000
--
-- ── Ops note ─────────────────────────────────────────────────────────────────
-- The increment is evaluated PER BID at bid time. Changing an operator's
-- default schedule therefore affects in-flight auctions that have no per-auction
-- override. Operators should set schedules before auctions go live.
--
-- Plain statements (no BEGIN/COMMIT, no self-mark): the orchestrator wraps this
-- in BEGIN/ROLLBACK for the dry-run, then applies + records _schema_migrations.
-- CREATE OR REPLACE preserves each function's existing ACL.
--
-- Bases reproduced:
--   place_bid(uuid,bigint) ← 0191_bid_count_human_only.sql (live def)
--   min_bid_increment_cents ← 0003_place_bid_fn.sql ladder (extended w/ schedule)
-- ============================================================================

-- ----------------------------------------------------------------------------
-- a. operators.bid_increment_schedule — the operator default. Nullable, no
--    default → existing rows are NULL → legacy ladder (zero behavior change).
-- ----------------------------------------------------------------------------
ALTER TABLE public.operators ADD COLUMN IF NOT EXISTS bid_increment_schedule JSONB;

-- ----------------------------------------------------------------------------
-- b. auctions.bid_increment_schedule — the per-auction override. Nullable, no
--    default → NULL means "inherit the operator default".
-- ----------------------------------------------------------------------------
ALTER TABLE public.auctions ADD COLUMN IF NOT EXISTS bid_increment_schedule JSONB;

-- ----------------------------------------------------------------------------
-- c. min_bid_increment_cents(current_cents, schedule) — schedule-aware, with a
--    verbatim legacy-ladder fallback. IMMUTABLE preserved (no table access;
--    jsonb_to_recordset is immutable). The DEFAULT NULL keeps the legacy 1-arg
--    signature working.
--
--    Resolution:
--      • If schedule has a tier with min_cents <= COALESCE(current_cents,0),
--        return the step_cents of the GREATEST such min_cents.
--      • Otherwise (schedule IS NULL, empty array, malformed, or no tier with
--        min_cents <= current) → the LEGACY LADDER, byte-identical to 0003/0191.
--    The COALESCE(<subselect>, <ladder>) makes the fallback fire whenever the
--    tier lookup yields NULL, covering all of: NULL schedule, empty array, a
--    schedule whose lowest min_cents is > current_cents.
-- ----------------------------------------------------------------------------
-- 0194 FIX: drop the legacy 1-arg signature FIRST. The new function below uses
-- DEFAULT NULL, so keeping min_bid_increment_cents(bigint) alongside it makes
-- every 1-arg call ambiguous ("function min_bid_increment_cents(bigint) is not
-- unique"). place_bid is the only caller and now uses the 2-arg form; plpgsql
-- bodies are not dependency-tracked, so this DROP is safe within the migration.
DROP FUNCTION IF EXISTS public.min_bid_increment_cents(bigint);

CREATE OR REPLACE FUNCTION public.min_bid_increment_cents(
  current_cents BIGINT,
  schedule JSONB DEFAULT NULL
)
RETURNS BIGINT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(
    -- Configured schedule: greatest min_cents tier whose floor is <= current.
    -- NULL/empty/malformed schedule → jsonb_to_recordset yields no rows → NULL,
    -- and a schedule whose lowest floor is above current also yields NULL here;
    -- both fall through to the legacy ladder below.
    (
      SELECT t.step_cents
      FROM jsonb_to_recordset(
             CASE WHEN jsonb_typeof(schedule) = 'array' THEN schedule ELSE '[]'::jsonb END
           ) AS t(min_cents BIGINT, step_cents BIGINT)
      WHERE t.min_cents <= COALESCE(current_cents, 0)
        AND t.step_cents IS NOT NULL
      ORDER BY t.min_cents DESC
      LIMIT 1
    ),
    -- LEGACY LADDER — reproduced verbatim from the live min_bid_increment_cents
    -- body (0003/0191). DO NOT change these boundaries; the client mirror in
    -- packages/shared/src/bidding.ts must match exactly.
    CASE
      WHEN current_cents IS NULL OR current_cents < 500    THEN 100      -- $1
      WHEN current_cents < 2500    THEN 100                              -- $1
      WHEN current_cents < 10000   THEN 200                              -- $2
      WHEN current_cents < 25000   THEN 500                              -- $5
      WHEN current_cents < 100000  THEN 1000                             -- $10
      WHEN current_cents < 500000  THEN 2500                             -- $25
      ELSE 5000                                                          -- $50
    END
  );
$$;

-- ----------------------------------------------------------------------------
-- d. place_bid(uuid, bigint) — live def from 0191_bid_count_human_only.sql,
--    reproduced FAITHFULLY. The ONLY changes vs 0191:
--      1. new DECLARE  v_op_schedule JSONB;
--      2. after v_auction is loaded, SELECT the operator default schedule.
--      3. the single increment line now passes the effective schedule:
--           min_bid_increment_cents(v_lot.current_bid_cents,
--             COALESCE(v_auction.bid_increment_schedule, v_op_schedule))
--    Everything else — 0084 guards, 0104 §A/§B, 0176 §C, 0111 lock + soft-close,
--    proxy math, the 0191 bid_count removal — is byte-for-byte from 0191.
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

-- Re-assert the GRANT (0003 granted EXECUTE to authenticated; CREATE OR REPLACE
-- preserves the existing ACL, but we re-assert for parity with the live def).
GRANT EXECUTE ON FUNCTION public.place_bid(UUID, BIGINT) TO authenticated;
