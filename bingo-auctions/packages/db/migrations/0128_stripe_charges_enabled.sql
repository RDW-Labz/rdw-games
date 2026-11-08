-- ============================================================================
-- 2026-05-23: Add stripe_charges_enabled to operators.
--
-- Context:
--   stripe_onboarding_complete previously served two purposes:
--     1. Gate the /onboarding redirect loop (stop showing the form).
--     2. Indicate the operator can actually accept payments.
--
--   This conflation caused a loop bug: the webhook handler only flipped the
--   flag when charges_enabled=true, but Stripe can take hours to approve a
--   new Connect account after the operator submits their details. The operator
--   finished the form but was bounced back to it on every page refresh.
--
-- Fix (fix committed 2026-05-23):
--   - stripe_onboarding_complete now flips TRUE on details_submitted=true
--     (form complete). This breaks the loop.
--   - stripe_charges_enabled (this column) tracks whether Stripe has approved
--     the account for live charges. The dashboard shows a "pending Stripe
--     review" banner when complete=true but charges_enabled=false.
--   - operators.status stays 'active' only when charges_enabled=true (same
--     semantics as before for the payment route gate).
--
-- Backfill: any operator with stripe_onboarding_complete=true and a real
-- stripe_account_id is assumed to have charges enabled (they were approved
-- before this column existed). Operators with no stripe_account_id (skipped)
-- leave stripe_charges_enabled=false — that is correct, they can't charge.
-- ============================================================================

ALTER TABLE operators
  ADD COLUMN IF NOT EXISTS stripe_charges_enabled BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN operators.stripe_charges_enabled IS
  'TRUE when Stripe has fully approved the Connect account for live charges (charges_enabled=true AND payouts_enabled=true on the Stripe Account object). Distinct from stripe_onboarding_complete, which flips as soon as the operator submits their details.';

-- Backfill: real accounts that were already active before this migration.
UPDATE operators
   SET stripe_charges_enabled = true
 WHERE stripe_onboarding_complete = true
   AND stripe_onboarding_skipped = false
   AND stripe_account_id IS NOT NULL;
