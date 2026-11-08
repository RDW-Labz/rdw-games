-- 0165_pickup_mode_taxonomy.sql
--
-- Extends the pickup_mode enum from 3 values to 4 by:
--   1. Adding  `counter_pickup`       — bidder walks aisles, finds lots on
--                                       labeled shelves, brings to counter.
--                                       No floor-plan map. QR + bin codes.
--   2. Renaming `self_serve` →        `self_serve_floor_plan`
--                                       (keeps semantics, adds precision).
--
-- All three constraints that reference pickup_mode are updated (0094 added
-- warehouses_pickup_mode_check, auctions_pickup_mode_override_check, and
-- pickups_pickup_mode_check — all must accept the new values before any
-- row update can succeed).
--
-- Also updates bidder_confirm_customer_pickup to accept the new modes that
-- allow self-completion (counter_pickup + self_serve_floor_plan + hybrid).
--
-- Live data snapshot (2026-06-01):
--   warehouses:   4 rows  —  3× staff_assisted, 1× self_serve (Harrison)
--   auctions:     8 rows  —  all pickup_mode_override IS NULL
--   pickups:      0 rows  —  column is nullable; no data
-- Net change: Harrison self_serve → counter_pickup (floor_plan_url IS NULL).

-- ORDER MATTERS (fixed 2026-06-02): DROP the old 3-value constraints FIRST, so
-- (a) the remap UPDATE below (self_serve → counter_pickup) isn't rejected by the
-- OLD constraint, and (b) the NEW 4-value constraint isn't added while a legacy
-- 'self_serve' row still exists. The original DROP+ADD-then-UPDATE order failed
-- on prod (0/4) because Harrison was still 'self_serve' when the new CHECK was added.
ALTER TABLE warehouses DROP CONSTRAINT IF EXISTS warehouses_pickup_mode_check;
ALTER TABLE auctions   DROP CONSTRAINT IF EXISTS auctions_pickup_mode_override_check;
ALTER TABLE pickups    DROP CONSTRAINT IF EXISTS pickups_pickup_mode_check;

-- Remap legacy 'self_serve' rows (now unconstrained).
-- Harrison: floor_plan_url IS NULL → counter_pickup; with a real floor plan → self_serve_floor_plan.
UPDATE warehouses
   SET pickup_mode = CASE
     WHEN floor_plan_url IS NOT NULL THEN 'self_serve_floor_plan'
     ELSE 'counter_pickup'
   END
 WHERE pickup_mode = 'self_serve';
UPDATE auctions
   SET pickup_mode_override = 'counter_pickup'
 WHERE pickup_mode_override = 'self_serve';
UPDATE pickups
   SET pickup_mode = 'counter_pickup'
 WHERE pickup_mode = 'self_serve';

-- Add the NEW 4-value constraints (no row holds 'self_serve' anymore).
ALTER TABLE warehouses ADD CONSTRAINT warehouses_pickup_mode_check
  CHECK (pickup_mode IN ('staff_assisted','counter_pickup','self_serve_floor_plan','hybrid'));
ALTER TABLE auctions ADD CONSTRAINT auctions_pickup_mode_override_check
  CHECK (pickup_mode_override IS NULL OR pickup_mode_override IN
    ('staff_assisted','counter_pickup','self_serve_floor_plan','hybrid'));
ALTER TABLE pickups ADD CONSTRAINT pickups_pickup_mode_check
  CHECK (pickup_mode IS NULL OR pickup_mode IN
    ('staff_assisted','counter_pickup','self_serve_floor_plan','hybrid'));

-- Update bidder_confirm_customer_pickup to accept new self-completion modes.
-- The function previously only allowed 'self_serve' and 'hybrid'; now it also
-- accepts 'counter_pickup' and 'self_serve_floor_plan' since bidders in those
-- modes self-collect and tap Confirm.
CREATE OR REPLACE FUNCTION bidder_confirm_customer_pickup(p_invoice_id UUID)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user             UUID := auth.uid();
  v_invoice          invoices%ROWTYPE;
  v_warehouse_mode   TEXT;
  v_auction_override TEXT;
  v_effective_mode   TEXT;
  v_picked_count     INT  := 0;
  v_pickup_id        UUID;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;

  SELECT * INTO v_invoice FROM invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invoice_not_found');
  END IF;
  IF v_invoice.bidder_id <> v_user THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_invoice_bidder');
  END IF;
  IF v_invoice.status <> 'paid' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'invoice_not_paid',
      'status', v_invoice.status
    );
  END IF;

  -- Resolve effective pickup mode via auction override → warehouse default.
  SELECT a.pickup_mode_override, w.pickup_mode
    INTO v_auction_override, v_warehouse_mode
  FROM invoice_lots il
  JOIN lots l ON l.id = il.lot_id
  JOIN auctions a ON a.id = l.auction_id
  JOIN warehouses w ON w.id = a.warehouse_id
  WHERE il.invoice_id = p_invoice_id
  LIMIT 1;

  v_effective_mode := COALESCE(v_auction_override, v_warehouse_mode);
  IF v_effective_mode IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_pickup_mode_resolved');
  END IF;
  -- Bidder self-confirm is valid ONLY for self_serve_floor_plan (bidder
  -- retrieves items using the warehouse map and taps Confirm). counter_pickup
  -- and staff_assisted complete via a staff QR scan at the counter
  -- (staff_confirm_pickup), so reject bidder self-confirm for those modes.
  IF v_effective_mode <> 'self_serve_floor_plan' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'wrong_pickup_mode',
      'effective_mode', v_effective_mode
    );
  END IF;

  -- Flip latest staged bin_assignment per lot → picked_up.
  WITH latest AS (
    SELECT DISTINCT ON (ba.lot_id) ba.id, ba.lot_id, ba.status
    FROM bin_assignments ba
    JOIN invoice_lots il ON il.lot_id = ba.lot_id
    WHERE il.invoice_id = p_invoice_id
    ORDER BY ba.lot_id, ba.assigned_at DESC
  ),
  staged AS (
    SELECT id FROM latest WHERE status = 'staged'
  ),
  picked AS (
    UPDATE bin_assignments
    SET status = 'picked_up', picked_up_at = now()
    WHERE id IN (SELECT id FROM staged)
    RETURNING id
  )
  SELECT count(*) INTO v_picked_count FROM picked;

  -- Update / create the pickups row.
  v_pickup_id := ensure_pickup_row(p_invoice_id);

  UPDATE pickups
  SET checked_in_at = COALESCE(checked_in_at, now()),
      completed_at  = now(),
      status        = 'completed',
      pickup_mode   = v_effective_mode,
      updated_at    = now()
  WHERE id = v_pickup_id
    AND status <> 'completed';

  PERFORM enqueue_notification(
    'pickup_confirmed',
    v_invoice.bidder_id,
    jsonb_build_object(
      'invoice_id', p_invoice_id,
      'mode', v_effective_mode,
      'lots_confirmed', v_picked_count
    ),
    'pickup_confirmed:self_serve:' || p_invoice_id::TEXT
  );

  RETURN jsonb_build_object(
    'ok', true,
    'pickup_id', v_pickup_id,
    'lots_confirmed', v_picked_count,
    'effective_mode', v_effective_mode
  );
END;
$$;

REVOKE ALL ON FUNCTION bidder_confirm_customer_pickup(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bidder_confirm_customer_pickup(UUID) TO authenticated;

COMMENT ON CONSTRAINT warehouses_pickup_mode_check ON warehouses IS
  'staff_assisted = staff retrieves; bidder shows QR at counter. '
  'counter_pickup = bidder walks aisles, finds lots on labeled shelves, brings to counter. '
  'self_serve_floor_plan = bidder uses warehouse map to find each bin. '
  'hybrid = per-auction override via auctions.pickup_mode_override.';
