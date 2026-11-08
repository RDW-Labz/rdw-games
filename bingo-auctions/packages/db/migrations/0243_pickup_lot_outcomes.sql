-- 0243 — per-lot pickup outcomes: missing items + partial checkout
-- (Jared test findings #5/#6, owner-approved 2026-07-06)
--
-- Staff at the counter can now mark each lot of a pickup as:
--   collected    — handed over (the default assumption at completion)
--   missing      — can't be located; checkout proceeds WITHOUT it and the
--                  row becomes a standing "refund me" work item (refund
--                  itself stays a human action on the invoice page —
--                  never automatic; resolved_at closes the loop)
--   left_behind  — customer is coming back for it (truck full); the
--                  invoice's pickup stays OPEN and the lot reappears on
--                  the customer's next Pickup pass visit
--
-- Absence of a row = collected-at-completion (today's behavior), so the
-- common all-good pickup needs zero extra clicks.
--
-- Plain DDL, transactional, idempotent.

BEGIN;

CREATE TABLE IF NOT EXISTS pickup_lot_outcomes (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  pickup_id UUID NOT NULL REFERENCES pickups(id) ON DELETE CASCADE,
  lot_id UUID NOT NULL REFERENCES lots(id) ON DELETE CASCADE,
  outcome TEXT NOT NULL CHECK (outcome IN ('collected', 'missing', 'left_behind')),
  note TEXT,
  decided_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- For 'missing': stamped once the refund (or other resolution) is done.
  resolved_at TIMESTAMPTZ,
  UNIQUE (pickup_id, lot_id)
);

CREATE INDEX IF NOT EXISTS pickup_lot_outcomes_missing_idx
  ON pickup_lot_outcomes (created_at)
  WHERE outcome = 'missing' AND resolved_at IS NULL;

ALTER TABLE pickup_lot_outcomes ENABLE ROW LEVEL SECURITY;

-- Staff-only. Bidder-facing reads happen server-side via the service role.
DROP POLICY IF EXISTS pickup_lot_outcomes_staff_all ON pickup_lot_outcomes;
CREATE POLICY pickup_lot_outcomes_staff_all ON pickup_lot_outcomes
  FOR ALL USING (
    EXISTS (SELECT 1 FROM operator_users ou WHERE ou.user_id = auth.uid())
  );

COMMIT;
