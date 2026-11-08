-- ============================================================================
-- Per-organization Pro subscriptions + delayed-settlement marketplace model.
--
-- Two big shifts from earlier phases:
--   1. Bidder Pro is now PER OPERATOR (not platform-wide). Each operator
--      runs their own Pro tier: their price, their perks. A bidder can be
--      Pro at Acme and at NW Returns simultaneously — separate Stripe
--      subscriptions, separate state.
--   2. Marketplace money flow switches from Stripe destination charges
--      (immediate routing to the operator's Connect account) to
--      "separate charges and transfers": bidder pays the platform; the
--      platform holds funds for `settlement_hold_days` (default 4) to cover
--      returns / disputes; then a worker transfers the operator's share to
--      their Connect account.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Operators: Pro tier config + settlement hold window
-- ----------------------------------------------------------------------------

ALTER TABLE operators
  ADD COLUMN IF NOT EXISTS pro_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS pro_monthly_cents INTEGER NOT NULL DEFAULT 499,
  ADD COLUMN IF NOT EXISTS pro_stripe_product_id TEXT,
  ADD COLUMN IF NOT EXISTS pro_stripe_price_id TEXT,
  ADD COLUMN IF NOT EXISTS pro_early_access_minutes INTEGER NOT NULL DEFAULT 30,
  ADD COLUMN IF NOT EXISTS pro_msrp_filter_enabled BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS pro_last_chance_members_only BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS settlement_hold_days INTEGER NOT NULL DEFAULT 4;

-- ----------------------------------------------------------------------------
-- Per-operator bidder subscriptions
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS bidder_subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  bidder_id UUID NOT NULL REFERENCES bidders(id) ON DELETE CASCADE,
  operator_id UUID NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  stripe_subscription_id TEXT UNIQUE,
  status subscription_status NOT NULL DEFAULT 'none',
  current_period_end TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (bidder_id, operator_id)
);

CREATE INDEX IF NOT EXISTS bidder_subscriptions_bidder_idx
  ON bidder_subscriptions (bidder_id);
CREATE INDEX IF NOT EXISTS bidder_subscriptions_operator_active_idx
  ON bidder_subscriptions (operator_id)
  WHERE status IN ('active', 'trialing');

ALTER TABLE bidder_subscriptions ENABLE ROW LEVEL SECURITY;

CREATE POLICY bidder_subs_self_read ON bidder_subscriptions
  FOR SELECT USING (bidder_id = auth.uid());

-- Operator staff can see active subscriptions to their org (for analytics +
-- support). Bidder PII still gated by the bidders table policy.
CREATE POLICY bidder_subs_operator_read ON bidder_subscriptions
  FOR SELECT USING (operator_id = current_operator_id());

-- updated_at trigger
CREATE TRIGGER bidder_subscriptions_set_updated_at
  BEFORE UPDATE ON bidder_subscriptions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------
-- Operator settlements: tracks money the platform owes each operator from
-- paid invoices. One row per invoice. status flow:
--   held       — bidder paid, hold window not yet expired
--   releasable — hold expired, ready for the settlement worker to pick up
--   transferred — transfer to operator's Connect succeeded
--   voided     — invoice fully refunded before transfer; nothing to settle
-- ----------------------------------------------------------------------------

CREATE TYPE settlement_status AS ENUM ('held', 'releasable', 'transferred', 'voided');

CREATE TABLE IF NOT EXISTS operator_settlements (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  operator_id UUID NOT NULL REFERENCES operators(id) ON DELETE RESTRICT,
  invoice_id UUID NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  -- Operator's share = invoice subtotal + buyer_premium - application_fee.
  -- Refunds reduce it (within window) or trigger a clawback (after window).
  amount_cents BIGINT NOT NULL,
  application_fee_cents BIGINT NOT NULL,
  refund_cents BIGINT NOT NULL DEFAULT 0,
  status settlement_status NOT NULL DEFAULT 'held',
  release_at TIMESTAMPTZ NOT NULL,
  stripe_transfer_id TEXT UNIQUE,
  transferred_at TIMESTAMPTZ,
  last_error TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (invoice_id)
);

CREATE INDEX IF NOT EXISTS operator_settlements_operator_idx
  ON operator_settlements (operator_id);
CREATE INDEX IF NOT EXISTS operator_settlements_releasable_idx
  ON operator_settlements (release_at)
  WHERE status IN ('held', 'releasable');

ALTER TABLE operator_settlements ENABLE ROW LEVEL SECURITY;
CREATE POLICY operator_settlements_staff_read ON operator_settlements
  FOR SELECT USING (operator_id = current_operator_id());

CREATE TRIGGER operator_settlements_set_updated_at
  BEFORE UPDATE ON operator_settlements
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ----------------------------------------------------------------------------
-- is_subscriber(operator_id) — replaces the old global function. Returns
-- true if the calling bidder has an active sub to that operator. Default
-- argument NULL means "any operator", preserved for backward compat (some
-- old code paths might still call without args; they get a permissive
-- check that matches old behavior).
-- ----------------------------------------------------------------------------

-- CASCADE drops the no-arg function plus any policies still bound to
-- it (e.g. lots_bidder_read_published from migration 0008). The policy
-- is recreated below against the new (operator-scoped) signature.
DROP FUNCTION IF EXISTS is_subscriber() CASCADE;

CREATE OR REPLACE FUNCTION is_subscriber(p_operator_id UUID DEFAULT NULL)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM bidder_subscriptions
    WHERE bidder_id = auth.uid()
      AND status IN ('active', 'trialing')
      AND (current_period_end IS NULL OR current_period_end > now())
      AND (p_operator_id IS NULL OR operator_id = p_operator_id)
  );
$$;

-- Refresh the lots RLS policy to scope early-access by the lot's operator.
DROP POLICY IF EXISTS lots_bidder_read_published ON lots;
CREATE POLICY lots_bidder_read_published ON lots
  FOR SELECT USING (
    is_bidder()
    AND status IN ('scheduled', 'live', 'won', 'unsold', 'relisted')
    AND (
      early_access_until IS NULL
      OR early_access_until <= now()
      OR is_subscriber(operator_id)
    )
  );
