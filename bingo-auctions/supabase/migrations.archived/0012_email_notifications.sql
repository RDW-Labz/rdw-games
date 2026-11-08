-- ============================================================================
-- Email notifications: track per-channel delivery state on the outbox so
-- push and email succeed/retry independently. processed_at stays as the
-- "push attempted" timestamp (matches the existing index); emailed_at is the
-- new column.
--
-- The notifications worker handles both channels: push via Expo, email via
-- Resend. A row is fully done when BOTH channels have been attempted (or
-- skipped because the bidder lacks a token / email).
-- ============================================================================

ALTER TABLE notifications_outbox
  ADD COLUMN IF NOT EXISTS emailed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS email_attempt_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_email_error TEXT;

-- Partial index for the email worker.
CREATE INDEX IF NOT EXISTS notifications_outbox_unemailed_idx
  ON notifications_outbox (created_at)
  WHERE emailed_at IS NULL;
