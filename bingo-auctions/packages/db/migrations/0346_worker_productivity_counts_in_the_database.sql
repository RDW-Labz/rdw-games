-- 0346 — count worker productivity in the database, per location.
--
-- ── THE BUG THE OWNER SPOTTED ───────────────────────────────────────────────
-- Worker Productivity showed 7-day totals HIGHER than 30-day totals for eight
-- of eleven staff. Johnny Tew read 93 lots in 7 days and 49 in 30. Thirty days
-- contains seven, so that is arithmetically impossible and the whole page was
-- suspect.
--
-- Cause: fetchLotsByPinWorker selected raw lot rows and counted them in
-- JavaScript, with no .limit(), no .range() and no ORDER BY. PostgREST returns
-- at most 1000 rows and does not report the truncation. The 7-day window used
-- to fit under that; the 30-day window has not for a long time. So the 30-day
-- column counted an arbitrary 1000 of several thousand rows, and the arbitrary
-- slice was often smaller per-worker than the honest 7-day number.
--
-- Both columns were wrong. Measured against the real data the day this was
-- written:
--
--     Worker             screen 7d / true    screen 30d / true
--     Lane Snow             116 / 280           139 / 1045
--     Cora Keele            123 / 299           125 / 1019
--     Tammy Davidson         83 / 254            75 /  644
--     Johnny Tew             93 / 213            49 /  460
--     Sky Woodell            95 / 206            38 /  453
--
-- The floor staff were being credited with a fraction of their actual work —
-- Lane Snow's month read 139 lots against 1,045 really lotted.
--
-- The page's own banner ("55% of the last 30 days' lots carry a PIN worker …
-- treat these as a floor") was explaining away a truncated query as if it were
-- an attribution gap. It was not; attribution is far better than that.
--
-- ── WHY AGGREGATE IN SQL RATHER THAN PAGE THE FETCH ─────────────────────────
-- Paging in 1000-row chunks (what product-feed.ts does) would fix the numbers
-- but keeps the shape that caused it: pull every row over the wire, count in
-- JS, and stay one forgotten .limit() away from the same bug. This page did
-- that six times over for six different metrics.
--
-- Counting in the database returns one row per worker instead of thousands of
-- lot rows, and it cannot silently truncate — there is nothing to truncate.
-- This is the third instance of the 1000-row cap found this week (the Auction
-- Builder's .limit(50000) guard and its .limit(5000) bucket counts were the
-- others), so the shape is the bug, not the number.
--
-- ── LOCATION ────────────────────────────────────────────────────────────────
-- p_warehouse_id filters the lots counted, so productivity can be read for
-- Harrison alone while Dodge City trains and Springdale waits for stock. NULL
-- means every location, which is today's behaviour.
--
-- Note this filters on where the LOT is, not where the worker is assigned. A
-- worker's assignment (workers.warehouse_id, added by 0293 and until now never
-- populated or read) is returned alongside so the two can be compared — a
-- Harrison-assigned picker showing Dodge City lots is worth seeing, not
-- hiding.

BEGIN;

CREATE OR REPLACE FUNCTION public.worker_productivity(
  p_warehouse_id uuid DEFAULT NULL
)
RETURNS TABLE (
  worker_id             uuid,
  display_name          text,
  role                  text,
  is_active             boolean,
  assigned_warehouse_id uuid,
  assigned_warehouse    text,
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
         -- FILTER rather than a join per window: one pass over the 30-day
         -- slice answers both columns, and 7d is by construction a subset of
         -- 30d, so the impossible ordering cannot come back.
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
   -- LEFT JOIN so a worker who lotted nothing still appears with zeros. A
   -- missing row reads as "no such worker"; a zero reads as "did none", and
   -- for a productivity screen those are very different statements.
   ORDER BY count(l.id) DESC, w.display_name;
$function$;

COMMENT ON FUNCTION public.worker_productivity(uuid) IS
  '0346: per-worker lot counts for 7d/30d, optionally scoped to one warehouse. Aggregated in SQL because the previous JS-side counting silently truncated at PostgREST''s 1000-row cap.';

-- How much of the work is attributed to a PIN worker at all — the number the
-- page''s banner quotes. Same window and same warehouse filter as above, so
-- the banner and the table can never disagree.
CREATE OR REPLACE FUNCTION public.worker_productivity_coverage(
  p_warehouse_id uuid DEFAULT NULL
)
RETURNS TABLE (
  lots_30d          bigint,
  attributed_30d    bigint,
  attributed_pct    numeric
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
     AND l.created_at >= now() - interval '30 days'
     AND (p_warehouse_id IS NULL OR l.warehouse_id = p_warehouse_id);
$function$;

COMMENT ON FUNCTION public.worker_productivity_coverage(uuid) IS
  '0346: share of the last 30 days'' lots carrying a PIN worker, for the Worker Productivity banner.';

GRANT EXECUTE ON FUNCTION public.worker_productivity(uuid)          TO authenticated;
GRANT EXECUTE ON FUNCTION public.worker_productivity_coverage(uuid) TO authenticated;

-- The counting join is lotted_by_worker + created_at, which nothing indexed.
-- Unlike 0343's rejected index this one is used: the planner has no other way
-- to find one worker''s lots inside a date window without scanning all 19,681.
CREATE INDEX IF NOT EXISTS lots_lotted_by_worker_created_idx
  ON public.lots (lotted_by_worker, created_at DESC)
  WHERE deleted_at IS NULL AND lotted_by_worker IS NOT NULL;

-- ── ASSIGNING A WORKER TO A LOCATION ────────────────────────────────────────
-- Owner, 2026-09-03: "I need workers connected to a specific warehouse/
-- location — not just a filter on the productivity dashboard."
--
-- workers.warehouse_id has existed since 0293 and was never usable: no UI
-- wrote it, nothing read it, and all twelve BinGo workers sit at NULL. The
-- column was a placeholder for a job nobody finished. These two changes make
-- it real — list_workers_admin returns it so the manager screen can show it,
-- and set_worker_warehouse writes it.
--
-- NULL keeps meaning "all locations", which is what every worker is today and
-- what an owner or a manager covering both buildings should stay. Assigning is
-- opt-in per person; nobody's access changes until somebody sets a value.

DROP FUNCTION IF EXISTS public.list_workers_admin(uuid);
CREATE FUNCTION public.list_workers_admin(p_operator_id uuid)
RETURNS TABLE(
  id uuid,
  display_name text,
  role operator_user_role,
  is_active boolean,
  locked_until timestamptz,
  created_at timestamptz,
  warehouse_id uuid,
  warehouse_name text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  PERFORM public._require_manager(p_operator_id);
  RETURN QUERY
    SELECT w.id, w.display_name, w.role, w.is_active, w.locked_until, w.created_at,
           w.warehouse_id, wh.name
      FROM public.workers w
      LEFT JOIN public.warehouses wh ON wh.id = w.warehouse_id
     WHERE w.operator_id = p_operator_id
     ORDER BY w.is_active DESC, lower(w.display_name);
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_worker_warehouse(
  p_worker_id    uuid,
  p_warehouse_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_operator uuid;
BEGIN
  SELECT operator_id INTO v_operator FROM public.workers WHERE id = p_worker_id;
  IF v_operator IS NULL THEN
    RAISE EXCEPTION 'worker_not_found' USING ERRCODE = 'P0001';
  END IF;
  PERFORM public._require_manager(v_operator);

  -- A worker can only be posted to a warehouse their own operator owns.
  -- Without this check a manager could park staff at another company's
  -- building by passing its id.
  IF p_warehouse_id IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM public.warehouses wh
        WHERE wh.id = p_warehouse_id AND wh.operator_id = v_operator
     ) THEN
    RAISE EXCEPTION 'warehouse_not_found_for_operator' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.workers
     SET warehouse_id = p_warehouse_id, updated_at = now()
   WHERE id = p_worker_id;
END;
$function$;

COMMENT ON FUNCTION public.set_worker_warehouse(uuid, uuid) IS
  '0346: assign a PIN worker to one location, or NULL for all locations. Manager-only; refuses a warehouse belonging to another operator.';

GRANT EXECUTE ON FUNCTION public.list_workers_admin(uuid)          TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_worker_warehouse(uuid, uuid)  TO authenticated;

COMMIT;
