-- ============================================================================
-- Migration 0407 — public_warehouse_pickup_info
--
-- RLS policy warehouses_bidder_read only exposes warehouses once a bidder has
-- invoice access (bidder_has_warehouse_access). Lot/auction pages still need
-- pickup-facing columns for off-site warehouses (customer_notice set) before
-- the customer wins anything — the website reads via service role; the bidder
-- app calls this SECURITY DEFINER RPC.
--
-- Exposes only fields already shown on public pickup pages — no tax_rate_bps,
-- Square location, floor plan, or coordinates. Active warehouse + active operator.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.public_warehouse_pickup_info(p_warehouse_id uuid)
RETURNS TABLE (
  id uuid,
  name text,
  address_line1 text,
  address_line2 text,
  city text,
  state text,
  postal_code text,
  timezone text,
  pickup_hours jsonb,
  pickup_instructions text,
  customer_notice text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    w.id,
    w.name,
    w.address_line1,
    w.address_line2,
    w.city,
    w.state,
    w.postal_code,
    w.timezone,
    w.pickup_hours,
    w.pickup_instructions,
    w.customer_notice
  FROM warehouses w
  JOIN operators o ON o.id = w.operator_id
  WHERE w.id = p_warehouse_id
    AND w.active
    AND o.status = 'active';
$$;

REVOKE ALL ON FUNCTION public.public_warehouse_pickup_info(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_warehouse_pickup_info(uuid) TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.public_warehouse_pickup_info(uuid) IS
  '0407: pickup-facing warehouse columns for public lot/auction UIs when RLS '
  'blocks direct warehouses reads. No row for inactive warehouses or operators.';

COMMIT;
