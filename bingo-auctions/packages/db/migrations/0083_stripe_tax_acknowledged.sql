-- ============================================================================
-- 0083_stripe_tax_acknowledged
--
-- Companion column for LAUNCH_PLAN §2.1 / Q1 (Path A — destination charges,
-- operator = MOR). Under Path A, the operator is legally responsible for
-- collecting + remitting sales tax in the jurisdictions where their
-- bidders are located. Stripe Tax (enabled on the operator's connected
-- account) does this automatically.
--
-- This migration adds a flag on `operators` that the operator-side
-- dashboard's first-run checklist toggles when the operator acknowledges
-- they've enabled Stripe Tax (or accepted responsibility for filing
-- themselves).
--
-- We don't poll Stripe to verify Stripe Tax is actually enabled — the
-- operator's word is sufficient for the checklist item. If they get
-- audited and didn't actually enable it, that's between them and the
-- state revenue authority, which is the correct legal allocation under
-- Path A.
-- ============================================================================

ALTER TABLE operators
  ADD COLUMN IF NOT EXISTS stripe_tax_acknowledged_at TIMESTAMPTZ;

COMMENT ON COLUMN operators.stripe_tax_acknowledged_at IS
  'When the operator acknowledged they have enabled Stripe Tax on their connected Stripe account (or accepted responsibility for handling sales tax themselves). Flipped by the post-onboarding checklist server action. Used to hide the Stripe Tax checklist tile after acknowledgement. Path A topology — operator is the merchant of record for sales tax (LAUNCH_PLAN §2.1).';
