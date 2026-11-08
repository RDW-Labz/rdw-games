-- Behavioural test for mig 0409 public_offsite_sales().
-- Plain-psql assertions, no pgTAP (matches duplicate_lot.sql).
--
-- Pins: notice + live listed auction → row; no notice → 0; inactive warehouse → 0;
-- only unlisted auction → 0; anon may EXECUTE, PUBLIC may not.
--
-- Runs inside a transaction that is ROLLED BACK.

\set ON_ERROR_STOP on

BEGIN;

-- ── Fixtures ────────────────────────────────────────────────────────────────

INSERT INTO operators (id, slug, business_name, contact_email, code, status)
VALUES ('f4090000-0000-0000-0000-000000000001', 'off409a', 'Offsite 409 A',
        'off409a@example.com', 'O4A', 'active');

INSERT INTO operators (id, slug, business_name, contact_email, code, status)
VALUES ('f4090000-0000-0000-0000-000000000002', 'off409b', 'Offsite 409 B',
        'off409b@example.com', 'O4B', 'active');

-- Listed off-site warehouse with a live auction
INSERT INTO warehouses (
  id, operator_id, name, address_line1, city, state, postal_code,
  customer_notice, active
)
VALUES (
  'f4090000-0000-0000-0000-000000000011',
  'f4090000-0000-0000-0000-000000000001',
  'Crandall Temp',
  '100 Offsite Rd', 'Harrison', 'AR', '72601',
  'Pickup at the off-site warehouse this week only.',
  true
);

-- Same operator, no customer_notice (must not appear)
INSERT INTO warehouses (
  id, operator_id, name, address_line1, city, state, postal_code,
  customer_notice, active
)
VALUES (
  'f4090000-0000-0000-0000-000000000012',
  'f4090000-0000-0000-0000-000000000001',
  'Main WH',
  '1 Main St', 'Harrison', 'AR', '72601',
  NULL,
  true
);

-- Inactive off-site warehouse (must not appear)
INSERT INTO warehouses (
  id, operator_id, name, address_line1, city, state, postal_code,
  customer_notice, active
)
VALUES (
  'f4090000-0000-0000-0000-000000000013',
  'f4090000-0000-0000-0000-000000000002',
  'Closed Offsite',
  '2 Closed Ln', 'Harrison', 'AR', '72601',
  'Closed location.',
  false
);

-- Only unlisted auction on an otherwise valid off-site warehouse
INSERT INTO warehouses (
  id, operator_id, name, address_line1, city, state, postal_code,
  customer_notice, active
)
VALUES (
  'f4090000-0000-0000-0000-000000000014',
  'f4090000-0000-0000-0000-000000000002',
  'Unlisted Only',
  '3 Test Ave', 'Harrison', 'AR', '72601',
  'Staff test only.',
  true
);

INSERT INTO auctions (
  id, operator_id, warehouse_id, title, status,
  starts_at, ends_at, pickup_starts_at, pickup_ends_at, unlisted
)
VALUES
  (
    'f4090000-0000-0000-0000-000000000021',
    'f4090000-0000-0000-0000-000000000001',
    'f4090000-0000-0000-0000-000000000011',
    'Crandall Live Sale',
    'live',
    now() - interval '1 hour',
    now() + interval '2 days',
    now() + interval '3 days',
    now() + interval '5 days',
    false
  ),
  (
    'f4090000-0000-0000-0000-000000000022',
    'f4090000-0000-0000-0000-000000000002',
    'f4090000-0000-0000-0000-000000000014',
    'Hidden Test Auction',
    'live',
    now() - interval '1 hour',
    now() + interval '2 days',
    now() + interval '3 days',
    now() + interval '5 days',
    true
  );

-- ── Assertions ──────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_count int;
  v_row record;
BEGIN
  SELECT COUNT(*)::int INTO v_count FROM public.public_offsite_sales();
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly 1 off-site sale row, got %', v_count;
  END IF;

  SELECT * INTO v_row
  FROM public.public_offsite_sales()
  WHERE warehouse_id = 'f4090000-0000-0000-0000-000000000011';

  IF v_row.warehouse_id IS NULL THEN
    RAISE EXCEPTION 'Crandall warehouse missing from public_offsite_sales()';
  END IF;
  IF v_row.auction_count <> 1 THEN
    RAISE EXCEPTION 'expected auction_count=1, got %', v_row.auction_count;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.public_offsite_sales()
    WHERE warehouse_id IN (
      'f4090000-0000-0000-0000-000000000012',
      'f4090000-0000-0000-0000-000000000013',
      'f4090000-0000-0000-0000-000000000014'
    )
  ) THEN
    RAISE EXCEPTION 'warehouse without notice, inactive, or unlisted-only should not appear';
  END IF;

  RAISE NOTICE 'public_offsite_sales row filter PASS';
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p, aclexplode(p.proacl) a WHERE p.proname = 'public_offsite_sales' AND a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
    RAISE EXCEPTION 'PUBLIC must not have EXECUTE on public_offsite_sales()';
  END IF;
  IF NOT has_function_privilege('anon', 'public.public_offsite_sales()', 'EXECUTE') THEN
    RAISE EXCEPTION 'anon must have EXECUTE on public_offsite_sales()';
  END IF;
  RAISE NOTICE 'public_offsite_sales privileges PASS';
END;
$$;

ROLLBACK;
