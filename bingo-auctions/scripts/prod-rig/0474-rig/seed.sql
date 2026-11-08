-- 0474 rig seed. Synthetic only: example.test addresses, fixed uuids.
\set ON_ERROR_STOP 1
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email text;
SET session_replication_role = replica;

INSERT INTO auth.users (id, email) VALUES
 ('00000000-0000-0000-0000-0000000000c1', 'manager@example.test'),
 ('00000000-0000-0000-0000-0000000000c2', 'lead@example.test'),
 ('00000000-0000-0000-0000-0000000000c3', 'admin@example.test'),
 ('00000000-0000-0000-0000-0000000000c4', 'otherop@example.test'),
 ('00000000-0000-0000-0000-0000000000e1', 'buyer@example.test');
INSERT INTO operators (id, slug, business_name, contact_email, code) VALUES
 ('00000000-0000-0000-0000-0000000000a1', 'rig474', 'Rig 474', 'o@example.test', 'RGY'),
 ('00000000-0000-0000-0000-0000000000a2', 'rig474b', 'Rig 474 B', 'o2@example.test', 'RGZ');
INSERT INTO warehouses (id, name, address_line1, operator_id, state, postal_code, city) VALUES
 ('00000000-0000-0000-0000-0000000000b1', 'Harrison', '1 St', '00000000-0000-0000-0000-0000000000a1', 'AR', '72601', 'Harrison');
INSERT INTO operator_users (operator_id, user_id, role, email) VALUES
 ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'manager', 'manager@example.test'),
 ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c2', 'lead', 'lead@example.test'),
 ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c3', 'admin', 'admin@example.test'),
 ('00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000c4', 'admin', 'otherop@example.test');
INSERT INTO bidders (id, email, birth_date) VALUES
 ('00000000-0000-0000-0000-0000000000e1', 'buyer@example.test', '1980-01-01');

-- One closed auction per invoice (invoices are unique per auction + bidder).
INSERT INTO auctions (id, operator_id, warehouse_id, title, status, starts_at, ends_at, pickup_starts_at, pickup_ends_at)
SELECT ('00000000-0000-0000-0000-0000000000f' || n)::uuid, '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1',
       'A' || n, 'closed', now()-interval '3 day', now()-interval '2 day', now()-interval '2 day', now()+interval '3 day'
  FROM generate_series(1, 6) n;

-- Lots 1x1..: L11 offline invoice I1; L21 credit-paid I2 (TEA3828564 shape);
-- L31 card-paid I3; L41/L42 offline two-line I4 ($20 hammer each, over the
-- $25 cap with premium+tax? no: 20+3+1.84 = 24.84 under); L51 forfeited on
-- offline I5; L61 unpaid I6.
INSERT INTO lots (id, operator_id, warehouse_id, auction_id, lot_number, title, lot_code, status, close_at)
SELECT ('00000000-0000-0000-0000-0000000001' || c)::uuid, '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1',
       ('00000000-0000-0000-0000-0000000000f' || left(c, 1))::uuid, right(c, 1)::int, 'L' || c, 'BIN-0001' || c, 'won', now()-interval '2 day'
  FROM unnest(ARRAY['11', '21', '31', '41', '42', '51', '61']) c;

INSERT INTO invoices (id, operator_id, auction_id, bidder_id, status, subtotal_cents, buyer_premium_cents, tax_cents, total_cents, credit_applied_cents, square_payment_id, paid_at) VALUES
 ('00000000-0000-0000-0000-0000000002a1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000e1', 'paid', 1000, 150, 92, 1242, 0, NULL, now()-interval '1 day'),
 ('00000000-0000-0000-0000-0000000002a2', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000e1', 'paid', 200, 30, 22, 252, 252, NULL, now()-interval '1 day'),
 ('00000000-0000-0000-0000-0000000002a3', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000e1', 'paid', 1000, 150, 92, 1242, 0, 'sq-pay-rig', now()-interval '1 day'),
 ('00000000-0000-0000-0000-0000000002a4', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000f4', '00000000-0000-0000-0000-0000000000e1', 'paid', 4000, 600, 368, 4968, 0, NULL, now()-interval '1 day'),
 ('00000000-0000-0000-0000-0000000002a5', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000f5', '00000000-0000-0000-0000-0000000000e1', 'paid', 500, 75, 46, 621, 0, NULL, now()-interval '1 day'),
 ('00000000-0000-0000-0000-0000000002a6', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000f6', '00000000-0000-0000-0000-0000000000e1', 'pending', 500, 75, 46, 621, 0, NULL, NULL);
INSERT INTO invoice_lots (invoice_id, lot_id, winning_bid_cents, forfeited_at) VALUES
 ('00000000-0000-0000-0000-0000000002a1', '00000000-0000-0000-0000-000000000111', 1000, NULL),
 ('00000000-0000-0000-0000-0000000002a2', '00000000-0000-0000-0000-000000000121', 200, NULL),
 ('00000000-0000-0000-0000-0000000002a3', '00000000-0000-0000-0000-000000000131', 1000, NULL),
 ('00000000-0000-0000-0000-0000000002a4', '00000000-0000-0000-0000-000000000141', 2000, NULL),
 ('00000000-0000-0000-0000-0000000002a4', '00000000-0000-0000-0000-000000000142', 2000, NULL),
 ('00000000-0000-0000-0000-0000000002a5', '00000000-0000-0000-0000-000000000151', 500, now()),
 ('00000000-0000-0000-0000-0000000002a6', '00000000-0000-0000-0000-000000000161', 500, NULL);

SET session_replication_role = origin;

CREATE OR REPLACE FUNCTION rig_as(p uuid) RETURNS void LANGUAGE sql AS
$$ SELECT set_config('request.jwt.claim.sub', coalesce(p::text, ''), false) $$;
