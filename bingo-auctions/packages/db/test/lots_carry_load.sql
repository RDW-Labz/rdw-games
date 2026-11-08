-- Behavioural test for mig 0428: new lots carry their load.
-- Plain-psql assertions, no pgTAP (matches lot_worker_attribution.sql).
--
--   1. create_draft_lot/24 with this operator's load → lots.load_id set.
--   2. /24 with ANOTHER operator's load → lot created, load_id NULL, no raise.
--   3. /24 with an ARCHIVED load → lot created, load_id NULL.
--   4. /23 and /22 still resolve and leave load_id NULL (no ambiguity, 42725).
--   5. A relist child inherits its parent's load (relist_lot_into_auction/2).
--   6. A manifest row's lot takes the import's auto-import load, and the
--      MANIFEST load wins over the shift's pick passed to /24.
--   7. Lots that already have a load are never overwritten by either trigger.
--
-- Runs against the migrated-but-empty CI database, inside a transaction that
-- is ROLLED BACK.

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO operators (id, slug, business_name, contact_email, code)
VALUES ('d1000000-0000-0000-0000-000000000001', 'loadcarry', 'Load Carry Co', 'lc@example.com', 'LCY'),
       ('d1000000-0000-0000-0000-0000000000a1', 'loadcarry2', 'Other Co', 'lc2@example.com', 'LC2');

INSERT INTO warehouses (id, operator_id, name, address_line1, city, state, postal_code)
VALUES ('d1000000-0000-0000-0000-000000000002', 'd1000000-0000-0000-0000-000000000001',
        'LCY WH', '1 Load St', 'Harrison', 'AR', '72601');

INSERT INTO auctions (id, operator_id, warehouse_id, title, status, starts_at, ends_at, pickup_starts_at, pickup_ends_at)
VALUES ('d1000000-0000-0000-0000-000000000003', 'd1000000-0000-0000-0000-000000000001',
        'd1000000-0000-0000-0000-000000000002', 'LCY target', 'draft',
        now(), now() + interval '2 days', now() + interval '3 days', now() + interval '4 days');

ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email TEXT;
INSERT INTO auth.users (id, email) VALUES ('d1000000-0000-0000-0000-000000000004', 'lcstaff@example.com');
INSERT INTO operator_users (operator_id, user_id, role, email)
VALUES ('d1000000-0000-0000-0000-000000000001', 'd1000000-0000-0000-0000-000000000004', 'manager', 'lcstaff@example.com');
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT 'd1000000-0000-0000-0000-000000000004'::uuid $$;

-- Loads: shift load (manual), archived load, foreign operator's load.
INSERT INTO loads (id, operator_id, type, source_name, archived_at) VALUES
  ('d1000000-0000-0000-0000-000000000010', 'd1000000-0000-0000-0000-000000000001', 'manual', 'BRN truck 12', NULL),
  ('d1000000-0000-0000-0000-000000000011', 'd1000000-0000-0000-0000-000000000001', 'manual', 'Old truck', now()),
  ('d1000000-0000-0000-0000-0000000000a2', 'd1000000-0000-0000-0000-0000000000a1', 'manual', 'Foreign truck', NULL);

-- A manifest import: the 0148 trigger creates its auto-import load.
INSERT INTO imports (id, operator_id, filename, status)
VALUES ('d1000000-0000-0000-0000-000000000020', 'd1000000-0000-0000-0000-000000000001', 'd2l.json', 'completed');
INSERT INTO import_rows (id, import_id, operator_id, title, status, raw_data)
VALUES ('d1000000-0000-0000-0000-000000000021', 'd1000000-0000-0000-0000-000000000020',
        'd1000000-0000-0000-0000-000000000001', 'Manifest chair', 'pending', '{}');

DO $$
DECLARE
  v_id    UUID;
  v_child UUID;
  v_load  UUID;
  v_mload UUID;
  v_fail  TEXT := '';
  c_op    CONSTANT UUID := 'd1000000-0000-0000-0000-000000000001';
  c_shift CONSTANT UUID := 'd1000000-0000-0000-0000-000000000010';
BEGIN
  -- 1. /24 with this operator's load
  SELECT out_id INTO v_id FROM public.create_draft_lot(
    c_op, 'Shift lot', NULL, NULL, NULL, 'good'::lot_condition, 1000, 100, NULL, NULL, 'BRN',
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, c_shift);
  SELECT load_id INTO v_load FROM lots WHERE id = v_id;
  IF v_load IS DISTINCT FROM c_shift THEN
    v_fail := v_fail || format(E'\n  [1] /24 did not stamp the shift load: %s', v_load);
  END IF;

  -- 2. foreign operator's load → created, NULL
  SELECT out_id INTO v_id FROM public.create_draft_lot(
    c_op, 'Foreign load lot', NULL, NULL, NULL, 'good'::lot_condition, 1000, 100, NULL, NULL, 'x',
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    'd1000000-0000-0000-0000-0000000000a2');
  IF v_id IS NULL THEN
    v_fail := v_fail || E'\n  [2] a foreign load blocked the lot create';
  ELSE
    SELECT load_id INTO v_load FROM lots WHERE id = v_id;
    IF v_load IS NOT NULL THEN v_fail := v_fail || format(E'\n  [2] cross-operator load leaked: %s', v_load); END IF;
  END IF;

  -- 3. archived load → created, NULL
  SELECT out_id INTO v_id FROM public.create_draft_lot(
    c_op, 'Archived load lot', NULL, NULL, NULL, 'good'::lot_condition, 1000, 100, NULL, NULL, 'x',
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
    'd1000000-0000-0000-0000-000000000011');
  SELECT load_id INTO v_load FROM lots WHERE id = v_id;
  IF v_id IS NULL OR v_load IS NOT NULL THEN
    v_fail := v_fail || format(E'\n  [3] archived load: id=%s load=%s', v_id, v_load);
  END IF;

  -- 4. /23 and /22 unchanged
  SELECT out_id INTO v_id FROM public.create_draft_lot(
    c_op, 'Legacy /23', NULL, NULL, NULL, 'good'::lot_condition, 1000, 100, NULL, NULL, 'x',
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL);
  SELECT load_id INTO v_load FROM lots WHERE id = v_id;
  IF v_id IS NULL OR v_load IS NOT NULL THEN
    v_fail := v_fail || format(E'\n  [4a] /23: id=%s load=%s', v_id, v_load);
  END IF;
  SELECT out_id INTO v_id FROM public.create_draft_lot(
    c_op, 'Legacy /22', NULL, NULL, NULL, 'good'::lot_condition, 1000, 100, NULL, NULL, 'x');
  IF v_id IS NULL THEN v_fail := v_fail || E'\n  [4b] /22 returned NULL — overload broke existing callers'; END IF;

  -- 5. relist child inherits parent's load
  SELECT out_id INTO v_id FROM public.create_draft_lot(
    c_op, 'Relist parent', NULL, NULL, NULL, 'good'::lot_condition, 1000, 100, NULL, NULL, 'BRN',
    NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, c_shift);
  UPDATE lots SET status = 'unsold', warehouse_id = 'd1000000-0000-0000-0000-000000000002' WHERE id = v_id;
  v_child := public.relist_lot_into_auction(v_id, 'd1000000-0000-0000-0000-000000000003');
  SELECT load_id INTO v_load FROM lots WHERE id = v_child;
  IF v_load IS DISTINCT FROM c_shift THEN
    v_fail := v_fail || format(E'\n  [5] relist child did not inherit the load: %s', v_load);
  END IF;

  -- 6. manifest row: lot takes the import's load, and it beats the shift pick
  SELECT id INTO v_mload FROM loads WHERE import_id = 'd1000000-0000-0000-0000-000000000020';
  IF v_mload IS NULL THEN
    v_fail := v_fail || E'\n  [6] fixture: 0148 did not create the auto-import load';
  ELSE
    SELECT out_id INTO v_id FROM public.create_draft_lot(
      c_op, 'Manifest chair', NULL, NULL, NULL, 'good'::lot_condition, 1000, 100, NULL, NULL, 'Wayfair-D2L',
      NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
      'd1000000-0000-0000-0000-000000000021', NULL, NULL, c_shift);
    SELECT load_id INTO v_load FROM lots WHERE id = v_id;
    IF v_load IS DISTINCT FROM v_mload THEN
      v_fail := v_fail || format(E'\n  [6] manifest lot load=%s, expected the import load %s', v_load, v_mload);
    END IF;
  END IF;

  -- 7. never overwrite: re-linking the manifest row to a lot that has a load
  UPDATE lots SET load_id = c_shift WHERE id = v_id;
  UPDATE import_rows SET lot_id = NULL WHERE id = 'd1000000-0000-0000-0000-000000000021';
  UPDATE import_rows SET lot_id = v_id WHERE id = 'd1000000-0000-0000-0000-000000000021';
  SELECT load_id INTO v_load FROM lots WHERE id = v_id;
  IF v_load IS DISTINCT FROM c_shift THEN
    v_fail := v_fail || format(E'\n  [7] trigger overwrote an existing load: %s', v_load);
  END IF;

  IF v_fail <> '' THEN
    RAISE EXCEPTION 'lots_carry_load: FAILED%', v_fail;
  END IF;
  RAISE NOTICE 'lots_carry_load: all checks passed';
END
$$;

ROLLBACK;
