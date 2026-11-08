-- 0476 rig seed: the TEA4842561 chain, synthetic (example.test).
--   old row  OLD1 (relisted), line on a payment_failed_relisted invoice (declined buyer)
--   new row  NEW1 (won), sticker RGV:TEA4842561, line on a paid invoice, REFUNDED
-- plus controls:
--   chain 2: old row on a declined invoice, new row with a LIVE paid line  -> new row
--   chain 3: old row picked up long ago, new row in_inventory              -> new row
--   chain 4: old row with an open paid line (genuinely still owed)          -> old row (unchanged)
\set ON_ERROR_STOP 1
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email text;
SET session_replication_role = replica;
INSERT INTO auth.users (id, email) VALUES
 ('00000000-0000-0000-0000-0000000000c1', 'station@example.test'),
 ('00000000-0000-0000-0000-0000000000e1', 'declined@example.test'),
 ('00000000-0000-0000-0000-0000000000e2', 'buyer@example.test');
INSERT INTO operators (id, slug, business_name, contact_email, code) VALUES
 ('00000000-0000-0000-0000-0000000000a1', 'rig476', 'Rig 476', 'o@example.test', 'RGV');
INSERT INTO warehouses (id, name, address_line1, operator_id, state, postal_code, city) VALUES
 ('00000000-0000-0000-0000-0000000000b1', 'Harrison', '1 St', '00000000-0000-0000-0000-0000000000a1', 'AR', '72601', 'Harrison');
INSERT INTO operator_users (operator_id, user_id, role, email) VALUES
 ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'admin', 'station@example.test');
INSERT INTO bidders (id, email, birth_date, display_name) VALUES
 ('00000000-0000-0000-0000-0000000000e1', 'declined@example.test', '1980-01-01', 'Declined Buyer'),
 ('00000000-0000-0000-0000-0000000000e2', 'buyer@example.test', '1980-01-01', 'Current Buyer');
INSERT INTO auctions (id, operator_id, warehouse_id, title, status, starts_at, ends_at, pickup_starts_at, pickup_ends_at)
SELECT ('00000000-0000-0000-0000-00000000aa0' || n)::uuid, '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1',
       'A' || n, 'closed', now()-interval '20 day' + n * interval '2 day', now()-interval '19 day' + n * interval '2 day',
       now()-interval '19 day' + n * interval '2 day', now()+interval '3 day'
  FROM generate_series(1, 8) n;

-- chain k: old row = 1k1, new row = 1k2 (created later)
INSERT INTO lots (id, operator_id, warehouse_id, auction_id, lot_number, title, lot_code, sticker_code, status, close_at, relisted_from_lot_id, created_at) VALUES
 ('00000000-0000-0000-0000-000000000111', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', NULL, NULL, 'OLD1', 'OLD1', NULL, 'relisted', NULL, NULL, now()-interval '20 day'),
 ('00000000-0000-0000-0000-000000000112', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000aa02', 1, 'NEW1', 'NEW1', 'RGV:TEA4842561', 'won', now()-interval '10 day', '00000000-0000-0000-0000-000000000111', now()-interval '12 day'),
 ('00000000-0000-0000-0000-000000000121', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', NULL, NULL, 'OLD2', 'OLD2', NULL, 'relisted', NULL, NULL, now()-interval '20 day'),
 ('00000000-0000-0000-0000-000000000122', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000aa04', 1, 'NEW2', 'NEW2', 'RGV:TEA0000002', 'won', now()-interval '10 day', '00000000-0000-0000-0000-000000000121', now()-interval '12 day'),
 ('00000000-0000-0000-0000-000000000131', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', NULL, NULL, 'OLD3', 'OLD3', NULL, 'relisted', NULL, NULL, now()-interval '20 day'),
 ('00000000-0000-0000-0000-000000000132', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', NULL, NULL, 'NEW3', 'NEW3', 'RGV:TEA0000003', 'in_inventory', NULL, '00000000-0000-0000-0000-000000000131', now()-interval '12 day'),
 ('00000000-0000-0000-0000-000000000141', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', NULL, NULL, 'OLD4', 'OLD4', NULL, 'relisted', NULL, NULL, now()-interval '20 day'),
 ('00000000-0000-0000-0000-000000000142', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', NULL, NULL, 'NEW4', 'NEW4', 'RGV:TEA0000004', 'in_inventory', NULL, '00000000-0000-0000-0000-000000000141', now()-interval '12 day');

INSERT INTO invoices (id, operator_id, auction_id, bidder_id, status, total_cents, paid_at) VALUES
 ('00000000-0000-0000-0000-0000000002a1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-0000000000e1', 'payment_failed_relisted', 881, NULL),
 ('00000000-0000-0000-0000-0000000002a2', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000aa02', '00000000-0000-0000-0000-0000000000e2', 'partially_refunded', 2393, now()-interval '9 day'),
 ('00000000-0000-0000-0000-0000000002a3', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000aa03', '00000000-0000-0000-0000-0000000000e1', 'payment_failed_relisted', 500, NULL),
 ('00000000-0000-0000-0000-0000000002a4', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000aa04', '00000000-0000-0000-0000-0000000000e2', 'paid', 500, now()-interval '9 day'),
 ('00000000-0000-0000-0000-0000000002a5', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000aa05', '00000000-0000-0000-0000-0000000000e1', 'paid', 500, now()-interval '19 day'),
 ('00000000-0000-0000-0000-0000000002a6', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000aa06', '00000000-0000-0000-0000-0000000000e1', 'paid', 500, now()-interval '19 day');
INSERT INTO invoice_lots (invoice_id, lot_id, winning_bid_cents, refunded_at, picked_up_at) VALUES
 ('00000000-0000-0000-0000-0000000002a1', '00000000-0000-0000-0000-000000000111', 700, NULL, NULL),
 ('00000000-0000-0000-0000-0000000002a2', '00000000-0000-0000-0000-000000000112', 1900, now()-interval '2 day', NULL),
 ('00000000-0000-0000-0000-0000000002a3', '00000000-0000-0000-0000-000000000121', 500, NULL, NULL),
 ('00000000-0000-0000-0000-0000000002a4', '00000000-0000-0000-0000-000000000122', 500, NULL, NULL),
 ('00000000-0000-0000-0000-0000000002a5', '00000000-0000-0000-0000-000000000131', 500, NULL, now()-interval '18 day'),
 ('00000000-0000-0000-0000-0000000002a6', '00000000-0000-0000-0000-000000000141', 500, NULL, NULL);
SET session_replication_role = origin;
CREATE OR REPLACE FUNCTION rig_as(p uuid) RETURNS void LANGUAGE sql AS
$$ SELECT set_config('request.jwt.claim.sub', coalesce(p::text, ''), false) $$;
