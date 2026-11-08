-- ============================================================================
-- Auction stagger + batched lot assignment RPC.
--
-- Two changes:
--
--   1. auctions.close_stagger_seconds — spreads lot close times so a
--      2500-lot auction doesn't have all lots closing at the same wall-clock
--      moment. Bidder browse stays usable across the whole auction window.
--      Default 0 = simultaneous (legacy behavior).
--
--   2. assign_lots_to_auction(auction_id, lot_ids[]) RPC — replaces the
--      N+1 loop in addInventoryToAuction (operator-web action). Atomic,
--      role-gated, computes per-lot close_at from the auction's
--      close_stagger_seconds + ends_at + lot_number.
--
-- The RPC is also what the auto-builder calls per generated auction.
-- ============================================================================

ALTER TABLE auctions
  ADD COLUMN IF NOT EXISTS close_stagger_seconds INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN auctions.close_stagger_seconds IS
  'Seconds between consecutive lot closes. 0 = all lots close simultaneously at ends_at. Set e.g. 5 for popcorn-style closes (lot N closes at ends_at + (N-1)*stagger).';

-- ----------------------------------------------------------------------------
-- assign_lots_to_auction RPC
--
-- Batched, atomic, role-gated. Replaces:
--   for (let lot of candidates) {
--     await admin.from('lots').update({...}).eq('id', lot.id);
--   }
-- in apps/operator-web/src/app/(operator)/auctions/[id]/build/actions.ts.
--
-- Returns one row per assigned lot so the caller can confirm the
-- assignment (and surface lot_number / close_at to the UI).
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION assign_lots_to_auction(
  p_auction_id UUID,
  p_lot_ids    UUID[]
)
RETURNS TABLE (
  lot_id     UUID,
  lot_code   TEXT,
  lot_number INTEGER,
  close_at   TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller       UUID := auth.uid();
  v_operator_id  UUID;
  v_role         operator_user_role;
  v_auction      RECORD;
  v_stagger      INTEGER;
  v_ends_at      TIMESTAMPTZ;
  v_next_number  INTEGER;
  v_lot          RECORD;
  v_close_at     TIMESTAMPTZ;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT operator_id, role INTO v_operator_id, v_role
  FROM operator_users WHERE user_id = v_caller LIMIT 1;
  IF v_operator_id IS NULL THEN
    RAISE EXCEPTION 'not_staff' USING ERRCODE = '42501';
  END IF;
  IF v_role NOT IN ('admin', 'manager') THEN
    RAISE EXCEPTION 'admin_or_manager_required' USING ERRCODE = '42501';
  END IF;

  -- Auction must belong to the operator and accept new lots.
  SELECT id, ends_at, warehouse_id, status, close_stagger_seconds
    INTO v_auction
  FROM auctions
  WHERE id = p_auction_id AND operator_id = v_operator_id
  FOR UPDATE;

  IF v_auction.id IS NULL THEN
    RAISE EXCEPTION 'auction_not_found' USING ERRCODE = '02000';
  END IF;
  IF v_auction.status NOT IN ('draft', 'scheduled') THEN
    RAISE EXCEPTION 'auction_not_editable_status:%', v_auction.status
      USING ERRCODE = '42501';
  END IF;

  v_stagger := COALESCE(v_auction.close_stagger_seconds, 0);
  v_ends_at := v_auction.ends_at;

  -- Next sequential lot_number for this auction.
  SELECT COALESCE(MAX(lot_number), 0) + 1 INTO v_next_number
  FROM lots WHERE auction_id = p_auction_id;

  -- Iterate. Order by id for consistent locking (avoid deadlocks when
  -- two operators concurrently auto-build).
  FOR v_lot IN
    SELECT id, lot_code, status, warehouse_id, auction_id
    FROM lots
    WHERE id = ANY(p_lot_ids)
      AND operator_id = v_operator_id
    ORDER BY id
    FOR UPDATE
  LOOP
    IF v_lot.auction_id IS NOT NULL THEN
      RAISE EXCEPTION 'lot_already_in_auction:%', v_lot.lot_code
        USING ERRCODE = '42501';
    END IF;
    IF v_lot.status <> 'in_inventory' THEN
      RAISE EXCEPTION 'lot_not_in_inventory:%:%', v_lot.lot_code, v_lot.status
        USING ERRCODE = '42501';
    END IF;
    IF v_auction.warehouse_id IS NOT NULL
       AND v_lot.warehouse_id <> v_auction.warehouse_id THEN
      RAISE EXCEPTION 'lot_wrong_warehouse:%', v_lot.lot_code
        USING ERRCODE = '42501';
    END IF;

    v_close_at := v_ends_at + (make_interval(secs => v_stagger * (v_next_number - 1)));

    UPDATE lots
       SET auction_id = p_auction_id,
           lot_number = v_next_number,
           status     = 'scheduled',
           close_at   = v_close_at
     WHERE id = v_lot.id;

    lot_id     := v_lot.id;
    lot_code   := v_lot.lot_code;
    lot_number := v_next_number;
    close_at   := v_close_at;
    RETURN NEXT;

    v_next_number := v_next_number + 1;
  END LOOP;

  RETURN;
END;
$$;

REVOKE EXECUTE ON FUNCTION assign_lots_to_auction(UUID, UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION assign_lots_to_auction(UUID, UUID[]) TO authenticated;
