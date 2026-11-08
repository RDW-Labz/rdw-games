-- 0348 — count lotting, not relisting, and stop the banner overstating the gap.
--
-- Owner, 2026-09-03, after asking me to double-check the reports: "yes exclude
-- relists".
--
-- ── WHAT WAS BEING COUNTED THAT SHOULD NOT BE ───────────────────────────────
-- A relist child is a new row in lots carrying relisted_from_lot_id. It is the
-- same physical item going back into a later auction — nobody photographed it,
-- described it, or put a sticker on it a second time. 1,866 of them were
-- created in the last 30 days and 217 carried a lotted_by_worker, so a handful
-- of staff were being credited with work that is not lotting. Unevenly, too:
-- relist credit lands on whoever happened to run the relot screen.
--
-- ── THE BANNER WAS THE BIGGER LIE ───────────────────────────────────────────
-- worker_productivity_coverage divided attributed lots by EVERY lot in the
-- window. That denominator included those 1,866 relists plus a bulk-created
-- batch (source 'Wayfair Audit', 889 rows arriving up to 15 in a single minute
-- from one manager account) that no picker ever touched. So the page told the
-- owner that only ~55-60% of the work was tracked.
--
-- Measured with relists and that batch removed, real coverage of hand-lotting
-- is 93-95% for each of the last three full weeks. The floor staff were being
-- told their tracking was half-broken when it is nearly complete.
--
-- This migration removes the relists from the denominator, which is the part
-- that can be identified structurally. The bulk batch cannot: `source` is a
-- free-text field staff type, so there is no honest predicate for "was this
-- created one item at a time". The remaining gap is named in the page's banner
-- instead of silently deflating the number.
--
-- ── NEW COLUMNS: THE ONES THAT ACTUALLY RANK PEOPLE ─────────────────────────
-- A 30-day total mostly measures attendance. Two pickers on 650 lots are not
-- equally productive if one did it in 14 days and the other in 19. So:
--
--   days_worked_30d  distinct days with at least one lot
--   per_day_30d      lots / days worked
--   per_hour_30d     lots / hours on task
--
-- Hours on task is the span from a worker's first lot of the day to their
-- last, summed over days. Breaks and non-lotting jobs sit INSIDE that span, so
-- the rate is a floor, never flattering. It is the fairest of the three
-- because it does not punish somebody for a short shift: on the real data it
-- moves Sky Woodell from 8th on raw volume to 2nd on rate, and it is the only
-- measure that separates a slow day from a short one.
--
-- Days with fewer than 5 lots are excluded from the RATE only (they still
-- count in every total). One lot at 9am and one at 4pm is not 0.3 lots/hour —
-- it is somebody who spent the day doing something else, and letting that
-- through would make the column meaningless for anyone with mixed duties.

BEGIN;

-- Dropped, not replaced: the RETURNS TABLE gains three columns, and Postgres
-- refuses CREATE OR REPLACE when the result shape changes. The signature is
-- unchanged, so the two callers keep working across the swap.
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
           (l.created_at AT TIME ZONE p_tz)::date AS day
      FROM lots l
     WHERE l.operator_id = (SELECT public.current_operator_id())
       AND l.deleted_at IS NULL
       AND l.lotted_by_worker IS NOT NULL
       -- 0348: a relist child is the same item going back out, not new work.
       AND l.relisted_from_lot_id IS NULL
       AND l.created_at >= now() - interval '30 days'
       AND (p_warehouse_id IS NULL OR l.warehouse_id = p_warehouse_id)
  ),
  totals AS (
    SELECT wid,
           count(*)                                                       AS lots_30d,
           count(*) FILTER (WHERE created_at >= now() - interval '7 days') AS lots_7d,
           count(*) FILTER (
             WHERE day = (now() AT TIME ZONE p_tz)::date
           )                                                              AS lots_today,
           count(DISTINCT day)                                            AS days_worked,
           max(created_at)                                                AS last_lotted
      FROM lotted
     GROUP BY wid
  ),
  per_day AS (
    SELECT wid, day,
           count(*) AS lots,
           EXTRACT(epoch FROM (max(created_at) - min(created_at))) / 3600.0 AS span_h
      FROM lotted
     GROUP BY wid, day
  ),
  rate AS (
    -- Fewer than 5 lots in a day says nothing about pace; see header.
    SELECT wid, sum(lots) AS lots, sum(span_h) AS hours
      FROM per_day
     WHERE lots >= 5
     GROUP BY wid
  )
  SELECT w.id,
         w.display_name,
         w.role::text,
         w.is_active,
         w.warehouse_id,
         wh.name,
         COALESCE(t.lots_today, 0),
         COALESCE(t.lots_7d, 0),
         COALESCE(t.lots_30d, 0),
         COALESCE(t.days_worked, 0),
         CASE WHEN COALESCE(t.days_worked, 0) = 0 THEN NULL
              ELSE round(t.lots_30d::numeric / t.days_worked, 1) END,
         CASE WHEN COALESCE(r.hours, 0) <= 0 THEN NULL
              ELSE round(r.lots::numeric / r.hours, 1) END,
         t.last_lotted
    FROM workers w
    LEFT JOIN warehouses wh ON wh.id = w.warehouse_id
    LEFT JOIN totals t ON t.wid = w.id
    LEFT JOIN rate   r ON r.wid = w.id
   WHERE w.operator_id = (SELECT public.current_operator_id())
   -- LEFT JOINs so a worker who lotted nothing still appears with zeros. A
   -- missing row reads as "no such worker"; a zero reads as "did none".
   ORDER BY COALESCE(t.lots_30d, 0) DESC, w.display_name;
$function$;

COMMENT ON FUNCTION public.worker_productivity(uuid, text) IS
  '0346/0347/0348: per-worker lotting for today, 7d and 30d, plus days worked, '
  'lots per day and lots per hour on task. Relist children are excluded — they '
  'are the same item going back out, not new lotting work.';

-- ---------------------------------------------------------------------------
-- Coverage: same window, same exclusion, so the banner and the table agree.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.worker_productivity_coverage(
  p_warehouse_id uuid DEFAULT NULL
)
RETURNS TABLE (
  lots_30d       bigint,
  attributed_30d bigint,
  attributed_pct numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT count(*),
         count(*) FILTER (WHERE l.lotted_by_worker IS NOT NULL),
         CASE WHEN count(*) = 0 THEN 0
              ELSE round(100.0 * count(*) FILTER (WHERE l.lotted_by_worker IS NOT NULL) / count(*), 1)
         END
    FROM lots l
   WHERE l.operator_id = (SELECT public.current_operator_id())
     AND l.deleted_at IS NULL
     AND l.relisted_from_lot_id IS NULL
     AND l.created_at >= now() - interval '30 days'
     AND (p_warehouse_id IS NULL OR l.warehouse_id = p_warehouse_id);
$function$;

COMMENT ON FUNCTION public.worker_productivity_coverage(uuid) IS
  '0346/0348: share of the last 30 days'' HAND-LOTTED lots carrying a PIN worker. '
  'Relist children are out of the denominator; they inflated the untracked share.';

-- ---------------------------------------------------------------------------
-- The printable day-by-day grid counts the same thing as the table above it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.worker_daily_productivity(
  p_end          date DEFAULT NULL,
  p_days         integer DEFAULT 14,
  p_warehouse_id uuid DEFAULT NULL,
  p_tz           text DEFAULT 'America/Chicago'
)
RETURNS TABLE (
  worker_id    uuid,
  display_name text,
  is_active    boolean,
  day          date,
  lots         bigint
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
    SELECT (b.last_day - offs)::date AS day
      FROM bounds b, generate_series(0, b.n - 1) AS offs
  ),
  staff AS (
    SELECT w.id, w.display_name, w.is_active
      FROM workers w
     WHERE w.operator_id = (SELECT public.current_operator_id())
  )
  SELECT s.id,
         s.display_name,
         s.is_active,
         d.day,
         count(l.id)
    FROM staff s
   CROSS JOIN days d
    LEFT JOIN lots l
           ON l.lotted_by_worker = s.id
          AND l.deleted_at IS NULL
          AND l.relisted_from_lot_id IS NULL      -- 0348
          AND (l.created_at AT TIME ZONE p_tz)::date = d.day
          AND (p_warehouse_id IS NULL OR l.warehouse_id = p_warehouse_id)
   GROUP BY s.id, s.display_name, s.is_active, d.day
   ORDER BY s.display_name, d.day;
$function$;

COMMENT ON FUNCTION public.worker_daily_productivity(date, integer, uuid, text) IS
  '0347/0348: per-worker per-day lotting over a window ending p_end, zero-filled, '
  'days bounded by p_tz. Relist children excluded, matching worker_productivity.';

GRANT EXECUTE ON FUNCTION public.worker_productivity(uuid, text)                     TO authenticated;
GRANT EXECUTE ON FUNCTION public.worker_productivity_coverage(uuid)                  TO authenticated;
GRANT EXECUTE ON FUNCTION public.worker_daily_productivity(date, integer, uuid, text) TO authenticated;

COMMIT;
