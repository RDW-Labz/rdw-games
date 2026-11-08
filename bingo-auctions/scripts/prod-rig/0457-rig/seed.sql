\set ON_ERROR_STOP 1
SET session_replication_role = replica;

-- auth.users: 2 operators' worth of staff + 2 bidders.
INSERT INTO auth.users (id) VALUES
 ('00000000-0000-0000-0000-0000000000c1'), -- op A admin
 ('00000000-0000-0000-0000-0000000000c2'), -- op A manager
 ('00000000-0000-0000-0000-0000000000c3'), -- op A picker
 ('00000000-0000-0000-0000-0000000000c4'), -- op B admin (cross-operator negative tests)
 ('00000000-0000-0000-0000-0000000000d1'), -- bidder 1 (waitlisted)
 ('00000000-0000-0000-0000-0000000000d2'); -- bidder 2 (unrelated)

INSERT INTO operators (id, slug, business_name, contact_email, status, code) VALUES
 ('00000000-0000-0000-0000-0000000000a1','op-a','Operator A','a@example.test','active','OPA'),
 ('00000000-0000-0000-0000-0000000000a2','op-b','Operator B','b@example.test','active','OPB');

INSERT INTO warehouses (id, name, address_line1, operator_id, state, postal_code, city) VALUES
 ('00000000-0000-0000-0000-0000000000b1','Warehouse A1','1 St','00000000-0000-0000-0000-0000000000a1','AR','72601','Harrison'),
 ('00000000-0000-0000-0000-0000000000b2','Warehouse B1','2 St','00000000-0000-0000-0000-0000000000a2','AR','72601','Harrison');

INSERT INTO operator_users (operator_id, user_id, role, email) VALUES
 ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000c1','admin','a-admin@example.test'),
 ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000c2','manager','a-mgr@example.test'),
 ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000c3','picker','a-pick@example.test'),
 ('00000000-0000-0000-0000-0000000000a2','00000000-0000-0000-0000-0000000000c4','admin','b-admin@example.test');

INSERT INTO bidders (id, email) VALUES
 ('00000000-0000-0000-0000-0000000000d1','bidder1@example.test'),
 ('00000000-0000-0000-0000-0000000000d2','bidder2@example.test');

SET session_replication_role = origin;
