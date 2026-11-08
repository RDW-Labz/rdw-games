-- 0349 — tell a person relotting a box apart from the system moving a row.
--
-- ── THE OWNER'S CORRECTION ──────────────────────────────────────────────────
-- 2026-09-03, after 0348 shipped: "Count a lot whenever an employee actively
-- creates it and assigns a sticker, regardless of which lotting method they
-- use... Do not exclude every row with relisted_from_lot_id. Some relots
-- involve real employee work and should count. Only exclude automatic relists
-- where the system moves an unsold or unpicked-up item back into an auction
-- without an employee creating the new lot and assigning a sticker."
--
-- He is right and 0348 was too blunt. It excluded every row carrying
-- relisted_from_lot_id, which throws away a picker who walks to a shelf, finds
-- a refunded item, photographs it and puts a fresh sticker on it. That is
-- lotting by any honest definition. 0348 also leaned on source <> 'Wayfair
-- Audit' for the coverage denominator; source is free text staff type, so that
-- rule is withdrawn entirely here rather than kept as a caveat.
--
-- ── WHAT THE SCHEMA COULD AND COULD NOT TELL US ─────────────────────────────
-- Every relist child in this database is minted by one function,
-- relist_lot_into_auction(uuid, uuid). There are two overloads and three kinds
-- of caller:
--
--   3-arg (uuid,uuid,uuid)   field app: lotting/relot.tsx and worklist/[id].tsx
--                            — a person with a scanner, standing at the shelf.
--                            A thin wrapper: it calls the 2-arg form, then
--                            UPDATEs lotted_by_worker from the clocked-in PIN.
--   2-arg (uuid,uuid)        operator-web worklist, the lot detail page and
--                            the Auction Builder carryover — a person at a
--                            desk moving a row; nobody touches the item.
--   2-arg, from pg_cron      auto_relist_unsold_lots(), every 10 minutes.
--
-- So the ONLY thing separating the floor from the desk today is whether
-- lotted_by_worker happens to be set — and that is a coincidence, not a
-- record of intent. resolve_active_worker() returns NULL when nobody is
-- clocked in, so a genuine physical relot with the PIN screen empty is stored
-- byte-for-byte identically to a cron row. The database cannot distinguish
-- them, which is what the owner asked me to check.
--
-- ── WHY NO CRON ROWS EXIST TODAY (AND WHY THAT IS NOT SAFETY) ───────────────
-- auto_relist_unsold_lots() only processes operators with
-- auto_relist_mode = 'auto'. Both operators are 'review' (verified on prod),
-- so the cron has minted zero relists and every relist in the data was started
-- by a person. That makes the backfill below safe. It is also exactly why the
-- marker is worth adding: the day somebody flips that setting to 'auto', the
-- productivity report would start silently crediting cron output to whichever
-- worker was clocked in, and nothing in the schema would notice.
--
-- ── THE MARKER ──────────────────────────────────────────────────────────────
-- lots.relist_origin, set at creation, three values:
--
--   'human_relot'  a person physically relotted it and assigned a sticker
--   'desk_relist'  a person moved the row from a screen; item never handled
--   'system_auto'  the cron did it; no person involved
--
-- Three rather than two because the desk case is real work that simply has
-- nobody to credit — collapsing it into 'system' would state something false
-- about who did it. The report counts everything except 'system_auto'.
--
-- Stamped where the intent is actually known: the 3-arg wrapper knows it was
-- called by the field app, and the cron knows it is the cron. Everything else
-- defaults to 'desk_relist' through a trigger, so the 2-arg function that
-- staff hit on the floor is not modified at all.

BEGIN;

ALTER TABLE public.lots
  ADD COLUMN IF NOT EXISTS relist_origin text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lots_relist_origin_chk') THEN
    ALTER TABLE public.lots
      ADD CONSTRAINT lots_relist_origin_chk
      CHECK (relist_origin IS NULL
             OR relist_origin IN ('human_relot', 'desk_relist', 'system_auto'));
  END IF;
END$$;

COMMENT ON COLUMN public.lots.relist_origin IS
  '0349: who created this relist child. human_relot = a person physically '
  'relotted the item and assigned a sticker (field app, PIN worker present); '
  'desk_relist = a person moved the row from a screen without handling the '
  'item; system_auto = auto_relist_unsold_lots(). NULL on non-relist lots. '
  'Productivity counts everything except system_auto.';

-- ── Backfill ────────────────────────────────────────────────────────────────
-- Safe because the cron has never minted a row for either operator (both have
-- auto_relist_mode = 'review'), so no historical row can be system_auto. The
-- floor/desk split falls out of whether the 3-arg wrapper stamped a worker.
-- Caveat recorded honestly: a physical relot done with nobody clocked in is
-- backfilled as desk_relist, because nothing distinguishes it. From here on
-- the marker is set by the caller and that ambiguity is gone.
UPDATE public.lots
   SET relist_origin = CASE WHEN lotted_by_worker IS NOT NULL THEN 'human_relot'
                            ELSE 'desk_relist' END
 WHERE relisted_from_lot_id IS NOT NULL
   AND relist_origin IS NULL;

-- ── Default for any path that does not declare itself ───────────────────────
-- A trigger rather than a column DEFAULT: the value depends on
-- relisted_from_lot_id, which a DEFAULT expression cannot see. This leaves the
-- 2-arg relist_lot_into_auction — the one the floor hits — untouched.
CREATE OR REPLACE FUNCTION public.lots_default_relist_origin()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.relisted_from_lot_id IS NOT NULL AND NEW.relist_origin IS NULL THEN
    NEW.relist_origin := 'desk_relist';
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS lots_default_relist_origin_trg ON public.lots;
CREATE TRIGGER lots_default_relist_origin_trg
  BEFORE INSERT ON public.lots
  FOR EACH ROW
  WHEN (NEW.relisted_from_lot_id IS NOT NULL)
  EXECUTE FUNCTION public.lots_default_relist_origin();

-- ── The field app's relot is the human one ──────────────────────────────────
-- Same wrapper as before with one extra assignment in the UPDATE it already
-- ran. Note relist_origin is set whether or not a worker resolved: the caller
-- IS the field app, so the item was physically handled even if the PIN screen
-- was empty. That is the ambiguity this migration exists to remove.
CREATE OR REPLACE FUNCTION public.relist_lot_into_auction(
  p_lot_id uuid, p_auction_id uuid, p_lotted_by_worker uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_worker_id  UUID;
  v_new_lot_id UUID;
BEGIN
  v_worker_id := public.resolve_active_worker(p_lotted_by_worker);

  v_new_lot_id := public.relist_lot_into_auction(p_lot_id, p_auction_id);

  IF v_new_lot_id IS NOT NULL THEN
    UPDATE lots
       SET lotted_by_worker = COALESCE(lotted_by_worker, v_worker_id),
           relist_origin    = 'human_relot'
     WHERE id = v_new_lot_id;
  END IF;

  RETURN v_new_lot_id;
END;
$function$;

-- ── The cron marks its own output ───────────────────────────────────────────
-- Everything else in this function is reproduced verbatim from the deployed
-- definition; the only change is capturing the new lot id and stamping it.
CREATE OR REPLACE FUNCTION public.auto_relist_unsold_lots()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_op          RECORD;
  v_lot         RECORD;
  v_auction_id  UUID;
  v_new_lot_id  UUID;
  v_relisted    INT := 0;
  v_failed      INT := 0;
  v_skipped     INT := 0;
  v_flagged     INT := 0;
  v_err_msg     TEXT;
BEGIN
  IF NOT pg_try_advisory_xact_lock(7423940124) THEN
    RETURN jsonb_build_object('skipped', 'lock_held');
  END IF;

  FOR v_op IN
    SELECT id AS operator_id, auto_relist_max_attempts, auto_flag_disposal_at_strikes
    FROM operators
    WHERE auto_relist_enabled = TRUE
      AND auto_relist_max_attempts > 0
      AND auto_relist_mode = 'auto'
  LOOP
    FOR v_lot IN
      SELECT id, warehouse_id, relist_count
      FROM lots
      WHERE operator_id = v_op.operator_id
        AND status = 'unsold'
        AND COALESCE(relist_count, 0) < v_op.auto_relist_max_attempts
        AND deleted_at IS NULL
      ORDER BY closed_at ASC NULLS LAST
      LIMIT 500
    LOOP
      SELECT id INTO v_auction_id
      FROM auctions
      WHERE operator_id = v_op.operator_id
        AND warehouse_id = v_lot.warehouse_id
        AND status IN ('draft', 'scheduled')
        AND ends_at > now()
      ORDER BY CASE WHEN status = 'scheduled' THEN 0 ELSE 1 END, ends_at ASC
      LIMIT 1;

      IF v_auction_id IS NULL THEN
        v_skipped := v_skipped + 1;
        CONTINUE;
      END IF;

      BEGIN
        v_new_lot_id := relist_lot_into_auction(v_lot.id, v_auction_id);
        IF v_new_lot_id IS NOT NULL THEN
          -- 0349: nobody touched this box. Without the stamp it is
          -- indistinguishable from a picker's relot and would be credited to
          -- whoever happened to be clocked in.
          UPDATE lots SET relist_origin = 'system_auto' WHERE id = v_new_lot_id;
          v_relisted := v_relisted + 1;
        ELSE
          v_failed := v_failed + 1;
        END IF;
      EXCEPTION WHEN OTHERS THEN
        v_err_msg := SQLERRM;
        v_failed := v_failed + 1;
        RAISE WARNING 'auto_relist failed for lot %: %', v_lot.id, v_err_msg;
      END;
    END LOOP;

    UPDATE lots
       SET flagged_for_disposal = TRUE,
           flagged_at = now(),
           flagged_reason = 'auto: exceeded auto_flag_disposal_at_strikes ('
                            || v_op.auto_flag_disposal_at_strikes || ')',
           updated_at = now()
     WHERE operator_id = v_op.operator_id
       AND COALESCE(relist_count, 0) >= v_op.auto_flag_disposal_at_strikes
       AND flagged_for_disposal = FALSE
       AND deleted_at IS NULL
       AND status <> 'disposed';
    GET DIAGNOSTICS v_flagged = ROW_COUNT;
  END LOOP;

  RETURN jsonb_build_object(
    'relisted', v_relisted, 'failed', v_failed, 'skipped', v_skipped,
    'flagged_for_disposal', v_flagged, 'at', now()
  );
END;
$function$;

-- Partial index: the report's only new predicate is "not system_auto", and
-- system rows are the rare case worth finding directly.
CREATE INDEX IF NOT EXISTS lots_relist_origin_system_idx
  ON public.lots (operator_id, created_at DESC)
  WHERE relist_origin = 'system_auto';

-- ── The report, under the corrected rule ────────────────────────────────────
-- Two changes from 0348, both walking back things I got wrong:
--
--   1. The relist exclusion narrows from "every row with relisted_from_lot_id"
--      to "relist_origin = 'system_auto'". A person's relot counts, because a
--      person did it.
--   2. The source rule is GONE. Coverage no longer cares what somebody typed
--      into Source of Truck; 'Wayfair Audit' was never a statement about who
--      did the work, and building a permanent report on a free-text field was
--      the wrong instinct.
--
-- relots_30d is added so the composition is visible rather than buried: a
-- picker on 1,051 items where 103 are relots is doing something different from
-- one on 1,054 where 2 are, and a supervisor should be able to see that
-- without asking for a query.

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

CREATE OR REPLACE FUNCTION public.worker_productivity_coverage(
  p_warehouse_id uuid DEFAULT NULL
)
RETURNS TABLE (lots_30d bigint, attributed_30d bigint, attributed_pct numeric)
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
     AND l.relist_origin IS DISTINCT FROM 'system_auto'
     AND l.created_at >= now() - interval '30 days'
     AND (p_warehouse_id IS NULL OR l.warehouse_id = p_warehouse_id);
$function$;

COMMENT ON FUNCTION public.worker_productivity_coverage(uuid) IS
  '0349: share of the last 30 days of employee-creatable lots carrying a PIN '
  'worker. Only system_auto relists are out of the denominator — the 0348 '
  'source-based rule is withdrawn.';

CREATE OR REPLACE FUNCTION public.worker_daily_productivity(
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
GRANT EXECUTE ON FUNCTION public.worker_productivity_coverage(uuid)                   TO authenticated;
GRANT EXECUTE ON FUNCTION public.worker_daily_productivity(date, integer, uuid, text) TO authenticated;

COMMIT;
