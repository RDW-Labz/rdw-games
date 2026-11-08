-- 0452 — Missing Items report: add warehouse_id/warehouse_name so the report
--        can be sorted and grouped per warehouse.
--
-- ── THE ASK ─────────────────────────────────────────────────────────────────
-- Owner, 2026-10-26: Missing Items and Aging Inventory reports should sort by
-- warehouse bin location (aisle, then bay, then shelf — numeric, so "2" comes
-- before "10"), scoped per warehouse, lots with no location last. Same order
-- in CSV and print.
--
-- aging_inventory_report() (0286/0318/0320) already returns bin_code and
-- warehouse_name, so that report's rows can be grouped per warehouse without
-- any SQL change — the sort is done entirely in
-- apps/operator-web/src/lib/location-sort.ts against the array the RPC
-- already returns.
--
-- missing_items_report() (0426) does NOT: it returns a location_code text
-- (the current or last-known bin's code) but nothing to say which warehouse
-- that bin, or the lot itself, belongs to. Without that there is no way to
-- group the report per warehouse client-side. This migration adds
-- `warehouse_id` and `warehouse_name` (from the lot's own warehouse_id —
-- lots.warehouse_id is NOT NULL and ON DELETE RESTRICT, so it is always
-- resolvable) to the function's output. Every other column, and the
-- function's own ORDER BY, is unchanged: the app re-sorts the rows it
-- receives, by location, same as it now does for aging inventory.
--
-- ── WHY A MIGRATION AT ALL ──────────────────────────────────────────────────
-- The report lives behind a SECURITY DEFINER RPC with a fixed RETURNS TABLE
-- shape — RLS can't be loosened to let the app just join warehouses itself,
-- and the output columns can only change in SQL. Postgres also won't let
-- CREATE OR REPLACE FUNCTION change a RETURNS TABLE column list, so this
-- DROPs then CREATEs the function (a catalog-only change — no lock on lots,
-- bins, or warehouses).
--
-- ── LOCKS ───────────────────────────────────────────────────────────────────
-- Function DROP + CREATE only. No table rewrite, no new FK, no lock on an
-- existing table. Still applied in the 05:00–07:00 CT window per Rule 9,
-- since missing_items_report is read by live staff screens.
--
-- Rollback: scripts/prod-rig/0452_ROLLBACK_missing_items_report_warehouse.sql
-- — drops and recreates the function exactly as 0426 left it (no warehouse
-- columns). The app's location-sort code tolerates a `warehouse_name:
-- undefined` row (compareLocation treats it the same as null), so a rollback
-- does not need an app-side change to stay working — only the per-warehouse
-- grouping reverts to "flat" until re-applied.

BEGIN;

DROP FUNCTION IF EXISTS public.missing_items_report(boolean);

CREATE FUNCTION public.missing_items_report(p_include_resolved boolean DEFAULT false)
RETURNS TABLE (
  lot_id              uuid,
  lot_code            text,
  display_code        text,
  title               text,
  photo_url           text,
  lot_status          text,
  warehouse_id        uuid,
  warehouse_name      text,
  location_code       text,
  location_at         timestamptz,
  missing_at          timestamptz,
  source              text,
  reason              text,
  marked_by_name      text,
  state               text,
  last_check_at       timestamptz,
  last_check_outcome  text,
  last_check_note     text,
  last_check_by_name  text,
  check_count         integer
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE
  v_op uuid;
BEGIN
  SELECT ou.operator_id INTO v_op
    FROM operator_users ou WHERE ou.user_id = auth.uid() LIMIT 1;
  IF v_op IS NULL THEN
    RETURN;  -- not staff: empty, never another operator's rows
  END IF;

  RETURN QUERY
  WITH marks AS (
    -- Latest pickup 'missing' outcome per lot, with its note and who decided.
    SELECT DISTINCT ON (o.lot_id)
           o.lot_id, o.created_at AS at, o.note, o.decided_by AS by_user
      FROM pickup_lot_outcomes o
      JOIN lots l ON l.id = o.lot_id
     WHERE o.outcome::text = 'missing'
       AND l.operator_id = v_op
     ORDER BY o.lot_id, o.created_at DESC
  ),
  removals AS (
    SELECT l.id AS lot_id, l.removed_at AS at, l.removal_note AS note, l.removed_by AS by_user
      FROM lots l
     WHERE l.operator_id = v_op
       AND l.removal_kind = 'missing'
       AND l.id NOT IN (SELECT m.lot_id FROM marks m)
  ),
  flagged AS (
    SELECT m.lot_id, m.at, m.note, m.by_user, 'pickup'::text AS source FROM marks m
    UNION ALL
    SELECT r.lot_id, r.at, r.note, r.by_user, 'removal'::text FROM removals r
  ),
  enriched AS (
    SELECT f.*,
           l.lot_code AS l_lot_code, l.display_code AS l_display_code, l.title AS l_title,
           l.photo_urls[1] AS l_photo, l.status::text AS l_status,
           l.removal_kind AS l_removal_kind, l.deleted_at AS l_deleted_at,
           l.warehouse_id AS l_warehouse_id, wh.name AS l_warehouse_name,
           lc.id AS c_id, lc.outcome AS c_outcome, lc.note AS c_note,
           lc.checked_at AS c_at, lc.checked_by AS c_by,
           (SELECT count(*)::int FROM missing_item_checks x WHERE x.lot_id = f.lot_id) AS c_count,
           COALESCE(f.at IS NOT NULL AND missing_item_found_since(f.lot_id, f.at), false) AS found_since,
           -- Last known location: the current shelf, else the last recorded one.
           COALESCE(ib.code, le.code) AS loc_code,
           CASE WHEN ib.code IS NOT NULL THEN l.intake_at ELSE le.occurred_at END AS loc_at
      FROM flagged f
      JOIN lots l ON l.id = f.lot_id
      LEFT JOIN warehouses wh ON wh.id = l.warehouse_id
      LEFT JOIN bins ib ON ib.id = l.intake_bin_id
      LEFT JOIN LATERAL (
        SELECT b.code, e.occurred_at
          FROM lot_location_events e
          JOIN bins b ON b.id = e.bin_id
         WHERE e.lot_id = f.lot_id
         ORDER BY e.occurred_at DESC
         LIMIT 1
      ) le ON true
      LEFT JOIN LATERAL (
        -- Only checks made after the latest mark count: an item found once
        -- and marked missing again is open again.
        SELECT c.* FROM missing_item_checks c
         WHERE c.lot_id = f.lot_id
           AND (f.at IS NULL OR c.checked_at >= f.at)
         ORDER BY c.checked_at DESC
         LIMIT 1
      ) lc ON true
  ),
  stated AS (
    SELECT e.*,
           CASE
             WHEN e.c_outcome = 'disposed' THEN 'disposed'
             WHEN e.l_removal_kind = 'missing' OR e.c_outcome = 'confirmed_missing' THEN 'confirmed_missing'
             WHEN e.l_removal_kind IS NOT NULL THEN 'disposed'
             WHEN e.c_outcome = 'unsellable' THEN 'unsellable'
             WHEN e.found_since THEN 'found'
             ELSE 'open'
           END AS st
      FROM enriched e
     WHERE e.l_deleted_at IS NULL
  )
  SELECT s.lot_id, s.l_lot_code, s.l_display_code, s.l_title, s.l_photo, s.l_status,
         s.l_warehouse_id, s.l_warehouse_name,
         s.loc_code, s.loc_at, s.at, s.source,
         NULLIF(btrim(COALESCE(s.note, '')), ''),
         COALESCE(mb.display_name, mb.email),
         s.st, s.c_at, s.c_outcome, s.c_note,
         COALESCE(cb.display_name, cb.email),
         s.c_count
    FROM stated s
    LEFT JOIN operator_users mb ON mb.user_id = s.by_user AND mb.operator_id = v_op
    LEFT JOIN operator_users cb ON cb.user_id = s.c_by AND cb.operator_id = v_op
   WHERE p_include_resolved OR s.st IN ('open', 'unsellable')
   ORDER BY s.at DESC NULLS LAST;
END;
$function$;

COMMENT ON FUNCTION public.missing_items_report(boolean) IS
  '0426, extended by 0452 with warehouse_id/warehouse_name: Missing Items report rows for the caller''s operator. Unresolved = open or unsellable. App sorts per warehouse then location (apps/operator-web/src/lib/location-sort.ts).';

REVOKE EXECUTE ON FUNCTION public.missing_items_report(boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.missing_items_report(boolean) FROM anon;
GRANT EXECUTE ON FUNCTION public.missing_items_report(boolean) TO authenticated;

COMMIT;
