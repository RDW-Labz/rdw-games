-- ============================================================================
-- Migration 0174 — Auction lifecycle: don't let leftover DRAFT lots pin an
--                   auction LIVE forever.
--
-- Bug (prod, 2026-06-02): "Test Auction.2" showed status='live' ~23h after its
-- window ended. Confirmed cause: it had 5 lots — 3 'won' (terminal) + 2 'draft'
-- (lot_codes BIN-000100/BIN-000101, created 10 min before close, never
-- published to bidders, no bids). advance_auction_lifecycle()'s close branch
-- (0096 lines 102-122) only closes an auction when EVERY child lot is terminal
-- (won/unsold/canceled/relisted). 'draft' is NOT terminal and has no close
-- path, so the two never-published drafts blocked the close indefinitely.
--
-- Fix: add a WINDOW-GATED close branch that ignores 'draft' lots. An auction
-- closes once its window has passed (COALESCE(last_lot_ends_at, ends_at) is
-- more than a 10-minute grace in the past) AND every NON-DRAFT lot is terminal.
-- Drafts (never seen by bidders) no longer keep a finished auction open.
--
-- Why time-gated: an operator may legitimately have draft lots in a LIVE
-- auction they are still building. The grace window means we only force-close
-- auctions whose bidding window has actually elapsed — drafts inside an active
-- window are never touched. The original fast-close branch (b) is preserved so
-- a clean auction (no drafts) still closes the instant its lots all finalize.
--
-- Non-destructive: this migration does NOT mutate the draft lots — they stay
-- 'draft' (recoverable / re-lottable). It only flips the parent auction to
-- 'closed'. (Policy for auto-resolving leftover drafts is a separate decision.)
--
-- Idempotent: CREATE OR REPLACE; safe to re-run. Ends with a one-shot catch-up
-- call to immediately close Test Auction.2 and any other already-stuck rows.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION advance_auction_lifecycle()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_promoted_live         INT := 0;
  v_promoted_closed       INT := 0;
  v_promoted_closed_stale INT := 0;
BEGIN
  -- (a) scheduled → live when any child lot is currently live or won.
  --     (unchanged from 0096)
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

  -- (b) live → closed when EVERY child lot is terminal and at least one lot
  --     exists. Fast path (no time gate) for the clean case. (unchanged from 0096)
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

  -- (b2) live/scheduled → closed when the auction's bidding WINDOW HAS PASSED
  --      and every NON-DRAFT lot is terminal. This is the draft-tolerant
  --      fallback: never-published 'draft' lots must not pin a finished auction
  --      open forever (prod bug 2026-06-02). Time-gated by a 10-minute grace
  --      past COALESCE(last_lot_ends_at, ends_at) so auctions still inside their
  --      window — where an operator may be adding/curating draft lots — are
  --      left alone. Requires >=1 lot. Draft lots are intentionally NOT mutated.
  WITH eligible AS (
    SELECT a.id
    FROM auctions a
    WHERE a.status IN ('scheduled', 'live')
      AND COALESCE(a.last_lot_ends_at, a.ends_at) IS NOT NULL
      AND COALESCE(a.last_lot_ends_at, a.ends_at) < now() - interval '10 minutes'
      AND EXISTS (SELECT 1 FROM lots l WHERE l.auction_id = a.id)
      AND NOT EXISTS (
        SELECT 1 FROM lots l
        WHERE l.auction_id = a.id
          AND l.status NOT IN ('won', 'unsold', 'canceled', 'relisted', 'draft')
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
  SELECT count(*) INTO v_promoted_closed_stale FROM promoted;

  RETURN jsonb_build_object(
    'promoted_live', v_promoted_live,
    'promoted_closed', v_promoted_closed,
    'promoted_closed_stale_draft', v_promoted_closed_stale,
    'at', now()
  );
END;
$$;

-- Only callable by service-role/cron (unchanged from 0096).
REVOKE ALL ON FUNCTION advance_auction_lifecycle() FROM PUBLIC;

-- One-shot catch-up: immediately reconcile any already-stuck auctions
-- (incl. Test Auction.2) without waiting for the next 60s cron tick.
SELECT public.advance_auction_lifecycle();

COMMIT;
