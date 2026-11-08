\set ON_ERROR_STOP 1
-- 0471 rig seed: synthetic only (example.test). Operator a1 (staff c1 admin,
-- c2 manager, c3 picker), operator a2 (c4 admin). Auction U1 live (closes in
-- 2 days), U2 closed. Bidders e1..e3.
--   L1 live in U1, #1, 2 bids (e1 $5, e2 $7 leading)      -> withdraw + undo
--   L2 live in U1, #2, no bids                             -> withdraw, dispose, undo
--   L3 won in U2                                          -> withdraw refused
--   L4 live in U1, #4, on an open invoice                  -> withdraw refused
--   L5 in_inventory                                        -> dispose + undo
--   L6 in_inventory                                        -> keep + undo
--   L7 in_inventory                                        -> dispose, 25 h old, undo refused
--   L8 scheduled in U1, #8, 1 bid (e3)                     -> withdraw, close passes, undo refused
--   L9 live in U1, #9, 1 bid (e1)                          -> withdraw then keep (business use)
--   L10 live in U1, #10, 1 bid (e2)                        -> admin_cancel_lot(force) then keep
--   L11 won in U2, its only invoice line refunded           -> keep allowed (sale undone)
--   L12 won in U2, its invoice canceled                     -> keep allowed (sale undone)
--   L13 won in U2, invoice line still standing              -> keep refused
SET session_replication_role = replica;

INSERT INTO auth.users (id, email) VALUES
 ('00000000-0000-0000-0000-0000000000c1', 'c1@example.test'),
 ('00000000-0000-0000-0000-0000000000c2', 'c2@example.test'),
 ('00000000-0000-0000-0000-0000000000c3', 'c3@example.test'),
 ('00000000-0000-0000-0000-0000000000c4', 'c4@example.test'),
 ('00000000-0000-0000-0000-0000000000e1', 'e1@example.test'),
 ('00000000-0000-0000-0000-0000000000e2', 'e2@example.test'),
 ('00000000-0000-0000-0000-0000000000e3', 'e3@example.test');

INSERT INTO operators (id, slug, business_name, contact_email, status, code) VALUES
 ('00000000-0000-0000-0000-0000000000a1','op-a','Operator A','a@example.test','active','OPA'),
 ('00000000-0000-0000-0000-0000000000a2','op-b','Operator B','b@example.test','active','OPB');

INSERT INTO operator_users (operator_id, user_id, role, email) VALUES
 ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000c1','admin','c1@example.test'),
 ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000c2','manager','c2@example.test'),
 ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000c3','picker','c3@example.test'),
 ('00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-0000000000c4','admin','c4@example.test');

-- Fake card ids (no real card): place_bid needs one on file.
INSERT INTO bidders (id, email, default_payment_method_id) VALUES
 ('00000000-0000-0000-0000-0000000000e1','e1@example.test','ccof:rig-fake-1'),
 ('00000000-0000-0000-0000-0000000000e2','e2@example.test','ccof:rig-fake-2'),
 ('00000000-0000-0000-0000-0000000000e3','e3@example.test','ccof:rig-fake-3');

INSERT INTO warehouses (id, operator_id, name, address_line1, city, state, postal_code) VALUES
 ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000a1','W1','1 Test St','Harrison','AR','72601');

INSERT INTO auctions (id, operator_id, warehouse_id, title, status, starts_at, ends_at, pickup_starts_at, pickup_ends_at) VALUES
 ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','Open auction','live',
  now() - interval '1 day', now() + interval '2 days', now() + interval '3 days', now() + interval '4 days'),
 ('00000000-0000-0000-0000-0000000000d2','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b1','Closed auction','closed',
  now() - interval '5 days', now() - interval '2 days', now() - interval '1 day', now() + interval '1 day');

INSERT INTO lots (id, operator_id, auction_id, warehouse_id, lot_number, title, lot_code, status, starting_bid_cents, close_at, bid_count) VALUES
 ('00000000-0000-0000-0000-00000000f001','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000b1',1,'Desk arm','RIG-L1','live',100, now() + interval '2 days', 2),
 ('00000000-0000-0000-0000-00000000f002','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000b1',2,'Lamp','RIG-L2','live',100, now() + interval '2 days', 0),
 ('00000000-0000-0000-0000-00000000f003','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000d2','00000000-0000-0000-0000-0000000000b1',3,'Chair','RIG-L3','won',100, now() - interval '2 days', 1),
 ('00000000-0000-0000-0000-00000000f004','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000b1',4,'Rug','RIG-L4','live',100, now() + interval '2 days', 0),
 ('00000000-0000-0000-0000-00000000f005','00000000-0000-0000-0000-0000000000a1',NULL,'00000000-0000-0000-0000-0000000000b1',NULL,'Fan','RIG-L5','in_inventory',100, NULL, 0),
 ('00000000-0000-0000-0000-00000000f006','00000000-0000-0000-0000-0000000000a1',NULL,'00000000-0000-0000-0000-0000000000b1',NULL,'Drill','RIG-L6','in_inventory',100, NULL, 0),
 ('00000000-0000-0000-0000-00000000f007','00000000-0000-0000-0000-0000000000a1',NULL,'00000000-0000-0000-0000-0000000000b1',NULL,'Box','RIG-L7','in_inventory',100, NULL, 0),
 ('00000000-0000-0000-0000-00000000f008','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000b1',8,'Mirror','RIG-L8','scheduled',100, now() + interval '2 days', 1),
 ('00000000-0000-0000-0000-00000000f009','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000b1',9,'Kettle','RIG-L9','live',100, now() + interval '2 days', 1),
 ('00000000-0000-0000-0000-00000000f010','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000b1',10,'Toaster','RIG-L10','live',100, now() + interval '2 days', 1),
 ('00000000-0000-0000-0000-00000000f011','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000d2','00000000-0000-0000-0000-0000000000b1',11,'Clock','RIG-L11','won',100, now() - interval '2 days', 1),
 ('00000000-0000-0000-0000-00000000f012','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000d2','00000000-0000-0000-0000-0000000000b1',12,'Vase','RIG-L12','won',100, now() - interval '2 days', 1),
 ('00000000-0000-0000-0000-00000000f013','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000d2','00000000-0000-0000-0000-0000000000b1',13,'Stool','RIG-L13','won',100, now() - interval '2 days', 1);

INSERT INTO bids (id, lot_id, bidder_id, amount_cents, max_amount_cents, is_auto, placed_at) VALUES
 ('00000000-0000-0000-0000-0000000bb001','00000000-0000-0000-0000-00000000f001','00000000-0000-0000-0000-0000000000e1',500,500,false, now() - interval '3 hours'),
 ('00000000-0000-0000-0000-0000000bb002','00000000-0000-0000-0000-00000000f001','00000000-0000-0000-0000-0000000000e2',700,900,false, now() - interval '2 hours'),
 ('00000000-0000-0000-0000-0000000bb003','00000000-0000-0000-0000-00000000f003','00000000-0000-0000-0000-0000000000e1',300,300,false, now() - interval '3 days'),
 ('00000000-0000-0000-0000-0000000bb008','00000000-0000-0000-0000-00000000f008','00000000-0000-0000-0000-0000000000e3',100,100,false, now() - interval '1 hour'),
 ('00000000-0000-0000-0000-0000000bb009','00000000-0000-0000-0000-00000000f009','00000000-0000-0000-0000-0000000000e1',100,100,false, now() - interval '1 hour'),
 ('00000000-0000-0000-0000-0000000bb010','00000000-0000-0000-0000-00000000f010','00000000-0000-0000-0000-0000000000e2',100,100,false, now() - interval '1 hour');

UPDATE lots SET current_bid_cents = 700, current_bid_id = '00000000-0000-0000-0000-0000000bb002', winner_bidder_id = '00000000-0000-0000-0000-0000000000e2'
 WHERE id = '00000000-0000-0000-0000-00000000f001';
UPDATE lots SET current_bid_cents = 300, current_bid_id = '00000000-0000-0000-0000-0000000bb003', winner_bidder_id = '00000000-0000-0000-0000-0000000000e1'
 WHERE id = '00000000-0000-0000-0000-00000000f003';
UPDATE lots SET current_bid_cents = 100, current_bid_id = '00000000-0000-0000-0000-0000000bb008', winner_bidder_id = '00000000-0000-0000-0000-0000000000e3'
 WHERE id = '00000000-0000-0000-0000-00000000f008';
UPDATE lots SET current_bid_cents = 100, current_bid_id = '00000000-0000-0000-0000-0000000bb009', winner_bidder_id = '00000000-0000-0000-0000-0000000000e1'
 WHERE id = '00000000-0000-0000-0000-00000000f009';

-- L4 is on an open invoice (a lot already sold through another path).
INSERT INTO invoices (id, operator_id, auction_id, bidder_id, status) VALUES
 ('00000000-0000-0000-0000-0000000aa004','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000e3','pending');
INSERT INTO invoice_lots (invoice_id, lot_id, winning_bid_cents) VALUES
 ('00000000-0000-0000-0000-0000000aa004','00000000-0000-0000-0000-00000000f004',100);

-- Won lots L11-L13 and their invoices.
INSERT INTO invoices (id, operator_id, auction_id, bidder_id, status) VALUES
 ('00000000-0000-0000-0000-0000000aa011','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000d2','00000000-0000-0000-0000-0000000000e1','paid'),
 ('00000000-0000-0000-0000-0000000aa012','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000d2','00000000-0000-0000-0000-0000000000e2','canceled'),
 ('00000000-0000-0000-0000-0000000aa013','00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000d2','00000000-0000-0000-0000-0000000000e3','paid');
INSERT INTO invoice_lots (invoice_id, lot_id, winning_bid_cents, refunded_at) VALUES
 ('00000000-0000-0000-0000-0000000aa011','00000000-0000-0000-0000-00000000f011',100, now() - interval '1 day'),
 ('00000000-0000-0000-0000-0000000aa012','00000000-0000-0000-0000-00000000f012',100, NULL),
 ('00000000-0000-0000-0000-0000000aa013','00000000-0000-0000-0000-00000000f013',100, NULL);

SET session_replication_role = origin;
