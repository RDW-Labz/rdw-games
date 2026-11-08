-- Behavioural test for mig 0410: warehouse_notice_acks / ack_warehouse_notice /
-- has_acked_warehouse_notice. Plain-psql assertions, no pgTAP.
--
-- Cases:
--   1. ack + has_acked true for matching notice text.
--   2. Changed warehouse notice → has_acked false until re-ack.
--   3. Warehouse without customer_notice → ack raises no_notice.
--   4. Bidder B cannot SELECT bidder A's ack rows (RLS).
--   5. PUBLIC has no EXECUTE on either RPC.
--
-- Fake data only. Runs inside a transaction that is ROLLED BACK.
\set ON_ERROR_STOP on
BEGIN;

INSERT INTO operators (id, slug, business_name, contact_email, code, status)
VALUES ('f4100000-0000-0000-0000-000000000001', 'whack', 'Notice Ack Test Co',
        'whack@example.test', 'WNA', 'active');

INSERT INTO warehouses (
  id, operator_id, name, address_line1, city, state, postal_code,
  customer_notice, active
)
VALUES (
  'f4100000-0000-0000-0000-000000000002',
  'f4100000-0000-0000-0000-000000000001',
  'Crandall temp',
  '119 East Crandall Avenue',
  'Harrison',
  'AR',
  '72601',
  'Temporary closeout — read before bidding.',
  true
);

INSERT INTO warehouses (
  id, operator_id, name, address_line1, city, state, postal_code, active
)
VALUES (
  'f4100000-0000-0000-0000-000000000003',
  'f4100000-0000-0000-0000-000000000001',
  'Main building',
  '1 Main St',
  'Harrison',
  'AR',
  '72601',
  true
);

ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email TEXT;
INSERT INTO auth.users (id, email) VALUES
  ('f4100000-0000-0000-0000-0000000000a1', 'whack-a@example.test'),
  ('f4100000-0000-0000-0000-0000000000b2', 'whack-b@example.test')
ON CONFLICT DO NOTHING;

INSERT INTO bidders (id, email, birth_date) VALUES
  ('f4100000-0000-0000-0000-0000000000a1', 'whack-a@example.test', DATE '1990-01-01'),
  ('f4100000-0000-0000-0000-0000000000b2', 'whack-b@example.test', DATE '1990-01-01')
ON CONFLICT DO NOTHING;

DO $$
DECLARE
  v_wh_notice uuid := 'f4100000-0000-0000-0000-000000000002';
  v_wh_plain  uuid := 'f4100000-0000-0000-0000-000000000003';
  v_bid_a     uuid := 'f4100000-0000-0000-0000-0000000000a1';
  v_bid_b     uuid := 'f4100000-0000-0000-0000-0000000000b2';
  v_fail      text := '';
  v_cnt       int;
  v_acked     boolean;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', v_bid_a::text, true);

  v_acked := public.has_acked_warehouse_notice(v_wh_notice);
  IF v_acked IS TRUE THEN
    v_fail := v_fail || E'\n  [1] has_acked should be false before ack';
  END IF;

  PERFORM public.ack_warehouse_notice(v_wh_notice);

  v_acked := public.has_acked_warehouse_notice(v_wh_notice);
  IF v_acked IS NOT TRUE THEN
    v_fail := v_fail || E'\n  [1] has_acked should be true after ack';
  END IF;

  UPDATE warehouses SET customer_notice = 'Updated notice text.'
   WHERE id = v_wh_notice;

  v_acked := public.has_acked_warehouse_notice(v_wh_notice);
  IF v_acked IS TRUE THEN
    v_fail := v_fail || E'\n  [2] has_acked should be false after notice change';
  END IF;

  BEGIN
    PERFORM public.ack_warehouse_notice(v_wh_plain);
    v_fail := v_fail || E'\n  [3] ack on warehouse without notice should raise';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE '%no_notice%' THEN
      v_fail := v_fail || E'\n  [3] expected no_notice, got: ' || SQLERRM;
    END IF;
  END;

  SELECT count(*)::int INTO v_cnt
    FROM public.warehouse_notice_acks
   WHERE bidder_id = v_bid_a;
  IF v_cnt < 1 THEN
    v_fail := v_fail || E'\n  [4] setup: bidder A should have an ack row';
  END IF;

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', v_bid_b::text, true);

  SELECT count(*)::int INTO v_cnt
    FROM public.warehouse_notice_acks
   WHERE bidder_id = v_bid_a;
  IF v_cnt <> 0 THEN
    v_fail := v_fail || E'\n  [4] bidder B must not see bidder A rows via RLS';
  END IF;

  RESET ROLE;

  IF EXISTS (
       SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
        WHERE p.proname = 'ack_warehouse_notice' AND a.grantee = 0
          AND a.privilege_type = 'EXECUTE') THEN
    v_fail := v_fail || E'\n  [5] PUBLIC must not EXECUTE ack_warehouse_notice';
  END IF;
  IF EXISTS (
       SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
        WHERE p.proname = 'has_acked_warehouse_notice' AND a.grantee = 0
          AND a.privilege_type = 'EXECUTE') THEN
    v_fail := v_fail || E'\n  [5] PUBLIC must not EXECUTE has_acked_warehouse_notice';
  END IF;

  IF v_fail <> '' THEN
    RAISE EXCEPTION 'warehouse_notice_acks failures:%', v_fail;
  END IF;
  RAISE NOTICE 'warehouse_notice_acks: all assertions passed';
END $$;

ROLLBACK;
