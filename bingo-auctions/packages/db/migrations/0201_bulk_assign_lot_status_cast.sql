-- ============================================================================
-- Migration 0201 — fix bulk_assign_lot_numbers: cast p_status TEXT -> lot_status
--
-- BUG (confirmed on live prod, 2026-06-11 tester recap)
-- ----------------------------------------------------
-- Inventory -> "Assign to Auction" (the "Assign N" footer on the operator-web
-- inventory list -> lotting/inventory/actions.ts assignLotsToAuction ->
-- rpc('bulk_assign_lot_numbers')) fails with:
--     column "status" is of type lot_status but expression is of type text
--
-- The 0135 (DB-8) function declares p_status TEXT and assigns it directly into
-- lots.status (enum lot_status):
--     status = p_status
-- Postgres implicitly coerces an *untyped string literal* into an enum, but NOT
-- a value already typed as text (a function parameter). So the UPDATE raises
-- 42804. The Auction-Builder "Add to auction" path uses a different RPC
-- (assign_lots_to_auction) with a literal status='scheduled' that coerces fine,
-- which is why ONLY the inventory bulk-assign path errored.
--
-- FIX
-- ---
-- Add an explicit ::lot_status cast on the assignment. Body otherwise
-- reproduced VERBATIM from 0135 — same signature, unnest+ordinality numbering,
-- the operator_id + status='in_inventory' + auction_id IS NULL guards, and the
-- REVOKE/GRANT. The TS caller (inventory/actions.ts) is unchanged; it still
-- passes 'draft'/'scheduled' as a JS string into p_status TEXT.
-- ============================================================================

CREATE OR REPLACE FUNCTION bulk_assign_lot_numbers(
  p_lot_ids      UUID[],
  p_auction_id   UUID,
  p_first_number INT,
  p_status       TEXT,
  p_close_at     TIMESTAMPTZ,
  p_operator_id  UUID
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated INT;
BEGIN
  WITH numbered AS (
    SELECT
      id::UUID   AS lot_id,
      (p_first_number + (ordinality - 1)::INT) AS lot_num
    FROM unnest(p_lot_ids) WITH ORDINALITY AS t(id, ordinality)
  )
  UPDATE lots l
  SET
    auction_id  = p_auction_id,
    lot_number  = n.lot_num,
    status      = p_status::lot_status,
    close_at    = p_close_at
  FROM numbered n
  WHERE l.id = n.lot_id
    AND l.operator_id = p_operator_id
    AND l.status = 'in_inventory'
    AND l.auction_id IS NULL;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

REVOKE EXECUTE ON FUNCTION bulk_assign_lot_numbers(UUID[], UUID, INT, TEXT, TIMESTAMPTZ, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bulk_assign_lot_numbers(UUID[], UUID, INT, TEXT, TIMESTAMPTZ, UUID) TO authenticated;
