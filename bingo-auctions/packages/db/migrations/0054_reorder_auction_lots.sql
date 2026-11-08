-- ============================================================================
-- 0054_reorder_auction_lots
--
-- Atomically reassign lot_number for every lot in an auction based on a
-- caller-supplied ordering. Used by the operator-web drag-to-reorder UX:
-- the operator drags the highest-value lot to position N (so it closes
-- last), saves, and we update lot_number 1..N to match the new order.
--
-- Why an RPC: lot_number has a partial UNIQUE index per auction
-- (lots_auction_lot_number_unique from migration 0021). Naive
-- per-row UPDATEs trip the UNIQUE constraint mid-loop ("lot 1 → lot 2"
-- collides with the existing lot 2). The clean atomic pattern is:
--
--   1. Verify all lot_ids belong to this auction (operator guard).
--   2. UPDATE all rows to lot_number = NULL in one statement (the
--      partial UNIQUE only fires when lot_number IS NOT NULL, so this
--      is allowed).
--   3. Re-assign lot_number 1..N from the ordered list, matching
--      ON id, in a single UPDATE FROM ... unnest(...) ordinality call.
--   4. Optionally call redistribute_close_times to refresh close_at.
--      We DO NOT do this here — the caller can choose to redistribute
--      separately so they see the change in two steps (reorder, then
--      redistribute) and don't accidentally break a hand-tuned
--      close-time sequence.
--
-- Args:
--   p_auction_id  the auction whose lots are being reordered
--   p_ordered_ids array of lot UUIDs IN THE NEW ORDER (position 1 = first
--                 element). Must include exactly the existing lot set.
--
-- Returns: the number of lots updated.
--
-- Security: SECURITY DEFINER + auth.uid + caller-must-own-auction.
-- Refuses on live/closed/canceled auctions.
-- ============================================================================

CREATE OR REPLACE FUNCTION reorder_auction_lots(
  p_auction_id UUID,
  p_ordered_ids UUID[]
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_op UUID;
  v_auction RECORD;
  v_existing_count INT;
  v_provided_count INT;
  v_updated INT;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'reorder_auction_lots: not authenticated' USING ERRCODE = '28000';
  END IF;

  v_caller_op := current_operator_id();
  IF v_caller_op IS NULL THEN
    RAISE EXCEPTION 'reorder_auction_lots: caller is not operator staff'
      USING ERRCODE = '42501';
  END IF;

  SELECT id, operator_id, status INTO v_auction
  FROM auctions WHERE id = p_auction_id;

  IF v_auction.id IS NULL OR v_auction.operator_id IS DISTINCT FROM v_caller_op THEN
    RETURN 0;
  END IF;

  IF v_auction.status NOT IN ('draft', 'scheduled') THEN
    RAISE EXCEPTION 'reorder_auction_lots: auction is %; cancel + recreate to change order', v_auction.status
      USING ERRCODE = '22023';
  END IF;

  v_provided_count := COALESCE(array_length(p_ordered_ids, 1), 0);
  IF v_provided_count = 0 THEN
    RETURN 0;
  END IF;

  -- Sanity: every provided id must belong to this auction. Catch
  -- off-auction ids (operator dragged a row that doesn't belong) AND
  -- missing ids (operator forgot to include some). Strict equality
  -- prevents a partial-reorder that would leave some lots with NULL
  -- lot_number after step 2.
  SELECT count(*) INTO v_existing_count
  FROM lots
  WHERE auction_id = p_auction_id;

  IF v_provided_count <> v_existing_count THEN
    RAISE EXCEPTION 'reorder_auction_lots: provided % ids but auction has % lots',
      v_provided_count, v_existing_count
      USING ERRCODE = '22023';
  END IF;

  -- All provided ids must actually be in this auction.
  IF EXISTS (
    SELECT 1
    FROM unnest(p_ordered_ids) AS u(id)
    WHERE NOT EXISTS (SELECT 1 FROM lots WHERE id = u.id AND auction_id = p_auction_id)
  ) THEN
    RAISE EXCEPTION 'reorder_auction_lots: one or more ids do not belong to this auction'
      USING ERRCODE = '22023';
  END IF;

  -- Step 1: clear lot_number on every lot in this auction. Partial
  -- UNIQUE index ignores NULLs so this can't trip.
  UPDATE lots SET lot_number = NULL WHERE auction_id = p_auction_id;

  -- Step 2: reassign 1..N from the ordered array in one UPDATE.
  -- WITH ORDINALITY gives us the position (1-indexed) for each id.
  WITH new_order AS (
    SELECT id, ord
    FROM unnest(p_ordered_ids) WITH ORDINALITY AS t(id, ord)
  )
  UPDATE lots
  SET lot_number = new_order.ord::INT
  FROM new_order
  WHERE lots.id = new_order.id
    AND lots.auction_id = p_auction_id;
  GET DIAGNOSTICS v_updated = ROW_COUNT;

  RETURN v_updated;
END;
$$;

REVOKE EXECUTE ON FUNCTION reorder_auction_lots(UUID, UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reorder_auction_lots(UUID, UUID[]) TO authenticated;

COMMENT ON FUNCTION reorder_auction_lots(UUID, UUID[]) IS
  '0054: atomic lot_number reassignment for drag-to-reorder UX. Two-step (NULL then reassign) to avoid mid-loop UNIQUE violations.';
