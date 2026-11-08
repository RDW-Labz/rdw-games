-- 0454 rig seed. Identical for the BEFORE (pre-0454) and AFTER (0454) copies.
-- Synthetic only: example.test addresses, fixed uuids, no prod data.
-- Loaded with triggers off (replica) so any state can be set up directly.
\set ON_ERROR_STOP 1
SET session_replication_role = replica;

INSERT INTO auth.users (id, email) VALUES
 ('00000000-0000-0000-0000-0000000000c1','admin@example.test'),
 ('00000000-0000-0000-0000-0000000000c2','manager@example.test'),
 ('00000000-0000-0000-0000-0000000000e1','b1@example.test'),
 ('00000000-0000-0000-0000-0000000000e2','b2@example.test');

INSERT INTO operators (id, slug, business_name, contact_email, code,
                       auto_relist_enabled, auto_relist_max_attempts, auto_relist_mode) VALUES
 ('00000000-0000-0000-0000-0000000000a1','rig454','Rig 454','o@example.test','R54', true, 3, 'auto');
INSERT INTO warehouses (id, name, address_line1, operator_id, state, postal_code, city) VALUES
 ('00000000-0000-0000-0000-0000000000b1','Harrison','1 St','00000000-0000-0000-0000-0000000000a1','AR','72601','Harrison');
INSERT INTO operator_users (operator_id, user_id, role, email) VALUES
 ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000c1','admin','admin@example.test'),
 ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000c2','manager','manager@example.test');
INSERT INTO bidders (id, email, birth_date, default_payment_method_id, unpaid_fees_cents) VALUES
 ('00000000-0000-0000-0000-0000000000e1','b1@example.test','1980-01-01','ccof:b1',0),
 ('00000000-0000-0000-0000-0000000000e2','b2@example.test','1980-01-01','ccof:b2',0);

-- Auctions. f1x standard, f2x per_unit (bid_mode).
INSERT INTO auctions (id, operator_id, warehouse_id, title, status, starts_at, ends_at,
                      pickup_starts_at, pickup_ends_at, soft_close_minutes, bid_mode,
                      unit_start_cents, bid_increment_schedule) VALUES
 ('00000000-0000-0000-0000-0000000000f1','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','A1 std draft','draft', now()+interval '1 day', now()+interval '2 day', now()+interval '3 day', now()+interval '6 day', 0, 'standard', NULL, NULL),
 ('00000000-0000-0000-0000-0000000000f2','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','A2 std scheduled','scheduled', now()+interval '1 day', now()+interval '2 day', now()+interval '3 day', now()+interval '6 day', 0, 'standard', NULL, NULL),
 ('00000000-0000-0000-0000-0000000000f3','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','A3 std live','live', now()-interval '1 day', now()+interval '1 day', now()+interval '2 day', now()+interval '6 day', 0, 'standard', NULL, NULL),
 ('00000000-0000-0000-0000-0000000000f4','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','A4 std closed','closed', now()-interval '3 day', now()-interval '1 day', now()-interval '1 day', now()+interval '6 day', 0, 'standard', NULL, NULL),
 ('00000000-0000-0000-0000-0000000000f5','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','A5 std draft empty','draft', now()+interval '1 day', now()+interval '2 day', now()+interval '3 day', now()+interval '6 day', 0, 'standard', NULL, NULL),
 ('00000000-0000-0000-0000-0000000000f6','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','A6 std draft with lot','draft', now()+interval '1 day', now()+interval '2 day', now()+interval '3 day', now()+interval '6 day', 0, 'standard', NULL, NULL),
 ('00000000-0000-0000-0000-0000000000f7','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','A7 std scheduled with bid','scheduled', now()+interval '1 day', now()+interval '2 day 1 hour', now()+interval '3 day', now()+interval '6 day', 0, 'standard', NULL, NULL),
 ('00000000-0000-0000-0000-000000000021','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','P1 per sq ft draft, default 5c','draft', now()+interval '1 day', now()+interval '2 day', now()+interval '3 day', now()+interval '6 day', 0, 'per_unit', 5, '[{"min_cents":0,"step_cents":5}]'),
 ('00000000-0000-0000-0000-000000000022','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','P2 per sq ft scheduled, no default','scheduled', now()+interval '1 day', now()+interval '2 day 2 hour', now()+interval '3 day', now()+interval '6 day', 0, 'per_unit', NULL, '[{"min_cents":0,"step_cents":5}]'),
 ('00000000-0000-0000-0000-000000000023','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','P3 per sq ft live','live', now()-interval '1 day', now()+interval '1 day', now()+interval '2 day', now()+interval '6 day', 0, 'per_unit', 5, '[{"min_cents":0,"step_cents":5}]'),
 ('00000000-0000-0000-0000-000000000024','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','P4 per sq ft closed','closed', now()-interval '3 day', now()-interval '1 day', now()-interval '1 day', now()+interval '6 day', 0, 'per_unit', 5, '[{"min_cents":0,"step_cents":5}]'),
 ('00000000-0000-0000-0000-000000000025','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','P5 per sq ft draft empty','draft', now()+interval '1 day', now()+interval '2 day', now()+interval '3 day', now()+interval '6 day', 0, 'per_unit', 10, '[{"min_cents":0,"step_cents":5}]');
UPDATE auctions SET prebid_enabled = false;

-- Lots. S* standard (unit_qty NULL), U* per_unit.
INSERT INTO lots (id, operator_id, warehouse_id, auction_id, title, lot_code, lot_number, status,
                  starting_bid_cents, close_at, unit_qty, unit_label) VALUES
 -- standard, in inventory (assign / relist sources)
 ('00000000-0000-0000-0000-000000000101','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1',NULL,'SI1 lamp','SI1',NULL,'in_inventory',100,NULL,NULL,NULL),
 ('00000000-0000-0000-0000-000000000102','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1',NULL,'SI2 chair','SI2',NULL,'in_inventory',500,NULL,NULL,NULL),
 ('00000000-0000-0000-0000-000000000103','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1',NULL,'SI3 rug','SI3',NULL,'in_inventory',1000,NULL,NULL,NULL),
 ('00000000-0000-0000-0000-000000000104','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1',NULL,'SI4 desk','SI4',NULL,'in_inventory',100,NULL,NULL,NULL),
 ('00000000-0000-0000-0000-000000000105','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1',NULL,'SI5 fan','SI5',NULL,'in_inventory',100,NULL,NULL,NULL),
 -- standard, in auctions
 ('00000000-0000-0000-0000-000000000111','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000f2','SD1 scheduled','SD1',1,'scheduled',100, now()+interval '2 day',NULL,NULL),
 ('00000000-0000-0000-0000-000000000112','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000f3','SL1 live','SL1',1,'live',100, now()+interval '1 day',NULL,NULL),
 ('00000000-0000-0000-0000-000000000113','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000f4','SU1 unsold','SU1',1,'unsold',100, now()-interval '1 day',NULL,NULL),
 ('00000000-0000-0000-0000-000000000114','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000f4','SU2 unsold auto','SU2',2,'unsold',300, now()-interval '1 day',NULL,NULL),
 ('00000000-0000-0000-0000-000000000115','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000f4','SU3 unsold 3-arg','SU3',3,'unsold',200, now()-interval '1 day',NULL,NULL),
 ('00000000-0000-0000-0000-000000000116','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000f4','SU4 unsold to inv','SU4',4,'unsold',200, now()-interval '1 day',NULL,NULL),
 ('00000000-0000-0000-0000-000000000117','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000f6','SA6 in A6','SA6',1,'scheduled',100, now()+interval '2 day',NULL,NULL),
 ('00000000-0000-0000-0000-000000000118','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000f7','SB7 bid in A7','SB7',1,'scheduled',100, now()+interval '2 day',NULL,NULL),
 -- per_unit, in inventory
 ('00000000-0000-0000-0000-000000000201','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1',NULL,'UI1 247 sq ft tile, start not set','UI1',NULL,'in_inventory',100,NULL,247,'sq ft'),
 ('00000000-0000-0000-0000-000000000202','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1',NULL,'UI2 247 sq ft own start 5c','UI2',NULL,'in_inventory',1235,NULL,247,'sq ft'),
 ('00000000-0000-0000-0000-000000000203','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1',NULL,'UI3 160 sq ft start 10.01','UI3',NULL,'in_inventory',1001,NULL,160,'sq ft'),
 ('00000000-0000-0000-0000-000000000204','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1',NULL,'UI4 100 sq ft start not set','UI4',NULL,'in_inventory',100,NULL,100,'sq ft'),
 ('00000000-0000-0000-0000-000000000205','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1',NULL,'UI5 160 sq ft own start 8.00','UI5',NULL,'in_inventory',800,NULL,160,'sq ft'),
 -- per_unit, in auctions
 ('00000000-0000-0000-0000-000000000211','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-000000000021','UD1 draft 247','UD1',1,'scheduled',1235, now()+interval '2 day',247,'sq ft'),
 ('00000000-0000-0000-0000-000000000212','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-000000000023','UL1 live 247','UL1',1,'live',1235, now()+interval '1 day',247,'sq ft'),
 ('00000000-0000-0000-0000-000000000213','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-000000000024','UU1 unsold 160','UU1',1,'unsold',800, now()-interval '1 day',160,'sq ft'),
 ('00000000-0000-0000-0000-000000000214','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-000000000022','US1 scheduled 200','US1',1,'scheduled',2000, now()+interval '2 day',200,'sq ft'),
 ('00000000-0000-0000-0000-000000000215','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-000000000021','UB1 bid, draft auction','UB1',2,'scheduled',1235, now()+interval '2 day',247,'sq ft'),
 ('00000000-0000-0000-0000-000000000216','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-000000000024','UU2 unsold 160 to inv','UU2',2,'unsold',800, now()-interval '1 day',160,'sq ft');

-- Bids: SL1 and UL1 live with a bid; SB7 and UB1 carry a bid while their
-- auction is not live (locks must hold on "has bids" alone).
INSERT INTO bids (lot_id, bidder_id, amount_cents, max_amount_cents) VALUES
 ('00000000-0000-0000-0000-000000000112','00000000-0000-0000-0000-0000000000e1',100,500),
 ('00000000-0000-0000-0000-000000000212','00000000-0000-0000-0000-0000000000e1',1235,2470),
 ('00000000-0000-0000-0000-000000000118','00000000-0000-0000-0000-0000000000e1',100,100),
 ('00000000-0000-0000-0000-000000000215','00000000-0000-0000-0000-0000000000e1',1235,1235);
UPDATE lots SET current_bid_cents = 100,  winner_bidder_id = '00000000-0000-0000-0000-0000000000e1' WHERE lot_code = 'SL1';
UPDATE lots SET current_bid_cents = 1235, winner_bidder_id = '00000000-0000-0000-0000-0000000000e1' WHERE lot_code = 'UL1';

SET session_replication_role = origin;
