-- Rollback for 0420_worker_reports_unshelved.sql — standby only.
-- Restores the 0349 definitions of worker_productivity and
-- worker_daily_productivity verbatim (drops the unshelved columns). The pages
-- read the unshelved fields as optional (missing = 0, column hidden), so
-- operator-web does not need to roll back with this.
-- Functions only; no locks on lots, bids or invoices.

BEGIN;

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
  last_lotted           timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH lotted AS (
    SELECT l.lotted_by_worker AS wid,
           l.created_at,
           (l.relisted_from_lot_id IS NOT NULL) AS is_relot,
           (l.created_at AT TIME ZONE p_tz)::date AS day
      FROM lots l
     WHERE l.operator_id = (SELECT public.current_operator_id())
       AND l.deleted_at IS NULL
       AND l.lotted_by_worker IS NOT NULL
       -- 0349: only the cron's own output is excluded.
       AND l.relist_origin IS DISTINCT FROM 'system_auto'
       AND l.created_at >= now() - interval '30 days'
       AND (p_warehouse_id IS NULL OR l.warehouse_id = p_warehouse_id)
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
         t.last_lotted
    FROM workers w
    LEFT JOIN warehouses wh ON wh.id = w.warehouse_id
    LEFT JOIN totals t ON t.wid = w.id
    LEFT JOIN rate   r ON r.wid = w.id
   WHERE w.operator_id = (SELECT public.current_operator_id())
   ORDER BY COALESCE(t.lots_30d, 0) DESC, w.display_name;
$function$;

COMMENT ON FUNCTION public.worker_productivity(uuid, text) IS
  '0349: per-worker lotting — every lot an employee created, by any method, '
  'including relots they physically performed. Only relist_origin=system_auto '
  'is excluded. No rule on the free-text source field.';

DROP FUNCTION IF EXISTS public.worker_daily_productivity(date, integer, uuid, text);

CREATE FUNCTION public.worker_daily_productivity(
  p_end date DEFAULT NULL, p_days integer DEFAULT 14,
  p_warehouse_id uuid DEFAULT NULL, p_tz text DEFAULT 'America/Chicago'
)
RETURNS TABLE (worker_id uuid, display_name text, is_active boolean, day date, lots bigint)
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
  SELECT s.id, s.display_name, s.is_active, d.day, count(l.id)
    FROM staff s
   CROSS JOIN days d
    LEFT JOIN lots l
           ON l.lotted_by_worker = s.id
          AND l.deleted_at IS NULL
          AND l.relist_origin IS DISTINCT FROM 'system_auto'
          AND (l.created_at AT TIME ZONE p_tz)::date = d.day
          AND (p_warehouse_id IS NULL OR l.warehouse_id = p_warehouse_id)
   GROUP BY s.id, s.display_name, s.is_active, d.day
   ORDER BY s.display_name, d.day;
$function$;

COMMENT ON FUNCTION public.worker_daily_productivity(date, integer, uuid, text) IS
  '0349: per-worker per-day lotting, zero-filled, days bounded by p_tz. '
  'Matches worker_productivity — only system_auto relists excluded.';

GRANT EXECUTE ON FUNCTION public.worker_productivity(uuid, text)                      TO authenticated;
GRANT EXECUTE ON FUNCTION public.worker_daily_productivity(date, integer, uuid, text) TO authenticated;

COMMIT;
