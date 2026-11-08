-- ============================================================================
-- 0167_notification_fanout.sql
--
-- Additive migration for Stream 15 notification fan-out (E1/E2/E3).
-- Three changes:
--
--   1. ADD two new notification_kind enum values:
--        - payment_succeeded   (E1 — bidder receipt push on invoice paid)
--        - pickup_reminder     (E3 — 24h-before-window-closes nudge)
--      `dispute_evidence_due` was added in mig 0077:183 — NOT re-added here.
--      No other enum values are modified.
--
--   2. ADD invoices.evidence_due_by TIMESTAMPTZ column.
--      The `charge.dispute.created` webhook handler stores evidence_due_by in
--      the outbox payload only. Adding it as a proper column enables the
--      dispute-deadline-reminders cron (E2) to do a simple indexed query
--      instead of parsing JSONB. The column is nullable; NULL means "not yet
--      recorded" (disputes created before this migration).
--      Backfill: existing open disputes (dispute_status IN
--      ('needs_response','warning_needs_response')) get a conservative estimate
--      of disputed_at + 7 days (Stripe standard window). This is only for the
--      initial pass — the webhook handler is a separate PR to start writing the
--      column going forward (additive; this migration does not modify any
--      existing function or handler).
--
-- ADDITIVE ONLY. No existing table data is deleted. No existing function body
-- is modified. No charge/settlement/finalize logic is changed.
-- ============================================================================

-- ── 1. New notification_kind enum values ──────────────────────────────────
-- notification_kind is a Postgres ENUM (created in mig 0006).
-- ALTER TYPE … ADD VALUE IF NOT EXISTS is idempotent; safe to re-run.
-- dispute_evidence_due already exists from mig 0077:183 — skipped.

ALTER TYPE notification_kind ADD VALUE IF NOT EXISTS 'payment_succeeded';
ALTER TYPE notification_kind ADD VALUE IF NOT EXISTS 'pickup_reminder';

-- ── 2. invoices.evidence_due_by — Stripe dispute response deadline ─────────

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS evidence_due_by TIMESTAMPTZ;

-- Conservative backfill: open disputes get disputed_at + 7 days as an
-- estimate. Only applies to rows where disputed_at IS NOT NULL and the
-- dispute is still actionable. NULL rows stay NULL (closed/unknown disputes).
UPDATE invoices
   SET evidence_due_by = disputed_at + INTERVAL '7 days'
 WHERE disputed_at IS NOT NULL
   AND evidence_due_by IS NULL
   AND dispute_status IN ('needs_response', 'warning_needs_response');

CREATE INDEX IF NOT EXISTS invoices_evidence_due_by_idx
  ON invoices (evidence_due_by)
  WHERE evidence_due_by IS NOT NULL
    AND dispute_status IN ('needs_response', 'warning_needs_response');
