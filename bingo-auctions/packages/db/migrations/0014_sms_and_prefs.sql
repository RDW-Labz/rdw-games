-- ============================================================================
-- Notification preferences + Twilio SMS support.
--
-- bidders gets per-channel toggles. Defaults are "everything on" because
-- the platform sends notifications that are nearly always wanted (won,
-- outbid). Bidders can disable any channel from /profile.
--
-- notifications_outbox gets sms tracking columns alongside the existing
-- push (processed_at) and email (emailed_at) tracks. Each channel runs as
-- a parallel worker; rows are fully done when all channels have either
-- delivered or been skipped.
-- ============================================================================

ALTER TABLE bidders
  ADD COLUMN IF NOT EXISTS push_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS email_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS sms_enabled BOOLEAN NOT NULL DEFAULT false;
  -- SMS opt-IN by default off — Twilio costs money + carriers flag
  -- unsolicited SMS. Bidders explicitly enable from profile.

ALTER TABLE notifications_outbox
  ADD COLUMN IF NOT EXISTS smsed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sms_attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_sms_error TEXT;

CREATE INDEX IF NOT EXISTS notifications_outbox_unsmsed_idx
  ON notifications_outbox (created_at)
  WHERE smsed_at IS NULL;
