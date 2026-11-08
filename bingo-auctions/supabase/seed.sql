-- ============================================================================
-- Dev seed data — for local Supabase only
--
-- Creates: 1 operator, 1 warehouse with floor plan dimensions, 6 bins,
-- 1 auction with 4 lots in 'scheduled' status. No bidders or bids — those
-- come from end-to-end test fixtures.
-- ============================================================================

INSERT INTO operators (
  id, slug, business_name, contact_email, status,
  monthly_subscription_cents, application_fee_bps,
  default_buyer_premium_bps, default_soft_close_minutes
) VALUES (
  '11111111-1111-1111-1111-111111111111',
  'bingo',
  'BinGo Auctions',
  'admin@bingoauctions.com',
  'active',
  0, 0, 1500, 3
) ON CONFLICT (id) DO NOTHING;

INSERT INTO warehouses (
  id, operator_id, name, address_line1, city, state, postal_code,
  floor_plan_width_px, floor_plan_height_px
) VALUES (
  '22222222-2222-2222-2222-222222222222',
  '11111111-1111-1111-1111-111111111111',
  'BinGo Warehouse',
  '123 Auction Way',
  'Cincinnati', 'OH', '45202',
  2000, 1500
) ON CONFLICT (id) DO NOTHING;

-- 6 bins arranged in 2 aisles
INSERT INTO bins (warehouse_id, code, aisle, bay, level, position, x_px, y_px) VALUES
  ('22222222-2222-2222-2222-222222222222', 'A-01-1-01', 'A', '01', 1, 1, 200, 300),
  ('22222222-2222-2222-2222-222222222222', 'A-01-1-02', 'A', '01', 1, 2, 400, 300),
  ('22222222-2222-2222-2222-222222222222', 'A-02-1-01', 'A', '02', 1, 1, 200, 600),
  ('22222222-2222-2222-2222-222222222222', 'A-02-1-02', 'A', '02', 1, 2, 400, 600),
  ('22222222-2222-2222-2222-222222222222', 'B-01-1-01', 'B', '01', 1, 1, 1200, 300),
  ('22222222-2222-2222-2222-222222222222', 'B-01-1-02', 'B', '01', 1, 2, 1400, 300)
ON CONFLICT (warehouse_id, code) DO NOTHING;

INSERT INTO auctions (
  id, operator_id, warehouse_id, title,
  starts_at, ends_at, soft_close_minutes,
  pickup_starts_at, pickup_ends_at, buyer_premium_bps, status
) VALUES (
  '33333333-3333-3333-3333-333333333333',
  '11111111-1111-1111-1111-111111111111',
  '22222222-2222-2222-2222-222222222222',
  'Test Auction — Mixed Inventory',
  now(),
  now() + interval '1 day',
  3,
  now() + interval '1 day' + interval '4 hours',
  now() + interval '4 days',
  1500, 'scheduled'
) ON CONFLICT (id) DO NOTHING;

INSERT INTO lots (
  operator_id, auction_id, warehouse_id, lot_number, title, description,
  category, condition, msrp_cents, starting_bid_cents, close_at, status
) VALUES
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333',
   '22222222-2222-2222-2222-222222222222', 1,
   'Test Lot — Apple AirPods Pro 2',
   'Sealed retail box. Amazon return.',
   'electronics', 'appears_new', 24900, 100,
   now() + interval '1 day', 'scheduled'),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333',
   '22222222-2222-2222-2222-222222222222', 2,
   'Test Lot — KitchenAid Stand Mixer',
   'Open box, all parts accounted for.',
   'home', 'open_box', 39900, 100,
   now() + interval '1 day' + interval '5 minutes', 'scheduled'),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333',
   '22222222-2222-2222-2222-222222222222', 3,
   'Test Lot — Dewalt 20V Drill Kit',
   'Used, working condition.',
   'tools', 'good', 14900, 100,
   now() + interval '1 day' + interval '10 minutes', 'scheduled'),
  ('11111111-1111-1111-1111-111111111111', '33333333-3333-3333-3333-333333333333',
   '22222222-2222-2222-2222-222222222222', 4,
   'Test Lot — Mystery Bin',
   'Sold as-is. Contents not photographed.',
   'mixed', 'as_is', NULL, 100,
   now() + interval '1 day' + interval '15 minutes', 'scheduled')
ON CONFLICT (auction_id, lot_number) DO NOTHING;
