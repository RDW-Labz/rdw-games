-- ============================================================================
-- Migration 0199 — cancel_auction() returns no-bid lots to inventory (INV-2)
--
-- Background (live-test feedback 2026-06-10):
--   cancel_auction() (migration 0096) flipped every child lot to
--   status='canceled' while KEEPING its auction_id and lot_number. No
--   inventory view ever surfaces a canceled lot (the available bucket filters
--   status='in_inventory' AND auction_id IS NULL), so the lots of a canceled
--   auction became orphaned — they "vanished" from the operator's inventory
--   even though they were never sold and are perfectly good stock.
--
-- This migration:
--   • Replaces cancel_auction() so the child-lot UPDATE RETURNS the no-bid
--     lots to inventory instead of marking them canceled:
--         status='in_inventory', auction_id=NULL, lot_number=NULL,
--         close_at=NULL, canceled_at=now(), canceled_by=v_user, updated_at=now()
--     The canceled_at/canceled_by writes are preserved for audit (the original
--     wrote them); they record that this lot passed through a canceled auction.
--   • Everything else — auth/role/scope checks, the advisory FOR UPDATE lock on
--     the auction row, the has-bids refusal, the auction-row UPDATE to
--     'canceled', the reason no-op, and the returned jsonb shape — is reproduced
--     VERBATIM from 0096 so behavior is otherwise identical.
--
-- Why returning lots is safe here:
--   cancel_auction() already REFUSES (error 'auction_has_bids') if ANY child
--   lot has bid_count > 0, so the lots reached by the UPDATE are always no-bid.
--   No-bid lots have no winner, no invoice, no payment — returning them to the
--   unassigned in-inventory pool is exactly the state intake produces.
--
-- Why close_at = NULL:
--   lots.close_at is NULLABLE (its NOT NULL was dropped in migration 0021), and
--   the canonical shape of an unassigned in-inventory lot is close_at = NULL —
--   that's exactly what intake_lot_to_bin (0059) inserts for a freshly-binned
--   lot. The lots_default_close_at_on_attach trigger (0179) only fills close_at
--   when auction_id IS NOT NULL, so a returned lot (auction_id NULL,
--   close_at NULL) is left untouched and stays valid. Clearing close_at also
--   keeps the lot out of the close_at-driven open/finalize cron scans.
--
-- CREATE OR REPLACE preserves the existing ACL granted in 0096
-- (REVOKE ALL FROM PUBLIC; GRANT EXECUTE TO authenticated) — re-stated below
-- for completeness / re-apply safety.
-- ============================================================================

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

  -- INV-2: RETURN the (always no-bid — see the guard above) child lots to the
  -- unassigned in-inventory pool instead of orphaning them as 'canceled' with a
  -- dangling auction_id. Clearing auction_id + lot_number + close_at restores
  -- the exact shape intake produces; canceled_at/canceled_by are kept for audit
  -- (this lot passed through a canceled auction). The lot is then visible again
  -- in the inventory "available" bucket and can be re-assigned to a new auction.
  WITH returned_lots AS (
    UPDATE lots
    SET
      status = 'in_inventory',
      auction_id = NULL,
      lot_number = NULL,
      close_at = NULL,
      canceled_at = now(),
      canceled_by = v_user,
      updated_at = now()
    WHERE auction_id = p_auction_id
      AND status IN ('draft', 'scheduled', 'live')
    RETURNING id
  )
  SELECT count(*) INTO v_lot_count FROM returned_lots;

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
