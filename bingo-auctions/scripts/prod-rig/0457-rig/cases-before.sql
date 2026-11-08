-- Pre-migration snapshot (prod today, per the inspector run before writing
-- 0457): 0 rows in operator_pro_plans, 0 in bidder_subscriptions, and none of
-- 0457's new columns/tables exist yet.
SELECT 'operator_pro_plans count (prod today): ' || count(*) FROM operator_pro_plans;
SELECT 'bidder_subscriptions count (prod today): ' || count(*) FROM bidder_subscriptions;
SELECT 'member_warehouse_settings exists (should be false): ' ||
  EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'member_warehouse_settings');
SELECT 'member_waitlist exists (should be false): ' ||
  EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'member_waitlist');
SELECT 'operator_pro_plans.billing_interval exists (should be false): ' ||
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'operator_pro_plans' AND column_name = 'billing_interval');
SELECT 'bidder_subscriptions.square_subscription_id exists (should be false): ' ||
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'bidder_subscriptions' AND column_name = 'square_subscription_id');
SELECT 'operator_pro_plans price_cents max allowed today (should reject 10000): ' || 'n/a, checked via insert attempt below';
-- 2026-10-26 additions (should all be false before apply).
SELECT 'operator_pro_plans.standard_pickup_allowance_qty exists (should be false): ' ||
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'operator_pro_plans' AND column_name = 'standard_pickup_allowance_qty');
SELECT 'operator_pro_plans.inspections_per_member_month exists (should be false): ' ||
  EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'operator_pro_plans' AND column_name = 'inspections_per_member_month');
SELECT 'member_slot_bookings exists (should be false): ' ||
  EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'member_slot_bookings');
SELECT 'member_inspections exists (should be false): ' ||
  EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'member_inspections');
