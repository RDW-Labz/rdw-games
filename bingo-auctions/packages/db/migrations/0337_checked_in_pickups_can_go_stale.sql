-- 0337 — a customer who checked in but never took everything is never swept.
--
-- Owner policy, stated 2026-08-27: "items that do not get picked up are
-- forfeited not refunded, and can go back to inventory to be listed on an
-- auction." That is exactly what auto_mark_pickup_no_show() and the console's
-- forfeit action already do. Neither ever ran on these visits.
--
-- auto_mark_pickup_no_show() selects `WHERE p.status IN ('pending',
-- 'scheduled')`. A visit that reaches 'checked_in' -- the customer stood at the
-- counter and took SOME of it -- leaves that set permanently. Nothing else
-- closes it. So it sits open forever, holding its uncollected lots out of
-- inventory, and the counter keeps listing them.
--
-- In prod: 29 checked_in visits past their window (26 over a week, oldest
-- 2026-07-13), 31 still-open lines, 31 lots stuck at 'won'. Meanwhile every
-- 'pending' pickup is inside its window -- the sweep works fine; it just never
-- saw these.
--
-- Three parts:
--   1. The sweep also considers 'checked_in'.
--   2. no_show stamps lines, like forfeited already does.
--   3. Backfill the 29.

BEGIN;

-- 1. Widen the sweep's status filter.
--
-- Done as an exact substitution on the LIVE definition rather than by
-- re-declaring an 11 KB function. 0301's author refused to retype this one for
-- the same reason: "reproducing it to add two lines is exactly the kind of
-- byte-for-byte transcription that has bitten this repo before." The anchor is
-- asserted first, so a drifted definition fails loudly instead of silently
-- doing nothing.
DO $do$
DECLARE
  def text;
  anchor CONSTANT text := $q$WHERE p.status IN ('pending', 'scheduled')$q$;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'auto_mark_pickup_no_show';

  IF def IS NULL THEN
    RAISE EXCEPTION '0337: auto_mark_pickup_no_show() not found';
  END IF;
  IF (SELECT count(*) FROM regexp_matches(def, $q$WHERE p\.status IN \('pending', 'scheduled'\)$q$, 'g')) <> 1 THEN
    RAISE EXCEPTION '0337: expected exactly one status filter to widen, definition has drifted';
  END IF;

  def := replace(def, anchor, $q$WHERE p.status IN ('pending', 'scheduled', 'checked_in')$q$);
  EXECUTE def;
END
$do$;

-- 2. A no-show ends the obligation on the line, same as a forfeit.
--
-- The 0301 trigger stamps invoice_lots.forfeited_at only on the transition to
-- 'forfeited'. The sweep sets 'no_show', so its own outcome never stamped the
-- lines -- and "is this line still owed?" is now answered from invoice_lots
-- alone by the counter screen. Both end states must stamp or the sweep quietly
-- leaves items looking collectable.
CREATE OR REPLACE FUNCTION public.stamp_forfeited_invoice_lines()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status IN ('forfeited', 'no_show')
     AND (OLD.status IS DISTINCT FROM NEW.status) THEN
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

COMMENT ON FUNCTION public.stamp_forfeited_invoice_lines() IS
  '0301/0337: mirrors a pickup reaching ''forfeited'' OR ''no_show'' onto its '
  'still-open invoice_lots as forfeited_at. Lines already collected or '
  'refunded keep their own end-state.';

-- 3. Backfill the stale visits.
--
-- 'forfeited' rather than 'no_show': the customer did show, and it is the
-- status the console has used 298 times against no_show's 1. The trigger above
-- stamps the lines. Lots are then returned to inventory exactly as
-- setPickupStatus does -- won -> unsold, which is what the auto-relist cron
-- (0097/0146) collects.
CREATE TEMP TABLE _stale_pickups ON COMMIT DROP AS
SELECT p.id AS pickup_id, i.id AS invoice_id
  FROM pickups p
  JOIN invoices i ON i.id = p.invoice_id
  JOIN auctions a ON a.id = i.auction_id
  JOIN operators o ON o.id = i.operator_id
 WHERE p.status = 'checked_in'
   AND a.pickup_ends_at
       + (COALESCE(o.pickup_grace_extension_hours, 24) * INTERVAL '1 hour') < now();

UPDATE pickups SET status = 'forfeited'
 WHERE id IN (SELECT pickup_id FROM _stale_pickups);

-- Only lots the bidder still owed (the trigger just stamped exactly those),
-- and only from 'won' so a lot already relisted or disposed is not clobbered.
UPDATE lots
   SET status = 'unsold'
 WHERE status = 'won'
   AND id IN (
     SELECT il.lot_id
       FROM invoice_lots il
       JOIN _stale_pickups sp ON sp.invoice_id = il.invoice_id
      WHERE il.picked_up_at IS NULL
        AND il.refunded_at IS NULL
   );

COMMIT;
