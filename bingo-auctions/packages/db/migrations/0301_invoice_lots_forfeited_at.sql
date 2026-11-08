-- 0301 — invoice_lots.forfeited_at: a per-LINE forfeit stamp
--
-- Why this exists. On 2026-07-29 the partial-refund display fix labelled each
-- invoice line from refunded_at / picked_up_at alone, so a line with neither
-- stamp read "Ready to collect". Forfeited pickups have neither stamp, so 72
-- bidders would have been told that 151 items they had already lost to the
-- no-show window were still theirs -- and the web receipt printed a shelf
-- location for goods that, in 80 of those 151 cases, had already been relisted
-- to somebody else.
--
-- That was fixed by having both invoice surfaces read the pickup row's status.
-- It works, but it leaves the underlying trap in place: forfeiture is recorded
-- ONLY on the pickup, one level up from the line, while every sibling
-- end-state -- collected, refunded -- is recorded ON the line. Any future
-- surface that reasons from invoice_lots alone, exactly as the original code
-- did, repeats the bug. The shape of the data invites the mistake.
--
-- So: give forfeiture the same per-line stamp its siblings have. After this,
-- "is this line still owed?" is answerable from invoice_lots by itself:
--
--   picked_up_at IS NULL AND refunded_at IS NULL AND forfeited_at IS NULL
--
-- A TRIGGER rather than an edit to auto_mark_pickup_no_show. That cron function
-- is the only writer today, but it is large, and reproducing it to add two
-- lines is exactly the kind of byte-for-byte transcription that has bitten this
-- repo before. A trigger also covers every OTHER path into 'forfeited' --
-- console actions, manual SQL, whatever gets built next -- so the stamp cannot
-- drift from pickups.status the way canceled_at drifted from lots.status.
--
-- Scope: only lines that are still open. A line already collected or refunded
-- keeps its own end-state; forfeiture does not overwrite history.

BEGIN;

ALTER TABLE public.invoice_lots
  ADD COLUMN IF NOT EXISTS forfeited_at TIMESTAMPTZ;

COMMENT ON COLUMN public.invoice_lots.forfeited_at IS
  '0301: the no-show window closed on this line and the bidder lost the item. '
  'Mirrors refunded_at / picked_up_at so "still owed" is answerable from this '
  'row alone. Maintained by trg_stamp_forfeited_lines on pickups; do not set '
  'by hand.';

CREATE INDEX IF NOT EXISTS invoice_lots_forfeited_at_idx
  ON public.invoice_lots (forfeited_at)
  WHERE forfeited_at IS NOT NULL;

CREATE OR REPLACE FUNCTION public.stamp_forfeited_invoice_lines()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  -- Only on the transition INTO forfeited, so a later touch of the pickup row
  -- does not re-stamp lines or move an existing timestamp.
  IF NEW.status = 'forfeited' AND (OLD.status IS DISTINCT FROM 'forfeited') THEN
    UPDATE invoice_lots
       SET forfeited_at = now()
     WHERE invoice_id = NEW.invoice_id
       AND picked_up_at IS NULL   -- already collected: not forfeited
       AND refunded_at IS NULL    -- already refunded: not forfeited
       AND forfeited_at IS NULL;  -- idempotent
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_stamp_forfeited_lines ON public.pickups;
CREATE TRIGGER trg_stamp_forfeited_lines
  AFTER UPDATE OF status ON public.pickups
  FOR EACH ROW
  EXECUTE FUNCTION public.stamp_forfeited_invoice_lines();

COMMENT ON FUNCTION public.stamp_forfeited_invoice_lines() IS
  '0301: mirrors a pickup going to ''forfeited'' onto its still-open '
  'invoice_lots as forfeited_at. Lines already collected or refunded keep '
  'their own end-state.';

-- ---------------------------------------------------------------------------
-- Backfill the pickups that were already forfeited before the trigger existed.
--
-- pickups.updated_at is the closest thing to the moment of forfeiture: the
-- no-show cron sets `status = 'forfeited', updated_at = now()` in one UPDATE.
-- It is approximate for any row touched again afterwards, which is why the
-- column is documented as "when we recorded it", not a legal deadline.
-- ---------------------------------------------------------------------------
UPDATE invoice_lots il
   SET forfeited_at = COALESCE(p.updated_at, now())
  FROM pickups p
 WHERE p.invoice_id = il.invoice_id
   AND p.status = 'forfeited'
   AND il.picked_up_at IS NULL
   AND il.refunded_at IS NULL
   AND il.forfeited_at IS NULL;

COMMIT;
