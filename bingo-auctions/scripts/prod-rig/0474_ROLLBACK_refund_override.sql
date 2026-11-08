-- Rollback for 0474 (manager refund override). Drops the two functions and the
-- two tables. Refunds already recorded stay on their invoices (refunded cents,
-- line refunded_at, credit rows, operator_audit_log 'invoice.refund_override');
-- only the override report table goes. Export it first if it has rows:
--   SELECT * FROM public.refund_overrides;
BEGIN;
SET LOCAL lock_timeout = '3s';
DROP FUNCTION IF EXISTS public.record_refund_override(UUID, UUID, INT, TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.refund_override_settings_set(INT, INT, TEXT);
DROP TABLE IF EXISTS public.refund_overrides;
DROP TABLE IF EXISTS public.refund_override_settings;
COMMIT;
