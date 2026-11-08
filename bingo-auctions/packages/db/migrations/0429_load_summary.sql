-- 0429 — load_summary(load): what one load made, in a single read-only call.
--
-- For the console load detail page (/loads/[id]). Computing this in the page
-- would take ~200 small queries for a large load (BRN ≈ 6,600 lots once
-- backfilled); one function call does it in one statement.
--
-- ── DEFINITIONS (all integer cents) ──────────────────────────────────────────
--   lots           ORIGINAL lots of the load: lots.load_id = the load, not
--                  deleted, whose parent (relisted_from_lot_id) is NULL or
--                  belongs to a different load. A relist copy is never
--                  counted as a lot of its own.
--   lineage        each original plus every relist copy below it
--                  (relisted_from_lot_id chain, not deleted), whatever load_id
--                  the copies carry — relisted copies count through their
--                  original lot.
--   lines          invoice_lots of lineage lots on invoices that were PAID
--                  (paid_at set, status paid / partially_refunded / refunded).
--                  Pending / failed / canceled invoices never count.
--   line value     winning_bid_cents + the line's share of the invoice's
--                  buyer's premium (premium × hammer ÷ invoice subtotal,
--                  rounded). TAX IS NEVER ADDED.
--   refunds        line value of every line refunded (invoice_lots.refunded_at)
--                  or on an invoice refunded as a whole (status 'refunded').
--   gross_cents    Σ line value;  net_revenue_cents = gross − refunds.
--   sold           originals with at least one paid, unrefunded line anywhere
--                  in their lineage;  unsold = lots − sold.
--   profit_cents   net_revenue − loads.purchase_cost_cents; NULL when no cost.
--
-- ── ACCESS ───────────────────────────────────────────────────────────────────
-- SECURITY DEFINER (one fast statement, no per-row RLS), so it checks the
-- caller itself: the load must belong to current_operator_id() and
-- current_operator_role() must be admin or manager. Anything else — including
-- a load that does not exist — raises 42501 'load_summary_forbidden', so the
-- function never confirms another operator's load exists. EXECUTE is revoked
-- from PUBLIC and granted to authenticated (+ service_role).
--
-- Read-only: STABLE, no writes. Locks: CREATE FUNCTION only.
-- Rollback: scripts/prod-rig/0429_ROLLBACK_load_summary.sql

BEGIN;

CREATE OR REPLACE FUNCTION public.load_summary(p_load_id uuid)
RETURNS json
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_load   loads%ROWTYPE;
  v_result json;
BEGIN
  SELECT * INTO v_load FROM loads WHERE id = p_load_id;

  IF v_load.id IS NULL
     OR v_load.operator_id IS DISTINCT FROM current_operator_id()
     OR current_operator_role() IS NULL
     OR current_operator_role()::text NOT IN ('admin', 'manager') THEN
    RAISE EXCEPTION 'load_summary_forbidden' USING ERRCODE = '42501';
  END IF;

  WITH RECURSIVE
  originals AS (
    SELECT l.id
      FROM lots l
      LEFT JOIN lots p ON p.id = l.relisted_from_lot_id
     WHERE l.load_id = p_load_id
       AND l.deleted_at IS NULL
       AND (l.relisted_from_lot_id IS NULL OR p.load_id IS DISTINCT FROM p_load_id)
  ),
  lineage AS (
    SELECT o.id AS root_id, o.id AS lot_id, 0 AS depth FROM originals o
    UNION ALL
    SELECT ln.root_id, c.id, ln.depth + 1
      FROM lots c
      JOIN lineage ln ON c.relisted_from_lot_id = ln.lot_id
     WHERE c.deleted_at IS NULL
       AND ln.depth < 50
  ),
  lines AS (
    SELECT ln.root_id,
           il.winning_bid_cents AS hammer,
           CASE WHEN coalesce(i.subtotal_cents, 0) > 0
                THEN round(coalesce(i.buyer_premium_cents, 0)::numeric
                           * il.winning_bid_cents / i.subtotal_cents)::bigint
                ELSE 0 END AS premium,
           (il.refunded_at IS NOT NULL OR i.status::text = 'refunded') AS refunded,
           il.forfeited_at IS NOT NULL AS forfeited
      FROM lineage ln
      JOIN invoice_lots il ON il.lot_id = ln.lot_id
      JOIN invoices i      ON i.id = il.invoice_id
     WHERE i.paid_at IS NOT NULL
       AND i.status::text IN ('paid', 'partially_refunded', 'refunded')
  ),
  totals AS (
    SELECT
      (SELECT count(*) FROM originals)                                   AS lots,
      (SELECT count(*) FROM lineage WHERE depth > 0)                     AS relist_copies,
      (SELECT count(DISTINCT root_id) FROM lines WHERE NOT refunded)     AS sold,
      (SELECT count(*) FROM lines)                                       AS invoice_lines,
      (SELECT count(*) FROM lines WHERE refunded)                        AS refunded_lines,
      (SELECT count(*) FROM lines WHERE forfeited)                       AS forfeited_lines,
      (SELECT coalesce(sum(hammer), 0) FROM lines)                       AS hammer_cents,
      (SELECT coalesce(sum(premium), 0) FROM lines)                      AS premium_cents,
      (SELECT coalesce(sum(hammer + premium), 0) FROM lines)             AS gross_cents,
      (SELECT coalesce(sum(hammer + premium), 0) FROM lines WHERE refunded) AS refunds_cents
  )
  SELECT json_build_object(
           'load_id',             v_load.id,
           'source_name',         v_load.source_name,
           'type',                v_load.type,
           'purchase_date',       v_load.purchase_date,
           'purchase_cost_cents', v_load.purchase_cost_cents,
           'lots',                t.lots,
           'sold',                t.sold,
           'unsold',              t.lots - t.sold,
           'relist_copies',       t.relist_copies,
           'invoice_lines',       t.invoice_lines,
           'refunded_lines',      t.refunded_lines,
           'forfeited_lines',     t.forfeited_lines,
           'hammer_cents',        t.hammer_cents,
           'premium_cents',       t.premium_cents,
           'gross_cents',         t.gross_cents,
           'refunds_cents',       t.refunds_cents,
           'net_revenue_cents',   t.gross_cents - t.refunds_cents,
           'profit_cents',        CASE WHEN v_load.purchase_cost_cents IS NULL THEN NULL
                                       ELSE t.gross_cents - t.refunds_cents - v_load.purchase_cost_cents END
         )
    INTO v_result
    FROM totals t;

  RETURN v_result;
END;
$function$;

COMMENT ON FUNCTION public.load_summary(uuid) IS
  '0429: one load''s lots / sold / unsold / gross / refunds / net revenue '
  '(tax excluded) / cost / profit. Relist copies count through their original '
  'lot. Admin/manager of the load''s operator only (42501 otherwise). Read-only.';

REVOKE ALL ON FUNCTION public.load_summary(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.load_summary(uuid) TO authenticated, service_role;

COMMIT;
