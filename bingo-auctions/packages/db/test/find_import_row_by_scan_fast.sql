-- Behavioural test for mig 0386's indexed tracking probe in
-- find_import_row_by_scan (both overloads).
--
-- Pins what the floor needs from a FedEx label scan on a Wayfair manifest row:
--   • a 12-digit tracking number finds its pending row (kind 'tracking' and 'auto');
--   • the raw 34-digit FedEx Ground composite finds the same row (0163 suffix);
--   • a row that stores several tokens in one tracking_number ("a b") is found
--     by its SECOND token (the list fallback 0386 keeps);
--   • exact beats list when both would match;
--   • a lotted row never comes back; an unknown number is a clean miss;
--   • every call answers in under 100 ms here (the table is tiny in CI; the
--     prod-shaped timing proof lives in the 0386 PR).
--
-- Fake data only: synthetic operator, user, tracking numbers. Runs inside a
-- transaction that is ROLLED BACK, so the DB is left untouched.
\set ON_ERROR_STOP on
BEGIN;

INSERT INTO operators (id, slug, business_name, contact_email, code)
VALUES ('f0000000-0000-0000-0000-000000000011', 'trktest', 'Tracking Test Co',
        'trk@example.test', 'TRK');
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email TEXT;
INSERT INTO auth.users (id, email)
VALUES ('f0000000-0000-0000-0000-000000000013', 'trk@example.test');
INSERT INTO operator_users (operator_id, user_id, role, email)
VALUES ('f0000000-0000-0000-0000-000000000011', 'f0000000-0000-0000-0000-000000000013',
        'manager', 'trk@example.test');
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT 'f0000000-0000-0000-0000-000000000013'::uuid $$;

INSERT INTO imports (id, operator_id, filename, status)
VALUES ('f0000000-0000-0000-0000-000000000014', 'f0000000-0000-0000-0000-000000000011',
        'fake_wayfair.json', 'completed');

-- Five single-box rows, one two-token list row, one lotted row, one row that
-- would collide with the list row's first token if exact did not win.
INSERT INTO import_rows (import_id, operator_id, title, tracking_number, status, raw_data, created_at)
VALUES
  ('f0000000-0000-0000-0000-000000000014', 'f0000000-0000-0000-0000-000000000011', 'Fake chandelier',  '541200000001', 'pending', '{}', now() - interval '5 days'),
  ('f0000000-0000-0000-0000-000000000014', 'f0000000-0000-0000-0000-000000000011', 'Fake dresser',     '541200000002', 'pending', '{}', now() - interval '4 days'),
  ('f0000000-0000-0000-0000-000000000014', 'f0000000-0000-0000-0000-000000000011', 'Fake bed',         '541200000003', 'pending', '{}', now() - interval '3 days'),
  ('f0000000-0000-0000-0000-000000000014', 'f0000000-0000-0000-0000-000000000011', 'Fake comforter',   '541200000004', 'pending', '{}', now() - interval '2 days'),
  ('f0000000-0000-0000-0000-000000000014', 'f0000000-0000-0000-0000-000000000011', 'Fake tissue box',  '541200000005', 'pending', '{}', now() - interval '1 day'),
  ('f0000000-0000-0000-0000-000000000014', 'f0000000-0000-0000-0000-000000000011', 'Fake list row',    '541200000006 541200000007', 'pending', '{}', now() - interval '1 day'),
  ('f0000000-0000-0000-0000-000000000014', 'f0000000-0000-0000-0000-000000000011', 'Fake lotted row',  '541200000008', 'lotted',  '{}', now() - interval '1 day'),
  ('f0000000-0000-0000-0000-000000000014', 'f0000000-0000-0000-0000-000000000011', 'Fake exact twin',  '541200000006', 'pending', '{}', now());

DO $$
DECLARE
  v_t0   timestamptz;
  v_ms   numeric;
  v_res  jsonb;
  v_code text;
  v_kind text;
  v_title text;
BEGIN
  -- 1. The five labels, 12-digit, both overloads and both kinds.
  FOR v_code, v_title IN
    SELECT * FROM (VALUES
      ('541200000001', 'Fake chandelier'), ('541200000002', 'Fake dresser'),
      ('541200000003', 'Fake bed'), ('541200000004', 'Fake comforter'),
      ('541200000005', 'Fake tissue box')) AS v(c, t)
  LOOP
    FOREACH v_kind IN ARRAY ARRAY['tracking', 'auto'] LOOP
      v_t0 := clock_timestamp();
      v_res := public.find_import_row_by_scan(ARRAY[v_code], v_kind);
      v_ms := extract(epoch FROM (clock_timestamp() - v_t0)) * 1000;
      IF coalesce((v_res->>'ok')::boolean, false) IS NOT TRUE
         OR v_res->'manifest_row'->>'title' <> v_title
         OR v_res->>'matched_field' <> 'tracking_number' THEN
        RAISE EXCEPTION '12-digit % kind=% did not find "%": %', v_code, v_kind, v_title, v_res;
      END IF;
      IF v_ms >= 100 THEN
        RAISE EXCEPTION '12-digit % kind=% took % ms (limit 100)', v_code, v_kind, round(v_ms);
      END IF;
    END LOOP;
    v_res := public.find_import_row_by_scan(ARRAY[v_code]);
    IF v_res->'manifest_row'->>'title' <> v_title THEN
      RAISE EXCEPTION '1-arg overload % did not find "%": %', v_code, v_title, v_res;
    END IF;
  END LOOP;

  -- 2. The 34-digit FedEx Ground composite (last 12 = the tracking number).
  v_t0 := clock_timestamp();
  v_res := public.find_import_row_by_scan(ARRAY['9622013140000000000000541200000001'], 'tracking');
  v_ms := extract(epoch FROM (clock_timestamp() - v_t0)) * 1000;
  IF v_res->'manifest_row'->>'title' <> 'Fake chandelier' THEN
    RAISE EXCEPTION '34-digit composite did not resolve to the chandelier: %', v_res;
  END IF;
  IF v_ms >= 100 THEN
    RAISE EXCEPTION '34-digit composite took % ms (limit 100)', round(v_ms);
  END IF;
  v_res := public.find_import_row_by_scan(ARRAY['9622013140000000000000541200000001']);
  IF v_res->'manifest_row'->>'title' <> 'Fake chandelier' THEN
    RAISE EXCEPTION '34-digit composite (1-arg) did not resolve to the chandelier: %', v_res;
  END IF;

  -- 3. A list row is found by its second token (the fallback 0386 keeps).
  v_t0 := clock_timestamp();
  v_res := public.find_import_row_by_scan(ARRAY['541200000007'], 'tracking');
  v_ms := extract(epoch FROM (clock_timestamp() - v_t0)) * 1000;
  IF v_res->'manifest_row'->>'title' <> 'Fake list row' THEN
    RAISE EXCEPTION 'second token of a list row was not found: %', v_res;
  END IF;
  IF v_ms >= 100 THEN
    RAISE EXCEPTION 'list-row probe took % ms (limit 100)', round(v_ms);
  END IF;

  -- 4. Exact beats list: 541200000006 is the list row's first token AND an
  --    exact row of its own; the exact row must win.
  v_res := public.find_import_row_by_scan(ARRAY['541200000006'], 'tracking');
  IF v_res->'manifest_row'->>'title' <> 'Fake exact twin' THEN
    RAISE EXCEPTION 'exact match did not beat the list row: %', v_res;
  END IF;

  -- 5. A lotted row never comes back; an unknown number is a clean miss.
  v_res := public.find_import_row_by_scan(ARRAY['541200000008'], 'tracking');
  IF coalesce((v_res->>'ok')::boolean, true) THEN
    RAISE EXCEPTION 'lotted row was returned: %', v_res;
  END IF;
  v_t0 := clock_timestamp();
  v_res := public.find_import_row_by_scan(ARRAY['541299999999', '9622013140000000000000541299999999'], 'tracking');
  v_ms := extract(epoch FROM (clock_timestamp() - v_t0)) * 1000;
  IF coalesce((v_res->>'ok')::boolean, true) OR v_res->>'reason' <> 'manifest_row_not_found' THEN
    RAISE EXCEPTION 'unknown number was not a clean miss: %', v_res;
  END IF;
  IF v_ms >= 100 THEN
    RAISE EXCEPTION 'miss took % ms (limit 100)', round(v_ms);
  END IF;
  v_res := public.find_import_row_by_scan(ARRAY['541299999999']);
  IF coalesce((v_res->>'ok')::boolean, true) THEN
    RAISE EXCEPTION 'unknown number (1-arg) was not a miss: %', v_res;
  END IF;

  -- 6. The partial index exists and carries the list predicate.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE tablename = 'import_rows' AND indexname = 'import_rows_tracking_list_idx'
      AND indexdef LIKE '%tracking_number ~ ''[ ,]''%'
  ) THEN
    RAISE EXCEPTION 'import_rows_tracking_list_idx is missing or lost its predicate';
  END IF;

  RAISE NOTICE 'find_import_row_by_scan_fast: all assertions passed';
END $$;

ROLLBACK;
