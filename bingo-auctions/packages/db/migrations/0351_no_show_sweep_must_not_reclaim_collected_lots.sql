-- 0351 — a lot the counter handed over must never be swept back into stock.
--
-- ── THE REPORT ──────────────────────────────────────────────────────────────
-- Owner, 2026-09-09, about PNK4997096: "a relisted item that are going to
-- auctions and not being found when the customer wins and comes to pick up".
--
-- That ceiling fan was sold three times and collected once. Generation 2 is
-- listed in a pickup session's collected_lot_ids — the counter recorded handing
-- it to the buyer in August — yet invoice_lots.picked_up_at was never written,
-- so the no-show sweep treated her as absent, reclaimed the item and relisted
-- it. September's buyer was refunded because the fan had been in someone's
-- house for a month.
--
-- ── THE DEFECT ──────────────────────────────────────────────────────────────
-- auto_mark_pickup_no_show() Step 2 routed EVERY lot on a no-show invoice back
-- to 'unsold':
--
--     SELECT il.lot_id FROM invoice_lots il
--     JOIN no_show_invoices nsi ON nsi.invoice_id = il.invoice_id
--
-- No per-lot check of any kind. A customer who collects three of four items on
-- an invoice whose pickup row never gets completed loses all four to the sweep:
-- the three already in their car are relisted and sold to somebody else, who
-- then cannot find them. The owner is right that a forfeit and a refund are
-- different animals — but this was never a forfeit. It was a completed pickup
-- the system failed to notice.
--
-- Measured on prod before the fix: 303 lots on a no-show invoice already
-- carried picked_up_at, and 76 lots present in pickup_sessions.collected_lot_ids
-- sat on a no-show or forfeited invoice — 75 of those are back in the sale
-- cycle right now. 32 lots were forfeited outright despite the counter
-- recording them collected; 27 were relisted, 6 of those refunded to a second
-- customer, 2 of whom were told the item was missing.
--
-- ── WHY TWO SOURCES OF TRUTH ────────────────────────────────────────────────
-- invoice_lots.picked_up_at is the accounting record; pickup_sessions
-- .collected_lot_ids is what the counter actually scanned. They disagree
-- because the write-through from session to invoice line is dropping. That
-- root cause is a separate investigation — this guard makes the sweep honour
-- EITHER signal, so the damage stops regardless of why the first field is
-- empty. A guard that depends on the broken field would be no guard at all.
--
-- ── HOW IT IS APPLIED ───────────────────────────────────────────────────────
-- A surgical single-line patch. auto_mark_pickup_no_show is ~300 lines across
-- four steps that handle notifications, audit rows, refund jobs and forfeit
-- escalation; retyping it to change one CTE invites a silent regression in the
-- other three. The patch aborts if its target is not found exactly once, and
-- no-ops if the guard is already present.
--
-- Verified in a rolled-back transaction before applying: guard present, all
-- four steps intact, and the whole function executed clean.

BEGIN;

-- The sweep now probes collected_lot_ids per candidate lot; without this it is
-- a sequential scan of pickup_sessions for every row considered.
CREATE INDEX IF NOT EXISTS pickup_sessions_collected_lot_ids_gin
  ON public.pickup_sessions USING gin (collected_lot_ids);

DO $do$
DECLARE v_src text; v_new text; v_hits int;
BEGIN
  v_src := pg_get_functiondef('public.auto_mark_pickup_no_show()'::regprocedure);

  IF v_src ILIKE '%collected_lot_ids @> ARRAY[il.lot_id]%' THEN
    RAISE NOTICE '0351: guard already present, nothing to do';
    RETURN;
  END IF;

  SELECT count(*) INTO v_hits FROM regexp_matches(v_src,
    'JOIN no_show_invoices nsi ON nsi\.invoice_id = il\.invoice_id', 'g');
  IF v_hits <> 1 THEN
    RAISE EXCEPTION '0351: expected exactly one patch target, found % — refusing to guess', v_hits;
  END IF;

  v_new := replace(v_src,
    'JOIN no_show_invoices nsi ON nsi.invoice_id = il.invoice_id',
    'JOIN no_show_invoices nsi ON nsi.invoice_id = il.invoice_id'
    || E'\r\n    WHERE il.picked_up_at IS NULL'
    || E'\r\n      AND il.refunded_at  IS NULL'
    || E'\r\n      AND NOT EXISTS (SELECT 1 FROM pickup_sessions ps'
    || E'\r\n                       WHERE ps.collected_lot_ids @> ARRAY[il.lot_id])');

  EXECUTE v_new;
END
$do$;

-- Belt and braces on the accounting mark. This already skipped picked_up_at;
-- it now also skips anything the counter scanned as handed over, so a dropped
-- write-through cannot produce a forfeit against an item that left the site.
CREATE OR REPLACE FUNCTION public.stamp_forfeited_invoice_lines()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status IN ('forfeited', 'no_show')
     AND (OLD.status IS DISTINCT FROM NEW.status) THEN
    UPDATE invoice_lots il
       SET forfeited_at = now()
     WHERE il.invoice_id = NEW.invoice_id
       AND il.picked_up_at IS NULL
       AND il.refunded_at IS NULL
       AND il.forfeited_at IS NULL
       -- 0351: the counter's own record of the hand-off.
       AND NOT EXISTS (SELECT 1 FROM pickup_sessions ps
                        WHERE ps.collected_lot_ids @> ARRAY[il.lot_id]);
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.stamp_forfeited_invoice_lines() IS
  '0166/0351: stamps forfeited_at on unclaimed invoice lines when a pickup flips to no_show/forfeited. Skips lines already picked up, refunded, or recorded collected in pickup_sessions.collected_lot_ids.';

COMMIT;
