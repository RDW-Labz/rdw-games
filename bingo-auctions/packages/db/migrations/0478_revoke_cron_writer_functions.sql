-- 0478 — cron/service-only writer functions: no PUBLIC, anon or authenticated EXECUTE
--
-- Security (Braden 2026-10-30). Prod read 10-30: anon (signed out) and
-- authenticated could EXECUTE these SECURITY DEFINER functions, which write
-- data and check no caller identity. Each is run only by pg_cron (as postgres,
-- the owner) or from inside another SECURITY DEFINER function
-- (build_invoices_for_auction <- drain_build_invoice_jobs). No app code calls
-- any of them with the anon key or a user session (repo grep 10-30).
-- service_role keeps its explicit grant; postgres owns them.
--
-- Function ACLs only: no table lock. Safe to re-run.
-- Rollback: scripts/prod-rig/0478_ROLLBACK_revoke_cron_writer_functions.sql

BEGIN;
SET LOCAL lock_timeout = '3s';

REVOKE EXECUTE ON FUNCTION public.auto_mark_pickup_no_show() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.advance_auction_lifecycle() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.auto_relist_unsold_lots() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.build_invoices_for_auction(uuid) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.drain_build_invoice_jobs(integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.mark_settlements_releasable() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.check_collected_item_invariants(interval) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_refund_job(text,integer) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.claim_webhook_event(text,text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.commit_webhook_event(text) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.mark_invite_consumed(uuid,uuid) FROM PUBLIC, anon, authenticated;

COMMIT;
