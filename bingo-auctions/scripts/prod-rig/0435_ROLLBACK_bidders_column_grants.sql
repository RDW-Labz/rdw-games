-- ROLLBACK for 0435: restores the pre-0435 grants exactly as read from prod on
-- 2026-10-21 (anon/authenticated: DELETE, INSERT, REFERENCES, SELECT, TRIGGER,
-- TRUNCATE, UPDATE on bidders; EXECUTE for everyone on the four functions).
-- clear_relot_fees_for_bidder is left in place (service_role only, harmless)
-- because the deployed pay-fees route calls it; revert that route first if you
-- also want it dropped:  DROP FUNCTION public.clear_relot_fees_for_bidder(uuid, text);
-- NOTE: this re-opens the hole 0435 closed. Use only if 0435 broke something.
SET lock_timeout = '3s';

REVOKE UPDATE (display_name, phone, push_enabled, email_enabled, sms_enabled, expo_push_token, push_registered_at)
  ON public.bidders FROM authenticated;
GRANT INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.bidders TO anon, authenticated;

GRANT EXECUTE ON FUNCTION public.clear_paid_relot_fees(text) TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_relot_fee(uuid, bigint) TO PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.delete_my_account() TO PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_bidder_preview_operator(uuid) TO PUBLIC, anon;
