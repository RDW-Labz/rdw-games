\set ON_ERROR_STOP 1
SET session_replication_role = replica;
INSERT INTO auth.users (id, email) VALUES ('00000000-0000-0000-0000-0000000000c1','a@example.test'),('00000000-0000-0000-0000-0000000000d1','b@example.test'),('00000000-0000-0000-0000-0000000000c9','z@example.test');
INSERT INTO operators (id, slug, business_name, contact_email, code) VALUES ('00000000-0000-0000-0000-0000000000a1','o1','Op One','o@example.test','OPA'),('00000000-0000-0000-0000-0000000000a2','o2','Op Two','o2@example.test','OPB');
INSERT INTO warehouses (id, name, address_line1, operator_id, state, postal_code, city) VALUES ('00000000-0000-0000-0000-0000000000b1','Harrison','1 St','00000000-0000-0000-0000-0000000000a1','AR','72601','H'),('00000000-0000-0000-0000-0000000000b2','Other','2 St','00000000-0000-0000-0000-0000000000a1','AR','72601','O');
INSERT INTO operator_users (operator_id, user_id, role, email) VALUES ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000c1','admin','a@example.test'),('00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-0000000000c9','admin','z@example.test');
INSERT INTO bidders (id, email) VALUES ('00000000-0000-0000-0000-0000000000d1','b@example.test');
INSERT INTO bins (id, warehouse_id, code, aisle, x_px, y_px, qr_token) VALUES ('00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000000b1','1-01-01','1',0,0,'00000000-0000-0000-0000-00000000aaa1');
INSERT INTO auctions (id, operator_id, warehouse_id, title, starts_at, ends_at, pickup_starts_at, pickup_ends_at) VALUES ('00000000-0000-0000-0000-0000000000f0','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','A', now()-interval '60 days', now()-interval '55 days', now()-interval '55 days', now()-interval '50 days');
-- G0 collected 50 days ago -> G1 relist copy (unsold) -> G2 relist copy of the copy (unsold)  [ghosts]
-- S0 collected, S1 copy; then the box was scanned back onto a shelf (event on S1 later)  [cleared]
-- C0 clean unsold lot   O0 collected lot in the other warehouse
INSERT INTO lots (id, operator_id, warehouse_id, title, lot_code, status, relisted_from_lot_id, created_at) VALUES
 ('00000000-0000-0000-0000-000000000100','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','G0','G-0','relisted',NULL, now()-interval '60 days'),
 ('00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','G1','G-1','relisted','00000000-0000-0000-0000-000000000100', now()-interval '45 days'),
 ('00000000-0000-0000-0000-000000000102','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','G2','G-2','unsold','00000000-0000-0000-0000-000000000101', now()-interval '30 days'),
 ('00000000-0000-0000-0000-000000000200','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','S0','S-0','relisted',NULL, now()-interval '60 days'),
 ('00000000-0000-0000-0000-000000000201','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','S1','S-1','unsold','00000000-0000-0000-0000-000000000200', now()-interval '45 days'),
 ('00000000-0000-0000-0000-000000000300','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','C0','C-0','unsold',NULL, now()-interval '60 days'),
 ('00000000-0000-0000-0000-000000000400','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b2','O0','O-0','unsold',NULL, now()-interval '60 days');
INSERT INTO invoices (id, operator_id, auction_id, bidder_id, status, paid_at, total_cents) VALUES ('00000000-0000-0000-0000-000000000091','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000f0','00000000-0000-0000-0000-0000000000d1','paid', now()-interval '55 days', 100);
INSERT INTO invoice_lots (invoice_id, lot_id, winning_bid_cents, picked_up_at) VALUES
 ('00000000-0000-0000-0000-000000000091','00000000-0000-0000-0000-000000000100',100, now()-interval '50 days'),
 ('00000000-0000-0000-0000-000000000091','00000000-0000-0000-0000-000000000200',100, now()-interval '50 days'),
 ('00000000-0000-0000-0000-000000000091','00000000-0000-0000-0000-000000000300',100, NULL),
 ('00000000-0000-0000-0000-000000000091','00000000-0000-0000-0000-000000000400',100, now()-interval '50 days');
INSERT INTO lot_location_events (lot_id, bin_id, kind, occurred_at) VALUES ('00000000-0000-0000-0000-000000000201','00000000-0000-0000-0000-0000000000e1','intake', now()-interval '10 days');
SET session_replication_role = origin;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c1', false);
SELECT 'harrison: ' || coalesce(string_agg(l.lot_code, ',' ORDER BY l.lot_code), 'none') FROM builder_collected_lot_ids('00000000-0000-0000-0000-0000000000b1') x JOIN lots l ON l.id = x;
SELECT 'all warehouses: ' || coalesce(string_agg(l.lot_code, ',' ORDER BY l.lot_code), 'none') FROM builder_collected_lot_ids(NULL) x JOIN lots l ON l.id = x;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c9', false);
SELECT 'other operator: ' || count(*) FROM builder_collected_lot_ids(NULL);
SELECT set_config('request.jwt.claim.sub', '', false);
SELECT 'no session: ' || count(*) FROM builder_collected_lot_ids(NULL);
SELECT 'grants anon/auth: ' || has_function_privilege('anon','public.builder_collected_lot_ids(uuid)','EXECUTE') || '/' || has_function_privilege('authenticated','public.builder_collected_lot_ids(uuid)','EXECUTE');
