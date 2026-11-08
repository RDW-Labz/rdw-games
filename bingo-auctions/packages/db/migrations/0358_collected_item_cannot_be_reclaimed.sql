-- 0358 — a lot the customer carried out cannot become stock again: the write
--        is skipped and recorded, never applied.
--
-- ── WHAT THIS CLOSES ────────────────────────────────────────────────────────
-- The 2026-09-14 audit's primary mechanism was a single write: the no-show
-- sweep's Step 2 moved 'won' lots to 'unsold' for every line on a no-show
-- invoice, including the lines the counter had already stamped picked up.
-- 301 collected lots went back into stock that way in 14 days; 197 were
-- relisted; 82 were promised to a second buyer.
--
-- 0351 fixed the sweep's query. 0355/0356 refuse the relist INSERT at the
-- table. But the reclaim itself — the status change that turns a customer's
-- item back into inventory — is still guarded only inside the one function
-- that was wrong. Two other writers flip every lot on an invoice with no
-- per-lot check at all (payment-followups abandon, grace-expiry), the console
-- forfeit filters in application code, and every backfill migration re-derives
-- the rule by hand. Any of them can be the next 0337.
--
-- This trigger puts the rule where none of them can miss it: a lot with an
-- unrefunded pickup stamp and no later put-away scan cannot move INTO 'unsold'
-- or 'in_inventory' from outside that set. It is the reclaim-side twin of the
-- 0356 relist guard and uses its exact clearances, so the two cannot disagree.
--
-- ── WHAT IS DELIBERATELY ALLOWED ────────────────────────────────────────────
--   * A line refunded (refunded_at) or an invoice refunded as a whole: the
--     customer returned it; it is stock again. 137 such lots on prod.
--   * A lot_location_events row on the lot or any relist descendant later than
--     the stamp (a lot's own birth event does not count): somebody put the box
--     back. 26 such lots on prod. Staff clear this from the floor by scanning
--     the box at Put-away (0354).
--   * Moves between 'unsold' and 'in_inventory' (the worklist pull): already
--     in the set, not a new reclaim.
--   * Moves to 'relisted', 'canceled', 'disposed', 'won': not stock.
--
-- ── SKIP AND RECORD, NOT ABORT ──────────────────────────────────────────────
-- A raised exception here would abort the whole statement that carried the
-- write. For the no-show sweep that is the entire pg_cron tick — Step 1's
-- pickup flips, notifications, audit rows, refund jobs, Step 4 — every 30
-- minutes, until somebody notices a failed job. That trades a silent data bug
-- for a silent outage. So this trigger does what 0351 does inside the sweep,
-- but for every writer: it leaves the collected lot exactly as it was (RETURN
-- NULL skips this row and only this row; the rest of the statement proceeds)
-- and records the attempt as a 'page' row in invariant_violations
-- (check collected_lot_reclaim_refused), which the health-check route emails
-- within minutes and /reports/health lists with the writer's query text.
-- The outcome is the correct one — the customer keeps their item, the other
-- lots on the invoice are handled — and the attempt is loud instead of fatal.
--
-- For an interactive caller the write reports 0 rows affected; the worklist
-- pull already treats that as "refresh and retry". The row on the health page
-- says why.
--
-- Measured on prod before shipping: every one of the 218 collected-lot flips
-- between 08-27 and 09-09 would have been skipped and recorded; 0 flips in
-- the last 24 h; 0 legitimate flips (returns never pass through 'unsold' —
-- the refund route stamps the line and leaves the lot alone).
--
-- Depends on 0357 (invariant_violations). Reverting this migration means
-- removing the trigger lots_collected_item_cannot_be_reclaimed_trg from lots.

BEGIN;

CREATE OR REPLACE FUNCTION public.lots_collected_item_cannot_be_reclaimed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_picked_up_at TIMESTAMPTZ;
  v_code         TEXT;
BEGIN
  -- The most recent hand-off of THIS lot that has not been undone. A lot
  -- normally has one invoice line; latest-wins is the conservative choice.
  WITH RECURSIVE fam AS (
    -- this lot and every relist descendant: every row that has described the
    -- box since the hand-off, so a put-away scan under any of its codes clears
    SELECT NEW.id AS id, 0 AS depth
    UNION ALL
    SELECT c.id, fam.depth + 1
      FROM lots c JOIN fam ON c.relisted_from_lot_id = fam.id
     WHERE fam.depth < 50
  ),
  stamped AS (
    SELECT il.picked_up_at
      FROM invoice_lots il
      JOIN invoices i ON i.id = il.invoice_id
     WHERE il.lot_id = NEW.id
       AND il.picked_up_at IS NOT NULL
       AND il.refunded_at IS NULL
       AND i.status <> 'refunded'
  )
  SELECT s.picked_up_at
    INTO v_picked_up_at
    FROM stamped s
   WHERE NOT EXISTS (
           SELECT 1
             FROM lot_location_events e
             JOIN lots m ON m.id = e.lot_id
            WHERE e.lot_id IN (SELECT id FROM fam)
              AND e.occurred_at > s.picked_up_at
              AND e.occurred_at > m.created_at + interval '5 seconds'
         )
   ORDER BY s.picked_up_at DESC
   LIMIT 1;

  IF v_picked_up_at IS NULL THEN
    RETURN NEW;                      -- never collected, refunded, or put back
  END IF;

  -- display_code is a row function on lots (attribute notation), not a
  -- column, so it is read through the table rather than off NEW.
  SELECT COALESCE(l.display_code, l.lot_code, l.id::text) INTO v_code
    FROM lots l WHERE l.id = NEW.id;

  -- Record the attempt. One row per lot; a repeat bumps refusals and
  -- last_seen_at; a row that had resolved (refund / put-back since) and
  -- recurs is reopened and becomes news again.
  INSERT INTO invariant_violations (check_code, lot_id, operator_id, severity, dedupe_key, details)
  VALUES (
    'collected_lot_reclaim_refused', NEW.id, NEW.operator_id, 'page',
    'collected_lot_reclaim_refused:' || NEW.id::text,
    jsonb_build_object(
      'lot',              v_code,
      'from_status',      OLD.status::text,
      'attempted_status', NEW.status::text,
      'collected_at',     v_picked_up_at,
      'refused_at',       now(),
      'actor',            auth.uid(),
      'writer',           left(current_query(), 300),
      'refusals',         1,
      'action',           'Nothing was changed: the lot stayed ' || OLD.status::text || ' because the customer collected it on '
                          || to_char(v_picked_up_at AT TIME ZONE 'America/Chicago', 'Mon FMDD')
                          || '. If it really is on the shelf, scan it at Put-away and retry. If the customer kept it, refund the line.'
    )
  )
  ON CONFLICT (dedupe_key) DO UPDATE
    SET last_seen_at    = now(),
        details         = EXCLUDED.details
                          || jsonb_build_object('refusals', COALESCE((invariant_violations.details->>'refusals')::int, 0) + 1),
        notified_at     = CASE WHEN invariant_violations.resolved_at IS NOT NULL THEN NULL ELSE invariant_violations.notified_at END,
        acknowledged_at = CASE WHEN invariant_violations.resolved_at IS NOT NULL THEN NULL ELSE invariant_violations.acknowledged_at END,
        acknowledged_by = CASE WHEN invariant_violations.resolved_at IS NOT NULL THEN NULL ELSE invariant_violations.acknowledged_by END,
        resolved_at     = NULL;

  -- Loud in the server log too, then skip this row and let the statement go on.
  RAISE WARNING
    'lot_collected_cannot_be_reclaimed: % was collected by a customer on % and has not been '
    'refunded or put back since; the change to % was skipped and recorded.',
    v_code, to_char(v_picked_up_at AT TIME ZONE 'America/Chicago', 'Mon FMDD'), NEW.status;
  RETURN NULL;
END;
$function$;

COMMENT ON FUNCTION public.lots_collected_item_cannot_be_reclaimed() IS
  '0358: skips (RETURN NULL) any move of a lot INTO unsold / in_inventory when '
  'an invoice line on it carries an unrefunded pickup stamp with no '
  'lot_location_events row on the lot or any relist descendant since (a lot''s '
  'own birth event does not count), and records the attempt in '
  'invariant_violations as collected_lot_reclaim_refused (page). The rest of '
  'the statement proceeds. Reclaim-side twin of the 0356 relist guard; fires '
  'for every writer including service_role and pg_cron.';

DROP TRIGGER IF EXISTS lots_collected_item_cannot_be_reclaimed_trg ON public.lots;
CREATE TRIGGER lots_collected_item_cannot_be_reclaimed_trg
  BEFORE UPDATE OF status ON public.lots
  FOR EACH ROW
  WHEN (NEW.status IN ('unsold', 'in_inventory')
        AND OLD.status NOT IN ('unsold', 'in_inventory'))
  EXECUTE FUNCTION public.lots_collected_item_cannot_be_reclaimed();

COMMIT;
