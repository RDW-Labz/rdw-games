-- Behavioural test for mig 0418 operator_reports_period_summary().
-- Plain-psql assertions, no pgTAP (matches duplicate_lot.sql).
--
-- Pins the /reports bug it fixes: totals must cover EVERY invoice in the
-- range, not the first 1,000. Seeds 1,202 in-range invoices (plus noise that
-- must be excluded) and asserts exact cent totals, the Chicago month edge,
-- operator scoping, agreement with operator_money_summary, the staff gate,
-- and that anon/PUBLIC cannot execute it.
--
-- Runs inside a transaction that is ROLLED BACK.

\set ON_ERROR_STOP on

BEGIN;

-- ── Fixtures ────────────────────────────────────────────────────────────────

INSERT INTO operators (id, slug, business_name, contact_email, code)
VALUES ('f4180000-0000-0000-0000-000000000001', 'rpt418a', 'Reports 418 A', 'rpt418a@example.test', 'R4A'),
       ('f4180000-0000-0000-0000-000000000002', 'rpt418b', 'Reports 418 B', 'rpt418b@example.test', 'R4B');

INSERT INTO warehouses (id, operator_id, name, address_line1, city, state, postal_code)
VALUES ('f4180000-0000-0000-0000-000000000011', 'f4180000-0000-0000-0000-000000000001',
        'R4A WH', '1 Report St', 'Harrison', 'AR', '72601'),
       ('f4180000-0000-0000-0000-000000000012', 'f4180000-0000-0000-0000-000000000002',
        'R4B WH', '2 Report St', 'Harrison', 'AR', '72601');

INSERT INTO auctions (id, operator_id, warehouse_id, title, status, starts_at, ends_at,
                      pickup_starts_at, pickup_ends_at)
VALUES ('f4180000-0000-0000-0000-000000000021', 'f4180000-0000-0000-0000-000000000001',
        'f4180000-0000-0000-0000-000000000011', 'R4A sale', 'closed',
        '2026-09-10', '2026-09-12', '2026-09-13', '2026-09-20'),
       ('f4180000-0000-0000-0000-000000000022', 'f4180000-0000-0000-0000-000000000002',
        'f4180000-0000-0000-0000-000000000012', 'R4B sale', 'closed',
        '2026-09-10', '2026-09-12', '2026-09-13', '2026-09-20');

ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email TEXT;
INSERT INTO auth.users (id, email) VALUES
  ('f4180000-0000-0000-0000-000000000032', 'rpt418staff@example.test')
ON CONFLICT DO NOTHING;
-- invoices are unique per (auction, bidder): one bidder per invoice.
-- Bidder n has id f4180000-0000-0000-0001-<n, 12 digits>.
INSERT INTO auth.users (id, email)
SELECT ('f4180000-0000-0000-0001-' || lpad(g::text, 12, '0'))::uuid,
       'rpt418b' || g || '@example.test'
FROM generate_series(1, 1210) g
ON CONFLICT DO NOTHING;
INSERT INTO bidders (id, email, birth_date)
SELECT ('f4180000-0000-0000-0001-' || lpad(g::text, 12, '0'))::uuid,
       'rpt418b' || g || '@example.test', DATE '1990-01-01'
FROM generate_series(1, 1210) g
ON CONFLICT DO NOTHING;
INSERT INTO operator_users (operator_id, user_id, role, email)
VALUES ('f4180000-0000-0000-0000-000000000001', 'f4180000-0000-0000-0000-000000000032',
        'manager', 'rpt418staff@example.test');

-- 1,200 plain paid invoices mid-September: 1000 hammer + 150 premium + 92 tax.
INSERT INTO invoices (operator_id, auction_id, bidder_id, status, subtotal_cents,
                      buyer_premium_cents, tax_cents, total_cents, paid_at)
SELECT 'f4180000-0000-0000-0000-000000000001', 'f4180000-0000-0000-0000-000000000021',
       ('f4180000-0000-0000-0001-' || lpad(g::text, 12, '0'))::uuid, 'paid', 1000, 150, 92, 1242,
       timestamptz '2026-09-15 12:00:00+00' + make_interval(secs => g)
FROM generate_series(1, 1200) g;

-- One partially refunded: face 5000 back (400 of it tax). No audit row, so
-- since mig 0421 its refund is dated at its latest known refund moment, which
-- here is paid_at (refunded_at NULL) — it stays in September. Refunds dated
-- apart from the sale are pinned in refunds_by_refund_date.sql.
INSERT INTO invoices (operator_id, auction_id, bidder_id, status, subtotal_cents,
                      buyer_premium_cents, tax_cents, total_cents, paid_at,
                      refunded_cash_cents, refunded_credit_cents, refunded_tax_cents)
VALUES ('f4180000-0000-0000-0000-000000000001', 'f4180000-0000-0000-0000-000000000021',
        'f4180000-0000-0000-0001-000000001201', 'partially_refunded', 10000, 1500, 920, 12420,
        '2026-09-20 12:00:00+00', 3000, 2000, 400);

-- Chicago month edge: 2026-09-30 23:59:59 CDT is IN September ...
INSERT INTO invoices (operator_id, auction_id, bidder_id, status, subtotal_cents,
                      buyer_premium_cents, tax_cents, total_cents, paid_at)
VALUES ('f4180000-0000-0000-0000-000000000001', 'f4180000-0000-0000-0000-000000000021',
        'f4180000-0000-0000-0001-000000001202', 'paid', 100, 0, 0, 100,
        '2026-10-01 04:59:59+00'),
-- ... 2026-10-01 00:00:00 CDT is NOT.
       ('f4180000-0000-0000-0000-000000000001', 'f4180000-0000-0000-0000-000000000021',
        'f4180000-0000-0000-0001-000000001203', 'paid', 99999, 0, 0, 99999,
        '2026-10-01 05:00:00+00');

-- Noise that must be excluded: unpaid in range, and another operator's sale.
INSERT INTO invoices (operator_id, auction_id, bidder_id, status, subtotal_cents,
                      buyer_premium_cents, tax_cents, total_cents, paid_at)
VALUES ('f4180000-0000-0000-0000-000000000001', 'f4180000-0000-0000-0000-000000000021',
        'f4180000-0000-0000-0001-000000001204', 'pending', 55555, 0, 0, 55555, NULL),
       ('f4180000-0000-0000-0000-000000000002', 'f4180000-0000-0000-0000-000000000022',
        'f4180000-0000-0000-0001-000000001205', 'paid', 77777, 0, 0, 77777,
        '2026-09-15 12:00:00+00');

-- ── Assertions ──────────────────────────────────────────────────────────────

-- Staff gate: an unknown caller is refused.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT 'f4180000-0000-0000-0000-0000000000ff'::uuid $$;
DO $$
BEGIN
  PERFORM public.operator_reports_period_summary(NULL, NULL);
  RAISE EXCEPTION 'FAIL: non-staff caller was not refused';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'ok: non-staff refused';
END $$;

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT 'f4180000-0000-0000-0000-000000000032'::uuid $$;

DO $$
DECLARE
  -- September 2026 in America/Chicago, as monthRangeInTimeZone produces it.
  v_from timestamptz := '2026-09-01 05:00:00+00';
  v_to   timestamptz := '2026-10-01 05:00:00+00';
  s json;
  m json;
BEGIN
  s := public.operator_reports_period_summary(v_from, v_to);
  m := public.operator_money_summary(v_from, v_to);

  -- 1,200 + 1 refunded + 1 edge = 1,202 — well past the old 1,000-row cap.
  IF (s->>'invoices')::int <> 1202 THEN
    RAISE EXCEPTION 'FAIL: invoices = %, want 1202', s->>'invoices';
  END IF;
  IF (s->>'gross_charged_cents')::bigint <> 1502920 THEN
    RAISE EXCEPTION 'FAIL: gross_charged = %, want 1502920', s->>'gross_charged_cents';
  END IF;
  IF (s->>'refunded_face_cents')::bigint <> 5000 THEN
    RAISE EXCEPTION 'FAIL: refunded_face = %, want 5000', s->>'refunded_face_cents';
  END IF;
  IF (s->>'net_collected_cents')::bigint <> 1497920 THEN
    RAISE EXCEPTION 'FAIL: net_collected = %, want 1497920', s->>'net_collected_cents';
  END IF;
  IF (s->>'net_tax_cents')::bigint <> 110920 THEN
    RAISE EXCEPTION 'FAIL: net_tax = %, want 110920', s->>'net_tax_cents';
  END IF;
  IF (s->>'net_revenue_cents')::bigint <> 1387000 THEN
    RAISE EXCEPTION 'FAIL: net_revenue = %, want 1387000', s->>'net_revenue_cents';
  END IF;
  -- Refunded invoice: hammer round(10000 * 6900/11500) = 6000, premium 900.
  IF (s->>'hammer_net_cents')::bigint <> 1206100 THEN
    RAISE EXCEPTION 'FAIL: hammer_net = %, want 1206100', s->>'hammer_net_cents';
  END IF;
  IF (s->>'premium_net_cents')::bigint <> 180900 THEN
    RAISE EXCEPTION 'FAIL: premium_net = %, want 180900', s->>'premium_net_cents';
  END IF;
  IF (s->>'hammer_net_cents')::bigint + (s->>'premium_net_cents')::bigint
     <> (s->>'net_revenue_cents')::bigint THEN
    RAISE EXCEPTION 'FAIL: hammer + premium <> net revenue';
  END IF;

  -- Same definitions as the Money page.
  IF (s->>'invoices')::bigint <> (m->>'invoices')::bigint
     OR (s->>'gross_charged_cents')::bigint <> (m->>'gross_charged_cents')::bigint
     OR (s->>'net_collected_cents')::bigint <> (m->>'net_collected_cents')::bigint
     OR (s->>'net_tax_cents')::bigint <> (m->>'net_tax_cents')::bigint THEN
    RAISE EXCEPTION 'FAIL: disagrees with operator_money_summary: % vs %', s, m;
  END IF;

  -- All time adds only the out-of-range edge invoice (not the pending one or
  -- the other operator's).
  s := public.operator_reports_period_summary(NULL, NULL);
  IF (s->>'invoices')::int <> 1203
     OR (s->>'gross_charged_cents')::bigint <> 1502920 + 99999 THEN
    RAISE EXCEPTION 'FAIL: all-time = %', s;
  END IF;

  -- Empty range returns zeros, not NULLs.
  s := public.operator_reports_period_summary('2020-01-01', '2020-02-01');
  IF (s->>'invoices')::int <> 0 OR (s->>'net_revenue_cents')::bigint <> 0
     OR (s->>'hammer_net_cents')::bigint <> 0 THEN
    RAISE EXCEPTION 'FAIL: empty range = %', s;
  END IF;

  RAISE NOTICE 'ok: totals cover all 1,202 invoices and match operator_money_summary';
END $$;

DO $$
BEGIN
  IF has_function_privilege('anon',
       'public.operator_reports_period_summary(timestamptz, timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: anon can execute operator_reports_period_summary';
  END IF;
  IF NOT has_function_privilege('authenticated',
       'public.operator_reports_period_summary(timestamptz, timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: authenticated cannot execute operator_reports_period_summary';
  END IF;
  RAISE NOTICE 'ok: grants';
END $$;

ROLLBACK;
