-- Behavioural test for mig 0492: reorder_lot_photo_urls().
--
-- WHAT MOTIVATED IT (RED TEAM on #683, 2026-11-04): the inventory Save path
-- applies an atomic append/remove delta so a concurrent attachment survives.
-- "Make Hero" changes only the order, so it was never persisted: the phone
-- showed the new hero while photo_urls[0] stayed the same.
--
-- Pins:
--   1. reordering moves the named photo first and keeps a concurrently
--      appended URL at the end,
--   2. a URL another device removed is not re-added by the reorder,
--   3. an empty list is an ok no-op,
--   4. a caller from another operator is refused,
--   5. a missing or soft-deleted lot reports ok=false.
--
-- Runs against the migrated-but-empty CI database, inside a transaction that is
-- ROLLED BACK, so the DB is left untouched.

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO operators (id, slug, business_name, contact_email, code)
VALUES ('a4920000-0000-0000-0000-000000000001', 'reordertest', 'Reorder Test Co',
        'reorder@example.com', 'RRT'),
       ('a4920000-0000-0000-0000-000000000002', 'reorderother', 'Other Co',
        'other@example.com', 'RRO');

INSERT INTO warehouses (id, operator_id, name, address_line1, city, state, postal_code)
VALUES ('a4920000-0000-0000-0000-0000000000a1', 'a4920000-0000-0000-0000-000000000001',
        'RRT WH', '1 A St', 'Harrison', 'AR', '72601');

ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email TEXT;
INSERT INTO auth.users (id, email)
VALUES ('a4920000-0000-0000-0000-000000000003', 'reorder@example.com');
INSERT INTO operator_users (operator_id, user_id, role, email)
VALUES ('a4920000-0000-0000-0000-000000000001', 'a4920000-0000-0000-0000-000000000003',
        'picker', 'reorder@example.com');
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT 'a4920000-0000-0000-0000-000000000003'::uuid $$;

INSERT INTO lots (id, operator_id, warehouse_id, lot_code, status, title, photo_urls)
VALUES ('a4920000-0000-0000-0000-0000000000b1', 'a4920000-0000-0000-0000-000000000001',
        'a4920000-0000-0000-0000-0000000000a1', 'RRT-0001', 'draft', 'Fixture',
        ARRAY['https://npwseclcxcatjhgjrtwe.supabase.co/storage/v1/object/public/lot-photos/a.jpg',
              'https://npwseclcxcatjhgjrtwe.supabase.co/storage/v1/object/public/lot-photos/b.jpg',
              'https://npwseclcxcatjhgjrtwe.supabase.co/storage/v1/object/public/lot-photos/concurrent.jpg']),
       ('a4920000-0000-0000-0000-0000000000b2', 'a4920000-0000-0000-0000-000000000001',
        'a4920000-0000-0000-0000-0000000000a1', 'RRT-0002', 'draft', 'Gone',
        ARRAY[]::TEXT[]);

UPDATE lots SET deleted_at = now() WHERE id = 'a4920000-0000-0000-0000-0000000000b2';

-- 1. B becomes the hero; the concurrent URL is kept at the end.
DO $$
DECLARE
  v_res  JSONB;
  v_urls TEXT[];
BEGIN
  v_res := public.reorder_lot_photo_urls(
    'a4920000-0000-0000-0000-0000000000b1',
    'a4920000-0000-0000-0000-000000000001',
    ARRAY['https://npwseclcxcatjhgjrtwe.supabase.co/storage/v1/object/public/lot-photos/b.jpg',
          'https://npwseclcxcatjhgjrtwe.supabase.co/storage/v1/object/public/lot-photos/a.jpg']);
  IF (v_res->>'ok')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'reorder failed: %', v_res;
  END IF;

  SELECT photo_urls INTO v_urls FROM lots
   WHERE id = 'a4920000-0000-0000-0000-0000000000b1';
  IF v_urls[1] NOT LIKE '%/b.jpg' THEN
    RAISE EXCEPTION 'expected b.jpg first, got %', v_urls;
  END IF;
  IF v_urls[2] NOT LIKE '%/a.jpg' THEN
    RAISE EXCEPTION 'expected a.jpg second, got %', v_urls;
  END IF;
  IF array_length(v_urls, 1) <> 3 OR v_urls[3] NOT LIKE '%/concurrent.jpg' THEN
    RAISE EXCEPTION 'concurrent attachment was not kept at the end: %', v_urls;
  END IF;
END
$$;

-- 2. A URL removed by another device is not re-added by the reorder.
DO $$
DECLARE
  v_res  JSONB;
  v_urls TEXT[];
BEGIN
  UPDATE lots
     SET photo_urls = ARRAY['https://npwseclcxcatjhgjrtwe.supabase.co/storage/v1/object/public/lot-photos/b.jpg',
                            'https://npwseclcxcatjhgjrtwe.supabase.co/storage/v1/object/public/lot-photos/concurrent.jpg']
   WHERE id = 'a4920000-0000-0000-0000-0000000000b1';

  v_res := public.reorder_lot_photo_urls(
    'a4920000-0000-0000-0000-0000000000b1',
    'a4920000-0000-0000-0000-000000000001',
    ARRAY['https://npwseclcxcatjhgjrtwe.supabase.co/storage/v1/object/public/lot-photos/a.jpg',
          'https://npwseclcxcatjhgjrtwe.supabase.co/storage/v1/object/public/lot-photos/b.jpg']);
  IF (v_res->>'ok')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'reorder with a removed URL should still be ok, got %', v_res;
  END IF;

  SELECT photo_urls INTO v_urls FROM lots
   WHERE id = 'a4920000-0000-0000-0000-0000000000b1';
  IF v_urls @> ARRAY['https://npwseclcxcatjhgjrtwe.supabase.co/storage/v1/object/public/lot-photos/a.jpg'] THEN
    RAISE EXCEPTION 'removed URL was re-added: %', v_urls;
  END IF;
  IF v_urls[1] NOT LIKE '%/b.jpg' OR array_length(v_urls, 1) <> 2 THEN
    RAISE EXCEPTION 'unexpected order after reorder: %', v_urls;
  END IF;
END
$$;

-- 3. An empty list is an ok no-op.
DO $$
DECLARE v_res JSONB;
BEGIN
  v_res := public.reorder_lot_photo_urls(
    'a4920000-0000-0000-0000-0000000000b1',
    'a4920000-0000-0000-0000-000000000001',
    ARRAY[]::TEXT[]);
  IF (v_res->>'ok')::boolean IS NOT TRUE OR v_res->>'reason' <> 'noop' THEN
    RAISE EXCEPTION 'empty reorder should be noop, got %', v_res;
  END IF;
END
$$;

-- 4. Another operator's staff cannot reorder this lot's photos.
DO $$
DECLARE v_failed BOOLEAN := false;
BEGIN
  BEGIN
    PERFORM public.reorder_lot_photo_urls(
      'a4920000-0000-0000-0000-0000000000b1',
      'a4920000-0000-0000-0000-000000000002',
      ARRAY['https://npwseclcxcatjhgjrtwe.supabase.co/storage/v1/object/public/lot-photos/b.jpg']);
  EXCEPTION WHEN OTHERS THEN
    v_failed := true;
  END;
  IF NOT v_failed THEN
    RAISE EXCEPTION 'cross-operator reorder was allowed';
  END IF;
END
$$;

-- 5. A soft-deleted lot is refused.
DO $$
DECLARE v_res JSONB;
BEGIN
  v_res := public.reorder_lot_photo_urls(
    'a4920000-0000-0000-0000-0000000000b2',
    'a4920000-0000-0000-0000-000000000001',
    ARRAY['https://npwseclcxcatjhgjrtwe.supabase.co/storage/v1/object/public/lot-photos/b.jpg']);
  IF (v_res->>'ok')::boolean IS NOT FALSE OR v_res->>'reason' <> 'not_found' THEN
    RAISE EXCEPTION 'deleted lot should be not_found, got %', v_res;
  END IF;
END
$$;

ROLLBACK;
