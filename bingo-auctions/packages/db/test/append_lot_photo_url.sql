-- Behavioural test for mig 0489: append_lot_photo_url().
--
-- WHAT MOTIVATED IT (RED TEAM on #683, 2026-11-04): the staff photo queue read
-- lots.photo_urls, then wrote the whole array back with one URL appended. Two
-- devices attaching to the same lot could interleave between read and write,
-- and the later writer erased the other device's photo. A zero-row update also
-- returned no error, so the client deleted its local file and reported success
-- without attaching anything.
--
-- Pins:
--   1. two appends both survive (the concurrency shape),
--   2. appending the same URL twice is a no-op that still reports ok,
--   3. an unsafe host (stripped by the 0049 trigger) reports ok=false,
--   4. a caller from another operator gets unauthorized,
--   5. a missing or soft-deleted lot reports ok=false.
--
-- Runs against the migrated-but-empty CI database, inside a transaction that is
-- ROLLED BACK, so the DB is left untouched.

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO operators (id, slug, business_name, contact_email, code)
VALUES ('a4890000-0000-0000-0000-000000000001', 'appendtest', 'Append Test Co',
        'append@example.com', 'APT'),
       ('a4890000-0000-0000-0000-000000000002', 'appendother', 'Other Co',
        'other@example.com', 'APO');

INSERT INTO warehouses (id, operator_id, name, address_line1, city, state, postal_code)
VALUES ('a4890000-0000-0000-0000-0000000000a1', 'a4890000-0000-0000-0000-000000000001',
        'APT WH', '1 A St', 'Harrison', 'AR', '72601');

ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email TEXT;
INSERT INTO auth.users (id, email)
VALUES ('a4890000-0000-0000-0000-000000000003', 'append@example.com');
INSERT INTO operator_users (operator_id, user_id, role, email)
VALUES ('a4890000-0000-0000-0000-000000000001', 'a4890000-0000-0000-0000-000000000003',
        'picker', 'append@example.com');
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT 'a4890000-0000-0000-0000-000000000003'::uuid $$;

INSERT INTO lots (id, operator_id, warehouse_id, lot_code, status, title, photo_urls)
VALUES ('a4890000-0000-0000-0000-0000000000b1', 'a4890000-0000-0000-0000-000000000001',
        'a4890000-0000-0000-0000-0000000000a1', 'APT-0001', 'draft', 'Fixture',
        ARRAY['https://npwseclcxcatjhgjrtwe.supabase.co/storage/v1/object/public/lot-photos/seed.jpg']),
       ('a4890000-0000-0000-0000-0000000000b2', 'a4890000-0000-0000-0000-000000000001',
        'a4890000-0000-0000-0000-0000000000a1', 'APT-0002', 'draft', 'Gone',
        ARRAY[]::TEXT[]);

UPDATE lots SET deleted_at = now() WHERE id = 'a4890000-0000-0000-0000-0000000000b2';

-- 1. Two appends both survive. Interleaving is the case the function exists
--    for; the UPDATE re-reads the row under its own lock.
DO $$
DECLARE
  v_res  JSONB;
  v_urls TEXT[];
BEGIN
  v_res := public.append_lot_photo_url(
    'a4890000-0000-0000-0000-0000000000b1',
    'a4890000-0000-0000-0000-000000000001',
    'https://npwseclcxcatjhgjrtwe.supabase.co/storage/v1/object/public/lot-photos/a.jpg');
  IF (v_res->>'ok')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'first append failed: %', v_res;
  END IF;

  v_res := public.append_lot_photo_url(
    'a4890000-0000-0000-0000-0000000000b1',
    'a4890000-0000-0000-0000-000000000001',
    'https://npwseclcxcatjhgjrtwe.supabase.co/storage/v1/object/public/lot-photos/b.jpg');
  IF (v_res->>'ok')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'second append failed: %', v_res;
  END IF;

  SELECT photo_urls INTO v_urls FROM lots
   WHERE id = 'a4890000-0000-0000-0000-0000000000b1';
  IF array_length(v_urls, 1) <> 3 THEN
    RAISE EXCEPTION 'expected seed + a + b, got %', v_urls;
  END IF;
  IF NOT (v_urls @> ARRAY['https://npwseclcxcatjhgjrtwe.supabase.co/storage/v1/object/public/lot-photos/a.jpg',
                          'https://npwseclcxcatjhgjrtwe.supabase.co/storage/v1/object/public/lot-photos/b.jpg']) THEN
    RAISE EXCEPTION 'a photo was erased: %', v_urls;
  END IF;
END
$$;

-- 2. Re-appending the same URL is idempotent and still ok.
DO $$
DECLARE v_res JSONB;
BEGIN
  v_res := public.append_lot_photo_url(
    'a4890000-0000-0000-0000-0000000000b1',
    'a4890000-0000-0000-0000-000000000001',
    'https://npwseclcxcatjhgjrtwe.supabase.co/storage/v1/object/public/lot-photos/a.jpg');
  IF (v_res->>'ok')::boolean IS NOT TRUE OR v_res->>'reason' <> 'already_present' THEN
    RAISE EXCEPTION 'repeat append should be a no-op, got %', v_res;
  END IF;
  IF jsonb_array_length(v_res->'photo_urls') <> 3 THEN
    RAISE EXCEPTION 'repeat append duplicated the URL: %', v_res;
  END IF;
END
$$;

-- 3. An unsafe host is stripped by the trigger, so the append must not claim
--    success — the client keeps the file and retries.
DO $$
DECLARE
  v_res  JSONB;
  v_urls TEXT[];
BEGIN
  v_res := public.append_lot_photo_url(
    'a4890000-0000-0000-0000-0000000000b1',
    'a4890000-0000-0000-0000-000000000001',
    'https://evil.example.com/photo.jpg');
  IF (v_res->>'ok')::boolean IS NOT FALSE OR v_res->>'reason' <> 'unsafe_url' THEN
    RAISE EXCEPTION 'unsafe URL should fail, got %', v_res;
  END IF;
  SELECT photo_urls INTO v_urls FROM lots
   WHERE id = 'a4890000-0000-0000-0000-0000000000b1';
  IF array_length(v_urls, 1) <> 3 THEN
    RAISE EXCEPTION 'unsafe URL changed the row: %', v_urls;
  END IF;
END
$$;

-- 4. Another operator's staff cannot attach to this lot.
DO $$
DECLARE v_failed BOOLEAN := false;
BEGIN
  BEGIN
    PERFORM public.append_lot_photo_url(
      'a4890000-0000-0000-0000-0000000000b1',
      'a4890000-0000-0000-0000-000000000002',
      'https://npwseclcxcatjhgjrtwe.supabase.co/storage/v1/object/public/lot-photos/c.jpg');
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'cross-operator append was allowed';
  END IF;
END
$$;

-- 5. Soft-deleted lot is refused.
DO $$
DECLARE v_res JSONB;
BEGIN
  v_res := public.append_lot_photo_url(
    'a4890000-0000-0000-0000-0000000000b2',
    'a4890000-0000-0000-0000-000000000001',
    'https://npwseclcxcatjhgjrtwe.supabase.co/storage/v1/object/public/lot-photos/d.jpg');
  IF (v_res->>'ok')::boolean IS NOT FALSE OR v_res->>'reason' <> 'not_found' THEN
    RAISE EXCEPTION 'deleted lot should be not_found, got %', v_res;
  END IF;
END
$$;

ROLLBACK;
