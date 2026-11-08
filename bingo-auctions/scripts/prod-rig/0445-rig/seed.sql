\set ON_ERROR_STOP 1
SET session_replication_role = replica;
INSERT INTO auth.users (id, email) VALUES ('00000000-0000-0000-0000-0000000000c1','a@example.test'),('00000000-0000-0000-0000-0000000000d1','b@example.test');
INSERT INTO operators (id, slug, business_name, contact_email, code) VALUES ('00000000-0000-0000-0000-0000000000a1','o1','Op One','o@example.test','OPA');
INSERT INTO warehouses (id, name, address_line1, operator_id, state, postal_code, city) VALUES ('00000000-0000-0000-0000-0000000000b1','Harrison','1 St','00000000-0000-0000-0000-0000000000a1','AR','72601','Harrison');
INSERT INTO operator_users (operator_id, user_id, role, email) VALUES ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000c1','admin','a@example.test');
INSERT INTO bidders (id, email) VALUES ('00000000-0000-0000-0000-0000000000d1','b@example.test');
INSERT INTO bins (id, warehouse_id, code, aisle, x_px, y_px, qr_token) VALUES
 ('00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000000b1','4-09-02','4',0,0,'00000000-0000-0000-0000-00000000aaa1'),
 ('00000000-0000-0000-0000-0000000000e2','00000000-0000-0000-0000-0000000000b1','15-11-01','15',0,0,'00000000-0000-0000-0000-00000000aaa2'),
 ('00000000-0000-0000-0000-0000000000e3','00000000-0000-0000-0000-0000000000b1','7-14-01','7',0,0,'00000000-0000-0000-0000-00000000aaa3');
INSERT INTO auctions (id, operator_id, warehouse_id, title, starts_at, ends_at, pickup_starts_at, pickup_ends_at) VALUES
 ('00000000-0000-0000-0000-0000000000f0','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','A', now()-interval '90 days', now()-interval '85 days', now()-interval '85 days', now()-interval '80 days');
-- P1 relisted after its mark, child on 4-09-02 with the parent's old intake_at (the BIN-005667 shape)
-- P2 relisted after its mark, child disposed (the BIN-011585 shape)
-- P3 plain lot, marked missing, never relisted
INSERT INTO lots (id, operator_id, warehouse_id, title, lot_code, status, intake_at, intake_bin_id, sticker_code, relisted_from_lot_id, removal_kind, created_at) VALUES
 ('00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','P1','R-0001','relisted', now()-interval '100 days','00000000-0000-0000-0000-0000000000e3', NULL, NULL, NULL, now()-interval '100 days'),
 ('00000000-0000-0000-0000-000000000102','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','C1','R-0002','in_inventory', now()-interval '100 days','00000000-0000-0000-0000-0000000000e1','BIN:TEA0000001','00000000-0000-0000-0000-000000000101', NULL, now()-interval '70 days'),
 ('00000000-0000-0000-0000-000000000103','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','P2','R-0003','relisted', now()-interval '60 days','00000000-0000-0000-0000-0000000000e2', NULL, NULL, NULL, now()-interval '60 days'),
 ('00000000-0000-0000-0000-000000000104','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','C2','R-0004','disposed', now()-interval '60 days','00000000-0000-0000-0000-0000000000e2','BIN:TEA0000002','00000000-0000-0000-0000-000000000103','other', now()-interval '50 days'),
 ('00000000-0000-0000-0000-000000000105','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','P3','R-0005','in_inventory', now()-interval '100 days','00000000-0000-0000-0000-0000000000e3','BIN:TEA0000003', NULL, NULL, now()-interval '100 days');
INSERT INTO invoices (id, operator_id, auction_id, bidder_id, status, paid_at, total_cents) VALUES ('00000000-0000-0000-0000-000000000091','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000f0','00000000-0000-0000-0000-0000000000d1','paid', now()-interval '85 days', 100);
INSERT INTO pickups (id, invoice_id, warehouse_id, status) VALUES ('00000000-0000-0000-0000-000000000081','00000000-0000-0000-0000-000000000091','00000000-0000-0000-0000-0000000000b1','completed');
INSERT INTO pickup_lot_outcomes (pickup_id, lot_id, outcome, created_at) VALUES
 ('00000000-0000-0000-0000-000000000081','00000000-0000-0000-0000-000000000101','missing', now()-interval '80 days'),
 ('00000000-0000-0000-0000-000000000081','00000000-0000-0000-0000-000000000103','missing', now()-interval '55 days'),
 ('00000000-0000-0000-0000-000000000081','00000000-0000-0000-0000-000000000105','missing', now()-interval '80 days');
