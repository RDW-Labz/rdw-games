-- 0357 — a monitor for the invariant "a lot already handed to a buyer is never
--        reclaimed, relisted, or promised to a second buyer".
--
-- ── WHY A MONITOR WHEN THE GUARDS EXIST ─────────────────────────────────────
-- The 2026-09-14 audit (docs/audits/flagged-items-pickup-forfeit-relist-
-- 2026-09-14.md) found 301 collected lots reclaimed by the no-show sweep over
-- 14 days, 197 of them relisted and 82 promised to a second buyer, before
-- anyone noticed. The guards that now exist were each right and each
-- incomplete for a while: 0351 guarded the sweep but not the relist; 0355
-- guarded the relist but only one generation deep; 0356 walks the lineage.
-- Every one of those gaps was invisible until a customer stood at the counter.
--
-- This migration adds the layer that does not depend on the guards being
-- correct: a pg_cron job that re-derives the invariant from the raw tables
-- every 15 minutes and records every violation it finds. The health-check
-- route (every 5 min) emails the operator about new 'page' rows and the
-- operations-health page lists what is open. Measured on prod before this
-- shipped (two independent runs, identical numbers): the event check fires on
-- 1 lot at 18:00 Central on 08-27, the first day of the wave, versus the 14
-- days it actually took.
--
-- ── THE CHECKS ──────────────────────────────────────────────────────────────
-- A lot is "gone" when an invoice line on it carries picked_up_at, the line is
-- not refunded, the invoice is not refunded, and no lot_location_events row on
-- the lot OR ANY DESCENDANT postdates the stamp (a lot's own birth event does
-- not count — relist children are born with one). That is 0356's predicate,
-- so the monitor and the guard agree on what "collected" means. The customer's
-- pickup-pass tick is the same shape with a weaker signal and is reported at
-- 'watch' severity only: in all 7 cases where a second buyer actually found a
-- "gone" item, the tick was the only signal.
--
--   code                              kind   severity  meaning
--   collected_lot_reclaimed           event  page      a gone lot was moved to unsold / in_inventory / relisted after its stamp
--   collected_lot_reclaim_refused     event  page      (written by the 0358 trigger) a writer tried to move a gone lot to unsold / in_inventory; the row was skipped
--   collected_lineage_relisted        event  page      a relist child was minted under a gone (stamped) ancestor
--   collected_lineage_ticked_relisted event  watch     same, tick-only ancestor
--   second_buyer_promise              state  page      a paid, uncollected, unrefunded line on a descendant of a gone (stamped) lot
--   second_buyer_promise_ticked       state  watch     same, tick-only ancestor
--   ghost_child_relistable            state  watch     a descendant of a gone lot sitting unsold / in_inventory (0356 refuses its relist; listed so someone fixes the row)
--   late_pickup_left_unsold           state  watch     forfeited then collected, lot still unsold with no live child (0356 restores forward; this catches drift)
--   no_show_sweep_stalled             live   page      auto-mark-pickup-no-show has no succeeded run in 90 minutes
--
-- Event checks look back p_event_window (default 7 days; rows dedupe on
-- (check, lot) so a long window costs nothing). State checks are recomputed
-- in full every run and resolve themselves when the condition clears. Event
-- rows resolve when the remediation is visible: the lot is back to 'won', the
-- line is refunded, the box was scanned at Put-away, or the child was canceled.
-- A resolved row that recurs is reopened and becomes news again.
--
-- ── WHAT IS DELIBERATELY EXCLUDED (the false-positive budget) ───────────────
-- Measured on prod 2026-09-14: 137 lots were collected and then refunded (a
-- return at the counter) and 88 of those were correctly relisted, 42 in the
-- last 30 days. A detector without the refund clearance would have raised 42
-- false alerts a month. 26 lots were collected and then scanned back onto a
-- shelf; 21 of those were relisted. Without ignoring the relist child's own
-- birth event, 18 of the 19 ghost children the audit found would have been
-- missed. Every 'page' check measured 0 in the last 24 hours and 0 legitimate
-- cases flagged.
--
-- ── BASELINE ────────────────────────────────────────────────────────────────
-- The first run finds the audit's backlog (88 second-buyer promises, 20
-- ghosts, 3 gone lots relistable, 3 tick-only). Those are known, exported to
-- docs/audits/second-buyer-promises-2026-09-14.csv before this ran, and are
-- the owner's decision. The seed step at the bottom marks everything found on
-- first run as acknowledged and notified so the monitor's first email is about
-- something new, not the backlog it was built after.

BEGIN;

-- ── 1. Storage ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.invariant_violations (
  id              BIGSERIAL PRIMARY KEY,
  check_code      TEXT NOT NULL,
  -- NULL for checks that are not about one lot (sweep liveness).
  lot_id          UUID REFERENCES public.lots(id) ON DELETE CASCADE,
  operator_id     UUID REFERENCES public.operators(id) ON DELETE CASCADE,
  severity        TEXT NOT NULL CHECK (severity IN ('page', 'watch')),
  -- check_code || ':' || lot_id (or '-'). UNIQUE treats NULLs as distinct, so
  -- the key is materialised rather than relying on NULLS NOT DISTINCT.
  dedupe_key      TEXT NOT NULL UNIQUE,
  details         JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at     TIMESTAMPTZ,
  acknowledged_at TIMESTAMPTZ,
  acknowledged_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  notified_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS invariant_violations_open_idx
  ON public.invariant_violations (severity, first_seen_at DESC)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS invariant_violations_lot_idx
  ON public.invariant_violations (lot_id);

ALTER TABLE public.invariant_violations ENABLE ROW LEVEL SECURITY;

-- service_role and the pg_cron owner write; operator admins/managers read
-- their own rows (liveness rows have no operator and are visible to all).
DROP POLICY IF EXISTS invariant_violations_read ON public.invariant_violations;
CREATE POLICY invariant_violations_read ON public.invariant_violations
  FOR SELECT TO authenticated
  USING (
    (operator_id IS NULL OR operator_id = public.current_operator_id())
    AND public.current_operator_role() IN ('admin', 'manager')
  );

COMMENT ON TABLE public.invariant_violations IS
  '0357: one row per (check, lot) where the "collected item never resold" '
  'invariant is broken. Written by check_collected_item_invariants() from '
  'pg_cron; emailed by /api/cron/health-check; listed on /reports/health.';

CREATE TABLE IF NOT EXISTS public.invariant_check_runs (
  id       BIGSERIAL PRIMARY KEY,
  ran_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  summary  JSONB NOT NULL
);
ALTER TABLE public.invariant_check_runs ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.invariant_check_runs IS
  '0357: heartbeat + summary of each check_collected_item_invariants() run. '
  'Pruned to 7 days by the function itself.';

-- ── 2. The shared predicate: which lots are gone ────────────────────────────
-- Mirrors 0356's lots_block_relist_of_collected_item() so the guard and the
-- monitor cannot disagree about what "collected" means. Returns one row per
-- (lot, signal kind) that has NOT been cleared by a refund or a later scan.
CREATE OR REPLACE FUNCTION public.collected_item_gone_lots()
RETURNS TABLE (lot_id UUID, operator_id UUID, kind TEXT, signal_at TIMESTAMPTZ, invoice_id UUID)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH RECURSIVE signals AS (
    -- Hard signal: staff stamped the line.
    SELECT il.lot_id, l.operator_id, 'stamped'::text AS kind, il.picked_up_at AS signal_at, il.invoice_id
      FROM invoice_lots il
      JOIN invoices i ON i.id = il.invoice_id
      JOIN lots l     ON l.id = il.lot_id
     WHERE il.picked_up_at IS NOT NULL
       AND il.refunded_at IS NULL
       AND i.status <> 'refunded'
    UNION ALL
    -- Soft signal: the customer ticked it on their pickup pass and staff never
    -- stamped it. The tick time is not stored; the session's creation is the
    -- earliest it could have happened.
    SELECT il.lot_id, l.operator_id, 'ticked'::text, ps.created_at, il.invoice_id
      FROM invoice_lots il
      JOIN invoices i ON i.id = il.invoice_id
      JOIN lots l     ON l.id = il.lot_id
      JOIN pickup_sessions ps ON ps.collected_lot_ids @> ARRAY[il.lot_id]
     WHERE il.picked_up_at IS NULL
       AND il.refunded_at IS NULL
       AND i.status <> 'refunded'
  ),
  -- The signalled lot and every lot ever minted from it: every row that has
  -- described this physical box since the hand-off.
  fam AS (
    SELECT s.lot_id AS root, s.lot_id AS id, 0 AS depth
      FROM (SELECT DISTINCT lot_id FROM signals) s
    UNION ALL
    SELECT fam.root, c.id, fam.depth + 1
      FROM lots c JOIN fam ON c.relisted_from_lot_id = fam.id
     WHERE fam.depth < 50
  ),
  -- Somebody physically put the box back: a location event on any member
  -- later than the signal. A lot's own birth event (lots_log_intake_move fires
  -- AFTER INSERT with the copied intake_bin_id) does not count.
  cleared AS (
    SELECT DISTINCT s.lot_id, s.kind
      FROM signals s
      JOIN fam f ON f.root = s.lot_id
      JOIN lot_location_events e ON e.lot_id = f.id
      JOIN lots m ON m.id = f.id
     WHERE e.occurred_at > s.signal_at
       AND e.occurred_at > m.created_at + interval '5 seconds'
  )
  SELECT s.lot_id, s.operator_id, s.kind, s.signal_at, s.invoice_id
    FROM signals s
   WHERE NOT EXISTS (SELECT 1 FROM cleared c WHERE c.lot_id = s.lot_id AND c.kind = s.kind);
$function$;

REVOKE ALL ON FUNCTION public.collected_item_gone_lots() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.collected_item_gone_lots() TO service_role;

COMMENT ON FUNCTION public.collected_item_gone_lots() IS
  '0357: every lot a customer carried out (staff stamp, or pickup-pass tick) '
  'that has not since been refunded or scanned back onto a shelf. Same '
  'predicate as the 0356 relist guard; used by the invariant monitor.';

-- ── 3. The monitor ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.check_collected_item_invariants(
  p_event_window INTERVAL DEFAULT interval '7 days'
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_new          INT := 0;
  v_resolved     INT := 0;
  v_reopened     INT := 0;
  v_n            INT := 0;
  v_sweep_exists BOOLEAN := false;
  v_sweep_ok     TIMESTAMPTZ;
  v_summary      JSONB;
BEGIN
  -- Scratch tables. Recreated per call; Postgres invalidates the cached plans
  -- when the relation OID changes, so repeated calls in one session are safe.
  DROP TABLE IF EXISTS pg_temp._iv_gone;
  CREATE TEMP TABLE _iv_gone AS SELECT * FROM public.collected_item_gone_lots();

  DROP TABLE IF EXISTS pg_temp._iv_desc;
  CREATE TEMP TABLE _iv_desc AS
    WITH RECURSIVE d AS (
      SELECT g.lot_id AS root, g.lot_id AS id, 0 AS depth
        FROM (SELECT DISTINCT lot_id FROM _iv_gone) g
      UNION ALL
      SELECT d.root, c.id, d.depth + 1
        FROM lots c JOIN d ON c.relisted_from_lot_id = d.id
       WHERE d.depth < 50
    )
    SELECT * FROM d;

  DROP TABLE IF EXISTS pg_temp._iv_hits;
  CREATE TEMP TABLE _iv_hits (
    check_code TEXT, lot_id UUID, operator_id UUID, severity TEXT, details JSONB
  );

  -- 3a. collected_lot_reclaimed (event, page): a stamped lot moved back toward
  --     stock after the stamp. lot_status_history is written by 0098's trigger
  --     on every status change, so this sees any writer — sweep, console,
  --     backfill, hand edit.
  INSERT INTO _iv_hits
  SELECT DISTINCT ON (h.lot_id)
         'collected_lot_reclaimed', h.lot_id, g.operator_id, 'page',
         jsonb_build_object(
           'lot',          COALESCE(l.display_code, l.lot_code, l.id::text),
           'from_status',  h.from_status,
           'to_status',    h.to_status,
           'changed_at',   h.changed_at,
           'changed_by',   h.changed_by,
           'collected_at', g.signal_at,
           'invoice_id',   g.invoice_id,
           'action',       'Set the lot back to won if the first buyer has it; refund the line if it must be reclaimed.'
         )
    FROM lot_status_history h
    JOIN _iv_gone g ON g.lot_id = h.lot_id AND g.kind = 'stamped'
    JOIN lots l     ON l.id = h.lot_id
   WHERE h.to_status IN ('unsold', 'in_inventory', 'relisted')
     AND h.changed_at > now() - p_event_window
     AND h.changed_at > g.signal_at
   ORDER BY h.lot_id, h.changed_at DESC, h.id DESC;   -- id breaks ties inside one transaction

  -- 3b/3c. collected_lineage_(ticked_)relisted (event): a relist child was
  --        minted under a gone ancestor after the hand-off.
  INSERT INTO _iv_hits
  SELECT DISTINCT ON (c.id)
         CASE g.kind WHEN 'stamped' THEN 'collected_lineage_relisted' ELSE 'collected_lineage_ticked_relisted' END,
         c.id, c.operator_id,
         CASE g.kind WHEN 'stamped' THEN 'page' ELSE 'watch' END,
         jsonb_build_object(
           'lot',           COALESCE(c.display_code, c.lot_code, c.id::text),
           'lot_status',    c.status::text,
           'root_lot_id',   d.root,
           'root_lot',      COALESCE(r.display_code, r.lot_code, r.id::text),
           'root_kind',     g.kind,
           'generations',   d.depth,
           'collected_at',  g.signal_at,
           'relisted_at',   c.created_at,
           'relist_origin', c.relist_origin,
           'action',        CASE g.kind WHEN 'stamped'
                              THEN 'Pull the relisted lot before it sells; the first buyer has the item.'
                              ELSE 'Check the shelf; the customer marked this collected on their pass.' END
         )
    FROM lots c
    JOIN _iv_desc d ON d.id = c.id AND d.depth > 0
    JOIN _iv_gone g ON g.lot_id = d.root
    JOIN lots r     ON r.id = d.root
   WHERE c.created_at > now() - p_event_window
     AND c.created_at > g.signal_at
     AND c.deleted_at IS NULL
   ORDER BY c.id, CASE g.kind WHEN 'stamped' THEN 0 ELSE 1 END, g.signal_at DESC;

  -- 3d/3e. second_buyer_promise(_ticked) (state): a paid, uncollected,
  --        unrefunded, unforfeited line on a descendant of a gone lot. This is
  --        the customer who will find an empty shelf.
  INSERT INTO _iv_hits
  SELECT DISTINCT ON (c.id)
         CASE g.kind WHEN 'stamped' THEN 'second_buyer_promise' ELSE 'second_buyer_promise_ticked' END,
         c.id, c.operator_id,
         CASE g.kind WHEN 'stamped' THEN 'page' ELSE 'watch' END,
         jsonb_build_object(
           'lot',               COALESCE(c.display_code, c.lot_code, c.id::text),
           'root_lot_id',       d.root,
           'root_lot',          COALESCE(r.display_code, r.lot_code, r.id::text),
           'root_kind',         g.kind,
           'generations',       d.depth,
           'collected_at',      g.signal_at,
           'second_invoice_id', i2.id,
           'second_paid_at',    i2.paid_at,
           'pickup_ends_at',    a.pickup_ends_at,
           'price_cents',       il2.winning_bid_cents,
           'action',            CASE g.kind WHEN 'stamped'
                                  THEN 'Refund the second buyer before they drive in, or confirm the shelf first.'
                                  ELSE 'Check the shelf before the second buyer arrives.' END
         )
    FROM _iv_desc d
    JOIN _iv_gone g       ON g.lot_id = d.root
    JOIN lots c           ON c.id = d.id
    JOIN lots r           ON r.id = d.root
    JOIN invoice_lots il2 ON il2.lot_id = d.id
    JOIN invoices i2      ON i2.id = il2.invoice_id
    LEFT JOIN auctions a  ON a.id = i2.auction_id
   WHERE d.depth > 0
     AND il2.picked_up_at IS NULL
     AND il2.refunded_at  IS NULL
     AND il2.forfeited_at IS NULL
     -- partially_refunded: another line on the invoice was refunded; this one is still owed
     AND i2.status IN ('paid', 'partially_refunded')
   ORDER BY c.id, CASE g.kind WHEN 'stamped' THEN 0 ELSE 1 END, g.signal_at DESC;

  -- 3f. ghost_child_relistable (state, watch): a descendant of a gone (stamped)
  --     lot sitting in a relistable status. 0356 refuses the relist, so this is
  --     a row to fix, not a customer at risk.
  INSERT INTO _iv_hits
  SELECT DISTINCT ON (c.id)
         'ghost_child_relistable', c.id, c.operator_id, 'watch',
         jsonb_build_object(
           'lot',          COALESCE(c.display_code, c.lot_code, c.id::text),
           'lot_status',   c.status::text,
           'root_lot_id',  d.root,
           'root_lot',     COALESCE(r.display_code, r.lot_code, r.id::text),
           'generations',  d.depth,
           'collected_at', g.signal_at,
           'action',       'Refund the first buyer''s line or scan the box at Put-away if it is on the shelf; otherwise cancel this lot.'
         )
    FROM _iv_desc d
    JOIN _iv_gone g ON g.lot_id = d.root AND g.kind = 'stamped'
    JOIN lots c     ON c.id = d.id
    JOIN lots r     ON r.id = d.root
   WHERE d.depth > 0
     AND c.status IN ('unsold', 'in_inventory')
     AND c.deleted_at IS NULL
   ORDER BY c.id, g.signal_at DESC;

  -- 3g. late_pickup_left_unsold (state, watch): the sweep forfeited, the
  --     customer collected later, the lot never went back to 'won'. 0356's
  --     restore trigger prevents this going forward; a hit means it is missing.
  INSERT INTO _iv_hits
  SELECT DISTINCT ON (l.id)
         'late_pickup_left_unsold', l.id, l.operator_id, 'watch',
         jsonb_build_object(
           'lot',          COALESCE(l.display_code, l.lot_code, l.id::text),
           'forfeited_at', il.forfeited_at,
           'collected_at', il.picked_up_at,
           'action',       'Set the lot back to won; the rightful buyer collected it.'
         )
    FROM invoice_lots il
    JOIN invoices i ON i.id = il.invoice_id
    JOIN lots l     ON l.id = il.lot_id
   WHERE il.picked_up_at IS NOT NULL
     AND il.forfeited_at IS NOT NULL
     AND il.picked_up_at > il.forfeited_at
     AND il.refunded_at IS NULL
     AND i.status <> 'refunded'
     AND l.status = 'unsold'
     AND NOT EXISTS (
           SELECT 1 FROM lots c
            WHERE c.relisted_from_lot_id = l.id
              AND c.deleted_at IS NULL
              AND c.status NOT IN ('canceled', 'disposed')
         )
   ORDER BY l.id, il.picked_up_at DESC;

  -- 3h. no_show_sweep_stalled (liveness, page): the other way this class of
  --     bug hides is the sweep silently not running. cron.job_run_details is
  --     kept 7 days by cron-history-cleanup. Skipped where pg_cron is absent.
  BEGIN
    SELECT EXISTS (SELECT 1 FROM cron.job j WHERE j.jobname = 'auto-mark-pickup-no-show')
      INTO v_sweep_exists;
    IF v_sweep_exists THEN
      SELECT max(d.start_time) FILTER (WHERE d.status = 'succeeded')
        INTO v_sweep_ok
        FROM cron.job j
        JOIN cron.job_run_details d ON d.jobid = j.jobid
       WHERE j.jobname = 'auto-mark-pickup-no-show';
      IF v_sweep_ok IS NULL OR v_sweep_ok < now() - interval '90 minutes' THEN
        INSERT INTO _iv_hits VALUES (
          'no_show_sweep_stalled', NULL, NULL, 'page',
          jsonb_build_object(
            'last_ok', v_sweep_ok,
            'action',  'Check cron.job_run_details for auto-mark-pickup-no-show; the no-show sweep is not completing.'
          )
        );
      END IF;
    END IF;
  EXCEPTION
    WHEN undefined_table OR invalid_schema_name OR insufficient_privilege THEN
      NULL;  -- no pg_cron here; nothing to check
  END;

  -- 3i. Upsert. Rows that had resolved and are back are counted as reopened
  --     and made news again (notified_at / acknowledged_at cleared).
  SELECT count(*) INTO v_reopened
    FROM _iv_hits h
    JOIN invariant_violations v
      ON v.dedupe_key = h.check_code || ':' || COALESCE(h.lot_id::text, '-')
   WHERE v.resolved_at IS NOT NULL;

  WITH up AS (
    INSERT INTO invariant_violations (check_code, lot_id, operator_id, severity, dedupe_key, details)
    SELECT h.check_code, h.lot_id, h.operator_id, h.severity,
           h.check_code || ':' || COALESCE(h.lot_id::text, '-'),
           h.details
      FROM _iv_hits h
    ON CONFLICT (dedupe_key) DO UPDATE
      SET last_seen_at    = now(),
          details         = EXCLUDED.details,
          severity        = EXCLUDED.severity,
          notified_at     = CASE WHEN invariant_violations.resolved_at IS NOT NULL THEN NULL ELSE invariant_violations.notified_at END,
          acknowledged_at = CASE WHEN invariant_violations.resolved_at IS NOT NULL THEN NULL ELSE invariant_violations.acknowledged_at END,
          acknowledged_by = CASE WHEN invariant_violations.resolved_at IS NOT NULL THEN NULL ELSE invariant_violations.acknowledged_by END,
          resolved_at     = NULL
    RETURNING (xmax = 0) AS is_new
  )
  SELECT count(*) FILTER (WHERE is_new) INTO v_new FROM up;

  -- 3j. Resolution.
  --     State + liveness checks: resolved when no longer in this run's hits.
  WITH r AS (
    UPDATE invariant_violations v
       SET resolved_at = now()
     WHERE v.resolved_at IS NULL
       AND v.check_code IN ('second_buyer_promise', 'second_buyer_promise_ticked',
                            'ghost_child_relistable', 'late_pickup_left_unsold',
                            'no_show_sweep_stalled')
       AND NOT EXISTS (
             SELECT 1 FROM _iv_hits h
              WHERE h.check_code = v.check_code
                AND h.lot_id IS NOT DISTINCT FROM v.lot_id
           )
    RETURNING 1
  ) SELECT count(*) INTO v_resolved FROM r;

  --     collected_lot_reclaimed: resolved when the lot is no longer gone
  --     (refund / put back) or is no longer sitting as stock.
  WITH r AS (
    UPDATE invariant_violations v
       SET resolved_at = now()
      FROM lots l
     WHERE v.resolved_at IS NULL
       AND v.check_code = 'collected_lot_reclaimed'
       AND l.id = v.lot_id
       AND (   l.status NOT IN ('unsold', 'in_inventory', 'relisted')
            OR l.deleted_at IS NOT NULL
            OR NOT EXISTS (SELECT 1 FROM _iv_gone g WHERE g.lot_id = v.lot_id AND g.kind = 'stamped'))
    RETURNING 1
  ) SELECT count(*) INTO v_n FROM r;
  v_resolved := v_resolved + v_n;

  --     collected_lot_reclaim_refused (written by the 0358 trigger): the lot
  --     kept its status, so it resolves only when the lot is no longer gone —
  --     the line was refunded or the box was scanned back onto a shelf.
  WITH r AS (
    UPDATE invariant_violations v
       SET resolved_at = now()
     WHERE v.resolved_at IS NULL
       AND v.check_code = 'collected_lot_reclaim_refused'
       AND NOT EXISTS (SELECT 1 FROM _iv_gone g WHERE g.lot_id = v.lot_id AND g.kind = 'stamped')
    RETURNING 1
  ) SELECT count(*) INTO v_n FROM r;
  v_resolved := v_resolved + v_n;

  --     collected_lineage_(ticked_)relisted: resolved when the child is dead
  --     or the root is no longer gone.
  WITH r AS (
    UPDATE invariant_violations v
       SET resolved_at = now()
      FROM lots c
     WHERE v.resolved_at IS NULL
       AND v.check_code IN ('collected_lineage_relisted', 'collected_lineage_ticked_relisted')
       AND c.id = v.lot_id
       AND (   c.status IN ('canceled', 'disposed')
            OR c.deleted_at IS NOT NULL
            OR NOT EXISTS (
                 SELECT 1 FROM _iv_gone g
                  WHERE g.lot_id = (v.details->>'root_lot_id')::uuid
                    AND g.kind = v.details->>'root_kind'))
    RETURNING 1
  ) SELECT count(*) INTO v_n FROM r;
  v_resolved := v_resolved + v_n;

  -- 3k. Summary + heartbeat.
  SELECT jsonb_build_object(
           'checked_at',       now(),
           'event_window',     p_event_window::text,
           'new',              v_new,
           'reopened',         v_reopened,
           'resolved',         v_resolved,
           'open_page',        count(*) FILTER (WHERE resolved_at IS NULL AND severity = 'page'),
           'open_watch',       count(*) FILTER (WHERE resolved_at IS NULL AND severity = 'watch'),
           'unnotified_page',  count(*) FILTER (WHERE resolved_at IS NULL AND severity = 'page'
                                                  AND notified_at IS NULL AND acknowledged_at IS NULL),
           'by_check',         COALESCE((SELECT jsonb_object_agg(check_code, n)
                                           FROM (SELECT check_code, count(*) AS n
                                                   FROM invariant_violations
                                                  WHERE resolved_at IS NULL
                                                  GROUP BY check_code) x), '{}'::jsonb)
         )
    INTO v_summary
    FROM invariant_violations;

  INSERT INTO invariant_check_runs (summary) VALUES (v_summary);
  DELETE FROM invariant_check_runs WHERE ran_at < now() - interval '7 days';

  RETURN v_summary;
END;
$function$;

REVOKE ALL ON FUNCTION public.check_collected_item_invariants(INTERVAL) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.check_collected_item_invariants(INTERVAL) TO service_role;

COMMENT ON FUNCTION public.check_collected_item_invariants(INTERVAL) IS
  '0357: re-derives the "collected item never resold" invariant from the raw '
  'tables and upserts violations into invariant_violations (dedupe on check + '
  'lot, self-resolving, reopen-on-recurrence). Run by pg_cron every 15 min. '
  'Returns a jsonb summary and writes a heartbeat to invariant_check_runs.';

-- ── 4. Read model for the operations-health page ────────────────────────────
CREATE OR REPLACE FUNCTION public.operator_invariant_summary()
RETURNS json
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_op      UUID;
  v_sweep   TIMESTAMPTZ;
  result    json;
BEGIN
  SELECT ou.operator_id INTO v_op
    FROM public.operator_users ou WHERE ou.user_id = auth.uid();
  IF v_op IS NULL THEN
    RAISE EXCEPTION 'not_operator_staff' USING ERRCODE = '42501';
  END IF;

  BEGIN
    SELECT max(d.start_time) FILTER (WHERE d.status = 'succeeded') INTO v_sweep
      FROM cron.job j JOIN cron.job_run_details d ON d.jobid = j.jobid
     WHERE j.jobname = 'auto-mark-pickup-no-show';
  EXCEPTION WHEN undefined_table OR invalid_schema_name OR insufficient_privilege THEN
    v_sweep := NULL;
  END;

  SELECT json_build_object(
    'generated_at',  now(),
    'last_check_at', (SELECT max(ran_at) FROM invariant_check_runs),
    'sweep_last_ok', v_sweep,
    'open_page',     (SELECT count(*) FROM invariant_violations v
                       WHERE v.resolved_at IS NULL AND v.severity = 'page'
                         AND (v.operator_id IS NULL OR v.operator_id = v_op)),
    'open_watch',    (SELECT count(*) FROM invariant_violations v
                       WHERE v.resolved_at IS NULL AND v.severity = 'watch'
                         AND (v.operator_id IS NULL OR v.operator_id = v_op)),
    'unacknowledged_page', (SELECT count(*) FROM invariant_violations v
                       WHERE v.resolved_at IS NULL AND v.severity = 'page' AND v.acknowledged_at IS NULL
                         AND (v.operator_id IS NULL OR v.operator_id = v_op)),
    'awaiting_email', (SELECT count(*) FROM invariant_violations v
                       WHERE v.resolved_at IS NULL AND v.severity = 'page'
                         AND v.acknowledged_at IS NULL AND v.notified_at IS NULL
                         AND (v.operator_id IS NULL OR v.operator_id = v_op)),
    'resolved_7d',   (SELECT count(*) FROM invariant_violations v
                       WHERE v.resolved_at > now() - interval '7 days'
                         AND (v.operator_id IS NULL OR v.operator_id = v_op)),
    'rows', COALESCE((
      SELECT json_agg(json_build_object(
               'id',              v.id,
               'check_code',      v.check_code,
               'severity',        v.severity,
               'lot',             v.details->>'lot',
               'root_lot',        v.details->>'root_lot',
               'action',          v.details->>'action',
               'first_seen_at',   v.first_seen_at,
               'acknowledged',    v.acknowledged_at IS NOT NULL,
               'notified',        v.notified_at IS NOT NULL
             ) ORDER BY CASE v.severity WHEN 'page' THEN 0 ELSE 1 END,
                        (v.acknowledged_at IS NOT NULL),
                        v.first_seen_at DESC)
        FROM (SELECT * FROM invariant_violations v
               WHERE v.resolved_at IS NULL
                 AND (v.operator_id IS NULL OR v.operator_id = v_op)
               ORDER BY CASE v.severity WHEN 'page' THEN 0 ELSE 1 END,
                        (v.acknowledged_at IS NOT NULL),
                        v.first_seen_at DESC
               LIMIT 40) v
    ), '[]'::json)
  ) INTO result;

  RETURN result;
END;
$function$;

GRANT EXECUTE ON FUNCTION public.operator_invariant_summary() TO authenticated;

COMMENT ON FUNCTION public.operator_invariant_summary() IS
  '0357: counts + the 40 most urgent open invariant_violations rows for the '
  'caller''s operator, for /reports/health. Staff only.';

-- ── 5. Schedule ─────────────────────────────────────────────────────────────
-- Every 15 minutes. The event checks look back 7 days, so a stalled job
-- catches up on its own. The health-check route (5 min) does the emailing.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'check-collected-item-invariants') THEN
    PERFORM cron.unschedule('check-collected-item-invariants');
  END IF;
  PERFORM cron.schedule(
    'check-collected-item-invariants',
    '*/15 * * * *',
    $cron$SELECT public.check_collected_item_invariants()$cron$
  );
END $$;

-- ── 6. Baseline ─────────────────────────────────────────────────────────────
-- First run with a 60-day event window so the audit's whole wave is on
-- record, then acknowledge everything found. The backlog is known (it is the
-- audit and docs/audits/second-buyer-promises-2026-09-14.csv); the monitor's
-- job from here is what happens next.
DO $$
DECLARE v JSONB; v_ack INT;
BEGIN
  v := public.check_collected_item_invariants(interval '60 days');
  UPDATE public.invariant_violations
     SET acknowledged_at = now(), notified_at = now()
   WHERE resolved_at IS NULL AND acknowledged_at IS NULL;
  GET DIAGNOSTICS v_ack = ROW_COUNT;
  RAISE NOTICE '0357 baseline: % — acknowledged % row(s)', v::text, v_ack;
END $$;

COMMIT;
