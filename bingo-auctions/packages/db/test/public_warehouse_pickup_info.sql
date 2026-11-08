-- Behavioural test for mig 0407: public_warehouse_pickup_info.
-- Plain-psql assertions, no pgTAP.
--
-- Cases:
--   1. Active warehouse + active operator → one row with pickup-facing columns.
--   2. Inactive warehouse (active = false) → zero rows.
--   3. Function result type does not include tax_rate_bps or square_location_id.
--   4. PUBLIC has no EXECUTE; anon does (signed-out app users).
--
-- Fake data only. Runs inside a transaction that is ROLLED BACK.
\set ON_ERROR_STOP on
BEGIN;

INSERT INTO operators (id, slug, business_name, contact_email, code, status)
VALUES ('f4070000-0000-0000-0000-000000000001', 'whpickup', 'Pickup RPC Test Co',
        'whpickup@example.test', 'WHP', 'active');

INSERT INTO warehouses (
  id, operator_id, name, address_line1, city, state, postal_code,
  customer_notice, pickup_instructions, active
)
VALUES (
  'f4070000-0000-0000-0000-000000000002',
  'f4070000-0000-0000-0000-000000000001',
  'Off-site closeout',
  '119 East Crandall Avenue',
  'Harrison',
  'AR',
  '72601',
  'Temporary closeout location.',
  'Enter through the south door.',
  true
);

INSERT INTO warehouses (
  id, operator_id, name, address_line1, city, state, postal_code, active
)
VALUES (
  'f4070000-0000-0000-0000-000000000003',
  'f4070000-0000-0000-0000-000000000001',
  'Closed building',
  '2 Inactive St',
  'Harrison',
  'AR',
  '72601',
  false
);

DO $$
DECLARE
  v_fail text := '';
  v_cnt  int;
  v_name text;
  v_result_type text;
BEGIN
  SELECT count(*)::int, max(name)
    INTO v_cnt, v_name
    FROM public.public_warehouse_pickup_info('f4070000-0000-0000-0000-000000000002');
  IF v_cnt <> 1 OR v_name IS DISTINCT FROM 'Off-site closeout' THEN
    v_fail := v_fail || E'\n  [1] expected one row for active warehouse';
  END IF;

  SELECT count(*)::int
    INTO v_cnt
    FROM public.public_warehouse_pickup_info('f4070000-0000-0000-0000-000000000003');
  IF v_cnt <> 0 THEN
    v_fail := v_fail || E'\n  [2] inactive warehouse should return no rows';
  END IF;

  SELECT pg_get_function_result(p.oid)
    INTO v_result_type
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public'
     AND p.proname = 'public_warehouse_pickup_info'
     AND pg_get_function_identity_arguments(p.oid) = 'p_warehouse_id uuid';

  IF v_result_type IS NULL THEN
    v_fail := v_fail || E'\n  [3] function not found';
  ELSIF v_result_type ILIKE '%tax_rate_bps%' OR v_result_type ILIKE '%square_location_id%' THEN
    v_fail := v_fail || E'\n  [3] result exposes sensitive warehouse columns';
  END IF;

  IF EXISTS (
       SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a
        WHERE p.proname = 'public_warehouse_pickup_info' AND a.grantee = 0
          AND a.privilege_type = 'EXECUTE') THEN
    v_fail := v_fail || E'\n  [4] PUBLIC must not have EXECUTE';
  END IF;
  IF NOT has_function_privilege('anon', 'public.public_warehouse_pickup_info(uuid)', 'EXECUTE') THEN
    v_fail := v_fail || E'\n  [4] anon must have EXECUTE';
  END IF;

  IF v_fail <> '' THEN
    RAISE EXCEPTION 'public_warehouse_pickup_info failures:%', v_fail;
  END IF;
  RAISE NOTICE 'public_warehouse_pickup_info: all assertions passed';
END $$;

ROLLBACK;
