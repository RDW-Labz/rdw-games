-- DRAFT — owner assigns migration number and copies into packages/db/migrations.
--
-- staff_inventory_counts() — worklist filter-pill totals for field-mobile.
-- Replaces a client-side scan of all operator lots (status/auction_id/flagged).
-- SECURITY INVOKER: lots RLS (lots_staff_read) still applies; the explicit
-- operator_id = current_operator_id() filter mirrors the old client query.
-- Note: the old client count query had no limit, so PostgREST's default max-rows
-- (1000) capped it. On ~37k lots the old pills undercounted; these are exact.
--
-- Pill rules (must match apps/field-mobile/features/lotting/useInventoryList.ts tally):
--   draft          — status = 'draft' AND auction_id IS NULL (unassigned drafts only)
--   pending_intake — status = 'pending_intake' (any auction_id)
--   in_inventory   — status = 'in_inventory' (any auction_id)
--   unsold         — status = 'unsold'
--   flagged        — flagged_for_disposal IS TRUE (in addition to status buckets)
--   forfeited      — status IN ('unsold','relisted') AND exists pickup on invoice
--                    chain with status IN ('no_show','forfeited')
-- All buckets: deleted_at IS NULL on lots; operator scope via RLS only.
--
-- "All" pill total on the client = draft + pending_intake + in_inventory + unsold (not computed here).

BEGIN;

CREATE OR REPLACE FUNCTION public.staff_inventory_counts()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $function$
  WITH status_buckets AS (
    SELECT
      count(*) FILTER (WHERE l.status = 'draft' AND l.auction_id IS NULL)     AS draft,
      count(*) FILTER (WHERE l.status = 'pending_intake')                       AS pending_intake,
      count(*) FILTER (WHERE l.status = 'in_inventory')                       AS in_inventory,
      count(*) FILTER (WHERE l.status = 'unsold')                               AS unsold,
      count(*) FILTER (WHERE l.flagged_for_disposal IS TRUE)                  AS flagged
    FROM public.lots l
    WHERE l.deleted_at IS NULL
      AND l.operator_id = public.current_operator_id()
  ),
  forfeited_bucket AS (
    SELECT count(DISTINCT l.id) AS forfeited
    FROM public.lots l
    INNER JOIN public.invoice_lots il ON il.lot_id = l.id
    INNER JOIN public.invoices inv ON inv.id = il.invoice_id
    INNER JOIN public.pickups p ON p.invoice_id = inv.id
    WHERE l.deleted_at IS NULL
      AND l.operator_id = public.current_operator_id()
      AND l.status IN ('unsold', 'relisted')
      AND p.status IN ('no_show', 'forfeited')
  )
  SELECT jsonb_build_object(
    'draft',          COALESCE(sb.draft, 0),
    'pending_intake', COALESCE(sb.pending_intake, 0),
    'in_inventory',   COALESCE(sb.in_inventory, 0),
    'unsold',         COALESCE(sb.unsold, 0),
    'flagged',        COALESCE(sb.flagged, 0),
    'forfeited',      COALESCE(fb.forfeited, 0)
  )
  FROM status_buckets sb
  CROSS JOIN forfeited_bucket fb;
$function$;

COMMENT ON FUNCTION public.staff_inventory_counts() IS
  'Worklist pill counts for staff inventory list; SECURITY INVOKER so lots RLS applies.';

REVOKE EXECUTE ON FUNCTION public.staff_inventory_counts() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.staff_inventory_counts() FROM anon;
GRANT EXECUTE ON FUNCTION public.staff_inventory_counts() TO authenticated;

COMMIT;
