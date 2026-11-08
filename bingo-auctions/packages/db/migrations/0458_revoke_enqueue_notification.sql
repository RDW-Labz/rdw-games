-- 0458 — enqueue_notification is server-only (audit #581, C-1).
--
-- public.enqueue_notification(notification_kind, uuid, jsonb, text) is
-- SECURITY DEFINER and had EXECUTE granted to anon and authenticated, with no
-- auth check, kind allow-list or payload validation. With the public anon key
-- anyone could queue emails (e.g. onboarding_nudge to any address, or a
-- marketing_campaign with an attacker-written body to a real bidder) and burn
-- the Resend quota.
--
-- Callers checked on prod 2026-10-26 (read-only): every function that calls it
-- (assign_lot_to_bin, bidder_confirm_customer_pickup, buy_dutch,
-- buy_flat_price, confirm_pickup, finalize_lot, manager_pickup_override,
-- place_bid, staff_confirm_pickup) is SECURITY DEFINER owned by postgres, so
-- they keep working; no trigger uses it; no app or script calls it (only the
-- generated types file names it). service_role keeps EXECUTE.
--
-- LOCKS: none on any table (function ACL only). Safe any hour.
-- ROLLBACK: scripts/prod-rig/0458_ROLLBACK_revoke_enqueue_notification.sql.

SET lock_timeout = '3s';

REVOKE EXECUTE ON FUNCTION public.enqueue_notification(notification_kind, uuid, jsonb, text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.enqueue_notification(notification_kind, uuid, jsonb, text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.enqueue_notification(notification_kind, uuid, jsonb, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_notification(notification_kind, uuid, jsonb, text) TO service_role;
