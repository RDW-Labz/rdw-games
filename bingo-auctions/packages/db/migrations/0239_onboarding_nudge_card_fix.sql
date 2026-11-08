-- 0239 — two email-only notification kinds
--
-- onboarding_nudge (owner, 2026-07-06): 35 auth users in the last 3 days
-- created a login but never finished bidder onboarding (no bidders row).
-- The hourly add-card-nudge cron now also sweeps those orphans and sends
-- ONE "finish setting up your account" email, once ever per user via
-- outbox key 'onboard_nudge:{user_id}' (no bidders column to stamp — the
-- UNIQUE idempotency_key is the whole guarantee).
--
-- card_fix_notice (incident, 2026-07-06): raw-phone signups had every
-- save-card attempt 500 (Square E.164 rejection; fixed in code same day).
-- One-off apology/retry email to the affected cohort, enqueued manually
-- via query mode with key 'cardfix:{bidder_id}'.
--
-- No BEGIN/COMMIT (ALTER TYPE ... ADD VALUE, mig-0167 pattern). Idempotent.

ALTER TYPE notification_kind ADD VALUE IF NOT EXISTS 'onboarding_nudge';
ALTER TYPE notification_kind ADD VALUE IF NOT EXISTS 'card_fix_notice';
