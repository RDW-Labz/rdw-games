-- 0393 — an item reported missing at the counter is never forfeited.
--
-- ── THE BUG ─────────────────────────────────────────────────────────────────
-- The counter marks a line missing (pickup_lot_outcomes.outcome = 'missing').
-- Its refund is owed, and the outcome sits unresolved until somebody issues
-- it. If the pickup then flips to no_show or forfeited — the nightly sweep, or
-- the console button — stamp_forfeited_invoice_lines() stamps forfeited_at on
-- every line not picked up, refunded or scanned collected. The missing line is
-- none of those, so it is stamped forfeited. The refund form then greys it out
-- and /api/invoices/[id]/refund-items refuses it (lot_forfeited).
--
-- Seen on prod 2026-10-05: a line reported missing at 16:38 CT was forfeited
-- by the 18:00 sweep. On 2026-10-06, 44 missing-reported lines carried
-- forfeited_at; 43 had been refunded anyway, 1 had not.
--
-- Owner's rule: a forfeit and a refund are different. A missing item was never
-- the customer's to forfeit.
--
-- ── THE FIX ─────────────────────────────────────────────────────────────────
-- The 0351 body (identical to prod on 2026-10-06) plus one more skip: a line
-- with a 'missing' outcome on a pickup for the same invoice. Resolved or not:
-- a resolved outcome means the refund went out, which is not a forfeit either.
--
-- The app side (same PR) keeps an already-forfeited missing line refundable,
-- so the one prod line can be refunded once it ships. No data change here.
--
-- Function replace only: no lock on lots, bids, invoices or invoice_lots.
-- Grants unchanged (CREATE OR REPLACE keeps the ACL; RETURNS trigger, so it
-- cannot be called directly). Rollback: scripts/prod-rig/rollback-0393.sql,
-- the exact prod body before this migration.

BEGIN;

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
                        WHERE ps.collected_lot_ids @> ARRAY[il.lot_id])
       -- 0393: reported missing at the counter. A refund is owed, not a forfeit.
       AND NOT EXISTS (SELECT 1 FROM pickup_lot_outcomes o
                         JOIN pickups p ON p.id = o.pickup_id
                        WHERE p.invoice_id = il.invoice_id
                          AND o.lot_id = il.lot_id
                          AND o.outcome = 'missing');
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.stamp_forfeited_invoice_lines() IS
  '0166/0351/0393: stamps forfeited_at on unclaimed invoice lines when a pickup flips to no_show/forfeited. Skips lines already picked up, refunded, recorded collected in pickup_sessions.collected_lot_ids, or reported missing in pickup_lot_outcomes.';

COMMIT;
