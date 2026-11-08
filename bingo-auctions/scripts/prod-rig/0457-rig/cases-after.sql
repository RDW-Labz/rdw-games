-- Post-migration shape check.
SELECT 'member_warehouse_settings exists: ' ||
  EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'member_warehouse_settings');
SELECT 'member_waitlist exists: ' ||
  EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'member_waitlist');
SELECT 'member_slot_bookings exists: ' ||
  EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'member_slot_bookings');
SELECT 'member_inspections exists: ' ||
  EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'member_inspections');
SELECT 'operator_pro_plans new column count (expect 19 -- 12 original + 7 added 2026-10-26): ' || count(*)
  FROM information_schema.columns WHERE table_name = 'operator_pro_plans'
  AND column_name IN ('billing_interval','intro_price_cents','intro_months','intro_seats','member_cap',
    'past_due_grace_days','early_access_minutes','perk_inspection_before_pickup','perk_scheduled_pickup_slots',
    'perk_early_building_access','perk_longer_pickup_window','perk_payment_grace',
    'standard_pickup_allowance_qty','standard_pickup_allowance_unit','large_order_slot_minutes',
    'large_order_fee_enabled','large_order_fee_cents','inspections_per_member_month','max_active_slots_per_member');
SELECT 'member_warehouse_settings new column count (expect 3, added 2026-10-26): ' || count(*)
  FROM information_schema.columns WHERE table_name = 'member_warehouse_settings'
  AND column_name IN ('large_orders_per_day','standard_pickup_allowance_qty_override','standard_pickup_allowance_unit_override');
SELECT 'bidder_subscriptions new column count (expect 3): ' || count(*)
  FROM information_schema.columns WHERE table_name = 'bidder_subscriptions'
  AND column_name IN ('intro_applied','square_subscription_id','past_due_since');
SELECT 'operator_pro_plans price_cents default: ' || column_default
  FROM information_schema.columns WHERE table_name = 'operator_pro_plans' AND column_name = 'price_cents';
SELECT 'operator_pro_plans active default: ' || column_default
  FROM information_schema.columns WHERE table_name = 'operator_pro_plans' AND column_name = 'active';
