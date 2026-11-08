-- 0435 — bidders: a signed-in bidder may update ONLY their own profile fields.
--
-- WHY (found 2026-10-21, read-only, not exploited): RLS bidders_self_update
-- (0133) is `id = auth.uid()` and no migration ever narrowed the Supabase
-- default grants, so `authenticated` (and `anon`) held INSERT/UPDATE/DELETE/
-- TRUNCATE on every bidders column. With the public anon key and their own JWT
-- a bidder could set their own tax_exempt (0233: zeroes tax on new invoices),
-- unpaid_fees_cents (0105: the relot-fee bidding block), no_show_count,
-- resale_cert_*, subscription_status, bidder_number, card_* … Two SECURITY
-- DEFINER functions were also open to every caller:
--   clear_paid_relot_fees(text) — marks the CALLER's fees paid with any string
--     as the "payment id"; no payment is checked.
--   apply_relot_fee(uuid, bigint) — adds a fee to the bidder of ANY invoice id.
-- Read-only audit 2026-10-21: no confirmed abuse (6 tax-exempt bidders, all
-- staff-approved; one unexplained fee/ledger mismatch reported separately).
--
-- WHAT
--   1. bidders: anon and authenticated lose INSERT, UPDATE, DELETE, TRUNCATE,
--      REFERENCES, TRIGGER. SELECT is unchanged (RLS still scopes it).
--      authenticated gets UPDATE back on exactly the 7 columns the bidder app
--      writes directly: display_name, phone (profile/edit.tsx), push_enabled,
--      email_enabled, sms_enabled (notifications.tsx), expo_push_token,
--      push_registered_at (lib/push.ts). RLS self_update still limits it to
--      their own row. ZIP (0434) is written only through set_my_postal_code /
--      snooze_my_postal_code_prompt (SECURITY DEFINER), so it is NOT here.
--      Every operator-web write uses service_role; signup is service_role
--      (/api/bidder/signup); the staff app writes no bidders rows; every SQL
--      function that writes bidders is SECURITY DEFINER (owner privileges).
--   2. clear_relot_fees_for_bidder(p_bidder_id, p_payment_id): service_role
--      only. The pay-fees route calls it with the admin client AFTER the Square
--      charge clears (same PR). clear_paid_relot_fees(text) loses EXECUTE for
--      PUBLIC/anon/authenticated (kept for rollback, callable by service_role).
--   3. apply_relot_fee: EXECUTE for service_role only (its one caller is the
--      grace-expiry cron via getSupabaseAdmin()).
--   4. delete_my_account / set_bidder_preview_operator: anon loses EXECUTE
--      (both require auth.uid(); authenticated keeps it).
--
-- ORDER: 0434 → 0435 → operator-web deploy (pay-fees route) → bidder OTA.
--   Between 0435 and the deploy, paying relot fees in the app fails (the old
--   route calls the revoked function) — minutes, in the 05:00–07:00 window.
-- LOCKS: GRANT/REVOKE take a brief lock on bidders; lock_timeout 3s, retry.
-- ROLLBACK: scripts/prod-rig/0435_ROLLBACK_bidders_column_grants.sql.
SET lock_timeout = '3s';

REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.bidders FROM anon, authenticated;
GRANT UPDATE (display_name, phone, push_enabled, email_enabled, sms_enabled, expo_push_token, push_registered_at)
  ON public.bidders TO authenticated;

CREATE OR REPLACE FUNCTION public.clear_relot_fees_for_bidder(p_bidder_id uuid, p_payment_id text)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  IF p_bidder_id IS NULL OR coalesce(trim(p_payment_id), '') = '' THEN
    RAISE EXCEPTION 'bidder and payment id required' USING ERRCODE = '22023';
  END IF;

  UPDATE bidder_fee_ledger
     SET paid_at = now(),
         paid_payment_intent_id = p_payment_id
   WHERE bidder_id = p_bidder_id AND paid_at IS NULL;

  UPDATE bidders SET unpaid_fees_cents = 0 WHERE id = p_bidder_id;

  RETURN 0;
END;
$function$;

COMMENT ON FUNCTION public.clear_relot_fees_for_bidder(uuid, text) IS
  '0435: service_role only. Called by /api/bidders/me/pay-fees after the Square '
  'charge for the outstanding relot fees succeeds. Replaces the caller-keyed '
  'clear_paid_relot_fees(text), which any signed-in bidder could call unpaid.';

REVOKE ALL ON FUNCTION public.clear_relot_fees_for_bidder(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clear_relot_fees_for_bidder(uuid, text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.clear_paid_relot_fees(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clear_paid_relot_fees(text) TO service_role;

REVOKE EXECUTE ON FUNCTION public.apply_relot_fee(uuid, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_relot_fee(uuid, bigint) TO service_role;

REVOKE EXECUTE ON FUNCTION public.delete_my_account() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.delete_my_account() TO authenticated, service_role;
REVOKE EXECUTE ON FUNCTION public.set_bidder_preview_operator(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_bidder_preview_operator(uuid) TO authenticated, service_role;
