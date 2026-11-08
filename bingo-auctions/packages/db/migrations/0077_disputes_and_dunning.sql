-- ============================================================================
-- Phase 1 §1.3 / §1.4 / §2.8 — Stripe chargeback handler, webhook idempotency,
-- failed-payment dunning + relisting.
--
-- Three blocks:
--   1. charge.dispute.* support — invoices.disputed_at + status columns,
--      operator_settlements.frozen_for_dispute, hold-window extension to 90d
--      (chargeback exposure on US cards is 75-120 days; current 4-day hold
--      means the platform eats the loss once the operator drained their
--      Connect balance).
--   2. processed_webhook_events — service-role-only idempotency log. We
--      INSERT…ON CONFLICT DO NOTHING right after signature verification and
--      return 200 on conflict so Stripe retries don't double-process.
--   3. payment_followups — dunning state machine. Bidder fails to pay, we
--      ping at 24h, 72h relist + final_status='abandoned'.
--
-- See LAUNCH_PLAN.md §1.3, §1.4, §2.8.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. invoices: Stripe-chargeback state
-- ----------------------------------------------------------------------------

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS disputed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dispute_status TEXT,
  ADD COLUMN IF NOT EXISTS dispute_id TEXT,
  ADD COLUMN IF NOT EXISTS dispute_reason TEXT;

-- Allowed values mirror Stripe's dispute.status enum + the inquiry variants.
-- We use a CHECK rather than a Postgres ENUM so future Stripe additions don't
-- require a type alter.
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS invoices_dispute_status_chk;
ALTER TABLE invoices ADD CONSTRAINT invoices_dispute_status_chk CHECK (
  dispute_status IS NULL
  OR dispute_status IN (
    'created',
    'needs_response',
    'under_review',
    'charge_refunded',
    'won',
    'lost',
    'warning_needs_response',
    'warning_under_review',
    'warning_closed'
  )
);

CREATE INDEX IF NOT EXISTS invoices_dispute_id_idx
  ON invoices (dispute_id)
  WHERE dispute_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS invoices_disputed_open_idx
  ON invoices (disputed_at)
  WHERE dispute_status IN ('created', 'needs_response', 'under_review',
                           'warning_needs_response', 'warning_under_review');

-- An invoice has at most one open Stripe chargeback at a time. We allow
-- multiple closed disputes because the same charge can be challenged twice
-- (warning → second warning → real chargeback), but only one is active.
CREATE UNIQUE INDEX IF NOT EXISTS invoices_dispute_id_unique
  ON invoices (dispute_id)
  WHERE dispute_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- 2. operator_settlements: dispute freeze + extended hold window
-- ----------------------------------------------------------------------------

ALTER TABLE operator_settlements
  ADD COLUMN IF NOT EXISTS frozen_for_dispute BOOLEAN NOT NULL DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS operator_settlements_frozen_idx
  ON operator_settlements (frozen_for_dispute)
  WHERE frozen_for_dispute = TRUE;

-- Backfill: every still-held settlement gets its release_at pushed out to
-- 90 days from creation. New settlements pick up the longer default via the
-- operators.settlement_hold_days bump below. Tradeoff: this delays operator
-- payouts; the alternative is a Stripe reserve (see "Decisions" in report).
UPDATE operator_settlements
   SET release_at = created_at + INTERVAL '90 days'
 WHERE status = 'held'
   AND release_at < created_at + INTERVAL '90 days';

-- Default the operator-level knob to 90d. Operators that already set a
-- custom value above the new default keep theirs (the > guard).
UPDATE operators SET settlement_hold_days = 90 WHERE settlement_hold_days < 90;
ALTER TABLE operators ALTER COLUMN settlement_hold_days SET DEFAULT 90;

-- mark_settlements_releasable() (pg_cron, migration 0072) honours
-- release_at, so the backfill above is sufficient — no function change needed.
-- The dispute-freeze logic is enforced in the settlements-release Worker by
-- skipping rows with frozen_for_dispute=TRUE (handled in a follow-up edit;
-- noted in the report).

-- ----------------------------------------------------------------------------
-- 3. processed_webhook_events — Stripe idempotency
--
-- INSERT…ON CONFLICT DO NOTHING runs right after signature verification.
-- If RETURNING comes back empty (conflict), the handler returns 200 without
-- mutating any state. Service-role only — there's no operator/bidder use
-- case for reading this.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS processed_webhook_events (
  stripe_event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS processed_webhook_events_processed_at_idx
  ON processed_webhook_events (processed_at);

ALTER TABLE processed_webhook_events ENABLE ROW LEVEL SECURITY;
-- No policies => only service-role (which bypasses RLS) can touch it. End
-- users (anon, authenticated) get a 0-row result on SELECT and a 42501 on
-- INSERT/UPDATE/DELETE.

-- ----------------------------------------------------------------------------
-- 4. payment_followups — dunning state machine
--
-- One row per failed invoice. The webhook's payment_intent.payment_failed
-- branch upserts on invoice_id; the /api/cron/payment-followups Worker scans
-- next_attempt_at <= now() AND final_status IS NULL and decides what to do
-- based on attempt_count:
--   attempt 1 (created on the first failure) — send first failure push
--   attempt 2 (after 24h) — send second nudge
--   attempt 3 (after 72h cumulative) — mark invoice unpaid_no_show, relist
-- final_status: 'paid' (bidder eventually paid), 'abandoned' (relisted),
-- 'canceled' (operator manual void).
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS payment_followups (
  invoice_id UUID PRIMARY KEY REFERENCES invoices(id) ON DELETE CASCADE,
  operator_id UUID NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  bidder_id UUID NOT NULL REFERENCES bidders(id) ON DELETE CASCADE,
  last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  next_attempt_at TIMESTAMPTZ NOT NULL,
  attempt_count INT NOT NULL DEFAULT 1,
  final_status TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE payment_followups DROP CONSTRAINT IF EXISTS payment_followups_final_status_chk;
ALTER TABLE payment_followups ADD CONSTRAINT payment_followups_final_status_chk CHECK (
  final_status IS NULL
  OR final_status IN ('paid', 'abandoned', 'canceled')
);

CREATE INDEX IF NOT EXISTS payment_followups_due_idx
  ON payment_followups (next_attempt_at)
  WHERE final_status IS NULL;
CREATE INDEX IF NOT EXISTS payment_followups_operator_idx
  ON payment_followups (operator_id);

ALTER TABLE payment_followups ENABLE ROW LEVEL SECURITY;

-- Operator staff can see their own org's followups (for an ops dashboard
-- listing bidders we're chasing).
CREATE POLICY payment_followups_operator_read ON payment_followups
  FOR SELECT
  USING (operator_id = current_operator_id());

-- updated_at trigger
DROP TRIGGER IF EXISTS payment_followups_set_updated_at ON payment_followups;
CREATE TRIGGER payment_followups_set_updated_at
  BEFORE UPDATE ON payment_followups
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------
-- 5. notification_kind enum — five new values
--
-- ALTER TYPE … ADD VALUE must be in its own transaction; in a migration this
-- is implicit. The TS union in lib/cron/notifications-drain.ts (line 17) will
-- need to be widened in a follow-up edit so the push titles/bodies render
-- correctly. Until then the switch falls through and the row sits unprocessed
-- (NOT silent fail — attempt_count climbs and the row dead-letters).
-- ----------------------------------------------------------------------------

ALTER TYPE notification_kind ADD VALUE IF NOT EXISTS 'payment_failed';
ALTER TYPE notification_kind ADD VALUE IF NOT EXISTS 'payment_retry_reminder';
ALTER TYPE notification_kind ADD VALUE IF NOT EXISTS 'dispute_opened';
ALTER TYPE notification_kind ADD VALUE IF NOT EXISTS 'dispute_evidence_due';
ALTER TYPE notification_kind ADD VALUE IF NOT EXISTS 'lot_relisted_no_show';

-- ----------------------------------------------------------------------------
-- 6. invoice_status — new 'unpaid_no_show' terminal state
-- ----------------------------------------------------------------------------

ALTER TYPE invoice_status ADD VALUE IF NOT EXISTS 'unpaid_no_show';

-- ----------------------------------------------------------------------------
-- 7. dispute-evidence storage bucket
--
-- Path convention: <operator_id>/<dispute_id>/<filename>
-- Private bucket. 25MB cap (Stripe accepts up to ~5MB per file but we hold
-- the original); JPEG / PNG / PDF only.
-- ----------------------------------------------------------------------------

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'dispute-evidence',
  'dispute-evidence',
  FALSE,
  26214400,
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
ON CONFLICT (id) DO UPDATE SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

CREATE POLICY "dispute-evidence operator read" ON storage.objects
  FOR SELECT
  USING (
    bucket_id = 'dispute-evidence'
    AND current_operator_id() IS NOT NULL
    AND (storage.foldername(name))[1] = current_operator_id()::text
    AND current_operator_role() IN ('admin', 'manager')
  );

CREATE POLICY "dispute-evidence operator write" ON storage.objects
  FOR INSERT
  WITH CHECK (
    bucket_id = 'dispute-evidence'
    AND current_operator_id() IS NOT NULL
    AND (storage.foldername(name))[1] = current_operator_id()::text
    AND current_operator_role() IN ('admin', 'manager')
  );

CREATE POLICY "dispute-evidence operator delete" ON storage.objects
  FOR DELETE
  USING (
    bucket_id = 'dispute-evidence'
    AND current_operator_id() IS NOT NULL
    AND (storage.foldername(name))[1] = current_operator_id()::text
    AND current_operator_role() = 'admin'
  );
