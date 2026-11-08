-- Behavioural test for mig 0421: refunds land on the REFUND date (Chicago day),
-- sales stay on paid_at, on BOTH operator_money_summary (Money page) and
-- operator_reports_period_summary (/reports), and the two agree.
-- Plain-psql assertions, no pgTAP. Runs inside a transaction that is ROLLED BACK.
--
-- Fixtures (operator A unless noted; amounts in cents):
--   A  paid 09-15, refunded 3000 (tax 240) on 10-10        → sale Sept, refund Oct
--   B  paid 09-20, three partial refunds: 1000 on 09-25, 500 on
--      2026-10-01 04:30Z (= Sept 30 23:30 CDT), 1500 on 10-05 → 1500 Sept, 1500 Oct
--   C  paid 08-10, a pre-0270 audit row (500, 08-12) the accumulators never
--      counted + 800 on 09-05; refunded face 800           → Aug 0, Sept 800
--   D  paid 09-02, face 1000 refunded but only 600 has an audit row (09-10);
--      the uncovered 400 goes to the latest refund moment  → Sept 1000
--   F  paid 10-03, no refund                               → Oct sale
--   X  operator B: paid Sept, refunded Oct                 → never counted

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO operators (id, slug, business_name, contact_email, code)
VALUES ('f4210000-0000-0000-0000-000000000001', 'rfd421a', 'Refund 421 A', 'rfd421a@example.test', 'R1A'),
       ('f4210000-0000-0000-0000-000000000002', 'rfd421b', 'Refund 421 B', 'rfd421b@example.test', 'R1B');

INSERT INTO warehouses (id, operator_id, name, address_line1, city, state, postal_code)
VALUES ('f4210000-0000-0000-0000-000000000011', 'f4210000-0000-0000-0000-000000000001',
        'R1A WH', '1 Refund St', 'Harrison', 'AR', '72601'),
       ('f4210000-0000-0000-0000-000000000012', 'f4210000-0000-0000-0000-000000000002',
        'R1B WH', '2 Refund St', 'Harrison', 'AR', '72601');

INSERT INTO auctions (id, operator_id, warehouse_id, title, status, starts_at, ends_at,
                      pickup_starts_at, pickup_ends_at)
VALUES ('f4210000-0000-0000-0000-000000000021', 'f4210000-0000-0000-0000-000000000001',
        'f4210000-0000-0000-0000-000000000011', 'R1A sale', 'closed',
        '2026-08-01', '2026-08-05', '2026-08-06', '2026-08-20'),
       ('f4210000-0000-0000-0000-000000000022', 'f4210000-0000-0000-0000-000000000002',
        'f4210000-0000-0000-0000-000000000012', 'R1B sale', 'closed',
        '2026-08-01', '2026-08-05', '2026-08-06', '2026-08-20');

ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email TEXT;
INSERT INTO auth.users (id, email) VALUES
  ('f4210000-0000-0000-0000-000000000032', 'rfd421staff@example.test')
ON CONFLICT DO NOTHING;
INSERT INTO auth.users (id, email)
SELECT ('f4210000-0000-0000-0001-' || lpad(g::text, 12, '0'))::uuid, 'rfd421b' || g || '@example.test'
FROM generate_series(1, 6) g
ON CONFLICT DO NOTHING;
INSERT INTO bidders (id, email, birth_date)
SELECT ('f4210000-0000-0000-0001-' || lpad(g::text, 12, '0'))::uuid, 'rfd421b' || g || '@example.test',
       DATE '1990-01-01'
FROM generate_series(1, 6) g
ON CONFLICT DO NOTHING;
INSERT INTO operator_users (operator_id, user_id, role, email)
VALUES ('f4210000-0000-0000-0000-000000000001', 'f4210000-0000-0000-0000-000000000032',
        'manager', 'rfd421staff@example.test');

INSERT INTO invoices (id, operator_id, auction_id, bidder_id, status, subtotal_cents,
                      buyer_premium_cents, tax_cents, total_cents, paid_at, refunded_at,
                      refunded_cash_cents, refunded_credit_cents, refunded_tax_cents)
VALUES
  -- A
  ('f4210000-0000-0000-0002-00000000000a', 'f4210000-0000-0000-0000-000000000001',
   'f4210000-0000-0000-0000-000000000021', 'f4210000-0000-0000-0001-000000000001',
   'partially_refunded', 10000, 1500, 920, 12420,
   '2026-09-15 17:00:00+00', '2026-10-10 15:00:00+00', 3000, 0, 240),
  -- B
  ('f4210000-0000-0000-0002-00000000000b', 'f4210000-0000-0000-0000-000000000001',
   'f4210000-0000-0000-0000-000000000021', 'f4210000-0000-0000-0001-000000000002',
   'partially_refunded', 4000, 600, 400, 5000,
   '2026-09-20 17:00:00+00', '2026-09-25 15:00:00+00', 2000, 1000, 300),
  -- C
  ('f4210000-0000-0000-0002-00000000000c', 'f4210000-0000-0000-0000-000000000001',
   'f4210000-0000-0000-0000-000000000021', 'f4210000-0000-0000-0001-000000000003',
   'partially_refunded', 2000, 300, 200, 2500,
   '2026-08-10 17:00:00+00', '2026-09-05 15:00:00+00', 800, 0, 0),
  -- D
  ('f4210000-0000-0000-0002-00000000000d', 'f4210000-0000-0000-0000-000000000001',
   'f4210000-0000-0000-0000-000000000021', 'f4210000-0000-0000-0001-000000000004',
   'refunded', 900, 100, 0, 1000,
   '2026-09-02 17:00:00+00', '2026-09-10 15:00:00+00', 1000, 0, 0),
  -- F
  ('f4210000-0000-0000-0002-00000000000f', 'f4210000-0000-0000-0000-000000000001',
   'f4210000-0000-0000-0000-000000000021', 'f4210000-0000-0000-0001-000000000005',
   'paid', 10000, 0, 0, 10000,
   '2026-10-03 17:00:00+00', NULL, 0, 0, 0),
  -- X (other operator)
  ('f4210000-0000-0000-0002-0000000000ff', 'f4210000-0000-0000-0000-000000000002',
   'f4210000-0000-0000-0000-000000000022', 'f4210000-0000-0000-0001-000000000006',
   'partially_refunded', 50000, 0, 0, 50000,
   '2026-09-15 17:00:00+00', '2026-10-10 15:00:00+00', 7000, 0, 0);

-- The refund routes' audit rows: the per-refund amount + timestamp.
INSERT INTO operator_audit_log (operator_id, action_type, target_id, after_state, created_at)
VALUES
  ('f4210000-0000-0000-0000-000000000001', 'invoice.refund', 'f4210000-0000-0000-0002-00000000000a',
   '{"cash_cents": 3000, "credit_cents": 0}', '2026-10-10 15:00:00+00'),
  ('f4210000-0000-0000-0000-000000000001', 'invoice.refund_item', 'f4210000-0000-0000-0002-00000000000b',
   '{"amount_cents": 1000}', '2026-09-25 15:00:00+00'),
  ('f4210000-0000-0000-0000-000000000001', 'invoice.refund_item', 'f4210000-0000-0000-0002-00000000000b',
   '{"amount_cents": 500}', '2026-10-01 04:30:00+00'),
  ('f4210000-0000-0000-0000-000000000001', 'invoice.refund_item', 'f4210000-0000-0000-0002-00000000000b',
   '{"amount_cents": 1500}', '2026-10-05 15:00:00+00'),
  ('f4210000-0000-0000-0000-000000000001', 'invoice.refund_item', 'f4210000-0000-0000-0002-00000000000c',
   '{"amount_cents": 500}', '2026-08-12 15:00:00+00'),
  ('f4210000-0000-0000-0000-000000000001', 'invoice.refund_item', 'f4210000-0000-0000-0002-00000000000c',
   '{"amount_cents": 800}', '2026-09-05 15:00:00+00'),
  ('f4210000-0000-0000-0000-000000000001', 'invoice.refund_item', 'f4210000-0000-0000-0002-00000000000d',
   '{"amount_cents": 600}', '2026-09-10 15:00:00+00'),
  ('f4210000-0000-0000-0000-000000000002', 'invoice.refund', 'f4210000-0000-0000-0002-0000000000ff',
   '{"cash_cents": 7000, "credit_cents": 0}', '2026-10-10 15:00:00+00');

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT 'f4210000-0000-0000-0000-000000000032'::uuid $$;

-- Assert one window on BOTH functions. Expected values are cents.
CREATE OR REPLACE FUNCTION pg_temp.check_window(
  p_name text, p_from timestamptz, p_to timestamptz,
  e_invoices int, e_gross bigint, e_face bigint, e_cash bigint, e_credit bigint,
  e_rtax bigint, e_net_collected bigint, e_net_tax bigint, e_net_revenue bigint,
  e_hammer_net bigint
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  m json := public.operator_money_summary(p_from, p_to);
  s json := public.operator_reports_period_summary(p_from, p_to);
  got text;
  want text;
BEGIN
  got := format('inv=%s gross=%s cash=%s credit=%s rtax=%s collected=%s tax=%s',
    m->>'invoices', m->>'gross_charged_cents', m->>'refunded_cash_cents',
    m->>'refunded_credit_cents', m->>'refunded_tax_cents',
    m->>'net_collected_cents', m->>'net_tax_cents');
  want := format('inv=%s gross=%s cash=%s credit=%s rtax=%s collected=%s tax=%s',
    e_invoices, e_gross, e_cash, e_credit, e_rtax, e_net_collected, e_net_tax);
  IF got <> want THEN
    RAISE EXCEPTION 'FAIL % money_summary: got %, want %', p_name, got, want;
  END IF;

  got := format('inv=%s gross=%s face=%s collected=%s tax=%s revenue=%s hammer=%s premium=%s',
    s->>'invoices', s->>'gross_charged_cents', s->>'refunded_face_cents',
    s->>'net_collected_cents', s->>'net_tax_cents', s->>'net_revenue_cents',
    s->>'hammer_net_cents', s->>'premium_net_cents');
  want := format('inv=%s gross=%s face=%s collected=%s tax=%s revenue=%s hammer=%s premium=%s',
    e_invoices, e_gross, e_face, e_net_collected, e_net_tax, e_net_revenue,
    e_hammer_net, e_net_revenue - e_hammer_net);
  IF got <> want THEN
    RAISE EXCEPTION 'FAIL % reports_period_summary: got %, want %', p_name, got, want;
  END IF;

  -- The two pages agree: Money page's net revenue is collected − tax.
  IF (m->>'net_collected_cents')::bigint - (m->>'net_tax_cents')::bigint
     <> (s->>'net_revenue_cents')::bigint
     OR (m->>'refunded_cash_cents')::bigint + (m->>'refunded_credit_cents')::bigint
     <> (s->>'refunded_face_cents')::bigint THEN
    RAISE EXCEPTION 'FAIL % pages disagree: % vs %', p_name, m, s;
  END IF;
  RAISE NOTICE 'ok: %', p_name;
END $$;

DO $$
BEGIN
  -- August (Chicago): C's sale; C's pre-0270 audit row (08-12) counts nothing.
  PERFORM pg_temp.check_window('August', '2026-08-01 05:00+00', '2026-09-01 05:00+00',
    1, 2500, 0, 0, 0, 0, 2500, 200, 2300, 2000);

  -- September: sales A+B+D. Refunds dated in Sept: B 1000 + 500 (Sept 30 23:30
  -- CDT), C 800, D 1000 (600 audited + 400 uncovered). A's refund is NOT here.
  --   face 3300 = cash 2800 + credit 500; tax refunded 150 (B's half of 300)
  --   hammer cut: B 1174 (half of 2348) + C 696 + D 900 = 2770
  PERFORM pg_temp.check_window('September', '2026-09-01 05:00+00', '2026-10-01 05:00+00',
    3, 18420, 3300, 2800, 500, 150, 15120, 1170, 13950, 14900 - 2770);

  -- October: sale F. Refunds: A 3000 (tax 240, hammer cut 2400) + B 1500
  -- (cash 1000, credit 500, tax 150, hammer cut 1174).
  PERFORM pg_temp.check_window('October', '2026-10-01 05:00+00', '2026-11-01 05:00+00',
    1, 10000, 4500, 4000, 500, 390, 5500, -390, 5890, 10000 - 3574);

  -- One Chicago day, Oct 10: only A's refund, no sales — honest negative.
  PERFORM pg_temp.check_window('Oct 10 day', '2026-10-10 05:00+00', '2026-10-11 05:00+00',
    0, 0, 3000, 3000, 0, 240, -3000, -240, -2760, -2400);

  -- All time: refunds equal the invoices' stored accumulators exactly, as
  -- before 0421 (C's unaccumulated pre-0270 500 is still not counted).
  PERFORM pg_temp.check_window('all time', NULL, NULL,
    5, 30920, 7800, 6800, 1000, 540, 23120, 1520 - 540, 23120 - 980,
    (10000 + 4000 + 2000 + 900 + 10000) - (2400 + 2348 + 696 + 900));
END $$;

-- The headline case, stated plainly: A paid in September, refunded in October.
DO $$
DECLARE
  sep json := public.operator_money_summary('2026-09-01 05:00+00', '2026-10-01 05:00+00');
  oct json := public.operator_money_summary('2026-10-01 05:00+00', '2026-11-01 05:00+00');
  r   record;
BEGIN
  SELECT * INTO r FROM public.operator_refund_ledger('f4210000-0000-0000-0000-000000000001')
  WHERE invoice_id = 'f4210000-0000-0000-0002-00000000000a';
  IF r.refunded_at <> '2026-10-10 15:00:00+00' OR r.face_cents <> 3000 THEN
    RAISE EXCEPTION 'FAIL: A ledger row = %', r;
  END IF;
  -- A's 12420 is in September's gross; its 3000 refund is in October's.
  IF (sep->>'gross_charged_cents')::bigint < 12420 THEN
    RAISE EXCEPTION 'FAIL: A gross not in September';
  END IF;
  RAISE NOTICE 'ok: paid in September, refunded in October';
END $$;

-- Every invoice's ledger rows add up to its stored refund totals.
DO $$
DECLARE bad int;
BEGIN
  SELECT count(*) INTO bad
  FROM public.invoices i
  LEFT JOIN (
    SELECT invoice_id, sum(face_cents) f, sum(cash_cents) c, sum(credit_cents) cr,
           sum(tax_cents) t
    FROM public.operator_refund_ledger('f4210000-0000-0000-0000-000000000001')
    GROUP BY invoice_id
  ) l ON l.invoice_id = i.id
  WHERE i.operator_id = 'f4210000-0000-0000-0000-000000000001'
    AND (coalesce(l.f, 0) <> i.refunded_cash_cents + i.refunded_credit_cents
      OR coalesce(l.c, 0) <> i.refunded_cash_cents
      OR coalesce(l.cr, 0) <> i.refunded_credit_cents
      OR coalesce(l.t, 0) <> i.refunded_tax_cents);
  IF bad > 0 THEN
    RAISE EXCEPTION 'FAIL: % invoices whose ledger rows do not sum to their totals', bad;
  END IF;
  RAISE NOTICE 'ok: ledger sums to the invoice accumulators';
END $$;

-- The ledger takes an operator id: callers must not be able to reach it.
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.operator_refund_ledger(uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.operator_refund_ledger(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: operator_refund_ledger is executable by anon/authenticated';
  END IF;
  IF NOT has_function_privilege('authenticated',
       'public.operator_money_summary(timestamptz, timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL: authenticated cannot execute operator_money_summary';
  END IF;
  RAISE NOTICE 'ok: grants';
END $$;

ROLLBACK;
