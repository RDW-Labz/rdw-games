-- Relot double tap (mig 0392). Run on a fresh copy of rigbase (prod's function
-- bodies over a full migration replay), before 0392, after 0392 and after
-- rollback-0392.sql. Everything runs in one transaction that is rolled back, so
-- the same copy can be reused. Calls the 3-arg overload the staff app calls
-- (it delegates to the 2-arg one), with no worker, as the app does when no
-- lotting worker is picked.
--
--   docker exec -i pgrig psql -U postgres -d <copy> < scripts/prod-rig/relot-double-tap-scenario.sql
\set ON_ERROR_STOP 1
\pset format unaligned
\pset tuples_only on
BEGIN;

-- ── seed ────────────────────────────────────────────────────────────────────
INSERT INTO operators (id, slug, business_name, contact_email, code)
VALUES ('00000000-0000-0000-0000-00000000000a', 'bingo-rig', 'BinGo Rig', 'rig@example.test', 'RIG');
INSERT INTO warehouses (id, operator_id, name, address_line1, city, state, postal_code)
VALUES ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000a', 'WH', '1 Main', 'Harrison', 'AR', '72601');
-- c1: a past auction the refunded sale belongs to. c2: a scheduled one to relot into.
INSERT INTO auctions (id, operator_id, warehouse_id, title, starts_at, ends_at, pickup_starts_at, pickup_ends_at, status, soft_close_minutes, unlisted)
VALUES ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1',
        'Rig past auction', now() - interval '3 days', now() - interval '2 days', now() - interval '2 days', now() + interval '1 day', 'closed', 2, true),
       ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1',
        'Rig next auction', now() + interval '1 day', now() + interval '2 days', now() + interval '2 days', now() + interval '5 days', 'scheduled', 2, true);
-- The CI auth.users stub has only id; bidders' trigger reads email (recipe step 4).
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email text,
  ADD COLUMN IF NOT EXISTS raw_user_meta_data jsonb DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
INSERT INTO auth.users (id, email) VALUES ('00000000-0000-0000-0000-0000000000b1', 'b1@example.test');
INSERT INTO bidders (id, email, default_payment_method_id, birth_date)
VALUES ('00000000-0000-0000-0000-0000000000b1', 'b1@example.test', 'ccof:b1', '1980-01-01');

-- Parents. P1 double tap; P2 its child sells then is refunded; P3 relot into an
-- auction; P4 its child goes unsold; P5 its child is disposed.
INSERT INTO lots (id, operator_id, warehouse_id, title, lot_code, status, starting_bid_cents)
SELECT ('00000000-0000-0000-0000-0000000000d' || n)::uuid, '00000000-0000-0000-0000-00000000000a',
       '00000000-0000-0000-0000-0000000000a1', 'Rig item ' || n, 'RIGP' || n, 'unsold', 100
  FROM generate_series(1, 5) AS n;

CREATE FUNCTION pg_temp.relot(p_parent text, p_auction uuid) RETURNS text LANGUAGE plpgsql AS $f$
DECLARE v_child uuid; v_desc text;
BEGIN
  v_child := public.relist_lot_into_auction((SELECT id FROM lots WHERE lot_code = p_parent), p_auction, NULL::uuid);
  SELECT 'ok, child ' || status::text || coalesce(' lot_number=' || lot_number, '')
    INTO v_desc FROM lots WHERE id = v_child;
  RETURN v_desc;
EXCEPTION WHEN others THEN
  RETURN 'REFUSED ' || split_part(SQLERRM, ':', 1);
END $f$;
CREATE FUNCTION pg_temp.kids(p_parent text) RETURNS text LANGUAGE sql AS $f$
  SELECT count(*) || ' [' || coalesce(string_agg(c.status::text, ',' ORDER BY c.created_at, c.lot_code), '') || ']'
    FROM lots c JOIN lots p ON p.id = c.relisted_from_lot_id
   WHERE p.lot_code = p_parent AND c.deleted_at IS NULL
$f$;

CREATE TEMP TABLE trace (n serial, line text);

-- ── 1. the bug: relot to inventory, then the same parent again ─────────────
INSERT INTO trace (line) SELECT '1 P1 relot #1 (no auction): ' || pg_temp.relot('RIGP1', NULL);
INSERT INTO trace (line) SELECT '1 P1 relot #2 (double tap): ' || pg_temp.relot('RIGP1', NULL);
INSERT INTO trace (line) SELECT '1 P1 children: ' || pg_temp.kids('RIGP1');

-- ── 2. child sold, then fully refunded: the parent may be relotted again ───
INSERT INTO trace (line) SELECT '2 P2 relot #1: ' || pg_temp.relot('RIGP2', NULL);
UPDATE lots SET status = 'won', auction_id = '00000000-0000-0000-0000-0000000000c1'
 WHERE relisted_from_lot_id = '00000000-0000-0000-0000-0000000000d2';
INSERT INTO invoices (id, operator_id, auction_id, bidder_id)
VALUES ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-00000000000a',
        '00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000b1');
INSERT INTO invoice_lots (invoice_id, lot_id, winning_bid_cents, refunded_at)
SELECT '00000000-0000-0000-0000-0000000000e1', id, 500, now()
  FROM lots WHERE relisted_from_lot_id = '00000000-0000-0000-0000-0000000000d2';
INSERT INTO trace (line) SELECT '2 P2 relot #2 (child won, refunded): ' || pg_temp.relot('RIGP2', NULL);
INSERT INTO trace (line) SELECT '2 P2 children: ' || pg_temp.kids('RIGP2');

-- ── 3. relot straight into an auction, then a second tap ───────────────────
INSERT INTO trace (line) SELECT '3 P3 relot into scheduled auction: ' || pg_temp.relot('RIGP3', '00000000-0000-0000-0000-0000000000c2');
INSERT INTO trace (line) SELECT '3 P3 second tap: ' || pg_temp.relot('RIGP3', '00000000-0000-0000-0000-0000000000c2');
INSERT INTO trace (line) SELECT '3 P3 children: ' || pg_temp.kids('RIGP3');

-- ── 4. child went unsold: the parent may be relotted again ─────────────────
INSERT INTO trace (line) SELECT '4 P4 relot #1: ' || pg_temp.relot('RIGP4', NULL);
UPDATE lots SET status = 'unsold' WHERE relisted_from_lot_id = '00000000-0000-0000-0000-0000000000d4';
INSERT INTO trace (line) SELECT '4 P4 relot #2 (child unsold): ' || pg_temp.relot('RIGP4', NULL);
INSERT INTO trace (line) SELECT '4 P4 children: ' || pg_temp.kids('RIGP4');

-- ── 5. child disposed: the parent may be relotted again ────────────────────
INSERT INTO trace (line) SELECT '5 P5 relot #1: ' || pg_temp.relot('RIGP5', NULL);
UPDATE lots SET status = 'disposed', removal_kind = 'other'
 WHERE relisted_from_lot_id = '00000000-0000-0000-0000-0000000000d5';
INSERT INTO trace (line) SELECT '5 P5 relot #2 (child disposed): ' || pg_temp.relot('RIGP5', NULL);
INSERT INTO trace (line) SELECT '5 P5 children: ' || pg_temp.kids('RIGP5');

SELECT line FROM trace ORDER BY n;
SELECT 'acl ' || p.oid::regprocedure::text || ' ' || coalesce(p.proacl::text, '(default)')
  FROM pg_proc p WHERE p.proname = 'relist_lot_into_auction' ORDER BY 1;
ROLLBACK;
