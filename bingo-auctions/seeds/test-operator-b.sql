-- ============================================================================
-- seeds/test-operator-b.sql
--
-- A second test operator for cross-tenant RLS isolation tests.
--
-- Why: until now we had only operator CLU (Cluer Test Auctions). Multi-
-- tenancy is the platform's core security contract, but with one operator
-- we couldn't actually verify that operator A is blocked from reading or
-- writing operator B's data — every RLS test was a hypothetical. This
-- seed creates a second operator (TST = "Test Operator B"), a warehouse
-- and a bin so basic field-mobile flows render, and a stub auction
-- to exercise auction-scoped RLS too.
--
-- The auth user (test-b@bidwizops.local) is created OUT OF BAND via the
-- companion script scripts/seed-test-operator-b.js — auth.users requires
-- the admin API, not raw SQL. After that script runs, an operator_users
-- row links the user to TST.
--
-- IDs follow the dev convention of repeated-octet UUIDs for visual
-- distinction in logs:
--   33333333-… = operator TST
--   44444444-… = TST's warehouse
--   55555555-… = TST's first bin
--
-- Idempotent: ON CONFLICT DO NOTHING throughout. Safe to re-run.
-- ============================================================================

INSERT INTO operators (
  id, slug, business_name, contact_email, status,
  code, next_lot_seq,
  monthly_subscription_cents, application_fee_bps,
  default_buyer_premium_bps, default_soft_close_minutes
) VALUES (
  '33333333-3333-3333-3333-333333333333',
  'test-operator-b',
  'Test Operator B',
  'test-b@bidwizops.local',
  'active',
  'TST',
  1,
  9900, 200, 1500, 3
) ON CONFLICT (id) DO NOTHING;

-- Warehouse for TST. Lots that get created against operator TST will land
-- here when the intake flow asks for a warehouse.
INSERT INTO warehouses (
  id, operator_id, name,
  address_line1, city, state, postal_code,
  floor_plan_width_px, floor_plan_height_px
) VALUES (
  '44444444-4444-4444-4444-444444444444',
  '33333333-3333-3333-3333-333333333333',
  'TST Main Warehouse',
  '999 Tenant Way', 'Bentonville', 'AR', '72712',
  1000, 700
) ON CONFLICT (id) DO NOTHING;

-- Single starter bin. Field-mobile needs at least one bin per operator
-- for the picker workflows to render anything.
-- qr_token is UUID (not text) — using a deterministic value here so we
-- don't break uniqueness if this seed is applied multiple times across
-- environments. Real bins use uuid_generate_v4() default.
INSERT INTO bins (id, warehouse_id, code, aisle, x_px, y_px, qr_token)
VALUES (
  '55555555-5555-5555-5555-555555555555',
  '44444444-4444-4444-4444-444444444444',
  'TST-A1',
  'A',
  100,
  100,
  '66666666-6666-6666-6666-666666666666'
) ON CONFLICT (id) DO NOTHING;
