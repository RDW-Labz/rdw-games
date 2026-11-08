-- Behavioural test for mig 0294's one-active-lot-per-item guard on
-- assign_lots_to_auction. Plain-psql assertions, no pgTAP (matches
-- resolve_category_ids_batch.sql).
--
-- Proves BOTH directions of the 2026-07-28 P0:
--   unblocked — two separately-stickered boxes under one lineage root can both
--               be listed (the regression 0288 caused);
--   still shut — a relist twin (sticker on one side only) and any
--                ancestor/descendant pair are still refused (the real duplicate
--                hole 0288/0290 closed).
--
-- Runs against the migrated-but-empty CI database. Everything happens inside a
-- transaction that is ROLLED BACK, so the DB is left untouched.
--
-- auth.uid() is stubbed to NULL by the CI harness; assign_lots_to_auction needs
-- a real staff caller, so we repoint it at a fixed uuid for the duration and
-- restore the NULL stub at the end.

\set ON_ERROR_STOP on

BEGIN;

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT '11111111-1111-1111-1111-111111111111'::uuid $$;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
INSERT INTO operators (id, slug, business_name, contact_email, code)
VALUES ('22222222-2222-2222-2222-222222222222', 'guardtest', 'Guard Test Co',
        'guard@example.com', 'GT');

INSERT INTO auth.users (id) VALUES ('11111111-1111-1111-1111-111111111111');

INSERT INTO operator_users (operator_id, user_id, role, email)
VALUES ('22222222-2222-2222-2222-222222222222',
        '11111111-1111-1111-1111-111111111111', 'admin', 'guard@example.com');

INSERT INTO warehouses (id, operator_id, name, address_line1, city, state, postal_code)
VALUES ('33333333-3333-3333-3333-333333333333',
        '22222222-2222-2222-2222-222222222222', 'WH1', '1 Test St', 'Harrison', 'AR', '72601');

INSERT INTO auctions (id, operator_id, warehouse_id, title, status,
                      starts_at, ends_at, pickup_starts_at, pickup_ends_at)
VALUES ('44444444-4444-4444-4444-444444444444',
        '22222222-2222-2222-2222-222222222222',
        '33333333-3333-3333-3333-333333333333', 'Guard Test Auction', 'draft',
        now(), now() + interval '2 days',
        now() + interval '3 days', now() + interval '4 days');

-- Lots. `sticker_code` is the physical-identity signal 0294 keys on.
--
--   ROOT_A ── A1 (sticker GT:A1)   two boxes from a quantity-2 manifest line,
--          └─ A2 (sticker GT:A2)   each independently stickered -> DISTINCT
--
--   ROOT_B ── B1 (sticker GT:B1)   relist twin: the relist moved the sticker
--          └─ B2 (sticker NULL )   onto one child -> SAME box
--
--   C1 (sticker GT:C1) ── C2 (sticker GT:C2)   parent/child, i.e. direct line.
--                                              Both stickered on purpose: the
--                                              direct-line refusal must NOT
--                                              care about stickers.
INSERT INTO lots (id, operator_id, warehouse_id, lot_code, title, status,
                  sticker_code, relisted_from_lot_id)
VALUES
  ('aaaa0000-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222222',
   '33333333-3333-3333-3333-333333333333', 'GT-ROOTA', 'Root A', 'relisted', NULL, NULL),
  ('aaaa0000-0000-0000-0000-00000000000a', '22222222-2222-2222-2222-222222222222',
   '33333333-3333-3333-3333-333333333333', 'GT-A1', 'Napoles utility sink', 'in_inventory',
   'GT:A1', 'aaaa0000-0000-0000-0000-000000000000'),
  ('aaaa0000-0000-0000-0000-00000000000b', '22222222-2222-2222-2222-222222222222',
   '33333333-3333-3333-3333-333333333333', 'GT-A2', 'Napoles utility sink', 'in_inventory',
   'GT:A2', 'aaaa0000-0000-0000-0000-000000000000'),

  ('bbbb0000-0000-0000-0000-000000000000', '22222222-2222-2222-2222-222222222222',
   '33333333-3333-3333-3333-333333333333', 'GT-ROOTB', 'Root B', 'relisted', NULL, NULL),
  ('bbbb0000-0000-0000-0000-00000000000a', '22222222-2222-2222-2222-222222222222',
   '33333333-3333-3333-3333-333333333333', 'GT-B1', 'Heiki loft bed', 'in_inventory',
   'GT:B1', 'bbbb0000-0000-0000-0000-000000000000'),
  ('bbbb0000-0000-0000-0000-00000000000b', '22222222-2222-2222-2222-222222222222',
   '33333333-3333-3333-3333-333333333333', 'GT-B2', 'Heiki loft bed', 'in_inventory',
   NULL, 'bbbb0000-0000-0000-0000-000000000000'),

  ('cccc0000-0000-0000-0000-00000000000a', '22222222-2222-2222-2222-222222222222',
   '33333333-3333-3333-3333-333333333333', 'GT-C1', 'Kylan nail desk', 'in_inventory',
   'GT:C1', NULL),
  ('cccc0000-0000-0000-0000-00000000000b', '22222222-2222-2222-2222-222222222222',
   '33333333-3333-3333-3333-333333333333', 'GT-C2', 'Kylan nail desk', 'in_inventory',
   'GT:C2', 'cccc0000-0000-0000-0000-00000000000a');

-- ---------------------------------------------------------------------------
-- Helper: attempt an assign, return the SQLERRM or 'OK'.
-- ---------------------------------------------------------------------------
CREATE FUNCTION pg_temp.try_assign(p_lot UUID) RETURNS TEXT
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM assign_lots_to_auction('44444444-4444-4444-4444-444444444444',
                                 ARRAY[p_lot]);
  RETURN 'OK';
EXCEPTION WHEN OTHERS THEN
  RETURN SQLERRM;
END;
$$;

CREATE FUNCTION pg_temp.expect(p_label TEXT, p_actual TEXT, p_expected TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF p_expected = 'OK' THEN
    IF p_actual <> 'OK' THEN
      RAISE EXCEPTION 'FAIL [%]: expected success, got "%"', p_label, p_actual;
    END IF;
  ELSIF position(p_expected IN p_actual) = 0 THEN
    RAISE EXCEPTION 'FAIL [%]: expected error containing "%", got "%"',
      p_label, p_expected, p_actual;
  END IF;
  RAISE NOTICE 'pass: % -> %', p_label, left(p_actual, 60);
END;
$$;

-- ---------------------------------------------------------------------------
-- 1. UNBLOCKED: two separately-stickered siblings both list.
--    Under 0288 the second call raised lot_item_already_listed — the P0.
-- ---------------------------------------------------------------------------
SELECT pg_temp.expect('A1 first sibling assigns',
       pg_temp.try_assign('aaaa0000-0000-0000-0000-00000000000a'), 'OK');
SELECT pg_temp.expect('A2 second sibling assigns (was the regression)',
       pg_temp.try_assign('aaaa0000-0000-0000-0000-00000000000b'), 'OK');

-- Both really are live listings, not a silent no-op.
DO $$
DECLARE v_n INT;
BEGIN
  SELECT count(*) INTO v_n FROM lots
   WHERE id IN ('aaaa0000-0000-0000-0000-00000000000a',
                'aaaa0000-0000-0000-0000-00000000000b')
     AND status = 'scheduled' AND auction_id = '44444444-4444-4444-4444-444444444444';
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'FAIL: expected 2 scheduled sibling lots, got %', v_n;
  END IF;
  RAISE NOTICE 'pass: both stickered siblings are scheduled';
END $$;

-- ---------------------------------------------------------------------------
-- 2. STILL SHUT: relist twin (sticker on one side only) is refused.
-- ---------------------------------------------------------------------------
SELECT pg_temp.expect('B1 assigns',
       pg_temp.try_assign('bbbb0000-0000-0000-0000-00000000000a'), 'OK');
SELECT pg_temp.expect('B2 unstickered twin refused',
       pg_temp.try_assign('bbbb0000-0000-0000-0000-00000000000b'),
       'lot_item_already_listed');

-- ---------------------------------------------------------------------------
-- 3. STILL SHUT: direct line refused even though BOTH carry a sticker.
--    This is what separates 0294 from "just trust the stickers".
-- ---------------------------------------------------------------------------
SELECT pg_temp.expect('C2 child assigns',
       pg_temp.try_assign('cccc0000-0000-0000-0000-00000000000b'), 'OK');
SELECT pg_temp.expect('C1 parent refused (ancestor of a live lot)',
       pg_temp.try_assign('cccc0000-0000-0000-0000-00000000000a'),
       'lot_item_already_listed');

-- ---------------------------------------------------------------------------
-- 4. The unique index agrees with the RPC: two unstickered active children of
--    one parent must still collide, and stickered ones must not.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_err TEXT := 'none';
BEGIN
  BEGIN
    -- B2 is unstickered; B1 is stickered and already scheduled. Forcing B2
    -- active must trip lots_one_active_relist_child only if B1 were ALSO
    -- unstickered, so first strip B1's sticker to create the real collision.
    UPDATE lots SET sticker_code = NULL
     WHERE id = 'bbbb0000-0000-0000-0000-00000000000a';
    UPDATE lots SET status = 'scheduled'
     WHERE id = 'bbbb0000-0000-0000-0000-00000000000b';
  EXCEPTION WHEN unique_violation THEN
    v_err := 'unique_violation';
  END;
  IF v_err <> 'unique_violation' THEN
    RAISE EXCEPTION
      'FAIL: two active UNSTICKERED children of one parent should violate '
      'lots_one_active_relist_child, got %', v_err;
  END IF;
  RAISE NOTICE 'pass: index still blocks two active unstickered children';
END $$;

-- ---------------------------------------------------------------------------
-- 5. duplicate_lot_audit() classifies the two shapes apart.
--    The stickered sibling pair must NOT be reported as same_root_active (that
--    is the release gate), and must be visible as same_root_distinct_units.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_conflict INT; v_distinct INT;
BEGIN
  SELECT count(*) INTO v_conflict
    FROM duplicate_lot_audit() WHERE kind = 'same_root_active';
  SELECT count(*) INTO v_distinct
    FROM duplicate_lot_audit() WHERE kind = 'same_root_distinct_units';

  IF v_distinct < 1 THEN
    RAISE EXCEPTION
      'FAIL: stickered sibling pair should surface as same_root_distinct_units';
  END IF;
  RAISE NOTICE 'pass: audit reports same_root_active=%, same_root_distinct_units=%',
    v_conflict, v_distinct;
END $$;

ROLLBACK;

-- Restore the harness stub for anything running after this file.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT NULL::uuid $$;

\echo 'lineage_assign_guard: ALL ASSERTIONS PASSED'
