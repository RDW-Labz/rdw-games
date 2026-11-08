-- ============================================================================
-- Public-facing recent-bids RPC for the bidder app's live ticker.
--
-- The bids table's RLS policy (bids_self_read) only lets a bidder see
-- their own bid rows — that's the right default, but it makes a "live
-- bid feed" during the closing window impossible from the client.
--
-- This SECURITY DEFINER function exposes a redacted view of the last N
-- bids on a single lot:
--   - amount_cents, placed_at: visible
--   - bidder_id: replaced with a stable 4-char anon hash so the same
--     bidder shows as "Bidder a3f2" across all rows in the result
--     without leaking their UUID
--   - is_you: true when this bid is the caller's own (so the ticker
--     can highlight "you" without identifying others)
--
-- The function is callable by anyone authenticated; it gates by lot
-- status so closed/draft/canceled lots can't be inspected.
-- ============================================================================

CREATE OR REPLACE FUNCTION get_lot_recent_bids(
  p_lot_id UUID,
  p_limit INTEGER DEFAULT 10
)
RETURNS TABLE (
  bidder_anon TEXT,
  amount_cents BIGINT,
  placed_at TIMESTAMPTZ,
  is_you BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
DECLARE
  v_lot_status lot_status;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'auth required';
  END IF;

  SELECT status INTO v_lot_status FROM lots WHERE id = p_lot_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF v_lot_status NOT IN ('scheduled', 'live', 'won', 'unsold', 'relisted') THEN
    RETURN;
  END IF;

  -- Cap the limit defensively. The bidder app uses 10; anything above
  -- that is wasted Realtime payload.
  IF p_limit > 25 THEN p_limit := 25; END IF;
  IF p_limit < 1 THEN p_limit := 1; END IF;

  RETURN QUERY
  SELECT
    -- Stable per-bidder anon: last 4 chars of UUID. Same bidder = same
    -- string within the result. Different lots can still surface the
    -- same person — that's fine for a ticker (it's the *bid count*
    -- people care about, not "who").
    'Bidder ' || RIGHT(b.bidder_id::TEXT, 4) AS bidder_anon,
    b.amount_cents,
    b.placed_at,
    (b.bidder_id = auth.uid()) AS is_you
  FROM bids b
  WHERE b.lot_id = p_lot_id
  ORDER BY b.placed_at DESC
  LIMIT p_limit;
END;
$$;

-- Authenticated callers only.
REVOKE ALL ON FUNCTION get_lot_recent_bids(UUID, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION get_lot_recent_bids(UUID, INTEGER) TO authenticated;
