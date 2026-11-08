-- 0394 rig proof: run on a fresh rigbase copy, once before and once after
-- applying 0392 then 0394 (the migration files Braden adds). Expected after:
-- anon denied; bidder, other operator's staff refused (relist_not_operator_staff);
-- own staff 2-arg + 3-arg ok; second tap refused (0392); no-user call ok.
\set ON_ERROR_STOP 0
\pset format unaligned
\pset tuples_only on
INSERT INTO operators (id, slug, business_name, contact_email, code) VALUES
 ('00000000-0000-0000-0000-00000000000a','bingo-rig','BinGo Rig','rig@example.test','RIG'),
 ('00000000-0000-0000-0000-00000000000b','other-rig','Other Rig','o@example.test','OTH');
INSERT INTO warehouses (id, operator_id, name, address_line1, city, state, postal_code) VALUES
 ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-00000000000a','WH','1 Main','Harrison','AR','72601');
INSERT INTO auth.users (id) VALUES ('00000000-0000-0000-0000-0000000000f1'), ('00000000-0000-0000-0000-0000000000f2'), ('00000000-0000-0000-0000-0000000000f3');
INSERT INTO operator_users (operator_id, user_id, role, email) VALUES
 ('00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-0000000000f1','picker','staff@example.test'),
 ('00000000-0000-0000-0000-00000000000b','00000000-0000-0000-0000-0000000000f3','admin','otherstaff@example.test');
INSERT INTO lots (id, operator_id, warehouse_id, title, lot_code, status, starting_bid_cents) VALUES
 ('00000000-0000-0000-0000-0000000001d1','00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-0000000000a1','P1','RIG-P1','unsold',100),
 ('00000000-0000-0000-0000-0000000001d2','00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-0000000000a1','P2','RIG-P2','unsold',100),
 ('00000000-0000-0000-0000-0000000001d3','00000000-0000-0000-0000-00000000000a','00000000-0000-0000-0000-0000000000a1','P3','RIG-P3','unsold',100);
SELECT 'PRIV anon 2arg=' || has_function_privilege('anon','public.relist_lot_into_auction(uuid,uuid)','EXECUTE') || ' anon 3arg=' || has_function_privilege('anon','public.relist_lot_into_auction(uuid,uuid,uuid)','EXECUTE')
  || ' auth 2arg=' || has_function_privilege('authenticated','public.relist_lot_into_auction(uuid,uuid)','EXECUTE') || ' auth 3arg=' || has_function_privilege('authenticated','public.relist_lot_into_auction(uuid,uuid,uuid)','EXECUTE');
\echo 1 anon, 2-arg
SET ROLE anon; SELECT 'ok ' || relist_lot_into_auction('00000000-0000-0000-0000-0000000001d1', NULL); RESET ROLE;
\echo 2 signed-in bidder, 2-arg
SET ROLE authenticated; SET request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000f2'; SELECT 'ok ' || relist_lot_into_auction('00000000-0000-0000-0000-0000000001d1', NULL); RESET ROLE; RESET request.jwt.claim.sub;
\echo 3 other operator staff, 2-arg
SET ROLE authenticated; SET request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000f3'; SELECT 'ok ' || relist_lot_into_auction('00000000-0000-0000-0000-0000000001d1', NULL); RESET ROLE; RESET request.jwt.claim.sub;
\echo 4 bidder, 3-arg
SET ROLE authenticated; SET request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000f2'; SELECT 'ok ' || relist_lot_into_auction('00000000-0000-0000-0000-0000000001d2', NULL, NULL); RESET ROLE; RESET request.jwt.claim.sub;
\echo 5 own staff, 2-arg, then a second tap
SET ROLE authenticated; SET request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000f1'; SELECT 'ok ' || relist_lot_into_auction('00000000-0000-0000-0000-0000000001d1', NULL); SELECT 'ok ' || relist_lot_into_auction('00000000-0000-0000-0000-0000000001d1', NULL); RESET ROLE; RESET request.jwt.claim.sub;
\echo 6 own staff, 3-arg
SET ROLE authenticated; SET request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000f1'; SELECT 'ok ' || relist_lot_into_auction('00000000-0000-0000-0000-0000000001d2', NULL, NULL); RESET ROLE; RESET request.jwt.claim.sub;
\echo 7 no user (service_role / cron), 2-arg
SELECT 'ok ' || relist_lot_into_auction('00000000-0000-0000-0000-0000000001d3', NULL);
SELECT 'CHILDREN ' || p.lot_code || '=' || count(c.id) || ' ' || coalesce(string_agg(c.status::text || '/' || coalesce(c.relist_origin,'-'), ','),'') FROM lots p LEFT JOIN lots c ON c.relisted_from_lot_id = p.id WHERE p.lot_code LIKE 'RIG-P%' GROUP BY p.lot_code ORDER BY 1;
