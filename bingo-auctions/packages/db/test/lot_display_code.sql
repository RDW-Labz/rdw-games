-- Behavioural test for mig 0315: `display_code`, the PostgREST computed column
-- that resolves the label physically on the box. Plain-psql assertions, no
-- pgTAP (matches relist_label_reclaim.sql).
--
-- The prod shape that motivated it (2026-08-10, six-item relist test):
--   TEA4951993 (legacy root: label lives in LOT_CODE, sticker lane empty)
--     → BIN-006802 (unsold twin, wears BIN:TEA4951993)
--     → BIN-007904 (won, sticker NULL)
--   Five sibling lots resolved fine because their parents carry BIN:… in
--   sticker_code; the sixth's label was only ever a legacy lot_code, so every
--   surface that did not join lineage printed "BIN-007904" while the box in the
--   warehouse read "TEA4951993".
--
-- Cases:
--   1. own sticker wins, operator prefix stripped
--   2. no sticker anywhere in lineage → own lot_code (a genuinely unlabelled lot)
--   3. LEGACY PARENT: label read from the parent's lot_code — the reported bug
--   4. sticker-bearing parent beats that parent's synthetic lot_code
--   5. a synthetic BIN-###### ancestor is NOT inheritable
--   6. DEPTH: resolves 4 ancestors up — past the 2 any PostgREST embed returns
--   7. nearest ancestor wins when two ancestors both carry a label
--   8. a lineage CYCLE terminates instead of spinning
--
-- Runs against the migrated-but-empty CI database, inside a transaction that
-- is ROLLED BACK, so the DB is left untouched.

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
INSERT INTO operators (id, slug, business_name, contact_email, code)
VALUES ('d0000000-0000-0000-0000-0000000000f1', 'displaycode', 'Display Code Test Co',
        'display@example.com', 'DSP');

INSERT INTO warehouses (id, operator_id, name, address_line1, city, state, postal_code)
VALUES ('d0000000-0000-0000-0000-0000000000f2', 'd0000000-0000-0000-0000-0000000000f1',
        'DSP WH', '1 Display St', 'Harrison', 'AR', '72601');

-- Mint a lot with an explicit code/sticker/parent and return its id. Inserting
-- straight into `lots` (rather than via an RPC) is deliberate: this test is
-- about how a row RESOLVES, independent of which write path produced it.
CREATE FUNCTION pg_temp.mk_lot(
  p_code    TEXT,
  p_sticker TEXT,
  p_parent  UUID
) RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE
  v_id UUID := gen_random_uuid();
BEGIN
  INSERT INTO lots (id, operator_id, warehouse_id, lot_code, sticker_code,
                    relisted_from_lot_id, title, condition, status)
  VALUES (v_id, 'd0000000-0000-0000-0000-0000000000f1',
          'd0000000-0000-0000-0000-0000000000f2', p_code, p_sticker,
          p_parent, 'Display test ' || p_code, 'good', 'in_inventory');
  RETURN v_id;
END
$$;

-- Read the computed column exactly as PostgREST would.
CREATE FUNCTION pg_temp.dc(p_id UUID) RETURNS TEXT LANGUAGE sql AS $$
  SELECT public.display_code(l) FROM lots l WHERE l.id = p_id
$$;

CREATE FUNCTION pg_temp.expect(p_case TEXT, p_got TEXT, p_want TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF p_got IS DISTINCT FROM p_want THEN
    RAISE EXCEPTION '% — expected %, got %', p_case, COALESCE(p_want, 'NULL'), COALESCE(p_got, 'NULL');
  END IF;
  RAISE NOTICE 'ok: % -> %', p_case, p_got;
END
$$;

-- ---------------------------------------------------------------------------
-- 1. Own sticker wins, prefix stripped.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_id UUID;
BEGIN
  v_id := pg_temp.mk_lot('BIN-000001', 'DSP:PNK4996455', NULL);
  PERFORM pg_temp.expect('1 own sticker', pg_temp.dc(v_id), 'PNK4996455');
END
$$;

-- ---------------------------------------------------------------------------
-- 2. Nothing to inherit → own lot_code.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_id UUID;
BEGIN
  v_id := pg_temp.mk_lot('BIN-000002', NULL, NULL);
  PERFORM pg_temp.expect('2 unlabelled lot keeps lot_code', pg_temp.dc(v_id), 'BIN-000002');
END
$$;

-- ---------------------------------------------------------------------------
-- 3. THE REPORTED BUG. Legacy parent carries the label as its lot_code; the
--    stickerless relist child must report it, not its own BIN-######.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_root UUID; v_child UUID;
BEGIN
  v_root  := pg_temp.mk_lot('TEA4951993', NULL, NULL);
  v_child := pg_temp.mk_lot('BIN-007904', NULL, v_root);
  PERFORM pg_temp.expect('3 legacy parent lot_code', pg_temp.dc(v_child), 'TEA4951993');
  PERFORM pg_temp.expect('3 legacy root itself', pg_temp.dc(v_root), 'TEA4951993');
END
$$;

-- ---------------------------------------------------------------------------
-- 4. A parent's sticker outranks that same parent's synthetic lot_code.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_parent UUID; v_child UUID;
BEGIN
  v_parent := pg_temp.mk_lot('BIN-006802', 'DSP:TEA4951993', NULL);
  v_child  := pg_temp.mk_lot('BIN-007905', NULL, v_parent);
  PERFORM pg_temp.expect('4 parent sticker', pg_temp.dc(v_child), 'TEA4951993');
END
$$;

-- ---------------------------------------------------------------------------
-- 5. A synthetic BIN-###### ancestor is not a physical label — do not inherit
--    it. The child keeps its own code rather than borrowing a meaningless one.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_parent UUID; v_child UUID;
BEGIN
  v_parent := pg_temp.mk_lot('BIN-006803', NULL, NULL);
  v_child  := pg_temp.mk_lot('BIN-007906', NULL, v_parent);
  PERFORM pg_temp.expect('5 synthetic ancestor not inherited', pg_temp.dc(v_child), 'BIN-007906');
END
$$;

-- ---------------------------------------------------------------------------
-- 6. DEPTH. Every shipped PostgREST embed returns two ancestors, so the
--    TypeScript walk gave up here and printed BIN-######. Resolving in SQL is
--    the whole reason this column exists.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_a UUID; v_b UUID; v_c UUID; v_d UUID; v_e UUID;
BEGIN
  v_a := pg_temp.mk_lot('BRN4371902', NULL, NULL);   -- label, 4 hops up
  v_b := pg_temp.mk_lot('BIN-008001', NULL, v_a);
  v_c := pg_temp.mk_lot('BIN-008002', NULL, v_b);
  v_d := pg_temp.mk_lot('BIN-008003', NULL, v_c);
  v_e := pg_temp.mk_lot('BIN-008004', NULL, v_d);
  PERFORM pg_temp.expect('6 four ancestors deep', pg_temp.dc(v_e), 'BRN4371902');
END
$$;

-- ---------------------------------------------------------------------------
-- 7. Nearest ancestor wins: the box was re-stickered partway up the chain, and
--    the newer label is the one now on it.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_a UUID; v_b UUID; v_c UUID;
BEGIN
  v_a := pg_temp.mk_lot('GRA4020769', NULL, NULL);          -- older label
  v_b := pg_temp.mk_lot('BIN-008101', 'DSP:PNK4858852', v_a); -- re-stickered
  v_c := pg_temp.mk_lot('BIN-008102', NULL, v_b);
  PERFORM pg_temp.expect('7 nearest ancestor wins', pg_temp.dc(v_c), 'PNK4858852');
END
$$;

-- ---------------------------------------------------------------------------
-- 8. A lineage CYCLE must terminate. 0312 exists because relist chains have
--    cycled on prod; a resolver that loops would hang every read of the row.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_x UUID; v_y UUID; v_got TEXT;
BEGIN
  v_x := pg_temp.mk_lot('BIN-008201', NULL, NULL);
  v_y := pg_temp.mk_lot('BIN-008202', NULL, v_x);
  UPDATE lots SET relisted_from_lot_id = v_y WHERE id = v_x;  -- close the loop
  v_got := pg_temp.dc(v_y);
  -- No label anywhere in the cycle, so it must fall through to its own code —
  -- the assertion that matters is that this statement RETURNS at all.
  PERFORM pg_temp.expect('8 cycle terminates', v_got, 'BIN-008202');
END
$$;

ROLLBACK;
