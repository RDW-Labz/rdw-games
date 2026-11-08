-- 0347 — today's number, and a printable day-by-day lotting report.
--
-- Owner, 2026-09-03: "would there be a way to add a single day lotting number
-- so we know the productivity for that day? or maybe a printable report that
-- shows each days numbers?"
--
-- 0346 fixed the 7/30-day columns but both are rolling windows, so neither
-- answers "how did we do today" or "which day was slow". A rolling 7-day total
-- also hides the shape of a week: five 80-lot days and two days off read the
-- same as seven 57-lot days.
--
-- ── THE DAY BOUNDARY IS CENTRAL, NOT UTC ────────────────────────────────────
-- This is the whole reason this needs a function rather than a date filter in
-- the app. Harrison is America/Chicago; UTC midnight is 7:00 PM Central in
-- summer. A "today" computed in UTC would roll over mid-shift, so an evening's
-- lotting would land on tomorrow's row and every day would be split in two at
-- the worst possible moment.
--
-- p_tz follows the convention already set by 0225 and 0289 (both take
-- p_tz TEXT DEFAULT 'America/Chicago'), so all the reporting agrees on when a
-- day starts. Dodge City is also Central; if a location ever runs on a
-- different clock the caller can pass its own zone.
--
-- ── SHAPE ───────────────────────────────────────────────────────────────────
-- Returns one row per worker per day, zero-filled from a generate_series cross
-- join. Zero-filled deliberately: a day a picker did not work must render as
-- "0", not as a gap the reader has to interpret, and a page that has to invent
-- missing cells is a page that will get it wrong once.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Today's count on the main productivity table.
--
-- The 1-arg form is dropped rather than left beside a 2-arg one: two overloads
-- differing only by a defaulted trailing parameter make an unqualified call
-- ambiguous. The app calls this with a named p_warehouse_id, which resolves to
-- the new signature with p_tz defaulted, so no caller changes.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.worker_productivity(uuid);

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
  last_lotted           timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT w.id,
         w.display_name,
         w.role::text,
         w.is_active,
         w.warehouse_id,
         wh.name,
         -- Calendar day in the warehouse's own timezone, NOT now() - 24h.
         -- "Today" on a shift board means since this morning, not a rolling
         -- day that quietly includes half of yesterday evening.
         count(l.id) FILTER (
           WHERE (l.created_at AT TIME ZONE p_tz)::date = (now() AT TIME ZONE p_tz)::date
         ),
         count(l.id) FILTER (WHERE l.created_at >= now() - interval '7 days'),
         count(l.id),
         max(l.created_at)
    FROM workers w
    LEFT JOIN warehouses wh ON wh.id = w.warehouse_id
    LEFT JOIN lots l
           ON l.lotted_by_worker = w.id
          AND l.deleted_at IS NULL
          AND l.created_at >= now() - interval '30 days'
          AND (p_warehouse_id IS NULL OR l.warehouse_id = p_warehouse_id)
   WHERE w.operator_id = (SELECT public.current_operator_id())
   GROUP BY w.id, w.display_name, w.role, w.is_active, w.warehouse_id, wh.name
   ORDER BY count(l.id) DESC, w.display_name;
$function$;

COMMENT ON FUNCTION public.worker_productivity(uuid, text) IS
  '0346/0347: per-worker lot counts for today (calendar day in p_tz), 7d and 30d, optionally scoped to one warehouse.';

-- ---------------------------------------------------------------------------
-- 2. The day-by-day grid behind the printable report.
--
-- p_end is the last day shown, so the caller pages backwards by moving it;
-- p_days is how many columns. Fourteen is the page default — two full rota
-- weeks, and it still fits a portrait sheet without shrinking the type.
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
           -- Clamped: a caller asking for 3650 days would build a grid of
           -- every worker times ten years and time the page out.
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
  -- Cross join then LEFT JOIN the counts: every worker gets every column, so
  -- a day off is a printed 0 rather than a missing cell the reader has to
  -- puzzle over.
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
          AND (l.created_at AT TIME ZONE p_tz)::date = d.day
          AND (p_warehouse_id IS NULL OR l.warehouse_id = p_warehouse_id)
   GROUP BY s.id, s.display_name, s.is_active, d.day
   ORDER BY s.display_name, d.day;
$function$;

COMMENT ON FUNCTION public.worker_daily_productivity(date, integer, uuid, text) IS
  '0347: per-worker per-day lot counts over a window ending p_end, zero-filled, days bounded by the warehouse timezone. Backs the printable daily report.';

GRANT EXECUTE ON FUNCTION public.worker_productivity(uuid, text)                            TO authenticated;
GRANT EXECUTE ON FUNCTION public.worker_daily_productivity(date, integer, uuid, text)        TO authenticated;

COMMIT;
