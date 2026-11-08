-- Concurrency test for mig 0492: reorder_lot_photo_urls().
--
-- WHAT MOTIVATED IT (RED TEAM on #683, 2026-11-04): the reorder read
-- lots.photo_urls into a variable and built its UPDATE from that snapshot. A
-- device that appended a photo between the read and the write had its
-- attachment erased by the reorder (or a removal resurrected). The ordinary
-- behaviour tests pre-seed the concurrent URL, so they never exercise that
-- interleaving.
--
-- This test uses a second PostgreSQL session (dblink) so the reorder is
-- genuinely in flight while the first session appends:
--   1. session A locks the lot row,
--   2. session B starts reorder_lot_photo_urls and blocks on the row lock,
--   3. session A appends concurrent.jpg and commits,
--   4. session B must keep that append.
--
-- Without the `FOR UPDATE` read the reorder had already copied the old array,
-- so it would write the order back and drop concurrent.jpg.
--
-- The fixtures are committed (session B must see them) and deleted again at
-- the end; auth.uid() is temporarily driven by a GUC so other tests keep the
-- CI default of NULL.

\set ON_ERROR_STOP on

CREATE EXTENSION IF NOT EXISTS dblink;

CREATE TEMP TABLE IF NOT EXISTS _reorder_0492 (
  res   JSONB,
  final TEXT[]
);
CREATE TEMP TABLE IF NOT EXISTS _reorder_0492_pid (pid INT);

-- ---------------------------------------------------------------------------
-- Committed fixtures
-- ---------------------------------------------------------------------------
BEGIN;

INSERT INTO operators (id, slug, business_name, contact_email, code)
VALUES ('b4920000-0000-0000-0000-000000000001', 'reorderconc', 'Reorder Concurrency Co',
        'reorderconc@example.com', 'RRC');

INSERT INTO warehouses (id, operator_id, name, address_line1, city, state, postal_code)
VALUES ('b4920000-0000-0000-0000-0000000000a1', 'b4920000-0000-0000-0000-000000000001',
        'RRC WH', '1 A St', 'Harrison', 'AR', '72601');

INSERT INTO auth.users (id)
VALUES ('b4920000-0000-0000-0000-000000000003');

INSERT INTO operator_users (operator_id, user_id, role, email)
VALUES ('b4920000-0000-0000-0000-000000000001', 'b4920000-0000-0000-0000-000000000003',
        'picker', 'reorderconc@example.com');

-- Session-scoped identity: unset in every other test, so auth.uid() still
-- behaves like the CI default (NULL) there.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
  LANGUAGE sql STABLE AS
$$ SELECT NULLIF(current_setting('bingo.test_uid', true), '')::uuid $$;

INSERT INTO lots (id, operator_id, warehouse_id, lot_code, status, title, photo_urls)
VALUES ('b4920000-0000-0000-0000-0000000000b1', 'b4920000-0000-0000-0000-000000000001',
        'b4920000-0000-0000-0000-0000000000a1', 'RRC-0001', 'draft', 'Fixture',
        ARRAY['https://npwseclcxcatjhgjrtwe.supabase.co/storage/v1/object/public/lot-photos/a.jpg',
              'https://npwseclcxcatjhgjrtwe.supabase.co/storage/v1/object/public/lot-photos/b.jpg']);

COMMIT;

-- ---------------------------------------------------------------------------
-- Session A holds the row lock; session B starts the reorder and blocks.
-- ---------------------------------------------------------------------------
BEGIN;

SET LOCAL bingo.test_uid = 'b4920000-0000-0000-0000-000000000003';

SELECT photo_urls
  FROM lots
 WHERE id = 'b4920000-0000-0000-0000-0000000000b1'
   FOR UPDATE;

SELECT dblink_connect('reorder_0492', format('dbname=%s user=postgres', current_database()));
SELECT dblink_exec('reorder_0492', 'SET statement_timeout = 20000');
SELECT dblink_exec('reorder_0492', 'SET bingo.test_uid = ''b4920000-0000-0000-0000-000000000003''');

-- Remember session B's backend so the wait below watches the right one.
INSERT INTO _reorder_0492_pid (pid)
SELECT t.pid
  FROM dblink('reorder_0492', 'SELECT pg_backend_pid()') AS t(pid INT);

SELECT dblink_send_query(
  'reorder_0492',
  $query$
    SELECT public.reorder_lot_photo_urls(
      'b4920000-0000-0000-0000-0000000000b1',
      'b4920000-0000-0000-0000-000000000001',
      ARRAY['https://npwseclcxcatjhgjrtwe.supabase.co/storage/v1/object/public/lot-photos/b.jpg',
            'https://npwseclcxcatjhgjrtwe.supabase.co/storage/v1/object/public/lot-photos/a.jpg'])
  $query$
);

-- Wait until session B is actually blocked on the lot row. `Lock` is the
-- proof it reached the row: the fixed read waits in `SELECT ... FOR UPDATE`
-- before copying the array, and the old read reached its UPDATE only after
-- copying the stale snapshot. Merely seeing the query start is too early — the
-- backend can be active before it executes the read, which made this test pass
-- against the unfixed function.
DO $$
DECLARE
  i INT := 0;
BEGIN
  WHILE i < 200 LOOP
    IF EXISTS (
      SELECT 1
        FROM pg_stat_activity AS a
        JOIN _reorder_0492_pid AS p ON p.pid = a.pid
       WHERE a.wait_event_type = 'Lock'
    ) THEN
      RETURN;
    END IF;
    PERFORM pg_sleep(0.05);
    i := i + 1;
  END LOOP;
  RAISE EXCEPTION 'second session did not block on the lot row';
END
$$;

-- The concurrent attachment lands between session B's read and its write.
UPDATE lots
   SET photo_urls = array_append(
         photo_urls,
         'https://npwseclcxcatjhgjrtwe.supabase.co/storage/v1/object/public/lot-photos/concurrent.jpg'),
       updated_at = now()
 WHERE id = 'b4920000-0000-0000-0000-0000000000b1';

COMMIT;

-- ---------------------------------------------------------------------------
-- Collect session B's verdict and the surviving order, then clean up.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_res JSONB;
BEGIN
  SELECT t.res INTO v_res
    FROM dblink_get_result('reorder_0492') AS t(res JSONB);
  -- Drain the trailing empty result so the connection is idle again.
  PERFORM * FROM dblink_get_result('reorder_0492') AS t(res JSONB);

  INSERT INTO _reorder_0492 (res, final)
  SELECT v_res, photo_urls
    FROM lots
   WHERE id = 'b4920000-0000-0000-0000-0000000000b1';
END
$$;

SELECT dblink_disconnect('reorder_0492');

DELETE FROM lots WHERE id = 'b4920000-0000-0000-0000-0000000000b1';
DELETE FROM operator_users
 WHERE user_id = 'b4920000-0000-0000-0000-000000000003';
DELETE FROM auth.users WHERE id = 'b4920000-0000-0000-0000-000000000003';
DELETE FROM warehouses WHERE id = 'b4920000-0000-0000-0000-0000000000a1';
DELETE FROM operators WHERE id = 'b4920000-0000-0000-0000-000000000001';

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
  LANGUAGE sql STABLE AS
$$ SELECT NULL::uuid $$;

-- ---------------------------------------------------------------------------
-- Assertions
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_res   JSONB;
  v_final TEXT[];
BEGIN
  SELECT res, final INTO v_res, v_final FROM _reorder_0492;

  IF v_res IS NULL OR (v_res->>'ok')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'reorder failed under a concurrent append: %', v_res;
  END IF;

  IF v_final[1] NOT LIKE '%/b.jpg' OR v_final[2] NOT LIKE '%/a.jpg' THEN
    RAISE EXCEPTION 'reorder did not apply the requested order: %', v_final;
  END IF;

  IF array_length(v_final, 1) <> 3
     OR NOT (v_final @> ARRAY['https://npwseclcxcatjhgjrtwe.supabase.co/storage/v1/object/public/lot-photos/concurrent.jpg']) THEN
    RAISE EXCEPTION 'concurrent append was lost or duplicated by the reorder: %', v_final;
  END IF;

  IF v_final[3] NOT LIKE '%/concurrent.jpg' THEN
    RAISE EXCEPTION 'concurrent append should stay at the end: %', v_final;
  END IF;
END
$$;
