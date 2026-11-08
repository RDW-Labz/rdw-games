\set ON_ERROR_STOP 1
SET session_replication_role = replica;
INSERT INTO auth.users (id, email) VALUES
 ('00000000-0000-0000-0000-0000000000c1','a@example.test'),
 ('00000000-0000-0000-0000-0000000000d1','b@example.test');
INSERT INTO operators (id, slug, business_name, contact_email, code) VALUES
 ('00000000-0000-0000-0000-0000000000a1','o1','Op One','o@example.test','OPA');
INSERT INTO warehouses (id, name, address_line1, operator_id, state, postal_code, city) VALUES
 ('00000000-0000-0000-0000-0000000000b1','Harrison','1 St','00000000-0000-0000-0000-0000000000a1','AR','72601','Harrison');
INSERT INTO operator_users (operator_id, user_id, role, email) VALUES
 ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000c1','admin','a@example.test');
INSERT INTO bidders (id, email) VALUES
 ('00000000-0000-0000-0000-0000000000d1','b@example.test');
INSERT INTO auctions (id, operator_id, warehouse_id, title, status, starts_at, ends_at, pickup_starts_at, pickup_ends_at) VALUES
 ('00000000-0000-0000-0000-0000000000f0','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','Standard auction','live', now()-interval '1 day', now()+interval '1 day', now()+interval '1 day', now()+interval '6 day');
-- L1: published standard lot (bidder-visible). L2: draft lot (staff-only, not bidder-visible).
INSERT INTO lots (id, operator_id, warehouse_id, auction_id, title, lot_code, status, starting_bid_cents) VALUES
 ('00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000f0','Standard lot L1','R-0001','live',100),
 ('00000000-0000-0000-0000-000000000102','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1',NULL,'Draft lot L2','R-0002','draft',100);
SET session_replication_role = origin;
