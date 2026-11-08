-- ROLLBACK for 0478: restore prod's function ACLs as read 2026-10-30.
BEGIN;
SET LOCAL lock_timeout = '3s';

GRANT EXECUTE ON FUNCTION public.auto_mark_pickup_no_show() TO anon, authenticated; -- was {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
GRANT EXECUTE ON FUNCTION public.advance_auction_lifecycle() TO anon, authenticated; -- was {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
GRANT EXECUTE ON FUNCTION public.auto_relist_unsold_lots() TO anon, authenticated; -- was {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
GRANT EXECUTE ON FUNCTION public.build_invoices_for_auction(uuid) TO anon, authenticated; -- was {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
GRANT EXECUTE ON FUNCTION public.drain_build_invoice_jobs(integer) TO anon, authenticated; -- was {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
GRANT EXECUTE ON FUNCTION public.mark_settlements_releasable() TO anon, authenticated; -- was {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
GRANT EXECUTE ON FUNCTION public.check_collected_item_invariants(interval) TO anon, authenticated; -- was {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
GRANT EXECUTE ON FUNCTION public.claim_refund_job(text,integer) TO anon, authenticated; -- was {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
GRANT EXECUTE ON FUNCTION public.claim_webhook_event(text,text) TO anon, authenticated; -- was {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
GRANT EXECUTE ON FUNCTION public.commit_webhook_event(text) TO anon, authenticated; -- was {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}
GRANT EXECUTE ON FUNCTION public.mark_invite_consumed(uuid,uuid) TO anon, authenticated; -- was {postgres=X/postgres,anon=X/postgres,authenticated=X/postgres,service_role=X/postgres}

COMMIT;
