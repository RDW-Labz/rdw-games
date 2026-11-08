-- 0473 rig seed. Synthetic only: example.test addresses, fixed uuids.
-- Crandall (b2) lots, a Harrison (b1) iPad. Triggers off while seeding so the
-- rows can be laid down in their end state; the cases run with triggers on.
\set ON_ERROR_STOP 1
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email text;
SET session_replication_role = replica;

INSERT INTO auth.users (id, email) VALUES
 ('00000000-0000-0000-0000-0000000000c1', 'staff@example.test'),
 ('00000000-0000-0000-0000-0000000000c2', 'notstaff@example.test'),
 ('00000000-0000-0000-0000-0000000000e1', 'buyer@example.test');

INSERT INTO operators (id, slug, business_name, contact_email, code) VALUES
 ('00000000-0000-0000-0000-0000000000a1', 'rig473', 'Rig 473', 'o@example.test', 'RGX');
INSERT INTO warehouses (id, name, address_line1, operator_id, state, postal_code, city) VALUES
 ('00000000-0000-0000-0000-0000000000b1', 'Harrison', '1 St', '00000000-0000-0000-0000-0000000000a1', 'AR', '72601', 'Harrison'),
 ('00000000-0000-0000-0000-0000000000b2', 'Crandall', '2 St', '00000000-0000-0000-0000-0000000000a1', 'TX', '75114', 'Crandall');
INSERT INTO operator_users (operator_id, user_id, role, email) VALUES
 ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000c1', 'admin', 'staff@example.test');
INSERT INTO bidders (id, email, birth_date) VALUES
 ('00000000-0000-0000-0000-0000000000e1', 'buyer@example.test', '1980-01-01');

-- Bins: d1/d4 Crandall, d2/d3 Harrison, d5 Harrison retired.
INSERT INTO bins (id, warehouse_id, code, aisle, x_px, y_px, qr_token, retired_at) VALUES
 ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000b2', '1-09-01', '1', 0, 0, '00000000-0000-0000-0000-00000000aad1', NULL),
 ('00000000-0000-0000-0000-0000000000d4', '00000000-0000-0000-0000-0000000000b2', '1-09-02', '1', 0, 0, '00000000-0000-0000-0000-00000000aad4', NULL),
 ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000b1', '5-01-01', '5', 0, 0, '00000000-0000-0000-0000-00000000aad2', NULL),
 ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000b1', '5-01-02', '5', 0, 0, '00000000-0000-0000-0000-00000000aad3', NULL),
 ('00000000-0000-0000-0000-0000000000d5', '00000000-0000-0000-0000-0000000000b1', '5-01-09', '5', 0, 0, '00000000-0000-0000-0000-00000000aad5', now());

-- Auctions (all Crandall): f1 closed, f2 live, f3 scheduled.
INSERT INTO auctions (id, operator_id, warehouse_id, title, status, starts_at, ends_at, pickup_starts_at, pickup_ends_at) VALUES
 ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b2', 'Closed', 'closed', now()-interval '12 day', now()-interval '11 day', now()-interval '11 day', now()-interval '9 day'),
 ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b2', 'Live', 'live', now()-interval '1 day', now()+interval '1 day', now()+interval '1 day', now()+interval '3 day'),
 ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b2', 'Scheduled', 'scheduled', now()+interval '1 day', now()+interval '2 day', now()+interval '2 day', now()+interval '4 day');

-- Lots (Crandall unless noted). L01 is the BRN4983203 shape: won, paid,
-- pickup no-show -> unsold, still on its closed auction, on a Crandall shelf.
INSERT INTO lots (id, operator_id, warehouse_id, auction_id, lot_number, title, lot_code, sticker_code, status, close_at, intake_bin_id, intake_at) VALUES
 ('00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000f1', 1, 'L01 ceiling fan (no-show)', 'BIN-033984', 'RGX:BRN4983203', 'unsold', now()-interval '11 day', '00000000-0000-0000-0000-0000000000d1', now()-interval '14 day'),
 ('00000000-0000-0000-0000-000000000102', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b2', NULL, NULL, 'L02 inventory', 'BIN-000102', NULL, 'in_inventory', NULL, '00000000-0000-0000-0000-0000000000d1', now()-interval '3 day'),
 ('00000000-0000-0000-0000-000000000103', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000f2', 1, 'L03 unsold in live auction', 'BIN-000103', NULL, 'unsold', now()-interval '1 hour', '00000000-0000-0000-0000-0000000000d1', now()-interval '3 day'),
 ('00000000-0000-0000-0000-000000000104', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000f3', 1, 'L04 scheduled', 'BIN-000104', NULL, 'scheduled', now()+interval '2 day', '00000000-0000-0000-0000-0000000000d1', now()-interval '3 day'),
 ('00000000-0000-0000-0000-000000000105', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000f2', 2, 'L05 live', 'BIN-000105', NULL, 'live', now()+interval '1 day', '00000000-0000-0000-0000-0000000000d1', now()-interval '3 day'),
 ('00000000-0000-0000-0000-000000000106', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000f1', 2, 'L06 won', 'BIN-000106', NULL, 'won', now()-interval '11 day', '00000000-0000-0000-0000-0000000000d1', now()-interval '14 day'),
 ('00000000-0000-0000-0000-000000000107', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000f1', 3, 'L07 unsold, invoice still pending', 'BIN-000107', NULL, 'unsold', now()-interval '11 day', '00000000-0000-0000-0000-0000000000d1', now()-interval '14 day'),
 ('00000000-0000-0000-0000-000000000108', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b2', NULL, NULL, 'L08 staged for pickup', 'BIN-000108', NULL, 'in_inventory', NULL, '00000000-0000-0000-0000-0000000000d1', now()-interval '3 day'),
 ('00000000-0000-0000-0000-000000000109', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b2', NULL, NULL, 'L09 canceled', 'BIN-000109', NULL, 'canceled', NULL, '00000000-0000-0000-0000-0000000000d1', now()-interval '3 day'),
 ('00000000-0000-0000-0000-000000000110', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b2', NULL, NULL, 'L10 shelved inventory (old paths)', 'BIN-000110', NULL, 'in_inventory', NULL, '00000000-0000-0000-0000-0000000000d1', now()-interval '3 day'),
 ('00000000-0000-0000-0000-000000000111', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b2', NULL, NULL, 'L11 pending intake', 'BIN-000111', NULL, 'pending_intake', NULL, NULL, NULL),
 ('00000000-0000-0000-0000-000000000112', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b2', NULL, NULL, 'L12 never shelved draft', 'BIN-000112', NULL, 'draft', NULL, NULL, NULL),
 ('00000000-0000-0000-0000-000000000113', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000f1', 4, 'L13 no-show, old app path', 'BIN-000113', NULL, 'unsold', now()-interval '11 day', '00000000-0000-0000-0000-0000000000d1', now()-interval '14 day'),
 ('00000000-0000-0000-0000-000000000114', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b2', NULL, NULL, 'L14 refusal checks', 'BIN-000114', NULL, 'in_inventory', NULL, '00000000-0000-0000-0000-0000000000d1', now()-interval '3 day'),
 ('00000000-0000-0000-0000-000000000115', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b2', NULL, NULL, 'L15 flag must not leak', 'BIN-000115', NULL, 'in_inventory', NULL, '00000000-0000-0000-0000-0000000000d1', now()-interval '3 day');

-- L16 pending intake recorded at Crandall; L17 unsold with an invoice in the
-- payment grace window; L18 pending intake with no building yet.
INSERT INTO auctions (id, operator_id, warehouse_id, title, status, starts_at, ends_at, pickup_starts_at, pickup_ends_at) VALUES
 ('00000000-0000-0000-0000-0000000000f5', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b2', 'Closed 3', 'closed', now()-interval '5 day', now()-interval '4 day', now()-interval '4 day', now()-interval '2 day');
INSERT INTO lots (id, operator_id, warehouse_id, auction_id, lot_number, title, lot_code, sticker_code, status, close_at, intake_bin_id, intake_at) VALUES
 ('00000000-0000-0000-0000-000000000116', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b2', NULL, NULL, 'L16 pending intake from Crandall', 'BIN-000116', NULL, 'pending_intake', NULL, NULL, NULL),
 ('00000000-0000-0000-0000-000000000117', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000f5', 1, 'L17 unsold, invoice in grace', 'BIN-000117', NULL, 'unsold', now()-interval '4 day', '00000000-0000-0000-0000-0000000000d1', now()-interval '9 day'),
 ('00000000-0000-0000-0000-000000000118', '00000000-0000-0000-0000-0000000000a1', NULL, NULL, NULL, 'L18 pending intake, no building', 'BIN-000118', NULL, 'pending_intake', NULL, NULL, NULL);
INSERT INTO invoices (id, operator_id, auction_id, bidder_id, status) VALUES
 ('00000000-0000-0000-0000-0000000001a3', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000f5', '00000000-0000-0000-0000-0000000000e1', 'payment_failed_grace');
INSERT INTO invoice_lots (invoice_id, lot_id, winning_bid_cents) VALUES
 ('00000000-0000-0000-0000-0000000001a3', '00000000-0000-0000-0000-000000000117', 700);

INSERT INTO invoices (id, operator_id, auction_id, bidder_id, status, paid_at) VALUES
 ('00000000-0000-0000-0000-0000000001a1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000e1', 'paid', now()-interval '11 day');
INSERT INTO invoice_lots (invoice_id, lot_id, winning_bid_cents) VALUES
 ('00000000-0000-0000-0000-0000000001a1', '00000000-0000-0000-0000-000000000101', 2500),
 ('00000000-0000-0000-0000-0000000001a1', '00000000-0000-0000-0000-000000000106', 1500);
-- L07's buyer has not paid yet (a second auction is needed for the unique key).
INSERT INTO auctions (id, operator_id, warehouse_id, title, status, starts_at, ends_at, pickup_starts_at, pickup_ends_at) VALUES
 ('00000000-0000-0000-0000-0000000000f4', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b2', 'Closed 2', 'closed', now()-interval '5 day', now()-interval '4 day', now()-interval '4 day', now()-interval '2 day');
UPDATE lots SET auction_id = '00000000-0000-0000-0000-0000000000f4' WHERE id = '00000000-0000-0000-0000-000000000107';
INSERT INTO invoices (id, operator_id, auction_id, bidder_id, status) VALUES
 ('00000000-0000-0000-0000-0000000001a2', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000f4', '00000000-0000-0000-0000-0000000000e1', 'pending');
INSERT INTO invoice_lots (invoice_id, lot_id, winning_bid_cents) VALUES
 ('00000000-0000-0000-0000-0000000001a2', '00000000-0000-0000-0000-000000000107', 900);

INSERT INTO bin_assignments (lot_id, bin_id, status) VALUES
 ('00000000-0000-0000-0000-000000000108', '00000000-0000-0000-0000-0000000000d4', 'staged');

SET session_replication_role = origin;

CREATE OR REPLACE FUNCTION rig_as(p uuid) RETURNS void LANGUAGE sql AS
$$ SELECT set_config('request.jwt.claim.sub', coalesce(p::text, ''), false) $$;
CREATE OR REPLACE FUNCTION rig_err(p_sql text) RETURNS text LANGUAGE plpgsql AS
$$ BEGIN EXECUTE p_sql; RETURN 'no error'; EXCEPTION WHEN OTHERS THEN RETURN SQLERRM; END $$;
