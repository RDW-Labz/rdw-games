-- 0400 rig proof (lots BEFORE DELETE footprint guard + audit row).
-- Run on a fresh rigbase copy, once before and once after applying
-- /tmp/0400_lots_hard_delete_footprint_guard.sql (the file Braden adds).
-- Expected after: every lot with a sticker / shelf / intake / bin assignment /
-- location event / claimed sticker refuses with lot_has_physical_footprint and
-- survives; the bare draft and bare canceled lot delete, each with one
-- operator_audit_log row (lot.hard_deleted) carrying lot_code, sticker, status
-- and the actor (user id via JWT; header actor for service_role; none for SQL).
-- Before: every delete succeeds and no audit row is written.
\set ON_ERROR_STOP 0
\pset format unaligned
\pset tuples_only on
-- Prod grants ALL on lots to authenticated/service_role (Supabase default);
-- the rig has no Supabase grants, so mimic them for the RLS path.
GRANT SELECT ON ALL TABLES IN SCHEMA public TO authenticated, service_role;
GRANT DELETE ON public.lots TO authenticated, service_role;
INSERT INTO operators (id, slug, business_name, contact_email, code) VALUES
 ('00000000-0000-0000-0000-00000000000a','bingo-rig','BinGo Rig','rig@example.test','RIG');
INSERT INTO warehouses (id, operator_id, name, address_line1, city, state, postal_code) VALUES
 ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-00000000000a','WH','1 Main','Harrison','AR','72601');
INSERT INTO bins (id, warehouse_id, code, aisle, x_px, y_px) VALUES
 ('00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000a1','A-01','A',0,0);
INSERT INTO auth.users (id) VALUES ('00000000-0000-0000-0000-0000000000f1');
INSERT INTO operator_users (operator_id, user_id, role, email) VALUES
 ('00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-0000000000f1','admin','admin@example.test');
INSERT INTO lots (id, operator_id, warehouse_id, title, lot_code, status, starting_bid_cents) VALUES
 ('00000000-0000-0000-0000-000000000d01','00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-0000000000a1','sticker only','RIG-STK','pending_intake',100),
 ('00000000-0000-0000-0000-000000000d02','00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-0000000000a1','shelf+intake','RIG-SHF','in_inventory',100),
 ('00000000-0000-0000-0000-000000000d03','00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-0000000000a1','location event only','RIG-LOC','canceled',100),
 ('00000000-0000-0000-0000-000000000d04','00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-0000000000a1','bin assignment only','RIG-BAS','unsold',100),
 ('00000000-0000-0000-0000-000000000d05','00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-0000000000a1','claimed pool sticker only','RIG-POOL','pending_intake',100),
 ('00000000-0000-0000-0000-000000000d06','00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-0000000000a1','BIN-028904 shape','RIG-028904','in_inventory',100),
 ('00000000-0000-0000-0000-000000000d07','00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-0000000000a1','bare draft','RIG-BARE','pending_intake',100),
 ('00000000-0000-0000-0000-000000000d08','00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-0000000000a1','bare canceled','RIG-BARE2','canceled',100),
 ('00000000-0000-0000-0000-000000000d09','00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-0000000000a1','bare sql','RIG-BARE3','pending_intake',100);
UPDATE lots SET sticker_code = 'RIG:STK0400A' WHERE id = '00000000-0000-0000-0000-000000000d01';
UPDATE lots SET intake_bin_id = '00000000-0000-0000-0000-0000000000b1', intake_at = now() WHERE id = '00000000-0000-0000-0000-000000000d02';
INSERT INTO lot_location_events (lot_id, kind, bin_id) VALUES ('00000000-0000-0000-0000-000000000d03','staged','00000000-0000-0000-0000-0000000000b1');
INSERT INTO bin_assignments (lot_id, bin_id) VALUES ('00000000-0000-0000-0000-000000000d04','00000000-0000-0000-0000-0000000000b1');
INSERT INTO lot_sticker_pool (qr_token, operator_id, printed_batch_id, claimed_at, claimed_by_lot_id) VALUES
 (gen_random_uuid(),'00000000-0000-0000-0000-00000000000a',gen_random_uuid(),now(),'00000000-0000-0000-0000-000000000d05');
UPDATE lots SET sticker_code = 'RIG:STK0400B', intake_bin_id = '00000000-0000-0000-0000-0000000000b1', intake_at = now() WHERE id = '00000000-0000-0000-0000-000000000d06';
INSERT INTO lot_location_events (lot_id, kind, bin_id) VALUES ('00000000-0000-0000-0000-000000000d06','intake','00000000-0000-0000-0000-0000000000b1');
-- Fixture check: the three RIG-BARE lots must show no evidence.
SELECT 'FIXTURE ' || lot_code || ' sticker=' || coalesce(sticker_code,'-') || ' shelf=' || (intake_bin_id IS NOT NULL) || ' events=' || (SELECT count(*) FROM lot_location_events e WHERE e.lot_id = l.id)
  FROM lots l WHERE lot_code LIKE 'RIG-%' ORDER BY lot_code;

\echo === 1 console path: admin via JWT (authenticated + RLS), each footprint lot
SET ROLE authenticated; SET request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000f1'; SET request.jwt.claim.role = 'authenticated';
DELETE FROM lots WHERE id = '00000000-0000-0000-0000-000000000d01' RETURNING 'DELETED ' || lot_code;
DELETE FROM lots WHERE id = '00000000-0000-0000-0000-000000000d02' RETURNING 'DELETED ' || lot_code;
DELETE FROM lots WHERE id = '00000000-0000-0000-0000-000000000d03' RETURNING 'DELETED ' || lot_code;
DELETE FROM lots WHERE id = '00000000-0000-0000-0000-000000000d04' RETURNING 'DELETED ' || lot_code;
DELETE FROM lots WHERE id = '00000000-0000-0000-0000-000000000d05' RETURNING 'DELETED ' || lot_code;
DELETE FROM lots WHERE id = '00000000-0000-0000-0000-000000000d06' RETURNING 'DELETED ' || lot_code;
\echo === 2 console path: bare draft
DELETE FROM lots WHERE id = '00000000-0000-0000-0000-000000000d07' RETURNING 'DELETED ' || lot_code;
RESET ROLE; RESET request.jwt.claim.sub; RESET request.jwt.claim.role;

\echo === 3 drafts path: service_role with x-bingo-actor header, bare canceled lot
SET ROLE service_role; SET request.jwt.claim.role = 'service_role';
SET request.headers = '{"x-bingo-actor":"00000000-0000-0000-0000-0000000000f1"}';
DELETE FROM lots WHERE id = '00000000-0000-0000-0000-000000000d08' RETURNING 'DELETED ' || lot_code;
\echo === 4 service_role, multi-row delete including footprint lots: all-or-nothing
DELETE FROM lots WHERE lot_code IN ('RIG-STK','RIG-SHF') RETURNING 'DELETED ' || lot_code;
RESET ROLE; RESET request.jwt.claim.role; RESET request.headers;

\echo === 5 direct SQL (postgres, no JWT): bare lot, then BIN-028904 shape
DELETE FROM lots WHERE id = '00000000-0000-0000-0000-000000000d09' RETURNING 'DELETED ' || lot_code;
DELETE FROM lots WHERE id = '00000000-0000-0000-0000-000000000d06' RETURNING 'DELETED ' || lot_code;

\echo === RESULT surviving lots (expect the six footprint lots)
SELECT 'SURVIVES ' || lot_code FROM lots WHERE lot_code LIKE 'RIG-%' ORDER BY lot_code;
\echo === RESULT audit rows (expect RIG-BARE, RIG-BARE2, RIG-BARE3)
SELECT 'AUDIT ' || action_type || ' ' || (before_state ->> 'lot_code') || ' sticker=' || coalesce(before_state ->> 'sticker_code','null')
       || ' status=' || (before_state ->> 'status') || ' actor=' || coalesce(actor_user_id::text,'none') || ' via=' || (after_state ->> 'via')
  FROM operator_audit_log WHERE action_type = 'lot.hard_deleted' ORDER BY id;
