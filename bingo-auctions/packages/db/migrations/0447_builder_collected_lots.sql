-- 0447 — builder_collected_lot_ids(): carry-over candidates whose item a
--        customer already took home, so the Auction Builder can stop
--        offering them.
--
-- WHY (read-only on prod, 2026-10-23)
--
-- Jared's Unpicked-Up list showed 7 items customers had already collected
-- (BRN4361602, PNK4998077, TEA4840777, TEA5009668, TEA5010019, TEA5009661,
-- BRN4361545). Each listed row is a RELIST COPY minted 09-04 to 09-07 from a
-- lot whose line was stamped picked up 08-28 to 09-06, before the 0355/0356
-- guards (09-14). The builder's carry-over buckets filter on lot status and a
-- forfeited pickup only; they never look at the lineage, so the ghost copy is
-- offered, and the 0356 relist guard then refuses it.
-- At Harrison today: 21 such rows (17 in Unsold, 4 in Unpicked-Up), 5 whose
-- own line was picked up and 16 relist copies of a collected item.
--
-- WHAT
--
-- builder_collected_lot_ids(p_warehouse_id) → SETOF uuid: lots of the
-- caller's operator, not deleted, status unsold or relisted, in that
-- warehouse (any warehouse when NULL), where the lot itself or any ancestor
-- (relisted_from_lot_id chain) is in collected_item_gone_lots() — the 0357
-- predicate that mirrors the 0356 relist guard (staff stamp or pickup-pass
-- tick, not cleared by a refund or a later scan back onto a shelf). Same
-- rule as the guard, so the list and the guard cannot disagree.
--
-- Operator staff only (current_operator_id()); returns nothing otherwise.
-- Read-only. Measured: collected_item_gone_lots() for BinGo ~315 ms on prod.
--
-- LOCKS: CREATE OR REPLACE FUNCTION only.
-- ROLLBACK: scripts/prod-rig/0447_ROLLBACK_builder_collected_lots.sql (drops it;
-- the console then shows these items again, as before).

SET lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.builder_collected_lot_ids(p_warehouse_id uuid DEFAULT NULL)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH RECURSIVE me AS (
    SELECT public.current_operator_id() AS op
  ),
  cand AS (
    SELECT l.id
      FROM lots l, me
     WHERE me.op IS NOT NULL
       AND l.operator_id = me.op
       AND l.deleted_at IS NULL
       AND l.status::text IN ('unsold', 'relisted')
       AND (p_warehouse_id IS NULL OR l.warehouse_id = p_warehouse_id)
  ),
  anc AS (
    SELECT c.id AS start, c.id AS id, 0 AS depth FROM cand c
    UNION ALL
    SELECT a.start, l.relisted_from_lot_id, a.depth + 1
      FROM anc a JOIN lots l ON l.id = a.id
     WHERE l.relisted_from_lot_id IS NOT NULL AND a.depth < 50
  ),
  gone AS (
    SELECT g.lot_id FROM collected_item_gone_lots() g, me WHERE g.operator_id = me.op
  )
  SELECT DISTINCT a.start FROM anc a JOIN gone g ON g.lot_id = a.id;
$function$;

COMMENT ON FUNCTION public.builder_collected_lot_ids(uuid) IS
  '0447: Auction Builder carry-over candidates (unsold/relisted) whose item, or an ancestor lot''s, was collected by a customer and not cleared (0357 predicate = the 0356 relist guard). The builder hides them.';

REVOKE ALL ON FUNCTION public.builder_collected_lot_ids(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.builder_collected_lot_ids(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.builder_collected_lot_ids(uuid) TO authenticated, service_role;
