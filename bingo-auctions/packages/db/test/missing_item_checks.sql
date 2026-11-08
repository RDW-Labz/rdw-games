-- Mig 0426: Missing Items report + the three resolve actions.
--
--   R1 report lists only unresolved items by default (open + unsellable)
--   F1 Found: puts the lot away (intake_lot_to_bin), records a check, and the
--      0345 relist guard then lets the item be listed again
--   F2 Found refuses a lot that is not marked missing
--   M1 Confirmed missing: written off (disposed, removal_kind 'missing')
--   M2 Confirmed missing refuses an item already found
--   M3 a picker cannot confirm missing; nothing is recorded
--   U1 Unsellable step 1 flags for disposal and keeps it on the report
--   U2 disposal cannot be recorded before step 1
--   U3 Unsellable step 2 records the disposal and resolves it
--   H1 include_resolved shows every state, with the last check and its author
--   S1 another operator's staff see nothing; anon cannot execute any of it
--
-- Runs against the migrated-but-empty CI database, inside a transaction that
-- is ROLLED BACK, so the DB is left untouched.

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO operators (id, slug, business_name, contact_email, code)
VALUES ('c4260000-0000-0000-0000-000000000001', 'missrpt', 'Missing Report Co', 'mr@example.com', 'MRP'),
       ('c4260000-0000-0000-0000-000000000099', 'missrpt2', 'Other Co', 'mr2@example.com', 'MRQ');

INSERT INTO warehouses (id, operator_id, name, address_line1, city, state, postal_code)
VALUES ('c4260000-0000-0000-0000-000000000002', 'c4260000-0000-0000-0000-000000000001',
        'MRP WH', '1 Missing St', 'Harrison', 'AR', '72601');

INSERT INTO bins (id, warehouse_id, code, aisle, x_px, y_px, qr_token)
VALUES ('c4260000-0000-0000-0000-000000000006', 'c4260000-0000-0000-0000-000000000002',
        'MRP-1-01-01', '1', 0, 0, 'c4260000-0000-0000-0000-0000000000b1');

ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email TEXT;
INSERT INTO auth.users (id, email) VALUES
  ('c4260000-0000-0000-0000-000000000010', 'mgr@example.com'),
  ('c4260000-0000-0000-0000-000000000011', 'picker@example.com'),
  ('c4260000-0000-0000-0000-000000000012', 'other@example.com'),
  ('c4260000-0000-0000-0000-000000000005', 'bidder@example.com');
INSERT INTO operator_users (operator_id, user_id, role, email) VALUES
  ('c4260000-0000-0000-0000-000000000001', 'c4260000-0000-0000-0000-000000000010', 'manager', 'mgr@example.com'),
  ('c4260000-0000-0000-0000-000000000001', 'c4260000-0000-0000-0000-000000000011', 'picker', 'picker@example.com'),
  ('c4260000-0000-0000-0000-000000000099', 'c4260000-0000-0000-0000-000000000012', 'manager', 'other@example.com');
INSERT INTO bidders (id, email, birth_date)
VALUES ('c4260000-0000-0000-0000-000000000005', 'bidder@example.com', DATE '1990-01-01');

INSERT INTO auctions (id, operator_id, warehouse_id, title, status,
                      starts_at, ends_at, pickup_starts_at, pickup_ends_at)
VALUES ('c4260000-0000-0000-0000-000000000003', 'c4260000-0000-0000-0000-000000000001',
        'c4260000-0000-0000-0000-000000000002', 'MRP closed', 'closed',
        now() - interval '10 days', now() - interval '8 days',
        now() - interval '7 days', now() - interval '2 days'),
       ('c4260000-0000-0000-0000-000000000004', 'c4260000-0000-0000-0000-000000000001',
        'c4260000-0000-0000-0000-000000000002', 'MRP next', 'draft',
        now() + interval '1 day', now() + interval '3 days',
        now() + interval '4 days', now() + interval '5 days');

INSERT INTO invoices (id, operator_id, auction_id, bidder_id, status, paid_at)
VALUES ('c4260000-0000-0000-0000-000000000007', 'c4260000-0000-0000-0000-000000000001',
        'c4260000-0000-0000-0000-000000000003', 'c4260000-0000-0000-0000-000000000005',
        'paid', now() - interval '6 days');
INSERT INTO pickups (id, invoice_id, warehouse_id, status)
VALUES ('c4260000-0000-0000-0000-000000000008', 'c4260000-0000-0000-0000-000000000007',
        'c4260000-0000-0000-0000-000000000002', 'completed');

-- A, B, C, D: missing at pickup 5 days ago, never found. Shelved 9 days ago.
-- E: removed from inventory as missing (0352), no pickup mark.
-- F: missing 5 days ago, put away 1 day ago (a location event) — found.
INSERT INTO lots (id, operator_id, warehouse_id, auction_id, lot_code, title, status,
                  intake_bin_id, intake_at, removal_kind, removed_at, removal_note, photo_urls)
SELECT ('c4260000-0000-0000-0000-0000000000' || t.suffix)::uuid,
       'c4260000-0000-0000-0000-000000000001', 'c4260000-0000-0000-0000-000000000002',
       'c4260000-0000-0000-0000-000000000003', 'MRP-' || t.tag, 'Missing fixture ' || t.tag,
       t.st::lot_status, 'c4260000-0000-0000-0000-000000000006', now() - interval '9 days',
       t.rk, CASE WHEN t.rk IS NOT NULL THEN now() - interval '4 days' END,
       CASE WHEN t.rk IS NOT NULL THEN 'Shelf check: not there' END,
       '{}'::text[]
  FROM (VALUES ('a1', 'A', 'unsold', NULL), ('a2', 'B', 'unsold', NULL),
               ('a3', 'C', 'unsold', NULL), ('a4', 'D', 'unsold', NULL),
               ('a5', 'E', 'disposed', 'missing'), ('a6', 'F', 'unsold', NULL)) AS t(suffix, tag, st, rk);

-- Inserting a lot with a shelf logs a put-away event dated now() (the
-- lots_log_intake_move trigger). Date it at the real shelving time, before the
-- missing mark, or every fixture would read as found.
UPDATE lot_location_events e SET occurred_at = now() - interval '9 days'
  FROM lots l WHERE l.id = e.lot_id AND l.lot_code LIKE 'MRP-%';

INSERT INTO pickup_lot_outcomes (pickup_id, lot_id, outcome, note, decided_by, created_at)
SELECT 'c4260000-0000-0000-0000-000000000008', ('c4260000-0000-0000-0000-0000000000' || s)::uuid,
       'missing', CASE WHEN s = 'a1' THEN 'Not in bin at pickup' END,
       'c4260000-0000-0000-0000-000000000011', now() - interval '5 days'
  FROM unnest(ARRAY['a1', 'a2', 'a3', 'a4', 'a6']) AS s;

INSERT INTO lot_location_events (lot_id, bin_id, kind, occurred_at)
VALUES ('c4260000-0000-0000-0000-0000000000a6', 'c4260000-0000-0000-0000-000000000006',
        'intake', now() - interval '1 day');

CREATE FUNCTION pg_temp.as_user(p uuid) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS %L',
                 'SELECT ' || quote_literal(p) || '::uuid');
END $$;

CREATE FUNCTION pg_temp.expect(p_name text, p_ok boolean, p_detail text DEFAULT '') RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'FAIL %: %', p_name, p_detail; END IF;
  RAISE NOTICE 'PASS %', p_name;
END $$;

CREATE FUNCTION pg_temp.codes(p_all boolean) RETURNS text LANGUAGE sql AS $$
  SELECT string_agg(r.lot_code || ':' || r.state, ',' ORDER BY r.lot_code)
    FROM missing_items_report(p_all) r
$$;

SELECT pg_temp.as_user('c4260000-0000-0000-0000-000000000010');

-- R1
SELECT pg_temp.expect('R1 unresolved only',
  pg_temp.codes(false) = 'MRP-A:open,MRP-B:open,MRP-C:open,MRP-D:open', pg_temp.codes(false));
SELECT pg_temp.expect('R1 row detail',
  (SELECT r.reason = 'Not in bin at pickup' AND r.location_code = 'MRP-1-01-01'
          -- photo_urls is cleaned by a lots trigger on insert; match whatever is stored.
          AND r.photo_url IS NOT DISTINCT FROM (SELECT photo_urls[1] FROM lots WHERE lot_code = 'MRP-A') AND r.source = 'pickup'
          AND r.marked_by_name = 'picker@example.com' AND r.check_count = 0
     FROM missing_items_report(false) r WHERE r.lot_code = 'MRP-A'));

-- F1: a picker can mark found (put-away is a floor job)
SELECT pg_temp.as_user('c4260000-0000-0000-0000-000000000011');
SELECT pg_temp.expect('F1 found ok',
  (missing_item_found('c4260000-0000-0000-0000-0000000000a1',
                      'c4260000-0000-0000-0000-0000000000b1', 'On the shelf after all')->>'ok')::boolean);
SELECT pg_temp.expect('F1 check row',
  EXISTS (SELECT 1 FROM missing_item_checks
           WHERE lot_id = 'c4260000-0000-0000-0000-0000000000a1' AND outcome = 'found'
             AND bin_id = 'c4260000-0000-0000-0000-000000000006'
             AND checked_by = 'c4260000-0000-0000-0000-000000000011'));
-- The 0345 guard now lets a relist child through.
INSERT INTO lots (operator_id, warehouse_id, lot_code, title, status, relisted_from_lot_id, relist_count)
VALUES ('c4260000-0000-0000-0000-000000000001', 'c4260000-0000-0000-0000-000000000002',
        'MRP-A-R1', 'relist of A', 'draft', 'c4260000-0000-0000-0000-0000000000a1', 1);
SELECT pg_temp.expect('F1 relist allowed after found', true);

-- F2
SELECT pg_temp.expect('F2 not marked missing',
  missing_item_found((SELECT id FROM lots WHERE lot_code = 'MRP-A-R1'),
                     'c4260000-0000-0000-0000-0000000000b1')->>'reason' = 'not_marked_missing');

-- M3 picker cannot confirm missing
SELECT pg_temp.expect('M3 picker refused',
  missing_item_confirm_missing('c4260000-0000-0000-0000-0000000000a4')->>'reason' = 'admin_or_manager_required');
SELECT pg_temp.expect('M3 nothing recorded',
  NOT EXISTS (SELECT 1 FROM missing_item_checks WHERE lot_id = 'c4260000-0000-0000-0000-0000000000a4'));

SELECT pg_temp.as_user('c4260000-0000-0000-0000-000000000010');

-- M1
SELECT pg_temp.expect('M1 confirm ok',
  (missing_item_confirm_missing('c4260000-0000-0000-0000-0000000000a2', 'Searched twice')->>'ok')::boolean);
SELECT pg_temp.expect('M1 written off',
  (SELECT status::text = 'disposed' AND removal_kind = 'missing' FROM lots
    WHERE id = 'c4260000-0000-0000-0000-0000000000a2'));

-- M2
SELECT pg_temp.expect('M2 already found',
  missing_item_confirm_missing('c4260000-0000-0000-0000-0000000000a1')->>'reason' = 'already_found');

-- U2 before U1
SELECT pg_temp.expect('U2 disposal needs step 1',
  missing_item_unsellable('c4260000-0000-0000-0000-0000000000a3', NULL, 'destroyed')->>'reason'
    = 'not_marked_unsellable');

-- U1
SELECT pg_temp.expect('U1 flag ok',
  (missing_item_unsellable('c4260000-0000-0000-0000-0000000000a3', 'Crushed box')->>'ok')::boolean);
SELECT pg_temp.expect('U1 flagged',
  (SELECT flagged_for_disposal AND flagged_reason LIKE 'unsellable: found after missing%'
     FROM lots WHERE id = 'c4260000-0000-0000-0000-0000000000a3'));
SELECT pg_temp.expect('U1 still on report',
  pg_temp.codes(false) = 'MRP-C:unsellable,MRP-D:open', pg_temp.codes(false));
SELECT pg_temp.expect('U1 found refused while unsellable',
  missing_item_found('c4260000-0000-0000-0000-0000000000a3',
                     'c4260000-0000-0000-0000-0000000000b1')->>'reason' = 'marked_unsellable');

-- U3
SELECT pg_temp.expect('U3 dispose ok',
  (missing_item_unsellable('c4260000-0000-0000-0000-0000000000a3', 'Hauled', 'destroyed')->>'ok')::boolean);
SELECT pg_temp.expect('U3 disposed',
  (SELECT status::text = 'disposed' AND removal_kind = 'destroyed' FROM lots
    WHERE id = 'c4260000-0000-0000-0000-0000000000a3'));
SELECT pg_temp.expect('U3 off the report', pg_temp.codes(false) = 'MRP-D:open', pg_temp.codes(false));

-- H1
SELECT pg_temp.expect('H1 all states',
  pg_temp.codes(true) =
    'MRP-A:found,MRP-B:confirmed_missing,MRP-C:disposed,MRP-D:open,MRP-E:confirmed_missing,MRP-F:found',
  pg_temp.codes(true));
SELECT pg_temp.expect('H1 last check',
  (SELECT r.last_check_outcome = 'disposed' AND r.last_check_note = 'Hauled'
          AND r.last_check_by_name = 'mgr@example.com' AND r.check_count = 2
     FROM missing_items_report(true) r WHERE r.lot_code = 'MRP-C'));
SELECT pg_temp.expect('H1 removal source',
  (SELECT r.source = 'removal' AND r.reason = 'Shelf check: not there'
     FROM missing_items_report(true) r WHERE r.lot_code = 'MRP-E'));

-- S1
SELECT pg_temp.as_user('c4260000-0000-0000-0000-000000000012');
SELECT pg_temp.expect('S1 other operator sees nothing',
  NOT EXISTS (SELECT 1 FROM missing_items_report(true)));
SELECT pg_temp.expect('S1 other operator cannot act',
  missing_item_found('c4260000-0000-0000-0000-0000000000a4',
                     'c4260000-0000-0000-0000-0000000000b1')->>'reason' = 'lot_not_found');
SELECT pg_temp.expect('S1 anon has no execute',
  NOT has_function_privilege('anon', 'public.missing_items_report(boolean)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.missing_item_found(uuid,uuid,text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.missing_item_confirm_missing(uuid,text)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'public.missing_item_unsellable(uuid,text,text)', 'EXECUTE')
  AND NOT has_function_privilege('authenticated', 'public.missing_item_found_since(uuid,timestamptz)', 'EXECUTE')
  AND has_function_privilege('authenticated', 'public.missing_items_report(boolean)', 'EXECUTE'));

ROLLBACK;
