-- Minimal seed for the hosted Supabase project. Just the operator(s)
-- and a single warehouse + a few bins so the field-mobile flows have
-- something to render against. Auctions / lots come later via the
-- intake + lotting flows on the app.
--
-- Uses the same UUIDs as the local dev_seed.sql so cross-environment
-- references stay readable.

INSERT INTO operators (
  id, slug, business_name, contact_email, status,
  code, next_lot_seq,
  monthly_subscription_cents, application_fee_bps,
  default_buyer_premium_bps, default_soft_close_minutes
) VALUES (
  '11111111-1111-1111-1111-111111111111',
  'cluer-test',
  'Cluer Test Auctions',
  'michael@cluerholdings.com',
  'active',
  'CLU',
  1,
  9900, 200, 1500, 3
) ON CONFLICT (id) DO NOTHING;

INSERT INTO warehouses (
  id, operator_id, name,
  address_line1, city, state, postal_code,
  floor_plan_width_px, floor_plan_height_px
) VALUES (
  '22222222-2222-2222-2222-222222222222',
  '11111111-1111-1111-1111-111111111111',
  'Main Warehouse',
  '123 Test St', 'Springdale', 'AR', '72762',
  1000, 700
) ON CONFLICT (id) DO NOTHING;

-- Six starter bins so the field-mobile bin-landmarks flow has rows to
-- render. Operator can add more from the operator-web /warehouses
-- page.
INSERT INTO bins (id, warehouse_id, code, aisle, x_px, y_px, qr_token)
VALUES
  ('33333333-3333-3333-3333-333333333301', '22222222-2222-2222-2222-222222222222', 'A-01', 'A', 120, 120, gen_random_uuid()),
  ('33333333-3333-3333-3333-333333333302', '22222222-2222-2222-2222-222222222222', 'A-02', 'A', 220, 120, gen_random_uuid()),
  ('33333333-3333-3333-3333-333333333303', '22222222-2222-2222-2222-222222222222', 'A-03', 'A', 320, 120, gen_random_uuid()),
  ('33333333-3333-3333-3333-333333333304', '22222222-2222-2222-2222-222222222222', 'B-01', 'B', 120, 320, gen_random_uuid()),
  ('33333333-3333-3333-3333-333333333305', '22222222-2222-2222-2222-222222222222', 'B-02', 'B', 220, 320, gen_random_uuid()),
  ('33333333-3333-3333-3333-333333333306', '22222222-2222-2222-2222-222222222222', 'B-03', 'B', 320, 320, gen_random_uuid())
ON CONFLICT (id) DO NOTHING;
