-- 0420 — worker reports: count unshelved drafts as their own bucket
--
-- WHAT WAS WRONG (prod, 2026-10-13):
--   Tim   — All locations 41, Crandall 36
--   Lane  — All locations 36, Crandall 30
--   11 drafts that day had no warehouse.
--
-- Both staff reports filter on lots.warehouse_id. A draft lotted but not yet
-- put away (pending_intake, no warehouse, bin or auction) counts under "All
-- locations" and under no warehouse, so the warehouse numbers never add up to
-- the All number and a supervisor cannot tell why.
--
-- WHAT THIS DOES:
--   Both functions gain an "unshelved" count: the worker's lots with
--   warehouse_id IS NULL, in the same window, with the same rules as the
--   existing counts. It does NOT depend on p_warehouse_id, so on any location
--   the page can show it beside that location's number — clearly labelled,
--   never folded in. For every worker:
--
--     lots(All) = sum over warehouses of lots(warehouse) + unshelved
--
--   (pinned by packages/db/test/worker_reports_unshelved.sql).
--
--   Every existing column is computed exactly as in 0349. Columns are only
--   APPENDED, so callers that ignore them are unaffected. Appending changes
--   the RETURNS TABLE type, which CREATE OR REPLACE cannot do, hence DROP +
--   CREATE inside one transaction (grants re-issued below).
--
-- LOCKS: functions only. No table DDL; nothing on lots, bids or invoices.
-- ROLLBACK: scripts/prod-rig/0420_ROLLBACK_worker_reports_unshelved.sql
-- (restores the 0349 definitions verbatim).
--
-- worker_productivity_coverage is unchanged: it answers "what share of this
-- location's lots carry a PIN worker", and unshelved drafts belong to no
-- location.

BEGIN;

-- ---------------------------------------------------------------------------
-- worker_productivity — latest definition was 0349. Adds unshelved_today,
-- unshelved_7d, unshelved_30d.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.worker_productivity(uuid, text);

CREATE FUNCTION public.worker_productivity(
  p_warehouse_id uuid DEFAULT NULL,
  p_tz           text DEFAULT 'America/Chicago'
)
RETURNS TABLE (
  worker_id             uuid,
  display_name          text,
  role                  text,
  is_active             boolean,
  assigned_warehouse_id uuid,
  assigned_warehouse    text,
  lots_today            bigint,
  lots_7d               bigint,
  lots_30d              bigint,
  relots_30d            bigint,
  days_worked_30d       bigint,
  per_day_30d           numeric,
  per_hour_30d          numeric,
  last_lotted           timestamptz,
  unshelved_today       bigint,
  unshelved_7d          bigint,
  unshelved_30d         bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH candidate AS (
    SELECT l.lotted_by_worker AS wid,
           l.created_at,
           (l.relisted_from_lot_id IS NOT NULL) AS is_relot,
           (l.created_at AT TIME ZONE p_tz)::date AS day,
           -- in_scope reproduces 0349's warehouse filter exactly.
           (p_warehouse_id IS NULL OR l.warehouse_id = p_warehouse_id) AS in_scope,
           (l.warehouse_id IS NULL) AS unshelved
      FROM lots l
     WHERE l.operator_id = (SELECT public.current_operator_id())
       AND l.deleted_at IS NULL
       AND l.lotted_by_worker IS NOT NULL
       AND l.relist_origin IS DISTINCT FROM 'system_auto'
       AND l.created_at >= now() - interval '30 days'
       AND (p_warehouse_id IS NULL OR l.warehouse_id = p_warehouse_id OR l.warehouse_id IS NULL)
  ),
  lotted AS (
    SELECT * FROM candidate WHERE in_scope
  ),
  totals AS (
    SELECT wid,
           count(*)                                                        AS lots_30d,
           count(*) FILTER (WHERE is_relot)                                AS relots_30d,
           count(*) FILTER (WHERE created_at >= now() - interval '7 days') AS lots_7d,
           count(*) FILTER (WHERE day = (now() AT TIME ZONE p_tz)::date)   AS lots_today,
           count(DISTINCT day)                                             AS days_worked,
           max(created_at)                                                 AS last_lotted
      FROM lotted GROUP BY wid
  ),
  unshelved AS (
    SELECT wid,
           count(*)                                                        AS u_30d,
           count(*) FILTER (WHERE created_at >= now() - interval '7 days') AS u_7d,
           count(*) FILTER (WHERE day = (now() AT TIME ZONE p_tz)::date)   AS u_today
      FROM candidate WHERE unshelved GROUP BY wid
  ),
  per_day AS (
    SELECT wid, day, count(*) AS lots,
           EXTRACT(epoch FROM (max(created_at) - min(created_at))) / 3600.0 AS span_h
      FROM lotted GROUP BY wid, day
  ),
  rate AS (
    SELECT wid, sum(lots) AS lots, sum(span_h) AS hours
      FROM per_day WHERE lots >= 5 GROUP BY wid
  )
  SELECT w.id, w.display_name, w.role::text, w.is_active, w.warehouse_id, wh.name,
         COALESCE(t.lots_today, 0),
         COALESCE(t.lots_7d, 0),
         COALESCE(t.lots_30d, 0),
         COALESCE(t.relots_30d, 0),
         COALESCE(t.days_worked, 0),
         CASE WHEN COALESCE(t.days_worked,0)=0 THEN NULL
              ELSE round(t.lots_30d::numeric / t.days_worked, 1) END,
         CASE WHEN COALESCE(r.hours,0)<=0 THEN NULL
              ELSE round(r.lots::numeric / r.hours, 1) END,
         t.last_lotted,
         COALESCE(u.u_today, 0),
         COALESCE(u.u_7d, 0),
         COALESCE(u.u_30d, 0)
    FROM workers w
    LEFT JOIN warehouses wh ON wh.id = w.warehouse_id
    LEFT JOIN totals    t ON t.wid = w.id
    LEFT JOIN rate      r ON r.wid = w.id
    LEFT JOIN unshelved u ON u.wid = w.id
   WHERE w.operator_id = (SELECT public.current_operator_id())
   ORDER BY COALESCE(t.lots_30d, 0) DESC, w.display_name;
$function$;

COMMENT ON FUNCTION public.worker_productivity(uuid, text) IS
  '0420: per-worker lotting (0349 rules) plus unshelved_* — the worker''s lots '
  'with no warehouse yet, independent of p_warehouse_id. '
  'All = sum(warehouses) + unshelved.';

-- ---------------------------------------------------------------------------
-- worker_daily_productivity — latest definition was 0349. Adds unshelved.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.worker_daily_productivity(date, integer, uuid, text);

CREATE FUNCTION public.worker_daily_productivity(
  p_end date DEFAULT NULL, p_days integer DEFAULT 14,
  p_warehouse_id uuid DEFAULT NULL, p_tz text DEFAULT 'America/Chicago'
)
RETURNS TABLE (
  worker_id    uuid,
  display_name text,
  is_active    boolean,
  day          date,
  lots         bigint,
  unshelved    bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH bounds AS (
    SELECT COALESCE(p_end, (now() AT TIME ZONE p_tz)::date) AS last_day,
           LEAST(GREATEST(p_days, 1), 92) AS n
  ),
  days AS (
    SELECT (b.last_day - offs)::date AS day FROM bounds b, generate_series(0, b.n - 1) AS offs
  ),
  staff AS (
    SELECT w.id, w.display_name, w.is_active FROM workers w
     WHERE w.operator_id = (SELECT public.current_operator_id())
  )
  SELECT s.id, s.display_name, s.is_active, d.day,
         count(l.id) FILTER (WHERE p_warehouse_id IS NULL OR l.warehouse_id = p_warehouse_id),
         count(l.id) FILTER (WHERE l.warehouse_id IS NULL)
    FROM staff s
   CROSS JOIN days d
    LEFT JOIN lots l
           ON l.lotted_by_worker = s.id
          AND l.deleted_at IS NULL
          AND l.relist_origin IS DISTINCT FROM 'system_auto'
          AND (l.created_at AT TIME ZONE p_tz)::date = d.day
          AND (p_warehouse_id IS NULL OR l.warehouse_id = p_warehouse_id OR l.warehouse_id IS NULL)
   GROUP BY s.id, s.display_name, s.is_active, d.day
   ORDER BY s.display_name, d.day;
$function$;

COMMENT ON FUNCTION public.worker_daily_productivity(date, integer, uuid, text) IS
  '0420: per-worker per-day lotting (0349 rules), zero-filled, days bounded by '
  'p_tz, plus unshelved — that worker''s lots with no warehouse yet, '
  'independent of p_warehouse_id. All = sum(warehouses) + unshelved.';

REVOKE EXECUTE ON FUNCTION public.worker_productivity(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.worker_productivity(uuid, text)                      TO authenticated;
REVOKE EXECUTE ON FUNCTION public.worker_daily_productivity(date, integer, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.worker_daily_productivity(date, integer, uuid, text) TO authenticated;

COMMIT;
