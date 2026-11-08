-- 0241 — pickup sessions: one QR per customer visit (staff feature request,
-- 2026-07-06; owner approved Phases 1+2)
--
-- Phase 1: a bidder gets ONE pickup-session QR covering every invoice they
-- can pick up (pickups.status IN pending/scheduled), instead of staff
-- scanning invoice-by-invoice. Membership is COMPUTED at read time from the
-- bidder's eligible pickups — never frozen at session creation — so an
-- invoice paid five minutes before the counter scan is included.
--
-- Phase 2: collected_lot_ids tracks the bidder's walk progress through the
-- aisle-ordered Pickup Helper checklist (append-only from the bidder's own
-- session; cleared never — sessions are per-visit and disposable).
--
-- Rollout guard: platform_settings.pickup_sessions_enabled (default FALSE).
-- The bidder-facing pass page 404s and the API refuses while off, so live
-- customers see nothing until the Jared test run passes. The staff session
-- page ignores the flag (scanning an existing QR should always work).
--
-- Wrapped in a transaction: plain DDL, no ALTER TYPE ADD VALUE.

BEGIN;

CREATE TABLE IF NOT EXISTS pickup_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  bidder_id UUID NOT NULL REFERENCES bidders(id) ON DELETE CASCADE,
  -- QR payload. URL-shaped (https://bingoauctions.com/pickups/session/{token})
  -- so any phone camera opens the staff console page — no scanner build needed.
  token UUID NOT NULL DEFAULT uuid_generate_v4() UNIQUE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'canceled')),
  -- Phase 2 walk progress (lot ids the bidder marked collected).
  collected_lot_ids UUID[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  -- Staff user who finalized at the counter.
  completed_by UUID REFERENCES auth.users(id) ON DELETE SET NULL
);

-- One OPEN session per bidder — re-opening the pass page reuses it.
CREATE UNIQUE INDEX IF NOT EXISTS pickup_sessions_one_open_idx
  ON pickup_sessions (bidder_id)
  WHERE status = 'open';

CREATE INDEX IF NOT EXISTS pickup_sessions_bidder_idx ON pickup_sessions (bidder_id);

ALTER TABLE pickup_sessions ENABLE ROW LEVEL SECURITY;

-- Bidders read their own sessions (progress rendering). Writes go through
-- server routes with the service role; no direct client writes.
DROP POLICY IF EXISTS pickup_sessions_self_read ON pickup_sessions;
CREATE POLICY pickup_sessions_self_read ON pickup_sessions
  FOR SELECT USING (bidder_id = auth.uid());

-- Operator staff read everything (single-operator platform).
DROP POLICY IF EXISTS pickup_sessions_staff_read ON pickup_sessions;
CREATE POLICY pickup_sessions_staff_read ON pickup_sessions
  FOR SELECT USING (
    EXISTS (SELECT 1 FROM operator_users ou WHERE ou.user_id = auth.uid())
  );

-- Rollout toggle, default OFF.
ALTER TABLE platform_settings
  ADD COLUMN IF NOT EXISTS pickup_sessions_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;
