-- Rollback for 0475. Removes the refund trigger and relist_refunded_lot.
--
-- The enum value 'refunded' CANNOT be dropped (Postgres has no DROP VALUE).
-- It stays, unused once the trigger is gone. Lots the trigger already moved
-- to 'refunded' are listed by the first statement; put them back to 'won'
-- (their pre-0475 state) only with the owner's go, by running the commented
-- UPDATE below. That UPDATE changes lot rows, so it is not run by default.
-- It also puts lots_bidder_read_published back to its pre-0475 form (no
-- 'refunded'): bidders then cannot read a lot left in 'refunded'.
-- DROP TRIGGER takes a brief lock on invoice_lots and DROP/CREATE POLICY a
-- brief ACCESS EXCLUSIVE on lots: 05:00-07:00 CT.
BEGIN;
SET LOCAL lock_timeout = '3s';
DROP TRIGGER IF EXISTS invoice_lots_0475_refund_to_refunded ON public.invoice_lots;
DROP FUNCTION IF EXISTS public.invoice_lots_0475_refund_to_refunded();
DROP FUNCTION IF EXISTS public.relist_refunded_lot(UUID, UUID, TEXT, TEXT, TEXT, UUID);

DROP POLICY IF EXISTS lots_bidder_read_published ON public.lots;
CREATE POLICY lots_bidder_read_published ON public.lots
  FOR SELECT
  USING (
    (SELECT is_bidder())
    AND status IN ('scheduled', 'live', 'won', 'unsold', 'relisted')
    AND (
      early_access_until IS NULL
      OR early_access_until <= now()
      OR is_subscriber(operator_id)
    )
    AND (
      NOT EXISTS (
        SELECT 1 FROM operators o
        WHERE o.id = lots.operator_id
          AND o.is_demo
      )
      OR EXISTS (
        SELECT 1 FROM bidders b
        WHERE b.id = (SELECT auth.uid())
          AND b.is_reviewer
      )
    )
  );
COMMIT;

-- Lots currently in 'refunded' (read-only):
SELECT id, lot_code, status, updated_at FROM public.lots WHERE status::text = 'refunded' ORDER BY updated_at;

-- Owner's go only:
-- BEGIN;
-- SELECT public.assert_no_physical_footprint(ARRAY(SELECT id FROM public.lots WHERE status::text = 'refunded'));
-- UPDATE public.lots SET status = 'won' WHERE status::text = 'refunded';
-- COMMIT;
