-- ============================================================================
-- Migration 0106 — Operator subscription-lapsed gating.
--
-- Companion to 0105 (auto-charge + grace + relot-fee). 0105 added
-- operators.lapse_at and committed to a daily cron that flips operators
-- to 'subscription_lapsed' once the 7-day grace window elapses on an
-- unresolved past_due platform subscription.
--
-- Two schema additions were missing from 0105 to make that cron's
-- WHERE-clause executable:
--
--   1. operator_status enum needs a 'subscription_lapsed' value. Without
--      this the daily cron's UPDATE operators SET status = ... fails
--      with invalid_text_representation.
--
--   2. operators.subscription_status mirrors the live Stripe platform
--      subscription state (none/active/past_due/canceled). The webhook
--      handler stamps it on every customer.subscription.* event for
--      platform_subscription kind events. The daily cron filters on
--      subscription_status='past_due' AND lapse_at<now() to find rows
--      to flip — we DON'T want to lapse operators who fixed billing in
--      the grace window (lapse_at gets cleared when status flips back
--      to 'active', see webhook handler).
--
-- Both additions are pure-additive; existing rows default to a no-op
-- state ('none'). The 'subscription_lapsed' enum value is added in the
-- SAME transaction the column is added because Postgres permits ADD
-- VALUE → reference in column DEFAULT/CHECK in the same tx as long as
-- nothing PARTIAL-INDEX-references it (we add a plain index only).
-- ============================================================================

ALTER TYPE operator_status ADD VALUE IF NOT EXISTS 'subscription_lapsed';

ALTER TABLE operators
  ADD COLUMN IF NOT EXISTS subscription_status subscription_status NOT NULL DEFAULT 'none';

CREATE INDEX IF NOT EXISTS operators_subscription_status_idx
  ON operators (subscription_status)
  WHERE subscription_status IN ('past_due', 'canceled');

COMMENT ON COLUMN operators.subscription_status IS
  'Mirror of the live Stripe platform subscription status (mapped via the '
  'webhook handler). Daily cron operator-sub-lapse uses this + lapse_at to '
  'decide which operators to flip to status = subscription_lapsed.';
