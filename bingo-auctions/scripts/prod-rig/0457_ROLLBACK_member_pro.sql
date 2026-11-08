-- Rollback for 0457_member_pro.sql — standby only.
--
-- Safe at any hour, as long as no later PR has started writing to these
-- columns/tables. Prod has 0 rows in operator_pro_plans and 0 in
-- bidder_subscriptions as of 2026-10-26 (confirmed before 0457 was written),
-- and member_warehouse_settings / member_waitlist / member_slot_bookings /
-- member_inspections are all brand-new in 0457 — so this rollback is a pure
-- drop, nothing to export first, UNLESS this PR's console page (or, for the
-- two booking/inspection tables, a later PR) has since been used to create
-- rows. If so:
--   SELECT * FROM public.member_warehouse_settings;
--   SELECT * FROM public.member_waitlist;
--   SELECT * FROM public.member_slot_bookings;
--   SELECT * FROM public.member_inspections;
--   SELECT id, operator_id, billing_interval, intro_price_cents, intro_months,
--          intro_seats, member_cap, past_due_grace_days, early_access_minutes,
--          standard_pickup_allowance_qty, standard_pickup_allowance_unit,
--          large_order_slot_minutes, large_order_fee_enabled, large_order_fee_cents,
--          inspections_per_member_month, max_active_slots_per_member
--     FROM public.operator_pro_plans;
--
-- Locks: DROP COLUMN / DROP CONSTRAINT take a brief ACCESS EXCLUSIVE lock on
-- operator_pro_plans, member_warehouse_settings and bidder_subscriptions
-- (metadata-only, no rewrite — all three tables are tiny). DROP TABLE on the
-- four new tables takes ACCESS EXCLUSIVE on themselves only (nothing else
-- references them). No hot-table lock anywhere in this rollback.

SET lock_timeout = '3s';

BEGIN;

-- (4) bidder_subscriptions — drop what 0457 added.
DROP INDEX IF EXISTS public.bidder_subscriptions_square_sub_idx;

ALTER TABLE public.bidder_subscriptions
  DROP COLUMN IF EXISTS past_due_since,
  DROP COLUMN IF EXISTS square_subscription_id,
  DROP COLUMN IF EXISTS intro_applied;

-- (8) member_inspections — new table, drop whole (reverse order of apply).
DROP TRIGGER IF EXISTS member_inspections_set_updated_at ON public.member_inspections;
DROP TRIGGER IF EXISTS member_inspections_operator_guard ON public.member_inspections;
DROP TABLE IF EXISTS public.member_inspections;
DROP FUNCTION IF EXISTS public.member_inspections_check_operator();

-- (7) member_slot_bookings — new table, drop whole.
DROP TRIGGER IF EXISTS member_slot_bookings_set_updated_at ON public.member_slot_bookings;
DROP TRIGGER IF EXISTS member_slot_bookings_operator_guard ON public.member_slot_bookings;
DROP TABLE IF EXISTS public.member_slot_bookings;
DROP FUNCTION IF EXISTS public.member_slot_bookings_check_operator();

-- (6) member_warehouse_settings — drop 0457's large-order + allowance-override columns.
ALTER TABLE public.member_warehouse_settings
  DROP COLUMN IF EXISTS standard_pickup_allowance_unit_override,
  DROP COLUMN IF EXISTS standard_pickup_allowance_qty_override,
  DROP COLUMN IF EXISTS large_orders_per_day;

-- (3) member_waitlist — new table, drop whole.
DROP TABLE IF EXISTS public.member_waitlist;

-- (2) member_warehouse_settings — new table + its trigger/function, drop whole.
DROP TRIGGER IF EXISTS member_warehouse_settings_set_updated_at ON public.member_warehouse_settings;
DROP TRIGGER IF EXISTS member_warehouse_settings_operator_guard ON public.member_warehouse_settings;
DROP TABLE IF EXISTS public.member_warehouse_settings;
DROP FUNCTION IF EXISTS public.member_warehouse_settings_check_operator();

-- (5)+(1) operator_pro_plans — drop 0457's columns (including the 2026-10-26
-- additions), restore the 0177 price_cents constraint + remove the 0457
-- DEFAULT (0177 had none).
ALTER TABLE public.operator_pro_plans
  DROP CONSTRAINT IF EXISTS operator_pro_plans_large_order_fee_check;

ALTER TABLE public.operator_pro_plans
  DROP COLUMN IF EXISTS max_active_slots_per_member,
  DROP COLUMN IF EXISTS inspections_per_member_month,
  DROP COLUMN IF EXISTS large_order_fee_cents,
  DROP COLUMN IF EXISTS large_order_fee_enabled,
  DROP COLUMN IF EXISTS large_order_slot_minutes,
  DROP COLUMN IF EXISTS standard_pickup_allowance_unit,
  DROP COLUMN IF EXISTS standard_pickup_allowance_qty,
  DROP COLUMN IF EXISTS perk_payment_grace,
  DROP COLUMN IF EXISTS perk_longer_pickup_window,
  DROP COLUMN IF EXISTS perk_early_building_access,
  DROP COLUMN IF EXISTS perk_scheduled_pickup_slots,
  DROP COLUMN IF EXISTS perk_inspection_before_pickup,
  DROP COLUMN IF EXISTS early_access_minutes,
  DROP COLUMN IF EXISTS past_due_grace_days,
  DROP COLUMN IF EXISTS member_cap,
  DROP COLUMN IF EXISTS intro_seats,
  DROP COLUMN IF EXISTS intro_months,
  DROP COLUMN IF EXISTS intro_price_cents,
  DROP COLUMN IF EXISTS billing_interval;

ALTER TABLE public.operator_pro_plans
  ALTER COLUMN price_cents DROP DEFAULT;

ALTER TABLE public.operator_pro_plans
  ALTER COLUMN active SET DEFAULT true;

ALTER TABLE public.operator_pro_plans
  DROP CONSTRAINT IF EXISTS operator_pro_plans_price_cents_check;

ALTER TABLE public.operator_pro_plans
  ADD CONSTRAINT operator_pro_plans_price_cents_check
  CHECK (price_cents BETWEEN 99 AND 4999);

-- staging_prep's meaning (0457 repurposed it as a perk on/off switch) is a
-- COMMENT-only change in 0457; nothing to roll back structurally. If restoring
-- the literal 0177 comment matters, re-run 0177's COMMENT ON COLUMN manually.

COMMIT;
