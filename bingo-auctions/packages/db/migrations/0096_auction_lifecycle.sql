-- ============================================================================
-- Migration 0096 — Auction lifecycle completeness
--
-- Background (from docs/auction-lot-audit-plan.md):
--   Nothing in the codebase ever flips auctions.status from scheduled→live
--   or live→closed. Lots close individually via pg_cron, invoices build,
--   payments process — but the auction record stays 'live' forever.
--   editAuction's lock on live/closed works only because nothing ever
--   clears those states. Analytics queries that filter by status='closed'
--   silently return zero rows.
--
-- This migration:
--   1. Adds closed_at / canceled_at / canceled_by columns
--   2. New SECURITY DEFINER function advance_auction_lifecycle() that
--      reconciles auction.status against its child lots' states
--   3. Schedules it on pg_cron every 60s
--   4. New SECURITY DEFINER RPC cancel_auction(auction_id, reason) that
--      atomically cancels the auction + all its non-bid lots
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. New timestamp / actor columns
-- ---------------------------------------------------------------------------

ALTER TABLE auctions
  ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;
ALTER TABLE auctions
  ADD COLUMN IF NOT EXISTS canceled_at TIMESTAMPTZ;
ALTER TABLE auctions
  ADD COLUMN IF NOT EXISTS canceled_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN auctions.closed_at IS
  'Set by advance_auction_lifecycle() when every child lot reaches a terminal '
  'state (won, unsold, canceled, relisted). Lets analytics queries filter '
  'past auctions reliably.';

COMMENT ON COLUMN auctions.canceled_at IS
  'Set by cancel_auction() RPC. Distinct from updated_at because that field '
  'changes on any UPDATE, including benign edits.';

COMMENT ON COLUMN auctions.canceled_by IS
  'auth.uid() at the time cancel_auction() was called. Defense-in-depth '
  'audit trail (proper audit history coming in migration 0097).';

ALTER TABLE lots
  ADD COLUMN IF NOT EXISTS canceled_at TIMESTAMPTZ;
ALTER TABLE lots
  ADD COLUMN IF NOT EXISTS canceled_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- 2. advance_auction_lifecycle()
-- ---------------------------------------------------------------------------
-- Idempotent reconciliation function. Pg_cron runs this every 60s. It:
--   (a) Flips scheduled→live when any child lot transitions to live
--       (catches the case place_bid() updates lots but not the parent).
--   (b) Flips live→closed (or scheduled→closed) when every child lot is
--       in a terminal state — won, unsold, canceled, or relisted.
--   (c) Sets closed_at on the transition.
--
-- We use SET search_path = public so the function can be called by
-- pg_cron without ambiguity. SECURITY DEFINER so it bypasses RLS on
-- the auctions table (the function runs as the owner, not the cron user).

CREATE OR REPLACE FUNCTION advance_auction_lifecycle()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_promoted_live   INT := 0;
  v_promoted_closed INT := 0;
BEGIN
  -- (a) scheduled → live when any child lot is currently live or won.
  -- "won" handles the edge case where a lot finalized between this tick
  -- and the previous one before we got to flip the auction to live.
  WITH eligible AS (
    SELECT a.id
    FROM auctions a
    WHERE a.status = 'scheduled'
      AND EXISTS (
        SELECT 1 FROM lots l
        WHERE l.auction_id = a.id
          AND l.status IN ('live', 'won')
      )
  ),
  promoted AS (
    UPDATE auctions
    SET status = 'live', updated_at = now()
    WHERE id IN (SELECT id FROM eligible)
    RETURNING id
  )
  SELECT count(*) INTO v_promoted_live FROM promoted;

  -- (b) live → closed when every child lot is in a terminal state and
  -- at least one lot exists. (Empty auctions never auto-close — they
  -- stay scheduled/live until an operator either adds lots or cancels.)
  -- Also accepts scheduled→closed for the case of an auction whose lots
  -- all ended up canceled before going live.
  WITH eligible AS (
    SELECT a.id
    FROM auctions a
    WHERE a.status IN ('scheduled', 'live')
      AND EXISTS (SELECT 1 FROM lots l WHERE l.auction_id = a.id)
      AND NOT EXISTS (
        SELECT 1 FROM lots l
        WHERE l.auction_id = a.id
          AND l.status NOT IN ('won', 'unsold', 'canceled', 'relisted')
      )
  ),
  promoted AS (
    UPDATE auctions
    SET
      status = 'closed',
      closed_at = COALESCE(closed_at, now()),
      updated_at = now()
    WHERE id IN (SELECT id FROM eligible)
    RETURNING id
  )
  SELECT count(*) INTO v_promoted_closed FROM promoted;

  RETURN jsonb_build_object(
    'promoted_live', v_promoted_live,
    'promoted_closed', v_promoted_closed,
    'at', now()
  );
END;
$$;

-- Only callable by service-role/cron — operator-staff don't need this.
REVOKE ALL ON FUNCTION advance_auction_lifecycle() FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 3. Schedule advance_auction_lifecycle on pg_cron
-- ---------------------------------------------------------------------------
-- Every 60s. Cheap query (two filtered counts + targeted updates) so even
-- on a busy platform it should take <10ms.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'advance-auction-lifecycle'
  ) THEN
    PERFORM cron.unschedule('advance-auction-lifecycle');
  END IF;
  PERFORM cron.schedule(
    'advance-auction-lifecycle',
    '* * * * *',   -- every minute (pg_cron's minimum interval)
    $cron$SELECT public.advance_auction_lifecycle()$cron$
  );
END $$;

-- ---------------------------------------------------------------------------
-- 4. cancel_auction RPC (atomic + scoped)
-- ---------------------------------------------------------------------------
-- Replaces the JS-only cancellation logic. Guarantees:
--   - caller is operator staff (admin/manager role) for the auction
--   - auction is in draft/scheduled status (live auctions need a separate
--     emergency flow — coming post-launch)
--   - no lot has bids (refunds-required path is also separate)
--   - the auction + all its draft/scheduled lots are flipped together
--   - canceled_at and canceled_by are captured for audit

CREATE OR REPLACE FUNCTION cancel_auction(
  p_auction_id UUID,
  p_reason TEXT DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user        UUID := auth.uid();
  v_op_id       UUID;
  v_role        operator_user_role;
  v_auction     RECORD;
  v_bid_count   INT;
  v_lot_count   INT;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;

  SELECT ou.operator_id, ou.role
    INTO v_op_id, v_role
  FROM operator_users ou
  WHERE ou.user_id = v_user
  LIMIT 1;

  IF v_op_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_operator_staff');
  END IF;

  IF v_role NOT IN ('admin', 'manager') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'insufficient_role');
  END IF;

  -- Lock the auction row so concurrent cancels serialize.
  SELECT id, status, operator_id
    INTO v_auction
  FROM auctions
  WHERE id = p_auction_id
  FOR UPDATE;

  IF v_auction.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'auction_not_found');
  END IF;
  IF v_auction.operator_id <> v_op_id THEN
    RETURN jsonb_build_object('ok', false, 'error', 'auction_not_found');
  END IF;
  IF v_auction.status NOT IN ('draft', 'scheduled') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'wrong_status',
      'status', v_auction.status
    );
  END IF;

  -- Refuse if any lot has bids. (A canceled auction with bids would
  -- need refunds, which is a separate flow we haven't built.)
  SELECT count(*) INTO v_bid_count
  FROM lots
  WHERE auction_id = p_auction_id
    AND bid_count > 0;
  IF v_bid_count > 0 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'auction_has_bids',
      'bid_lot_count', v_bid_count
    );
  END IF;

  -- Atomically flip all the child lots, then the auction.
  WITH canceled_lots AS (
    UPDATE lots
    SET
      status = 'canceled',
      canceled_at = now(),
      canceled_by = v_user,
      updated_at = now()
    WHERE auction_id = p_auction_id
      AND status IN ('draft', 'scheduled', 'live')
    RETURNING id
  )
  SELECT count(*) INTO v_lot_count FROM canceled_lots;

  UPDATE auctions
  SET
    status = 'canceled',
    canceled_at = now(),
    canceled_by = v_user,
    updated_at = now()
  WHERE id = p_auction_id
    AND operator_id = v_op_id;

  -- Optional reason audit. Until migration 0097 lands with proper
  -- status_history tables, the reason just gets folded into a single
  -- text column. For now we discard it — the auth.uid() capture is
  -- the durable bit; reason is operator courtesy.
  PERFORM p_reason;

  RETURN jsonb_build_object(
    'ok', true,
    'auction_id', p_auction_id,
    'canceled_lot_count', v_lot_count,
    'canceled_by', v_user,
    'canceled_at', now()
  );
END;
$$;

REVOKE ALL ON FUNCTION cancel_auction(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cancel_auction(UUID, TEXT) TO authenticated;

COMMIT;
