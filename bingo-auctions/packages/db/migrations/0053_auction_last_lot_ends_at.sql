-- ============================================================================
-- 0053_auction_last_lot_ends_at
--
-- Two-endpoint auction ending window. Operators think in "first lot
-- closes at X, last lot closes at Y" — not in stagger seconds.
--
-- Adds:
--   auctions.last_lot_ends_at TIMESTAMPTZ — when the LAST lot in the
--                                            auction closes. Nullable
--                                            for backward compat with
--                                            auctions that only had
--                                            close_stagger_seconds set.
--
-- Plus an RPC redistribute_close_times(auction_id) that recomputes
-- per-lot close_at from the two endpoints. Operators run this after
-- adding/removing lots to evenly redistribute the stagger.
--
-- Backward compat: assign_lots_to_auction (from 0030) still uses
-- close_stagger_seconds. The new flow is opt-in: operators who set
-- last_lot_ends_at and call redistribute_close_times get evenly-spaced
-- close times across the window. Operators who don't keep the legacy
-- fixed-stagger behavior.
--
-- The CHECK constraint enforces the obvious invariant
-- (last_lot_ends_at >= ends_at when both are set) so a typo can't
-- produce a negative interval.
-- ============================================================================

ALTER TABLE auctions
  ADD COLUMN IF NOT EXISTS last_lot_ends_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'auctions_last_lot_ends_after_first'
      AND conrelid = 'public.auctions'::regclass
  ) THEN
    ALTER TABLE public.auctions
      ADD CONSTRAINT auctions_last_lot_ends_after_first
      CHECK (last_lot_ends_at IS NULL OR last_lot_ends_at >= ends_at);
  END IF;
END $$;

COMMENT ON COLUMN auctions.last_lot_ends_at IS
  '0053: end of the lot-close window. Per-lot close_at gets distributed evenly between auctions.ends_at (first lot) and last_lot_ends_at (last lot). NULL = legacy fixed-stagger via close_stagger_seconds.';

-- ── RPC: redistribute_close_times ────────────────────────────────────────────
-- Recompute every lot's close_at to evenly span [ends_at, last_lot_ends_at]
-- by lot_number. Idempotent — running twice produces the same result. Used
-- after adding/removing lots, or after editing the auction's window.
--
-- Math: for N lots with lot_number 1..N
--   step      = (last_lot_ends_at - ends_at) / max(N - 1, 1)
--   close_at  = ends_at + (lot_number - 1) * step
--
-- Edge cases:
--   N = 0   → no-op, return 0
--   N = 1   → that one lot closes at ends_at exactly
--   last_lot_ends_at IS NULL → no-op, return 0 (legacy auction; operator
--                              should set the endpoint first)
--
-- Returns: number of lots updated.
CREATE OR REPLACE FUNCTION redistribute_close_times(p_auction_id UUID)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_op UUID;
  v_auction RECORD;
  v_count INT;
  v_step INTERVAL;
  v_updated INT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'redistribute_close_times: not authenticated' USING ERRCODE = '28000';
  END IF;

  v_caller_op := current_operator_id();
  IF v_caller_op IS NULL THEN
    RAISE EXCEPTION 'redistribute_close_times: caller is not operator staff'
      USING ERRCODE = '42501';
  END IF;

  SELECT id, operator_id, ends_at, last_lot_ends_at, status
  INTO v_auction
  FROM auctions
  WHERE id = p_auction_id;

  IF v_auction.id IS NULL OR v_auction.operator_id IS DISTINCT FROM v_caller_op THEN
    -- Cross-tenant or missing: silently no-op rather than disclose
    -- existence. Matches the auto_pick_featured_images pattern.
    RETURN 0;
  END IF;

  -- Don't allow recompute on live/closed auctions — bidders are looking
  -- at live close times. Operator should cancel + relist instead.
  IF v_auction.status NOT IN ('draft', 'scheduled') THEN
    RAISE EXCEPTION 'redistribute_close_times: auction is % — cancel + recreate to change close times', v_auction.status
      USING ERRCODE = '22023';
  END IF;

  IF v_auction.last_lot_ends_at IS NULL THEN
    -- Legacy mode — operator hasn't set the second endpoint. The fixed-
    -- stagger from close_stagger_seconds + assign_lots_to_auction still
    -- works; we just don't redistribute here.
    RETURN 0;
  END IF;

  SELECT count(*) INTO v_count FROM lots WHERE auction_id = p_auction_id;
  IF v_count = 0 THEN
    RETURN 0;
  END IF;

  IF v_count = 1 THEN
    -- Special case: single lot closes at ends_at.
    UPDATE lots SET close_at = v_auction.ends_at WHERE auction_id = p_auction_id;
    RETURN 1;
  END IF;

  -- Even distribution. Use millisecond precision to avoid loss when the
  -- window is short and N is large.
  v_step := (v_auction.last_lot_ends_at - v_auction.ends_at) / (v_count - 1);

  WITH numbered AS (
    SELECT id, lot_number FROM lots WHERE auction_id = p_auction_id
  )
  UPDATE lots
  SET close_at = v_auction.ends_at + (numbered.lot_number - 1) * v_step
  FROM numbered
  WHERE lots.id = numbered.id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  RETURN v_updated;
END;
$$;

REVOKE EXECUTE ON FUNCTION redistribute_close_times(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION redistribute_close_times(UUID) TO authenticated;

COMMENT ON FUNCTION redistribute_close_times(UUID) IS
  '0053: evenly redistribute lots.close_at between auctions.ends_at (first lot) and last_lot_ends_at (last lot). No-op when last_lot_ends_at is null (legacy stagger mode). Errors when the auction is live/closed/canceled.';
