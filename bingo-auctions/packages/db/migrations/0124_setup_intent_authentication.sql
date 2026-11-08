-- ============================================================================
-- Migration 0124 — SCA / 3D Secure off-session authentication recovery.
--
-- Background
-- ----------
-- Today the auto-charge cron (apps/operator-web/src/lib/cron/auto-charge-drain.ts)
-- creates an off-session PaymentIntent with confirm=true. If the issuing bank
-- requires Strong Customer Authentication (PSD2 / 3DS), Stripe returns the PI
-- with status='requires_action' and a client_secret the bidder needs to
-- complete a 3DS challenge on-device. Today we treat this as a generic decline
-- and flip the invoice to payment_failed_grace — the bidder has no path to
-- actually finish the 3DS step, so it always times out into the relot fee.
--
-- This migration adds the persistence + signaling primitives for a proper
-- recovery path: the cron stores the client_secret on the invoice, the bidder
-- web app surfaces a "Verify card" CTA on /profile/verify-card, and the
-- bidder uses Stripe.js confirmCardPayment(clientSecret) to complete the
-- challenge. On success the existing payment_intent.succeeded webhook handler
-- runs (idempotency-safe via processed_webhook_events / 0100) and clears the
-- authentication_required_at flag.
--
-- Schema decision: flag column, NOT a new invoice_status value
-- ------------------------------------------------------------
-- We considered adding 'requires_action' to the invoice_status enum (between
-- 'pending' and 'paid'). REJECTED because:
--   1. ~20 callers read invoice_status (cron predicates, UI status pills,
--      RLS-adjacent helpers, the bidder-app invoice screen, etc.) and would
--      ALL need new branches; a missed branch silently strands the invoice.
--   2. The auto-charge trigger from migration 0105 only enqueues
--      auto_charge_jobs on NEW pending invoices — flipping a pending invoice
--      to requires_action would not retrigger anything anyway.
--   3. The bidder-app invoice screen (invoice/[id].tsx) treats 'pending' as
--      "charging in progress, show spinner" — if we changed the status the
--      copy would have to change, but the underlying state machine is the
--      same: "waiting for the bidder to do one more thing".
--
-- Going with a FLAG COLUMN (`authentication_required_at`) keeps status='pending'
-- and lets the cron predicate AND the bidder UI branch on a single nullable
-- timestamp. The auto-charge drain query just adds
--   AND authentication_required_at IS NULL
-- to skip rows that need bidder action; the webhook payment_intent.succeeded
-- handler clears it; and the new /profile/verify-card route lists rows where
-- it's NOT NULL.
--
-- ADDITIVE ONLY. Every alter is idempotent.
-- ============================================================================

-- ── 1. invoices: client_secret + flag column ────────────────────────────────

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS authentication_client_secret TEXT,
  ADD COLUMN IF NOT EXISTS authentication_required_at   TIMESTAMPTZ;

COMMENT ON COLUMN invoices.authentication_client_secret IS
  'Stripe PaymentIntent client_secret captured when an off-session charge '
  'returns status=requires_action (PSD2 / 3DS). The bidder uses this with '
  'Stripe.js confirmCardPayment() on /profile/verify-card to complete the '
  'challenge. Cleared by the payment_intent.succeeded webhook handler.';

COMMENT ON COLUMN invoices.authentication_required_at IS
  'Set when Stripe returns requires_action on the off-session PaymentIntent. '
  'Cleared on payment_intent.succeeded (webhook) or when the bidder retries '
  'and the PI completes. While NOT NULL the auto-charge cron MUST skip this '
  'invoice (no automatic re-attempt) and the bidder UI surfaces a "Verify '
  'card" banner.';

-- Partial index — most invoices have this NULL. The bidder app + the
-- /profile/verify-card server component list "needs action" rows by
-- scanning this column.
CREATE INDEX IF NOT EXISTS invoices_requires_action_idx
  ON invoices (authentication_required_at)
  WHERE authentication_required_at IS NOT NULL;

-- ── 2. notification_kind enum — new SCA-action value ────────────────────────
-- Postgres allows ALTER TYPE ADD VALUE inside the implicit migration tx, but
-- the value cannot be referenced in the SAME transaction. We only reference
-- this value at runtime (notifications_outbox.kind rows) so the migration
-- runner committing this file makes it usable on the NEXT statement, well
-- before any application code inserts it.

ALTER TYPE notification_kind ADD VALUE IF NOT EXISTS 'payment_requires_action';

-- NB: the notifications-drain TS handler (lib/cron/notifications-drain.ts)
-- has its own discriminated-union type for `kind`. That union is widened in
-- the same commit as this migration so the new kind renders a real push
-- title/body instead of falling through. Without that widening the row
-- still inserts safely — it just doesn't push until the TS catches up.
