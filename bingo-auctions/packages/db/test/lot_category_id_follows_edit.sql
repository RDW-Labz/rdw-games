-- Behavioural test for mig 0419: lots.category_id follows a category edit.
-- Plain-psql assertions, no pgTAP.
--
-- Before 0419 the lots_autoresolve_category_id trigger only filled a NULL
-- category_id, so editing lots.category (console lot edit, staff worklist)
-- left the lot under its old category in the bidder browse filter.
--
-- Cases:
--   1. INSERT with resolvable text fills category_id (0220 behaviour kept).
--   2. Changing category to another resolvable text re-points category_id.
--   3. Changing category to unresolvable text clears a text-derived id.
--   4. An id not derived from the text (picker / cron) survives a change to
--      unresolvable text.
--   5. An UPDATE that sets category and category_id together keeps the
--      explicit category_id.
--   6. An UPDATE that does not touch category leaves category_id alone,
--      and a same-value category write is not a change.
--   7. INSERT with an explicit category_id keeps it.
--
-- Fake data only. Runs inside a transaction that is ROLLED BACK.
\set ON_ERROR_STOP on
BEGIN;

INSERT INTO operators (id, slug, business_name, contact_email, code)
VALUES ('f4190000-0000-0000-0000-000000000001', 'cat419', 'Cat 419 Test Co',
        'cat419@example.test', 'C19');

INSERT INTO categories (id, name, slug) VALUES
  ('f4190000-0000-0000-0000-0000000000c1', 'Qx419 Widgets', 'qx419-widgets'),
  ('f4190000-0000-0000-0000-0000000000c2', 'Qx419 Gadgets', 'qx419-gadgets'),
  ('f4190000-0000-0000-0000-0000000000c3', 'Qx419 Picked',  'qx419-picked');

INSERT INTO category_aliases (raw, category_id) VALUES
  ('qx419 widgets', 'f4190000-0000-0000-0000-0000000000c1'),
  ('qx419 gadgets', 'f4190000-0000-0000-0000-0000000000c2');

INSERT INTO lots (id, operator_id, lot_code, status, title, category, condition,
                  starting_bid_cents)
VALUES ('f4190000-0000-0000-0000-0000000000a1', 'f4190000-0000-0000-0000-000000000001',
        'C19-A', 'live', 'Thing A', 'Qx419 Widgets', 'good', 500);

DO $$
DECLARE v uuid;
BEGIN
  -- 1. INSERT fills.
  SELECT category_id INTO v FROM lots WHERE id = 'f4190000-0000-0000-0000-0000000000a1';
  IF v IS DISTINCT FROM 'f4190000-0000-0000-0000-0000000000c1'::uuid THEN
    RAISE EXCEPTION 'case 1: insert should resolve to widgets, got %', v;
  END IF;

  -- 2. Edit to another resolvable category re-points.
  UPDATE lots SET category = 'Qx419 Gadgets' WHERE id = 'f4190000-0000-0000-0000-0000000000a1';
  SELECT category_id INTO v FROM lots WHERE id = 'f4190000-0000-0000-0000-0000000000a1';
  IF v IS DISTINCT FROM 'f4190000-0000-0000-0000-0000000000c2'::uuid THEN
    RAISE EXCEPTION 'case 2: edit should re-point to gadgets, got %', v;
  END IF;

  -- 3. Edit to unresolvable text clears the stale text-derived id.
  UPDATE lots SET category = 'zzqq nothing matches 419' WHERE id = 'f4190000-0000-0000-0000-0000000000a1';
  SELECT category_id INTO v FROM lots WHERE id = 'f4190000-0000-0000-0000-0000000000a1';
  IF v IS NOT NULL THEN
    RAISE EXCEPTION 'case 3: unresolvable edit should clear a text-derived id, got %', v;
  END IF;

  -- 4. A picked id (not derived from the text) survives an unresolvable edit...
  UPDATE lots SET category_id = 'f4190000-0000-0000-0000-0000000000c3'
  WHERE id = 'f4190000-0000-0000-0000-0000000000a1';
  UPDATE lots SET category = 'zzqq still nothing 419' WHERE id = 'f4190000-0000-0000-0000-0000000000a1';
  SELECT category_id INTO v FROM lots WHERE id = 'f4190000-0000-0000-0000-0000000000a1';
  IF v IS DISTINCT FROM 'f4190000-0000-0000-0000-0000000000c3'::uuid THEN
    RAISE EXCEPTION 'case 4: picked id should survive unresolvable edit, got %', v;
  END IF;
  -- ...and clearing the text keeps it too.
  UPDATE lots SET category = NULL WHERE id = 'f4190000-0000-0000-0000-0000000000a1';
  SELECT category_id INTO v FROM lots WHERE id = 'f4190000-0000-0000-0000-0000000000a1';
  IF v IS DISTINCT FROM 'f4190000-0000-0000-0000-0000000000c3'::uuid THEN
    RAISE EXCEPTION 'case 4b: picked id should survive clearing the text, got %', v;
  END IF;
  -- ...but a resolvable edit is the newer human choice and wins.
  UPDATE lots SET category = 'Qx419 Widgets' WHERE id = 'f4190000-0000-0000-0000-0000000000a1';
  SELECT category_id INTO v FROM lots WHERE id = 'f4190000-0000-0000-0000-0000000000a1';
  IF v IS DISTINCT FROM 'f4190000-0000-0000-0000-0000000000c1'::uuid THEN
    RAISE EXCEPTION 'case 4c: resolvable edit should re-point to widgets, got %', v;
  END IF;

  -- 5. Both set in one UPDATE: explicit category_id wins.
  UPDATE lots SET category = 'Qx419 Gadgets',
                  category_id = 'f4190000-0000-0000-0000-0000000000c3'
  WHERE id = 'f4190000-0000-0000-0000-0000000000a1';
  SELECT category_id INTO v FROM lots WHERE id = 'f4190000-0000-0000-0000-0000000000a1';
  IF v IS DISTINCT FROM 'f4190000-0000-0000-0000-0000000000c3'::uuid THEN
    RAISE EXCEPTION 'case 5: explicit category_id should win, got %', v;
  END IF;

  -- 6. Non-category UPDATE and same-value category write leave the id alone.
  UPDATE lots SET title = 'Thing A renamed' WHERE id = 'f4190000-0000-0000-0000-0000000000a1';
  UPDATE lots SET category = 'Qx419 Gadgets' WHERE id = 'f4190000-0000-0000-0000-0000000000a1';
  SELECT category_id INTO v FROM lots WHERE id = 'f4190000-0000-0000-0000-0000000000a1';
  IF v IS DISTINCT FROM 'f4190000-0000-0000-0000-0000000000c3'::uuid THEN
    RAISE EXCEPTION 'case 6: unchanged category should not re-resolve, got %', v;
  END IF;

  RAISE NOTICE 'lot_category_id_follows_edit: cases 1-6 OK';
END $$;

-- 7. INSERT with an explicit id keeps it.
INSERT INTO lots (id, operator_id, lot_code, status, title, category, category_id,
                  condition, starting_bid_cents)
VALUES ('f4190000-0000-0000-0000-0000000000a2', 'f4190000-0000-0000-0000-000000000001',
        'C19-B', 'draft', 'Thing B', 'Qx419 Widgets',
        'f4190000-0000-0000-0000-0000000000c3', 'good', 500);

DO $$
DECLARE v uuid;
BEGIN
  SELECT category_id INTO v FROM lots WHERE id = 'f4190000-0000-0000-0000-0000000000a2';
  IF v IS DISTINCT FROM 'f4190000-0000-0000-0000-0000000000c3'::uuid THEN
    RAISE EXCEPTION 'case 7: explicit insert id should be kept, got %', v;
  END IF;
  RAISE NOTICE 'lot_category_id_follows_edit: case 7 OK';
END $$;

ROLLBACK;
