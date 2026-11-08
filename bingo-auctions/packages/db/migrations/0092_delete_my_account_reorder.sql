-- ============================================================================
-- 0092_delete_my_account_reorder.sql
--
-- Bug caught by mega-sim 2026-05-18: the bidders.email anonymization in
-- delete_my_account() silently failed. The RPC reported `anonymized_email`
-- in its JSON return, but the actual `bidders.email` column was unchanged
-- (still the bidder's real email) — so PII survived a "delete my account"
-- call, breaking Apple Guideline 5.1.1(v) compliance in practice.
--
-- Root cause: the `bidders_lock_email_to_auth` BEFORE UPDATE trigger
-- (introduced in an earlier migration to keep bidders.email and
-- auth.users.email always in sync) re-reads auth.users.email during the
-- bidders UPDATE and forcibly overwrites NEW.email back to the auth value.
-- delete_my_account() was updating bidders BEFORE auth.users, so the
-- trigger fired while auth.users still held the original email, locking
-- the bidders row back to the un-anonymized value before auth.users got
-- its own UPDATE applied.
--
-- Fix: reorder so auth.users is anonymized FIRST, then bidders. The
-- lock-to-auth trigger then copies the already-anonymized email into
-- bidders.email. No trigger logic changes — just statement ordering.
--
-- Also: bumped banned_until from 2100-01-01 → 9999-12-31. Old value was
-- semantically fine (sub-account permanently disabled) but tripped over
-- timezone-sensitive year assertions on the JS side (a CST `getFullYear`
-- on `2100-01-01T00:00:00Z` returns 2099). Using 9999 makes the
-- "permanently banned" intent unambiguous in every timezone.
-- ============================================================================

CREATE OR REPLACE FUNCTION delete_my_account()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_now     TIMESTAMPTZ := now();
  v_anon_email TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  v_anon_email := 'deleted-' || v_user_id::text || '@deleted.local';

  -- Cancel pending invoices first (no FK chain dependency here).
  UPDATE invoices
     SET status = 'canceled'
   WHERE bidder_id = v_user_id
     AND status = 'pending';

  -- Wipe bidder-personal rows that have no audit value.
  DELETE FROM watchlist WHERE bidder_id = v_user_id;
  DELETE FROM saved_searches WHERE bidder_id = v_user_id;
  DELETE FROM bidder_subscriptions WHERE bidder_id = v_user_id;
  DELETE FROM operator_policy_acceptances WHERE user_id = v_user_id;

  -- ── ORDER MATTERS ───────────────────────────────────────────────────────
  -- auth.users must be anonymized BEFORE bidders so the
  -- `bidders_lock_email_to_auth` BEFORE UPDATE trigger reads the
  -- already-anonymized auth.users.email and propagates it into bidders.
  -- (Original 0089 had these reversed, which silently un-anonymized the
  -- bidders.email column — caught by mega-sim 2026-05-18.)
  UPDATE auth.users
     SET email                = v_anon_email,
         encrypted_password   = NULL,
         banned_until         = '9999-12-31'::timestamptz,
         email_confirmed_at   = NULL,
         phone                = NULL,
         phone_confirmed_at   = NULL,
         raw_user_meta_data   = jsonb_build_object('deleted', true, 'deleted_at', v_now),
         updated_at           = v_now
   WHERE id = v_user_id;

  -- Detach social-login identities so the user cannot OAuth back in.
  DELETE FROM auth.identities WHERE user_id = v_user_id;

  -- Now anonymize the bidders row. The lock-to-auth trigger will copy
  -- the now-anonymized auth.users.email into NEW.email.
  UPDATE bidders
     SET email                = v_anon_email,
         display_name         = 'Deleted Bidder',
         phone                = NULL,
         birth_date           = NULL,
         identity_verified_at = NULL,
         deleted_at           = v_now
   WHERE id = v_user_id;

  RETURN jsonb_build_object(
    'ok', true,
    'deleted_at', v_now,
    'anonymized_email', v_anon_email
  );
END;
$$;

COMMENT ON FUNCTION delete_my_account() IS
  'Apple Guideline 5.1.1(v) — tombstones the calling user. Anonymizes '
  'bidders + auth.users (auth FIRST to satisfy the bidders email-lock '
  'trigger), cancels pending invoices, deletes watchlist/saved_searches/'
  'bidder_subscriptions/operator_policy_acceptances. Settled bids and paid '
  'invoices retained for 7-year tax compliance. banned_until set to 9999 '
  'so the account can never be signed in to.';
