-- 0328 — every shelf a lot has ever been on, across its relist lineage.
--
-- Reported through the in-app form 2026-08-18 (Jourdan Parker):
-- "We have so many relisted items not being found in the location it says they
-- are in. It would be nice if it showed us every location it's ever been on."
--
-- ── WHY THE CURRENT LOCATION IS OFTEN WRONG FOR A RELIST ─────────────────────
-- A relist mints a NEW lots row (relisted_from_lot_id → the old one). The box
-- never moved; the record did. So the new row starts with whatever location the
-- relist pipeline gave it, the old row keeps the shelf the box is actually
-- sitting on, and the two disagree. 0311 fixed relocation to follow the live
-- lot, but nothing shows a human the chain — so when the current answer is
-- wrong there is nowhere to look for the right one.
--
-- ── TWO PARTS, BECAUSE THE PAST AND THE FUTURE NEED DIFFERENT ANSWERS ────────
-- FUTURE: lot_location_events records each move as it happens.
-- PAST: there is no history to backfill — nothing has ever recorded a move — so
-- the reader function ALSO derives what today's tables still remember: each
-- lineage row's intake_bin_id, and every bin_assignments row. That is thinner
-- than real history (one entry per row, not per move) but it is what exists,
-- and a partial chain beats "we started logging on the 19th."
--
-- ── WHY TRIGGERS RATHER THAN EDITING THE RPCs ────────────────────────────────
-- Four code paths write intake_bin_id today (batch_intake_lot_to_bin,
-- audit_relocate_lot, intake_lot_to_bin, the relist pipeline) and the next one
-- to be added would not know it owes the log an entry. A trigger on the column
-- cannot be forgotten and cannot disagree with the row it is recording.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The log
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.lot_location_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lot_id      uuid NOT NULL REFERENCES public.lots(id) ON DELETE CASCADE,
  bin_id      uuid REFERENCES public.bins(id) ON DELETE SET NULL,

  -- 'intake' = the lot's own shelf changed. 'staged' = a pickup assignment.
  -- Kept apart because they answer different questions: the first is where the
  -- box lives, the second is where a customer collects it.
  kind        text NOT NULL CHECK (kind IN ('intake', 'staged')),

  -- Who moved it, when known. auth.uid() is NULL for pipeline writes (cron
  -- relists), and that is worth recording as unknown rather than guessing.
  actor_id    uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lot_location_events_lot_idx
  ON public.lot_location_events (lot_id, occurred_at DESC);

COMMENT ON TABLE public.lot_location_events IS
  '0328: append-only log of every shelf/staging move. Written by triggers, not '
  'by the RPCs — four code paths move a lot today and a fifth would not know '
  'to log. Read through lot_location_history(), which merges this with what '
  'lots/bin_assignments still remember from before this table existed.';

ALTER TABLE public.lot_location_events ENABLE ROW LEVEL SECURITY;

-- Operator staff read their own operator's rows. No client writes at all: the
-- triggers run as the table owner, and an append-only log nobody can edit is
-- the only kind worth trusting when the question is "where has this been?"
DROP POLICY IF EXISTS lot_location_events_staff_read ON public.lot_location_events;
CREATE POLICY lot_location_events_staff_read
  ON public.lot_location_events FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.lots l
      WHERE l.id = lot_location_events.lot_id
        AND l.operator_id = (SELECT public.current_operator_id())
    )
  );

-- ---------------------------------------------------------------------------
-- 2. The triggers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.log_lot_intake_move()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- Only real placements. Clearing a bin (bin → NULL) is recorded as a move to
  -- nowhere by design: "it was taken off 7-06-02" is exactly the kind of thing
  -- staff need when the current location is empty.
  IF TG_OP = 'INSERT' THEN
    IF NEW.intake_bin_id IS NULL THEN RETURN NEW; END IF;
  ELSIF NEW.intake_bin_id IS NOT DISTINCT FROM OLD.intake_bin_id THEN
    RETURN NEW;
  END IF;

  INSERT INTO lot_location_events (lot_id, bin_id, kind, actor_id)
  VALUES (NEW.id, NEW.intake_bin_id, 'intake', auth.uid());

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS lots_log_intake_move ON public.lots;
CREATE TRIGGER lots_log_intake_move
  AFTER INSERT OR UPDATE OF intake_bin_id ON public.lots
  FOR EACH ROW EXECUTE FUNCTION public.log_lot_intake_move();

CREATE OR REPLACE FUNCTION public.log_lot_staged_move()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.bin_id IS NOT DISTINCT FROM OLD.bin_id THEN
    RETURN NEW;
  END IF;

  INSERT INTO lot_location_events (lot_id, bin_id, kind, actor_id)
  VALUES (NEW.lot_id, NEW.bin_id, 'staged', auth.uid());

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bin_assignments_log_move ON public.bin_assignments;
CREATE TRIGGER bin_assignments_log_move
  AFTER INSERT OR UPDATE OF bin_id ON public.bin_assignments
  FOR EACH ROW EXECUTE FUNCTION public.log_lot_staged_move();

-- ---------------------------------------------------------------------------
-- 3. The reader
-- ---------------------------------------------------------------------------
-- Walks the relist chain in BOTH directions from the lot in hand — a picker
-- scanning a sticker may land on any generation of it, and "every location it's
-- ever been" means the box's whole life, not this row's.
CREATE OR REPLACE FUNCTION public.lot_location_history(p_lot_id uuid)
RETURNS TABLE (
  lot_id      uuid,
  lot_code    text,
  bin_code    text,
  kind        text,
  occurred_at timestamptz,
  is_current  boolean,
  source      text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
-- The RETURNS TABLE columns (lot_id, lot_code, kind, source, ...) share names
-- with columns of the tables queried below, and plpgsql resolves a bare
-- identifier to the OUT parameter first — which is an ambiguity error inside
-- the CTEs. use_column says "a bare name is a column"; every OUT value is
-- supplied positionally by RETURN QUERY, so nothing here needs to read one.
#variable_conflict use_column
DECLARE
  v_op_id UUID;
BEGIN
  v_op_id := current_operator_id();
  IF v_op_id IS NULL THEN RETURN; END IF;

  RETURN QUERY
  WITH RECURSIVE
  -- Older generations: follow relisted_from_lot_id up.
  ancestors AS (
    SELECT l.id, l.lot_code, l.relisted_from_lot_id, l.intake_bin_id, l.created_at, l.intake_at
    FROM lots l WHERE l.id = p_lot_id AND l.operator_id = v_op_id
    UNION ALL
    SELECT p.id, p.lot_code, p.relisted_from_lot_id, p.intake_bin_id, p.created_at, p.intake_at
    FROM lots p JOIN ancestors a ON p.id = a.relisted_from_lot_id
    WHERE p.operator_id = v_op_id
  ),
  -- Newer generations: follow the same column down.
  descendants AS (
    SELECT l.id, l.lot_code, l.intake_bin_id, l.created_at, l.intake_at
    FROM lots l WHERE l.id = p_lot_id AND l.operator_id = v_op_id
    UNION ALL
    SELECT c.id, c.lot_code, c.intake_bin_id, c.created_at, c.intake_at
    FROM lots c JOIN descendants d ON c.relisted_from_lot_id = d.id
    WHERE c.operator_id = v_op_id
  ),
  lineage AS (
    SELECT DISTINCT u.id, u.lot_code, u.intake_bin_id, u.created_at, u.intake_at
    FROM (
      SELECT a.id, a.lot_code, a.intake_bin_id, a.created_at, a.intake_at FROM ancestors a
      UNION
      SELECT d.id, d.lot_code, d.intake_bin_id, d.created_at, d.intake_at FROM descendants d
    ) u
  ),
  -- Logged moves (0328 onwards).
  logged AS (
    SELECT e.lot_id, lg.lot_code, b.code AS bin_code, e.kind,
           e.occurred_at, 'logged'::text AS source
    FROM lot_location_events e
    JOIN lineage lg ON lg.id = e.lot_id
    LEFT JOIN bins b ON b.id = e.bin_id
  ),
  -- What the rows themselves still remember from before the log existed. Only
  -- surfaced when the log has nothing for that lot, so a move recorded properly
  -- is never shadowed by the weaker derived entry.
  derived_intake AS (
    SELECT lg.id, lg.lot_code, b.code AS bin_code, 'intake'::text AS kind,
           COALESCE(lg.intake_at, lg.created_at) AS occurred_at,
           'derived'::text AS source
    FROM lineage lg
    JOIN bins b ON b.id = lg.intake_bin_id
    WHERE NOT EXISTS (
      SELECT 1 FROM lot_location_events e
      WHERE e.lot_id = lg.id AND e.kind = 'intake'
    )
  ),
  derived_staged AS (
    SELECT lg.id, lg.lot_code, b.code AS bin_code, 'staged'::text AS kind,
           ba.assigned_at AS occurred_at, 'derived'::text AS source
    FROM lineage lg
    JOIN bin_assignments ba ON ba.lot_id = lg.id
    JOIN bins b ON b.id = ba.bin_id
    WHERE NOT EXISTS (
      SELECT 1 FROM lot_location_events e
      WHERE e.lot_id = lg.id AND e.kind = 'staged'
    )
  ),
  merged AS (
    SELECT * FROM logged
    UNION ALL SELECT * FROM derived_intake
    UNION ALL SELECT * FROM derived_staged
  )
  SELECT m.lot_id, m.lot_code, m.bin_code, m.kind, m.occurred_at,
         -- The newest entry is where the system currently believes it is; the
         -- whole point of the list is that the ones below it may be truer.
         ROW_NUMBER() OVER (ORDER BY m.occurred_at DESC) = 1 AS is_current,
         m.source
  FROM merged m
  WHERE m.bin_code IS NOT NULL
  ORDER BY m.occurred_at DESC
  LIMIT 50;
END;
$$;

REVOKE ALL ON FUNCTION public.lot_location_history(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lot_location_history(uuid) TO authenticated;

COMMENT ON FUNCTION public.lot_location_history(uuid) IS
  '0328: every shelf a box has been on, across its whole relist chain (walked '
  'in both directions — a scan can land on any generation). Merges the 0328 '
  'event log with locations still recorded on lots/bin_assignments, the latter '
  'only where the log has nothing, so history predating the log is not lost.';

COMMIT;
