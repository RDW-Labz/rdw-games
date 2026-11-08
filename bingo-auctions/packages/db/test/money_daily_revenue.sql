-- Behavioural test for mig 0417 + 0422: operator_money_daily + the
-- status='paid' revenue rule removed from operator_engagement_report /
-- operator_ops_health; since 0422 its refunds come from operator_refund_ledger
-- (0421), the same rows the Money page and /reports read.
-- Plain-psql assertions, no pgTAP.
--
-- The bug: revenue summed total_cents WHERE status = 'paid', so a partially
-- refunded invoice vanished from revenue entirely. Fixtures (Chicago days,
-- relative to today so the engagement report's 14-day window covers them):
--   A  paid,               D0 10:00, $110 (tax $10), no refund
--   B  partially_refunded, D0 20:30 — after 6 PM Central, already the NEXT
--      day in UTC — $55 (tax $5); $22 refunded on D2 (tax $2)
--   C  partially_refunded, D1 12:00, $33 (tax $3); refunded $11 on D1 and
--      $11 on D3 (tax $1 each) — invoices.refunded_at only holds the first
--   F  refunded, D1, $10, no audit row and no refunded_at (pre-backfill
--      shape) — the refund falls back to the paid_at day
--   G  partially_refunded, D1 13:30, $20 (no tax); $5 refunded. Two audit
--      rows: $4 on D1 (a pre-0270 row the accumulator never counted) and $5
--      on D3. The ledger (0421) fills newest first, so all $5 lands on D3 —
--      0417's own proportional split put $2.22 on D1 and $2.78 on D3. Pins
--      that per-day refunds use the ledger, not a second split.
--   P  pending (never paid) — never counts
--   X  another operator's paid invoice — never counts for this operator
--
-- Expected per day:            gross   refunds  net coll   tax   net rev
--   D0  A + B                  16500       0     16500    1500    15000
--   D1  C + F + G; C#1, F      6300    2100      4200     200     4000
--   D2  B's refund                0    2200     -2200    -200    -2000
--   D3  C#2, G                    0    1600     -1600    -100    -1500
--   total                      22800    5900     16900    1400    15500
-- Every day's refunds and refunded tax also equal operator_money_summary and
-- operator_reports_period_summary for that day (one refund source).
-- The old rule would have read D0 = $110 (A only) and dropped B entirely.
--
-- Fake data only. Runs inside a transaction that is ROLLED BACK.
\set ON_ERROR_STOP on
BEGIN;

INSERT INTO operators (id, slug, business_name, contact_email, code)
VALUES ('d4170000-0000-0000-0000-000000000001', 'moneyday', 'Money Day Co', 'money@example.test', 'MDY'),
       ('d4170000-0000-0000-0000-000000000091', 'moneyother', 'Other Co', 'other@example.test', 'MDO');
INSERT INTO warehouses (id, operator_id, name, address_line1, city, state, postal_code)
VALUES ('d4170000-0000-0000-0000-000000000002', 'd4170000-0000-0000-0000-000000000001', 'MDY WH', '1 Money St', 'Harrison', 'AR', '72601'),
       ('d4170000-0000-0000-0000-000000000092', 'd4170000-0000-0000-0000-000000000091', 'MDO WH', '2 Money St', 'Harrison', 'AR', '72601');
INSERT INTO auctions (id, operator_id, warehouse_id, title, status, starts_at, ends_at, pickup_starts_at, pickup_ends_at)
VALUES ('d4170000-0000-0000-0000-000000000003', 'd4170000-0000-0000-0000-000000000001', 'd4170000-0000-0000-0000-000000000002',
        'MDY sale', 'closed', now() - interval '20 days', now() - interval '19 days', now(), now() + interval '2 days'),
       ('d4170000-0000-0000-0000-000000000093', 'd4170000-0000-0000-0000-000000000091', 'd4170000-0000-0000-0000-000000000092',
        'MDO sale', 'closed', now() - interval '20 days', now() - interval '19 days', now(), now() + interval '2 days');
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email TEXT;
-- One bidder per invoice (invoices are unique per auction + bidder).
INSERT INTO auth.users (id, email)
SELECT ('d4170000-0000-0000-0000-0000000001' || s)::uuid, 'moneybidder' || s || '@example.test'
FROM unnest(ARRAY['0a','0b','0c','0d','0f','a1','a2']) AS s
ON CONFLICT DO NOTHING;
INSERT INTO auth.users (id, email)
VALUES ('d4170000-0000-0000-0000-000000000005', 'moneystaff@example.test') ON CONFLICT DO NOTHING;
INSERT INTO bidders (id, email, birth_date)
SELECT ('d4170000-0000-0000-0000-0000000001' || s)::uuid, 'moneybidder' || s || '@example.test', DATE '1990-01-01'
FROM unnest(ARRAY['0a','0b','0c','0d','0f','a1','a2']) AS s
ON CONFLICT DO NOTHING;
INSERT INTO operator_users (operator_id, user_id, role, email)
VALUES ('d4170000-0000-0000-0000-000000000001', 'd4170000-0000-0000-0000-000000000005', 'manager', 'moneystaff@example.test');
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT 'd4170000-0000-0000-0000-000000000005'::uuid $$;

-- D0 = five Chicago days ago. Wall-clock helper: day offset + local time → timestamptz.
CREATE TEMP TABLE t_days AS
SELECT ((now() AT TIME ZONE 'America/Chicago')::date - 5) AS d0;
CREATE FUNCTION pg_temp.at_chi(p_off int, p_time time) RETURNS timestamptz LANGUAGE sql AS
$$ SELECT ((SELECT d0 FROM t_days) + p_off + p_time) AT TIME ZONE 'America/Chicago' $$;

INSERT INTO invoices (id, operator_id, auction_id, bidder_id, status,
                      subtotal_cents, buyer_premium_cents, tax_cents, total_cents,
                      paid_at, refunded_cash_cents, refunded_credit_cents, refunded_tax_cents, refunded_at)
VALUES
  -- A
  ('d4170000-0000-0000-0000-00000000000a', 'd4170000-0000-0000-0000-000000000001', 'd4170000-0000-0000-0000-000000000003',
   'd4170000-0000-0000-0000-00000000010a', 'paid', 9000, 1000, 1000, 11000,
   pg_temp.at_chi(0, '10:00'), 0, 0, 0, NULL),
  -- B: refund face is cash 1700 + credit 500 = 2200
  ('d4170000-0000-0000-0000-00000000000b', 'd4170000-0000-0000-0000-000000000001', 'd4170000-0000-0000-0000-000000000003',
   'd4170000-0000-0000-0000-00000000010b', 'partially_refunded', 4500, 500, 500, 5500,
   pg_temp.at_chi(0, '20:30'), 1700, 500, 200, pg_temp.at_chi(2, '09:00')),
  -- C
  ('d4170000-0000-0000-0000-00000000000c', 'd4170000-0000-0000-0000-000000000001', 'd4170000-0000-0000-0000-000000000003',
   'd4170000-0000-0000-0000-00000000010c', 'partially_refunded', 2700, 300, 300, 3300,
   pg_temp.at_chi(1, '12:00'), 2200, 0, 200, pg_temp.at_chi(1, '15:00')),
  -- F
  ('d4170000-0000-0000-0000-00000000000f', 'd4170000-0000-0000-0000-000000000001', 'd4170000-0000-0000-0000-000000000003',
   'd4170000-0000-0000-0000-00000000010f', 'refunded', 1000, 0, 0, 1000,
   pg_temp.at_chi(1, '13:00'), 1000, 0, 0, NULL),
  -- G
  ('d4170000-0000-0000-0000-00000000000d', 'd4170000-0000-0000-0000-000000000001', 'd4170000-0000-0000-0000-000000000003',
   'd4170000-0000-0000-0000-00000000010d', 'partially_refunded', 2000, 0, 0, 2000,
   pg_temp.at_chi(1, '13:30'), 500, 0, 0, pg_temp.at_chi(1, '14:00')),
  -- P
  ('d4170000-0000-0000-0000-0000000000a1', 'd4170000-0000-0000-0000-000000000001', 'd4170000-0000-0000-0000-000000000003',
   'd4170000-0000-0000-0000-0000000001a1', 'pending', 7000, 0, 0, 7000,
   NULL, 0, 0, 0, NULL),
  -- X (other operator; outside the engagement report's window)
  ('d4170000-0000-0000-0000-0000000000a2', 'd4170000-0000-0000-0000-000000000091', 'd4170000-0000-0000-0000-000000000093',
   'd4170000-0000-0000-0000-0000000001a2', 'paid', 99000, 0, 0, 99000,
   pg_temp.at_chi(-20, '12:00'), 0, 0, 0, NULL);

-- The refund routes' audit rows: refund-items (amount per item) for B,
-- whole-invoice refund (cash + credit) twice for C.
INSERT INTO operator_audit_log (operator_id, action_type, target_id, after_state, created_at)
VALUES
  ('d4170000-0000-0000-0000-000000000001', 'invoice.refund_item', 'd4170000-0000-0000-0000-00000000000b',
   '{"amount_cents": 1200}', pg_temp.at_chi(2, '09:00')),
  ('d4170000-0000-0000-0000-000000000001', 'invoice.refund_item', 'd4170000-0000-0000-0000-00000000000b',
   '{"amount_cents": 1000}', pg_temp.at_chi(2, '09:00')),
  ('d4170000-0000-0000-0000-000000000001', 'invoice.refund', 'd4170000-0000-0000-0000-00000000000c',
   '{"cash_cents": 1100, "credit_cents": 0}', pg_temp.at_chi(1, '15:00')),
  ('d4170000-0000-0000-0000-000000000001', 'invoice.refund', 'd4170000-0000-0000-0000-00000000000c',
   '{"cash_cents": 1100, "credit_cents": 0}', pg_temp.at_chi(3, '11:00')),
  ('d4170000-0000-0000-0000-000000000001', 'invoice.refund_item', 'd4170000-0000-0000-0000-00000000000d',
   '{"amount_cents": 400}', pg_temp.at_chi(1, '14:00')),
  ('d4170000-0000-0000-0000-000000000001', 'invoice.refund_item', 'd4170000-0000-0000-0000-00000000000d',
   '{"amount_cents": 500}', pg_temp.at_chi(3, '12:00'));

DO $$
DECLARE
  v_d0   date := (SELECT d0 FROM t_days);
  v_fail text := '';
  j      json;
  r      record;
  tot    json;
  e      json;
  got    text;
BEGIN
  j := public.operator_money_daily(v_d0, v_d0 + 3, 'America/Chicago');

  IF json_array_length(j->'days') <> 4 THEN
    v_fail := v_fail || E'\n  [days] expected 4 rows, got ' || json_array_length(j->'days');
  END IF;

  FOR r IN
    SELECT * FROM (VALUES
      (0, 2, 16500,    0,  16500,  1500,  15000),
      (1, 3,  6300, 2100,   4200,   200,   4000),
      (2, 0,     0, 2200,  -2200,  -200,  -2000),
      (3, 0,     0, 1600,  -1600,  -100,  -1500)
    ) AS t(off, n, gross, refunds, net_collected, tax, net_revenue)
  LOOP
    SELECT x INTO e FROM json_array_elements(j->'days') x
     WHERE (x->>'day')::date = v_d0 + r.off;
    got := format('%s/%s/%s/%s/%s/%s',
                  e->>'invoices_paid', e->>'gross_charged_cents', e->>'refunds_cents',
                  e->>'net_collected_cents', e->>'tax_cents', e->>'net_revenue_cents');
    IF got IS DISTINCT FROM format('%s/%s/%s/%s/%s/%s', r.n, r.gross, r.refunds, r.net_collected, r.tax, r.net_revenue) THEN
      v_fail := v_fail || format(E'\n  [D%s] invoices/gross/refunds/net collected/tax/net revenue = %s, expected %s/%s/%s/%s/%s/%s',
                                 r.off, got, r.n, r.gross, r.refunds, r.net_collected, r.tax, r.net_revenue);
    END IF;
  END LOOP;

  -- 1. The partially refunded invoice still counts its full gross on its paid
  --    day (B is in D0's 16500; the old rule read 11000).
  -- 2. Its refund is subtracted on the refund day (D2), not the sale day.
  --    Both are pinned by the D0 and D2 rows above; spelt out for the log:
  SELECT x INTO e FROM json_array_elements(j->'days') x WHERE (x->>'day')::date = v_d0;
  IF (e->>'gross_charged_cents')::bigint = 11000 THEN
    v_fail := v_fail || E'\n  [B] partially refunded invoice dropped from gross (status=''paid'' rule is back)';
  END IF;
  IF (e->>'refunds_cents')::bigint <> 0 THEN
    v_fail := v_fail || E'\n  [B] refund landed on the sale day instead of the refund day';
  END IF;

  -- Totals, and they reconcile with the Money page's summary for the same
  -- window (every refund here was issued inside the window).
  tot := j->'totals';
  got := format('%s/%s/%s/%s/%s', tot->>'gross_charged_cents', tot->>'refunds_cents',
                tot->>'net_collected_cents', tot->>'tax_cents', tot->>'net_revenue_cents');
  IF got <> '22800/5900/16900/1400/15500' THEN
    v_fail := v_fail || E'\n  [totals] ' || got || ', expected 22800/5900/16900/1400/15500';
  END IF;
  e := public.operator_money_summary(
         (v_d0)::timestamp AT TIME ZONE 'America/Chicago',
         (v_d0 + 4)::timestamp AT TIME ZONE 'America/Chicago');
  IF (e->>'gross_charged_cents')::numeric <> (tot->>'gross_charged_cents')::numeric
     OR (e->>'net_collected_cents')::numeric <> (tot->>'net_collected_cents')::numeric
     OR (e->>'net_tax_cents')::numeric <> (tot->>'tax_cents')::numeric THEN
    v_fail := v_fail || E'\n  [summary] operator_money_daily totals disagree with operator_money_summary: ' || e::text;
  END IF;

  -- One refund source (0422): for every day, and for the whole range, the
  -- per-day refunds equal the Money page's and /reports' refunds for the
  -- same window — face (cash + credit) and refunded tax.
  FOR r IN SELECT off FROM generate_series(0, 4) AS off LOOP
    DECLARE
      v_lo  date := v_d0 + CASE WHEN r.off = 4 THEN 0 ELSE r.off END;
      v_hi  date := v_d0 + CASE WHEN r.off = 4 THEN 3 ELSE r.off END;
      d     json := public.operator_money_daily(v_lo, v_hi, 'America/Chicago')->'totals';
      ms    json := public.operator_money_summary(
                      v_lo::timestamp AT TIME ZONE 'America/Chicago',
                      (v_hi + 1)::timestamp AT TIME ZONE 'America/Chicago');
      rp    json := public.operator_reports_period_summary(
                      v_lo::timestamp AT TIME ZONE 'America/Chicago',
                      (v_hi + 1)::timestamp AT TIME ZONE 'America/Chicago');
    BEGIN
      IF (d->>'refunds_cents')::bigint
           <> (ms->>'refunded_cash_cents')::bigint + (ms->>'refunded_credit_cents')::bigint
         OR (d->>'refunds_cents')::bigint <> (rp->>'refunded_face_cents')::bigint
         OR (d->>'tax_cents')::bigint <> (ms->>'net_tax_cents')::bigint
         OR (d->>'tax_cents')::bigint <> (rp->>'net_tax_cents')::bigint
         OR (d->>'net_revenue_cents')::bigint <> (rp->>'net_revenue_cents')::bigint THEN
        v_fail := v_fail || format(E'\n  [one source %s..%s] daily %s / money summary %s / reports %s',
                                   v_lo, v_hi, d::text, ms::text, rp::text);
      END IF;
    END;
  END LOOP;

  -- A one-day window (the Ops "today" card shape) only sees that day.
  j := public.operator_money_daily(v_d0 + 2, v_d0 + 2, 'America/Chicago');
  IF (j->'totals'->>'refunds_cents')::bigint <> 2200 OR (j->'totals'->>'gross_charged_cents')::bigint <> 0 THEN
    v_fail := v_fail || E'\n  [one day] D2 alone: ' || (j->'totals')::text;
  END IF;

  -- Bad input refuses rather than returning a confident $0.
  BEGIN
    PERFORM public.operator_money_daily(v_d0 + 1, v_d0, 'America/Chicago');
    v_fail := v_fail || E'\n  [range] inverted range was accepted';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;

  -- Engagement report (Health page, 0417): gmv_cents no longer drops B.
  j := public.operator_engagement_report('America/Chicago', 14);
  SELECT x INTO e FROM json_array_elements(j->'daily') x WHERE (x->>'day')::date = v_d0;
  IF (e->>'gmv_cents')::bigint <> 16500 THEN
    v_fail := v_fail || E'\n  [engagement] D0 gmv_cents = ' || coalesce(e->>'gmv_cents', 'null') || ', expected 16500';
  END IF;

  -- Not staff → refused.
  CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $f$ SELECT 'd4170000-0000-0000-0000-00000000010a'::uuid $f$;
  BEGIN
    PERFORM public.operator_money_daily(v_d0, v_d0, 'America/Chicago');
    v_fail := v_fail || E'\n  [auth] non-staff caller was answered';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  IF v_fail <> '' THEN
    RAISE EXCEPTION 'money_daily_revenue FAILED:%', v_fail;
  END IF;
  RAISE NOTICE 'money_daily_revenue: all cases passed';
END;
$$;

-- PUBLIC must not execute it (operator-scoped money).
DO $$
BEGIN
  IF has_function_privilege('anon', 'public.operator_money_daily(date, date, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'money_daily_revenue FAILED: anon can execute operator_money_daily';
  END IF;
END;
$$;

ROLLBACK;
