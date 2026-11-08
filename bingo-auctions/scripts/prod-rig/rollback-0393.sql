-- Rollback for 0393: restores stamp_forfeited_invoice_lines() to the exact
-- prod body read on 2026-10-06 (pg_get_functiondef via q.sh), i.e. 0351.
-- Grants unchanged (CREATE OR REPLACE keeps the ACL). Function replace only.

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
                        WHERE ps.collected_lot_ids @> ARRAY[il.lot_id]);
  END IF;
  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.stamp_forfeited_invoice_lines() IS
  '0166/0351: stamps forfeited_at on unclaimed invoice lines when a pickup flips to no_show/forfeited. Skips lines already picked up, refunded, or recorded collected in pickup_sessions.collected_lot_ids.';

COMMIT;
