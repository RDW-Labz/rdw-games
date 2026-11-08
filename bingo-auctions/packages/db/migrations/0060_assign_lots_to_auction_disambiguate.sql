-- ============================================================================
-- 0060_assign_lots_to_auction_disambiguate
--
-- The assign_lots_to_auction RPC introduced in 0030 declares its
-- RETURNS TABLE columns as `lot_id, lot_code, lot_number, close_at`.
-- In PL/pgSQL those OUT parameters become same-named variables in the
-- function scope. Three of them (lot_code, lot_number, close_at) are
-- ALSO real columns on the `lots` table.
--
-- When the function body queries `lots` without explicit table
-- qualification — e.g.
--    SELECT COALESCE(MAX(lot_number), 0) + 1 ...
--    UPDATE lots SET lot_number = v_next_number, close_at = ...
-- — Postgres raises 42702 "column reference is ambiguous: it could
-- refer to either a PL/pgSQL variable or a table column."
--
-- This bug only surfaced once the mega-sim phase-2A exercised the
-- happy path of assign_lots_to_auction end-to-end. Real-world callers
-- (operator-web auction builder + auto-builder) presumably haven't hit
-- it because either:
--   • The hosted operator never auto-built an auction post-0030.
--   • Or Postgres tolerated the ambiguity in an older version and
--     started failing after a planner upgrade.
--
-- Fix: set `#variable_conflict use_column` at the top of the function
-- body. That tells PL/pgSQL "ambiguous names resolve to the column,
-- not the variable" — which is exactly what the original author meant.
-- OUT parameters are still assignable via plain name; only ambiguous
-- READS prefer the column. The function logic is unchanged.
--
-- Also explicitly qualifying the references in the offending queries
-- for defense-in-depth — that way future variable additions to the
-- function body won't reintroduce the same class of bug.
-- ============================================================================

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
#variable_conflict use_column
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
  SELECT a.id, a.ends_at, a.warehouse_id, a.status, a.close_stagger_seconds
    INTO v_auction
  FROM auctions a
  WHERE a.id = p_auction_id AND a.operator_id = v_operator_id
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

  -- Next sequential lot_number for this auction. Explicit table-qualified
  -- to avoid the OUT-parameter shadowing that 0060 fixes.
  SELECT COALESCE(MAX(l.lot_number), 0) + 1 INTO v_next_number
  FROM lots l WHERE l.auction_id = p_auction_id;

  FOR v_lot IN
    SELECT l.id, l.lot_code, l.status, l.warehouse_id, l.auction_id
    FROM lots l
    WHERE l.id = ANY(p_lot_ids)
      AND l.operator_id = v_operator_id
    ORDER BY l.id
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

    -- Assign to OUT parameters. With #variable_conflict use_column the
    -- bare names below would resolve to columns — but inside a RETURN
    -- NEXT statement they're unambiguous as OUT parameters because
    -- there's no surrounding query. Still, use the explicit form to
    -- make intent obvious.
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

COMMENT ON FUNCTION assign_lots_to_auction(UUID, UUID[]) IS
  '0060: fixed PL/pgSQL OUT-parameter / column-name shadowing on lot_code, lot_number, close_at. Set #variable_conflict use_column and explicitly qualify column references inside SELECT/UPDATE. No behavior change.';
