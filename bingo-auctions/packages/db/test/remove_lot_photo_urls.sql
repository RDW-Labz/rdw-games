-- Behavioural test for mig 0491: remove_lot_photo_urls().
--
-- WHAT MOTIVATED IT (RED TEAM on #683, 2026-11-04): the inventory Save path
-- wrote the whole photo_urls array back, so a photo attached concurrently by
-- another device or a background retry was erased. Appends are atomic (0489);
-- removals must touch only the URLs the operator removed.
--
-- Pins:
--   1. removing one URL keeps a concurrently appended URL,
--   2. removing a URL that is not present is an ok no-op,
--   3. an empty list is an ok no-op,
--   4. a caller from another operator is refused,
--   5. a missing or soft-deleted lot reports ok=false.
--
-- Runs against the migrated-but-empty CI database, inside a transaction that is
-- ROLLED BACK, so the DB is left untouched.

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO operators (id, slug, business_name, contact_email, code)
VALUES ('a4910000-0000-0000-0000-000000000001', 'removetest', 'Remove Test Co',
        'remove@example.com', 'RMT'),
       ('a4910000-0000-0000-0000-000000000002', 'removeother', 'Other Co',
        'other@example.com', 'RMO');

INSERT INTO warehouses (id, operator_id, name, address_line1, city, state, postal_code)
VALUES ('a4910000-0000-0000-0000-0000000000a1', 'a4910000-0000-0000-0000-000000000001',
        'RMT WH', '1 A St', 'Harrison', 'AR', '72601');

ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email TEXT;
INSERT INTO auth.users (id, email)
VALUES ('a4910000-0000-0000-0000-000000000003', 'remove@example.com');
INSERT INTO operator_users (operator_id, user_id, role, email)
VALUES ('a4910000-0000-0000-0000-000000000001', 'a4910000-0000-0000-0000-000000000003',
        'picker', 'remove@example.com');
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT 'a4910000-0000-0000-0000-000000000003'::uuid $$;

INSERT INTO lots (id, operator_id, warehouse_id, lot_code, status, title, photo_urls)
VALUES ('a4910000-0000-0000-0000-0000000000b1', 'a4910000-0000-0000-0000-000000000001',
        'a4910000-0000-0000-0000-0000000000a1', 'RMT-0001', 'draft', 'Fixture',
        ARRAY['https://npwseclcxcatjhgjrtwe.supabase.co/storage/v1/object/public/lot-photos/seed.jpg',
              'https://npwseclcxcatjhgjrtwe.supabase.co/storage/v1/object/public/lot-photos/a.jpg',
              'https://npwseclcxcatjhgjrtwe.supabase.co/storage/v1/object/public/lot-photos/concurrent.jpg']),
       ('a4910000-0000-0000-0000-0000000000b2', 'a4910000-0000-0000-0000-000000000001',
        'a4910000-0000-0000-0000-0000000000a1', 'RMT-0002', 'draft', 'Gone',
        ARRAY[]::TEXT[]);

UPDATE lots SET deleted_at = now() WHERE id = 'a4910000-0000-0000-0000-0000000000b2';

-- 1. Removing A keeps the seed and the URL another device appended.
DO $$
DECLARE
  v_res  JSONB;
  v_urls TEXT[];
BEGIN
  v_res := public.remove_lot_photo_urls(
    'a4910000-0000-0000-0000-0000000000b1',
    'a4910000-0000-0000-0000-000000000001',
    ARRAY['https://npwseclcxcatjhgjrtwe.supabase.co/storage/v1/object/public/lot-photos/a.jpg']);
  IF (v_res->>'ok')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'remove failed: %', v_res;
  END IF;

  SELECT photo_urls INTO v_urls FROM lots
   WHERE id = 'a4910000-0000-0000-0000-0000000000b1';
  IF array_length(v_urls, 1) <> 2 THEN
    RAISE EXCEPTION 'expected seed + concurrent, got %', v_urls;
  END IF;
  IF v_urls @> ARRAY['https://npwseclcxcatjhgjrtwe.supabase.co/storage/v1/object/public/lot-photos/a.jpg'] THEN
    RAISE EXCEPTION 'removed URL is still present: %', v_urls;
  END IF;
  IF NOT (v_urls @> ARRAY['https://npwseclcxcatjhgjrtwe.supabase.co/storage/v1/object/public/lot-photos/concurrent.jpg']) THEN
    RAISE EXCEPTION 'concurrent attachment was erased: %', v_urls;
  END IF;
END
$$;

-- 2. Removing a URL that is not present is an ok no-op.
DO $$
DECLARE
  v_res  JSONB;
  v_urls TEXT[];
BEGIN
  v_res := public.remove_lot_photo_urls(
    'a4910000-0000-0000-0000-0000000000b1',
    'a4910000-0000-0000-0000-000000000001',
    ARRAY['https://npwseclcxcatjhgjrtwe.supabase.co/storage/v1/object/public/lot-photos/missing.jpg']);
  IF (v_res->>'ok')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'absent removal should be ok, got %', v_res;
  END IF;
  IF jsonb_array_length(v_res->'photo_urls') <> 2 THEN
    RAISE EXCEPTION 'absent removal changed the row: %', v_res;
  END IF;
  SELECT photo_urls INTO v_urls FROM lots
   WHERE id = 'a4910000-0000-0000-0000-0000000000b1';
  IF array_length(v_urls, 1) <> 2 THEN
    RAISE EXCEPTION 'absent removal changed the row: %', v_urls;
  END IF;
END
$$;

-- 3. An empty list is an ok no-op.
DO $$
DECLARE v_res JSONB;
BEGIN
  v_res := public.remove_lot_photo_urls(
    'a4910000-0000-0000-0000-0000000000b1',
    'a4910000-0000-0000-0000-000000000001',
    ARRAY[]::TEXT[]);
  IF (v_res->>'ok')::boolean IS NOT TRUE OR v_res->>'reason' <> 'noop' THEN
    RAISE EXCEPTION 'empty removal should be noop, got %', v_res;
  END IF;
END
$$;

-- 4. Another operator's staff cannot remove photos from this lot.
DO $$
DECLARE v_failed BOOLEAN := false;
BEGIN
  BEGIN
    PERFORM public.remove_lot_photo_urls(
      'a4910000-0000-0000-0000-0000000000b1',
      'a4910000-0000-0000-0000-000000000002',
      ARRAY['https://npwseclcxcatjhgjrtwe.supabase.co/storage/v1/object/public/lot-photos/seed.jpg']);
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'cross-operator removal was allowed';
  END IF;
END
$$;

-- 5. A soft-deleted lot is refused.
DO $$
DECLARE v_res JSONB;
BEGIN
  v_res := public.remove_lot_photo_urls(
    'a4910000-0000-0000-0000-0000000000b2',
    'a4910000-0000-0000-0000-000000000001',
    ARRAY['https://npwseclcxcatjhgjrtwe.supabase.co/storage/v1/object/public/lot-photos/seed.jpg']);
  IF (v_res->>'ok')::boolean IS NOT FALSE OR v_res->>'reason' <> 'not_found' THEN
    RAISE EXCEPTION 'deleted lot should be not_found, got %', v_res;
  END IF;
END
$$;

ROLLBACK;
