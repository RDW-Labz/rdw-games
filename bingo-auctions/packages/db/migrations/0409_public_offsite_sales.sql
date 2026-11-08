-- ============================================================================
-- Migration 0409 — public_offsite_sales()
--
-- Lists active off-site warehouses (non-blank customer_notice per 0406) that
-- have at least one storefront-visible auction (scheduled/live, listed, non-demo
-- operator). Powers home/browse sale buttons and bidder-app off-site sale screens.
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION public.public_offsite_sales()
RETURNS TABLE (
  warehouse_id uuid,
  name text,
  address_line1 text,
  address_line2 text,
  city text,
  state text,
  postal_code text,
  timezone text,
  pickup_hours jsonb,
  pickup_instructions text,
  customer_notice text,
  auction_count int
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    w.id AS warehouse_id,
    w.name,
    w.address_line1,
    w.address_line2,
    w.city,
    w.state,
    w.postal_code,
    w.timezone,
    w.pickup_hours,
    w.pickup_instructions,
    w.customer_notice,
    COUNT(a.id)::int AS auction_count
  FROM warehouses w
  INNER JOIN operators o ON o.id = w.operator_id
  INNER JOIN auctions a ON a.warehouse_id = w.id
  WHERE w.active IS TRUE
    AND w.customer_notice IS NOT NULL
    AND btrim(w.customer_notice) <> ''
    AND o.status = 'active'
    AND COALESCE(o.is_demo, false) IS NOT TRUE
    AND a.status IN ('scheduled', 'live')
    AND a.unlisted IS NOT TRUE
  GROUP BY
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
  HAVING COUNT(a.id) >= 1
  ORDER BY w.name;
$$;

REVOKE ALL ON FUNCTION public.public_offsite_sales() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.public_offsite_sales() TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.public_offsite_sales() IS
  '0409: Off-site warehouse sale list for public home/browse surfaces. '
  'Active warehouses with customer_notice and >=1 listed scheduled/live auction '
  '(non-demo operator).';

COMMIT;
