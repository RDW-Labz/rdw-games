-- ============================================================================
-- 0089_account_deletion.sql
--
-- In-app account deletion per Apple App Store Guideline 5.1.1(v).
-- Apps that allow account creation must offer in-app deletion. Without
-- this the bidder-app will be rejected on submission.
--
-- Design tradeoff: a strict DELETE on auth.users would cascade to
-- bidders.id (PK = auth.users.id), which would cascade to bids and
-- invoices — both of which we must retain for 7 years per US tax law
-- (operator's 1099-K reporting depends on bid/invoice ledger surviving).
--
-- Instead we TOMBSTONE both rows: anonymize the bidder row (email,
-- display_name, phone, birth_date null/redacted), anonymize the
-- auth.users row (email replaced, encrypted_password nulled, banned_until
-- set to year 2100 so the account cannot sign in). From the bidder's
-- perspective the account is permanently inaccessible and no PII
-- remains. The bid/invoice ledger persists with a now-anonymous
-- bidder reference, which is what tax-retention and dispute audit need.
--
-- Apple has accepted this tombstone pattern for marketplaces with
-- legal retention obligations (eBay, StockX, Mercari all use it).
-- ============================================================================

-- 1. deleted_at column on bidders for the soft-delete state
ALTER TABLE bidders
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS bidders_deleted_at_idx ON bidders (deleted_at)
  WHERE deleted_at IS NOT NULL;

-- 2. The RPC. Callable by any authenticated user (operator or bidder).
-- Performs tombstone of the calling user. Idempotent — safe to call twice.
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

  -- Cancel pending invoices (the bidder hasn't paid yet; let the
  -- operator know nothing's coming so they can relist).
  -- Note: settled (paid) invoices are kept verbatim per tax retention.
  -- invoice_status enum values (confirmed via pg_enum): pending, paid,
  -- refunded, partially_refunded, canceled, unpaid_no_show. Only `pending`
  -- represents an un-paid invoice; the rest are terminal.
  UPDATE invoices
     SET status = 'canceled'
   WHERE bidder_id = v_user_id
     AND status = 'pending';

  -- Wipe bidder-side records that have no audit value: watchlist,
  -- saved searches, bidder Pro subscriptions, operator policy
  -- acceptance trail. These are all bidder-personal records, not
  -- operator-side ledger entries.
  DELETE FROM watchlist WHERE bidder_id = v_user_id;
  DELETE FROM saved_searches WHERE bidder_id = v_user_id;
  DELETE FROM bidder_subscriptions WHERE bidder_id = v_user_id;
  DELETE FROM operator_policy_acceptances WHERE user_id = v_user_id;

  -- Anonymize the bidders row. Keep the PK intact because bids and
  -- invoices reference it via FK; we cannot delete the row without
  -- destroying that ledger. We zero out every column that could
  -- identify the human.
  UPDATE bidders
     SET email                = v_anon_email,
         display_name         = 'Deleted Bidder',
         phone                = NULL,
         birth_date           = NULL,
         identity_verified_at = NULL,
         deleted_at           = v_now
   WHERE id = v_user_id;

  -- Tombstone auth.users so the account can never be signed into
  -- again. We do NOT DELETE because that would cascade to bidders,
  -- breaking the FK chain to bids/invoices that we must retain.
  --   - email     -> anonymized (so the original email can be re-used
  --                  by a fresh signup if the user changes their mind)
  --   - encrypted_password -> NULL (sign-in by password becomes
  --                            impossible)
  --   - banned_until -> 2100-01-01 (no possible sign-in even via
  --                                magic link or OAuth)
  --   - email_confirmed_at -> NULL (no auto-redirects)
  --   - raw_user_meta_data -> stripped to just { deleted: true }
  --   - phone -> NULL
  --   - identity tokens (Google/Apple) -> cleared via auth.identities
  UPDATE auth.users
     SET email                = v_anon_email,
         encrypted_password   = NULL,
         banned_until         = '2100-01-01'::timestamptz,
         email_confirmed_at   = NULL,
         phone                = NULL,
         phone_confirmed_at   = NULL,
         raw_user_meta_data   = jsonb_build_object('deleted', true, 'deleted_at', v_now),
         updated_at           = v_now
   WHERE id = v_user_id;

  -- Detach social-login identities so the user cannot sign back in
  -- via Google / Apple OAuth with their original third-party account.
  DELETE FROM auth.identities WHERE user_id = v_user_id;

  RETURN jsonb_build_object(
    'ok', true,
    'deleted_at', v_now,
    'anonymized_email', v_anon_email
  );
END;
$$;

GRANT EXECUTE ON FUNCTION delete_my_account() TO authenticated;

-- Comment for future maintainers
COMMENT ON FUNCTION delete_my_account() IS
  'Apple Guideline 5.1.1(v) — tombstones the calling user. Anonymizes '
  'bidders + auth.users, cancels pending invoices, deletes watchlist/'
  'saved_searches/bidder_subscriptions/operator_policy_acceptances. '
  'Settled bids and paid invoices are retained for 7-year tax compliance.';
