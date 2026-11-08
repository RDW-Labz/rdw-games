-- 0453 rig seed. Identical for the BEFORE (pre-0453) and AFTER (0453) copies.
-- Synthetic only: example.test addresses, fixed uuids, no prod data.
\set ON_ERROR_STOP 1
SET session_replication_role = replica;

INSERT INTO auth.users (id, email) VALUES
 ('00000000-0000-0000-0000-0000000000c1','staff@example.test'),
 ('00000000-0000-0000-0000-0000000000e1','b1@example.test'),
 ('00000000-0000-0000-0000-0000000000e2','b2@example.test'),
 ('00000000-0000-0000-0000-0000000000e3','b3@example.test'),
 ('00000000-0000-0000-0000-0000000000e4','b4@example.test'),
 ('00000000-0000-0000-0000-0000000000e5','nocard@example.test'),
 ('00000000-0000-0000-0000-0000000000e6','grace@example.test'),
 ('00000000-0000-0000-0000-0000000000e7','notbidder@example.test');

INSERT INTO operators (id, slug, business_name, contact_email, code) VALUES
 ('00000000-0000-0000-0000-0000000000a1','rig453','Rig 453','o@example.test','R45');
INSERT INTO warehouses (id, name, address_line1, operator_id, state, postal_code, city) VALUES
 ('00000000-0000-0000-0000-0000000000b1','Harrison','1 St','00000000-0000-0000-0000-0000000000a1','AR','72601','Harrison');
INSERT INTO operator_users (operator_id, user_id, role, email) VALUES
 ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000c1','admin','staff@example.test');

INSERT INTO bidders (id, email, birth_date, default_payment_method_id, unpaid_fees_cents) VALUES
 ('00000000-0000-0000-0000-0000000000c1','staff@example.test','1980-01-01','ccof:staff',0),
 ('00000000-0000-0000-0000-0000000000e1','b1@example.test','1980-01-01','ccof:b1',0),
 ('00000000-0000-0000-0000-0000000000e2','b2@example.test','1980-01-01','ccof:b2',0),
 ('00000000-0000-0000-0000-0000000000e3','b3@example.test','1980-01-01','ccof:b3',0),
 ('00000000-0000-0000-0000-0000000000e4','b4@example.test','1980-01-01','ccof:b4',0),
 ('00000000-0000-0000-0000-0000000000e5','nocard@example.test','1980-01-01',NULL,0),
 ('00000000-0000-0000-0000-0000000000e6','grace@example.test','1980-01-01','ccof:grace',0);

-- Auctions. f1 standard live (soft close 2 min, operator/legacy ladder);
-- f2 standard not started (no pre-bid); f3 per_unit, own ladder $0.10/unit;
-- f4 per_unit with NO schedule; f5 per_unit tiered ladder ($0.05, $0.10 from
-- $0.50/unit); f6 standard that the per-unit file later flips to per_unit
-- (the "switched after standard bids" defensive case); f7 per_unit for the
-- concurrency + fuzz runs ($0.05/unit).
INSERT INTO auctions (id, operator_id, warehouse_id, title, status, starts_at, ends_at,
                      pickup_starts_at, pickup_ends_at, soft_close_minutes, bid_mode,
                      unit_start_cents, bid_increment_schedule) VALUES
 ('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','Std live','live', now()-interval '1 day', now()+interval '1 day', now()+interval '2 day', now()+interval '6 day', 2, 'standard', NULL, NULL),
 ('00000000-0000-0000-0000-0000000000f2','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','Std future','scheduled', now()+interval '1 day', now()+interval '2 day', now()+interval '3 day', now()+interval '6 day', 2, 'standard', NULL, NULL),
 ('00000000-0000-0000-0000-0000000000f3','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','Per sq ft','live', now()-interval '1 day', now()+interval '1 day', now()+interval '2 day', now()+interval '6 day', 2, 'per_unit', 5, '[{"min_cents":0,"step_cents":10}]'),
 ('00000000-0000-0000-0000-0000000000f4','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','Per sq ft no ladder','live', now()-interval '1 day', now()+interval '1 day', now()+interval '2 day', now()+interval '6 day', 2, 'per_unit', 5, NULL),
 ('00000000-0000-0000-0000-0000000000f5','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','Per sq ft tiered','live', now()-interval '1 day', now()+interval '1 day', now()+interval '2 day', now()+interval '6 day', 0, 'per_unit', 5, '[{"min_cents":0,"step_cents":5},{"min_cents":50,"step_cents":10}]'),
 ('00000000-0000-0000-0000-0000000000f6','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','Std then flipped','live', now()-interval '1 day', now()+interval '1 day', now()+interval '2 day', now()+interval '6 day', 0, 'standard', NULL, NULL),
 ('00000000-0000-0000-0000-0000000000f7','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','Per sq ft load','live', now()-interval '1 day', now()+interval '1 day', now()+interval '2 day', now()+interval '6 day', 0, 'per_unit', 5, '[{"min_cents":0,"step_cents":5}]');

-- Lots. S* standard, U* per_unit. close_at set explicitly (triggers are off).
-- f2 must refuse bids before it starts (pre-bidding off).
UPDATE auctions SET prebid_enabled = false;

INSERT INTO lots (id, operator_id, warehouse_id, auction_id, title, lot_code, status, starting_bid_cents, close_at, unit_qty, unit_label) VALUES
 ('00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000f1','S1 duel','S1','live',100, now()+interval '1 hour', NULL, NULL),
 ('00000000-0000-0000-0000-000000000102','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000f1','S2 gates','S2','live',500, now()+interval '1 hour', NULL, NULL),
 ('00000000-0000-0000-0000-000000000103','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000f1','S3 soft close','S3','live',100, now()+interval '30 seconds', NULL, NULL),
 ('00000000-0000-0000-0000-000000000104','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000f2','S4 not started','S4','scheduled',100, now()+interval '2 day', NULL, NULL),
 ('00000000-0000-0000-0000-000000000105','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000f1','S5 closed','S5','live',100, now()-interval '1 minute', NULL, NULL),
 ('00000000-0000-0000-0000-000000000106','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000f1','S6 unsold','S6','unsold',100, now()+interval '1 hour', NULL, NULL),
 ('00000000-0000-0000-0000-000000000107','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000f1','S7 concurrency','S7','live',100, now()+interval '1 hour', NULL, NULL),
 ('00000000-0000-0000-0000-000000000108','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000f1','S8 timing','S8','live',100, now()+interval '1 hour', NULL, NULL),
 ('00000000-0000-0000-0000-000000000201','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000f3','U1 247 sq ft tile','U1','live',1235, now()+interval '1 hour', 247, 'sq ft'),
 ('00000000-0000-0000-0000-000000000202','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000f3','U2 160 sq ft tile','U2','live',800, now()+interval '1 hour', 160, 'sq ft'),
 ('00000000-0000-0000-0000-000000000203','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000f3','U3 start not multiple','U3','live',1000, now()+interval '1 hour', 247, 'sq ft'),
 ('00000000-0000-0000-0000-000000000204','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000f3','U4 no qty','U4','live',1235, now()+interval '1 hour', NULL, NULL),
 ('00000000-0000-0000-0000-000000000205','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000f4','U5 no ladder','U5','live',1235, now()+interval '1 hour', 247, 'sq ft'),
 ('00000000-0000-0000-0000-000000000206','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000f5','U6 tiered 100','U6','live',500, now()+interval '1 hour', 100, 'sq ft'),
 ('00000000-0000-0000-0000-000000000207','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000f3','U7 soft close','U7','live',1235, now()+interval '30 seconds', 247, 'sq ft'),
 ('00000000-0000-0000-0000-000000000208','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000f7','U8 concurrency 173','U8','live',865, now()+interval '1 hour', 173, 'sq ft'),
 ('00000000-0000-0000-0000-000000000209','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000f7','U9 fuzz 173','U9','live',865, now()+interval '1 hour', 173, 'sq ft'),
 ('00000000-0000-0000-0000-000000000210','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000f6','X1 std then flipped','X1','live',100, now()+interval '1 hour', NULL, NULL);

-- An invoice in the payment_failed_grace window for grace@ at this operator.
INSERT INTO invoices (operator_id, auction_id, bidder_id, status) VALUES
 ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000e6','payment_failed_grace');

SET session_replication_role = origin;

-- Labels for deterministic output (ids → names, no timestamps).
CREATE TABLE rig_labels (id uuid PRIMARY KEY, label text NOT NULL);
INSERT INTO rig_labels SELECT id, split_part(email, '@', 1) FROM auth.users;
INSERT INTO rig_labels SELECT id, lot_code FROM lots;
CREATE TABLE rig_seed_close AS SELECT id, close_at FROM lots;
