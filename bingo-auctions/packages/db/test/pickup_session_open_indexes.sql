-- Behavioural test for mig 0297's pickup_sessions open-session indexes.
-- Plain-psql assertions, no pgTAP (matches lineage_assign_guard.sql).
--
-- Proves the model 0293 described and 0297 finally delivers:
--   allowed  — one open session per warehouse, PLUS one legacy
--              (warehouse_id IS NULL) session, held simultaneously. 0293
--              created the per-warehouse index but never dropped the old
--              bidder-wide one, so this combination raised 23505 and
--              getOrCreateOpenSession returned null. 49 of the 107 bidders
--              with items to collect had no pickup pass at all as a result
--              (prod, 2026-07-29).
--   refused  — a SECOND open session for the same (bidder, warehouse), and a
--              second open legacy session. Without the 0297 replacement index
--              the legacy slot would be unbounded, because NULL is never equal
--              to itself in a unique index.
--
-- A closed session must never block a new open one, so the last case reopens
-- the same warehouse after completing the first.
--
-- Runs against the migrated-but-empty CI database, inside a transaction that is
-- ROLLED BACK, so the DB is left untouched.

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
INSERT INTO operators (id, slug, business_name, contact_email, code)
VALUES ('b0000000-0000-0000-0000-0000000000e1', 'pickupidxtest', 'Pickup Index Test Co',
        'pickupidx@example.com', 'PIX');

INSERT INTO warehouses (id, operator_id, name, address_line1, city, state, postal_code)
VALUES ('b0000000-0000-0000-0000-0000000000e2', 'b0000000-0000-0000-0000-0000000000e1',
        'PIX Harrison', '1 Pickup St', 'Harrison', 'AR', '72601'),
       ('b0000000-0000-0000-0000-0000000000e3', 'b0000000-0000-0000-0000-0000000000e1',
        'PIX Dodge City', '2 Pickup St', 'Dodge City', 'KS', '67801');

-- The CI harness stubs auth.users as just (id uuid), but bidders triggers read
-- auth.users.email. Real Supabase has the column; add it inside this
-- rolled-back transaction so nothing leaks to the next test.
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email TEXT;

INSERT INTO auth.users (id, email)
VALUES ('b0000000-0000-0000-0000-0000000000e4', 'pickupidx@example.com');

INSERT INTO bidders (id, email, birth_date)
VALUES ('b0000000-0000-0000-0000-0000000000e4', 'pickupidx@example.com', DATE '1990-01-01');

-- Insert one open session and report whether the unique indexes accepted it.
CREATE FUNCTION pg_temp.try_open(p_warehouse UUID) RETURNS TEXT
LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO pickup_sessions (bidder_id, warehouse_id)
  VALUES ('b0000000-0000-0000-0000-0000000000e4', p_warehouse);
  RETURN 'ALLOWED';
EXCEPTION WHEN unique_violation THEN
  RETURN 'REFUSED';
END $$;

-- ---------------------------------------------------------------------------
-- Assertions
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_fail TEXT := '';
  v_got  TEXT;
BEGIN
  -- 1. First Harrison session — the ordinary case.
  v_got := pg_temp.try_open('b0000000-0000-0000-0000-0000000000e2');
  IF v_got <> 'ALLOWED' THEN
    v_fail := v_fail || E'\n  first Harrison open -> ' || v_got || ', expected ALLOWED';
  END IF;

  -- 2. Dodge City alongside Harrison — the point of 0293.
  v_got := pg_temp.try_open('b0000000-0000-0000-0000-0000000000e3');
  IF v_got <> 'ALLOWED' THEN
    v_fail := v_fail || E'\n  Dodge City alongside Harrison -> ' || v_got || ', expected ALLOWED';
  END IF;

  -- 3. Legacy all-locations session alongside both — the case the stale
  --    pre-0293 index broke, and the reason 49 bidders had no pass.
  v_got := pg_temp.try_open(NULL);
  IF v_got <> 'ALLOWED' THEN
    v_fail := v_fail || E'\n  legacy NULL session alongside warehouse ones -> ' || v_got
                     || ', expected ALLOWED (stale pickup_sessions_one_open_idx still present?)';
  END IF;

  -- 4. Second open session for the SAME warehouse — still one per building.
  v_got := pg_temp.try_open('b0000000-0000-0000-0000-0000000000e2');
  IF v_got <> 'REFUSED' THEN
    v_fail := v_fail || E'\n  duplicate Harrison open -> ' || v_got || ', expected REFUSED';
  END IF;

  -- 5. Second open LEGACY session — 0297's replacement index bounds the slot.
  v_got := pg_temp.try_open(NULL);
  IF v_got <> 'REFUSED' THEN
    v_fail := v_fail || E'\n  duplicate legacy open -> ' || v_got
                     || ', expected REFUSED (0297 NULL-scoped index missing?)';
  END IF;

  -- 6. A COMPLETED session must not block a fresh one for that warehouse.
  UPDATE pickup_sessions SET status = 'completed'
   WHERE bidder_id = 'b0000000-0000-0000-0000-0000000000e4'
     AND warehouse_id = 'b0000000-0000-0000-0000-0000000000e2';
  v_got := pg_temp.try_open('b0000000-0000-0000-0000-0000000000e2');
  IF v_got <> 'ALLOWED' THEN
    v_fail := v_fail || E'\n  reopen Harrison after completing -> ' || v_got || ', expected ALLOWED';
  END IF;

  IF v_fail <> '' THEN
    RAISE EXCEPTION 'pickup_sessions open-index assertions failed:%', v_fail;
  END IF;
  RAISE NOTICE 'pickup_session_open_indexes: all 6 cases OK';
END $$;

ROLLBACK;
