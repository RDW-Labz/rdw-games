-- ============================================================================
-- Phase 6: stripe_onboarding_skipped flag.
--
-- Test operators (the project owner's friends) need to complete operator
-- signup and reach the dashboard WITHOUT setting up real Stripe Connect
-- accounts. The /onboarding page currently blocks them forever because
-- stripe_onboarding_complete=false → redirect loop.
--
-- This adds a flag for "operator deliberately skipped Stripe in test
-- mode." The dashboard reads it to show a "you can't accept payments"
-- banner. Bidder-side payment routes already 422 with
-- 'operator_not_onboarded' when stripe_account_id is null, so no
-- bidder-side change needed beyond cosmetic copy.
--
-- The skipStripeOnboarding() server action sets BOTH
-- stripe_onboarding_complete=true (so the redirect loop ends) and
-- stripe_onboarding_skipped=true (so we know it wasn't real).
--
-- Production safety: the action is gated on the env var
-- ALLOW_SKIP_STRIPE_ONBOARDING=true, set ONLY on the dev/staging Vercel
-- project. Production should never have this flag set.
-- ============================================================================

ALTER TABLE operators
  ADD COLUMN IF NOT EXISTS stripe_onboarding_skipped BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN operators.stripe_onboarding_skipped IS
  'TRUE when operator skipped Stripe Connect setup via the test-mode bypass. stripe_onboarding_complete is also set TRUE so the /onboarding redirect loop ends, but no real Stripe account exists. Dashboard surfaces a banner; bidder pay route still 422s.';

-- Backfill existing operators: anyone with stripe_account_id IS NULL
-- but somehow stripe_onboarding_complete=true got there via test SQL,
-- not via real Stripe. Mark them skipped so the dashboard banner shows.
UPDATE operators
   SET stripe_onboarding_skipped = true
 WHERE stripe_account_id IS NULL
   AND stripe_onboarding_complete = true;
