-- ============================================================================
-- Migration 0177 — Operator memberships ("Pro per operator"), schema layer.
--
-- Implements PLAN docs/plans/PLAN-operator-memberships-2026-06-03.md §5
-- ("Option B-lite"): the lowest-regression way to give each operator a
-- customizable paid bidder-membership with the 3 real-world perks
-- (extended pickup window, extra payment grace, staging & prep), sold by the
-- operator to their bidders, with the platform skimming a flat commission.
--
-- This migration is the SCHEMA layer ONLY (Phase 0 of the rollout). The money
-- flow (destination-charge subscriptions), webhook deltas, perk-enforcement
-- hooks, and UI all land in later PRs. Nothing here changes behavior for any
-- existing consumer.
--
-- WHAT THIS DOES
-- --------------
--   (1) NEW table operator_pro_plans — holds the per-operator perk magnitudes
--       + the plan's Stripe Product/Price (which live on the PLATFORM account,
--       the correct topology for destination charges). RLS enabled.
--   (2) ADD nullable bidder_subscriptions.plan_id — purely additive; every
--       existing row, is_subscriber(), the webhook upsert, useOperatorFeatures()
--       and the account-deletion cascades keep working untouched (the column is
--       nullable and nothing reads it yet).
--   (2b) ADD operators.membership_fee_bps — the platform's flat % cut of
--        membership revenue, mirroring operators.application_fee_bps. Applied
--        later as application_fee_percent on the Connect subscription. This is
--        intentionally NOT the tiered GMV bracket rate (mig 0087) — a Stripe
--        subscription fee can only be one flat percent.
--   (3) Helper my_active_pro_plan(operator_id) for client/RLS paths.
--   (4) Idempotent data migration: seed one 'Pro' plan per currently
--       pro_enabled operator from the legacy operators.pro_* columns, then
--       backfill that operator's active bidder_subscriptions.plan_id.
--
-- CONVENTION COMPLIANCE (verified against the codebase)
-- -----------------------------------------------------
--   * Cents as INTEGER … _cents with a >= 99 floor — matches
--     operators.pro_monthly_cents (0013:23) + saveProSettings' z.min(99).
--   * RLS helper calls PRE-WRAPPED in (SELECT …) per mig 0133 (initPlan
--     once-per-query, not once-per-row). 0133's verification asserts zero
--     unwrapped calls — every new policy below ships wrapped.
--   * subscription_status enum REUSED (0008) — no new status type invented.
--   * set_updated_at() trigger + active BOOLEAN soft-disable — house patterns.
--   * uuid_generate_v4() PK default + operators(id) ON DELETE CASCADE — house
--     patterns (cf. bidder_subscriptions 0013:35-38).
--
-- RED-TEAM FIX (docs/audits/redteam-plans-2026-06-03.md, "operator_pro_plans
-- anon leak", HIGH)
-- ------------------------------------------------------------------------
--   The public-read policy MUST gate on (SELECT is_bidder()). Without it an
--   unauthenticated caller holding the public anon key could enumerate every
--   operator's Stripe Product/Price IDs over the internet (same exposure class
--   as the 0028 H3 fix, but reaching anon). The stripe_product_id /
--   stripe_price_id columns are resolved SERVER-SIDE via service-role in the
--   checkout flow — a bidder/anon client never needs to read them.
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT TOUCH (PLAN §5 + §10)
-- --------------------------------------------------------------
--   * is_subscriber() (0013:126) — left exactly as-is (RLS-critical primitive).
--   * lots_bidder_read_published (0013:144) — the dropped early-access perk's
--     RLS clause is left INERT; dead-clause cleanup is a separate follow-up
--     migration, not gratuitous RLS risk here.
--
-- Numbering: master/worktree max = 0176; next = 0177. (Memberships = 0177,
-- the live-test patch plan = 0178+, per red-team COH-1 to avoid a 0177
-- collision.)
--
-- Idempotent: CREATE TABLE / ADD COLUMN IF NOT EXISTS, NOT-EXISTS-guarded
-- seed. Safe to re-run. Wrapped in a single BEGIN/COMMIT.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- (1) NEW: operator-defined membership plans (operator-scoped)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS operator_pro_plans (
  id                   UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  operator_id          UUID NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  name                 TEXT NOT NULL,
  price_cents          INTEGER NOT NULL CHECK (price_cents BETWEEN 99 AND 4999),  -- operator picks $0.99–$49.99 (decision #4)
  -- the 3 real-world perks (magnitudes / flags) --------------------------------
  extended_pickup_days INTEGER NOT NULL DEFAULT 0 CHECK (extended_pickup_days BETWEEN 0 AND 30),
  extra_grace_hours    INTEGER NOT NULL DEFAULT 0 CHECK (extra_grace_hours BETWEEN 0 AND 168),
  staging_prep         BOOLEAN NOT NULL DEFAULT false,
  active               BOOLEAN NOT NULL DEFAULT true,
  -- Stripe (Product/Price live on the PLATFORM account — correct for
  -- destination charges; minted via the ensureProProductAndPrice() pattern).
  -- These are NOT exposed to bidder/anon clients: the public_read policy below
  -- still returns the row, but the checkout flow resolves the Price server-side
  -- by planId via service-role, so a client never needs to read these IDs.
  stripe_product_id    TEXT,
  stripe_price_id      TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS operator_pro_plans_operator_idx
  ON operator_pro_plans (operator_id)
  WHERE active;

ALTER TABLE operator_pro_plans ENABLE ROW LEVEL SECURITY;

-- public_read — bidders may read ACTIVE plans of ACTIVE operators (to subscribe).
--
-- RED-TEAM FIX (HIGH, "operator_pro_plans anon leak"): the (SELECT is_bidder())
-- gate is MANDATORY. Without it an unauthenticated anon-key caller would
-- enumerate every operator's Stripe Product/Price IDs over the internet. The
-- gate restricts reads to authenticated bidders; anon gets nothing. (RLS
-- helper pre-wrapped in (SELECT …) per mig 0133.)
CREATE POLICY operator_pro_plans_public_read ON operator_pro_plans
  FOR SELECT USING (
    active = true
    AND (SELECT is_bidder())
    AND EXISTS (
      SELECT 1 FROM operators o
      WHERE o.id = operator_pro_plans.operator_id
        AND o.status = 'active'
    )
  );

-- staff_read / staff_insert / staff_update / staff_delete — operator-scoped,
-- with write paths gated to admin/manager (delete to admin only). All RLS
-- helper calls pre-wrapped per mig 0133.
CREATE POLICY operator_pro_plans_staff_read ON operator_pro_plans
  FOR SELECT USING (operator_id = (SELECT current_operator_id()));

CREATE POLICY operator_pro_plans_staff_insert ON operator_pro_plans
  FOR INSERT WITH CHECK (
    operator_id = (SELECT current_operator_id())
    AND (SELECT current_operator_role()) IN ('admin', 'manager')
  );

CREATE POLICY operator_pro_plans_staff_update ON operator_pro_plans
  FOR UPDATE USING (
    operator_id = (SELECT current_operator_id())
    AND (SELECT current_operator_role()) IN ('admin', 'manager')
  )
  WITH CHECK (
    operator_id = (SELECT current_operator_id())
    AND (SELECT current_operator_role()) IN ('admin', 'manager')
  );

CREATE POLICY operator_pro_plans_staff_delete ON operator_pro_plans
  FOR DELETE USING (
    operator_id = (SELECT current_operator_id())
    AND (SELECT current_operator_role()) = 'admin'
  );

CREATE TRIGGER operator_pro_plans_set_updated_at
  BEFORE UPDATE ON operator_pro_plans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMENT ON TABLE operator_pro_plans IS
  'Per-operator paid bidder-membership plans (mig 0177, PLAN §5 Option B-lite). '
  'Holds the 3 real-world perk magnitudes (extended_pickup_days, extra_grace_hours, '
  'staging_prep) + the plan''s Stripe Product/Price (which live on the PLATFORM '
  'account, for destination charges). stripe_product_id/stripe_price_id are '
  'resolved server-side via service-role in checkout — bidder/anon never need '
  'them (see public_read policy + the is_bidder() red-team gate).';

-- ----------------------------------------------------------------------------
-- (2) EXTEND existing subs table — purely additive
-- ----------------------------------------------------------------------------
-- Nullable so all existing rows + is_subscriber()/webhook/cascades keep working
-- untouched. ON DELETE RESTRICT: a plan with live subs cannot be hard-deleted
-- (operators soft-disable via active=false instead).
ALTER TABLE bidder_subscriptions
  ADD COLUMN IF NOT EXISTS plan_id UUID REFERENCES operator_pro_plans(id) ON DELETE RESTRICT;

COMMENT ON COLUMN bidder_subscriptions.plan_id IS
  'mig 0177: links a subscription to its operator_pro_plans row. Nullable — '
  'legacy rows + is_subscriber()/webhook/deletion-cascades are unaffected. The '
  'webhook upsert starts populating it in the money-flow PR.';

-- ----------------------------------------------------------------------------
-- (2b) Platform membership commission — ONE flat knob (mirrors application_fee_bps)
-- ----------------------------------------------------------------------------
-- The platform's % cut of membership revenue, applied later as
-- application_fee_percent = membership_fee_bps / 100 on the Connect
-- destination-charge subscription. Default 500 = 5.00% (owner sets 4–5% before
-- launch). Super-admin-editable. This is NOT the tiered/bracketed GMV rate
-- (compute_application_fee_cents / mig 0087) — a Stripe subscription fee can
-- only be one flat percent.
ALTER TABLE operators
  ADD COLUMN IF NOT EXISTS membership_fee_bps INTEGER NOT NULL DEFAULT 500
  CHECK (membership_fee_bps BETWEEN 0 AND 10000);

COMMENT ON COLUMN operators.membership_fee_bps IS
  'mig 0177: platform commission on membership revenue, in basis points '
  '(500 = 5.00%). Applied as application_fee_percent on the Connect membership '
  'subscription. Flat — distinct from the tiered GMV brackets (mig 0087).';

-- ----------------------------------------------------------------------------
-- (3) Plan-aware helper for CLIENT / RLS paths (where auth.uid() is set).
-- ----------------------------------------------------------------------------
-- Returns the calling bidder's active plan at the given operator, or no row.
-- SECURITY DEFINER + STABLE, mirroring is_subscriber()'s active/trialing +
-- unexpired predicate.
--
-- 🛑 DO NOT call this from a pg_cron job (PLAN §7 / §10 #2): cron has no
-- auth.uid() → it would return NULL/empty. The perk crons MUST inline the
-- join keyed on the invoice's bidder_id instead.
CREATE OR REPLACE FUNCTION my_active_pro_plan(p_operator_id UUID)
RETURNS operator_pro_plans
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.*
  FROM bidder_subscriptions s
  JOIN operator_pro_plans p ON p.id = s.plan_id
  WHERE s.bidder_id = auth.uid()
    AND s.operator_id = p_operator_id
    AND s.status IN ('active', 'trialing')
    AND (s.current_period_end IS NULL OR s.current_period_end > now())
  LIMIT 1;
$$;

COMMENT ON FUNCTION my_active_pro_plan(UUID) IS
  'mig 0177 (PLAN §5): the calling bidder''s active membership plan at the given '
  'operator, or no row. For client/RLS paths only — never call from pg_cron '
  '(no auth.uid() there; crons inline the join on the invoice bidder_id).';

-- ----------------------------------------------------------------------------
-- (4) DATA MIGRATION — seed one 'Pro' plan per currently pro_enabled operator
--     + backfill that operator's active bidder_subscriptions.plan_id.
-- ----------------------------------------------------------------------------
-- Maps the legacy operators.pro_monthly_cents + pro_stripe_* into a default
-- 'Pro' plan (perks 0/0/false — operators tune them in the new editor). The
-- NOT EXISTS guard makes this idempotent: a re-run after a plan already exists
-- for an operator is a no-op (avoids duplicate seed rows).
INSERT INTO operator_pro_plans (
  operator_id, name, price_cents,
  extended_pickup_days, extra_grace_hours, staging_prep,
  active, stripe_product_id, stripe_price_id
)
SELECT
  o.id,
  'Pro',
  GREATEST(o.pro_monthly_cents, 99),  -- clamp to the price_cents floor (legacy default is 499; safe)
  0, 0, false,
  true,
  o.pro_stripe_product_id,
  o.pro_stripe_price_id
FROM operators o
WHERE o.pro_enabled = true
  AND NOT EXISTS (
    SELECT 1 FROM operator_pro_plans p
    WHERE p.operator_id = o.id
  );

-- Backfill live subs: point each active/trialing subscription at its operator's
-- seeded default plan. Guarded to rows that still have a NULL plan_id and to
-- operators that have exactly one plan (the seeded default), so a re-run or a
-- multi-plan operator is never mis-mapped.
UPDATE bidder_subscriptions s
SET plan_id = p.id,
    updated_at = now()
FROM operator_pro_plans p
WHERE p.operator_id = s.operator_id
  AND s.plan_id IS NULL
  AND s.status IN ('active', 'trialing')
  AND (
    SELECT count(*) FROM operator_pro_plans p2
    WHERE p2.operator_id = s.operator_id
  ) = 1;

COMMIT;
