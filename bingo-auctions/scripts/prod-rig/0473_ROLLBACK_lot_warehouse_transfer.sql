-- Rollback for 0473 (warehouse transfer). Removes the transfer RPC and the
-- guard trigger. Lots already transferred stay where they are (the audit rows
-- in operator_audit_log keep the record). Same lock window as the apply:
-- DROP TRIGGER takes a brief lock on lots, 05:00-07:00 CT.
BEGIN;
SET LOCAL lock_timeout = '3s';
DROP TRIGGER IF EXISTS lots_0473_transfer_guard ON public.lots;
DROP FUNCTION IF EXISTS public.lots_0473_transfer_guard();
DROP FUNCTION IF EXISTS public.transfer_lot_to_bin(UUID, UUID, TEXT, TEXT);
COMMIT;
