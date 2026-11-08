-- Behavioural test for mig 0429: load_summary(load).
-- Every expected number below is worked out BY HAND from the fixture.
--
-- Load L (cost $100.00 = 10000) owns five ORIGINAL lots; lot E is in another
-- load M. Invoices (15% premium, 9.5% tax — tax must never appear):
--
--   lot  invoice              hammer  inv subtotal  inv premium  line premium   value  refunded?
--   A    I1 paid               1500         2000          300   300*1500/2000=225  1725  no   (I1 also has lot X, hammer 500, NOT in L)
--   B    I2 paid, forfeited    1000         1000          150        150          1150  no   (no-show: payment kept)
--   B2   I3 partially_refunded  400          400           60         60           460  YES  (relist copy of B, load_id NULL)
--   C    —                        —            —            —          —             —   —    (never sold)
--   D    I4 refunded (whole)    800          800          120        120           920  YES  (line not stamped; invoice status refunded)
--   F    I5 pending (unpaid)    999            —            —          —             —   —    (never paid → excluded)
--   E    I6 paid               5000         5000          750        750          5750  —    (load M → excluded)
--
--   lots          = A, B, C, D, F                       = 5
--   relist_copies = B2                                  = 1
--   invoice_lines = A, B, B2, D                         = 4
--   refunded      = B2, D                               = 2
--   forfeited     = B                                   = 1
--   hammer        = 1500 + 1000 + 400 + 800             = 3700
--   premium       = 225 + 150 + 60 + 120                = 555
--   gross         = 3700 + 555                          = 4255
--   refunds       = 460 + 920                           = 1380
--   net revenue   = 4255 - 1380                         = 2875
--   sold          = A (paid), B (paid, forfeit kept)    = 2   (B2 refunded doesn't matter: B already sold;
--                                                              D only refunded; F unpaid; C none)
--   unsold        = 5 - 2                               = 3
--   profit        = 2875 - 10000                        = -7125
--
-- Access: a manager gets the numbers; a picker, a load of ANOTHER operator and
-- a load that does not exist all raise 42501 'load_summary_forbidden'; PUBLIC
-- has no EXECUTE.
--
-- Runs inside a transaction that is ROLLED BACK.

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO operators (id, slug, business_name, contact_email, code) VALUES
  ('e2000000-0000-0000-0000-000000000001', 'loadsum', 'Load Summary Co', 'ls@example.com', 'LSM'),
  ('e2000000-0000-0000-0000-0000000000a1', 'loadsum2', 'Other Co', 'ls2@example.com', 'LS2');
INSERT INTO warehouses (id, operator_id, name, address_line1, city, state, postal_code)
VALUES ('e2000000-0000-0000-0000-000000000002', 'e2000000-0000-0000-0000-000000000001', 'LSM WH', '1 Sum St', 'Harrison', 'AR', '72601');

ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email TEXT;
INSERT INTO auth.users (id, email) VALUES
  ('e2000000-0000-0000-0000-000000000004', 'mgr@example.com'),
  ('e2000000-0000-0000-0000-000000000006', 'picker@example.com'),
  ('e2000000-0000-0000-0000-000000000005', 'buyer@example.com');
INSERT INTO operator_users (operator_id, user_id, role, email) VALUES
  ('e2000000-0000-0000-0000-000000000001', 'e2000000-0000-0000-0000-000000000004', 'manager', 'mgr@example.com'),
  ('e2000000-0000-0000-0000-000000000001', 'e2000000-0000-0000-0000-000000000006', 'picker', 'picker@example.com');
INSERT INTO bidders (id, email, birth_date) VALUES ('e2000000-0000-0000-0000-000000000005', 'buyer@example.com', DATE '1990-01-01');

-- Who is calling: a session setting the stub auth.uid() reads.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;

INSERT INTO loads (id, operator_id, type, source_name, purchase_cost_cents) VALUES
  ('e2000000-0000-0000-0000-000000000010', 'e2000000-0000-0000-0000-000000000001', 'manual', 'Load L', 10000),
  ('e2000000-0000-0000-0000-000000000011', 'e2000000-0000-0000-0000-000000000001', 'manual', 'Load M', NULL),
  ('e2000000-0000-0000-0000-0000000000a2', 'e2000000-0000-0000-0000-0000000000a1', 'manual', 'Foreign', 500);

CREATE FUNCTION pg_temp.lot(p_code TEXT, p_load UUID, p_parent UUID DEFAULT NULL) RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE v UUID;
BEGIN
  INSERT INTO lots (operator_id, warehouse_id, lot_code, title, status, load_id, relisted_from_lot_id)
  VALUES ('e2000000-0000-0000-0000-000000000001', 'e2000000-0000-0000-0000-000000000002', p_code, p_code, 'won', p_load, p_parent)
  RETURNING id INTO v;
  RETURN v;
END $$;

-- One invoice per auction (invoices are UNIQUE (auction_id, bidder_id)).
CREATE FUNCTION pg_temp.inv(p_status invoice_status, p_subtotal BIGINT, p_premium BIGINT, p_tax BIGINT, p_paid BOOLEAN) RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE a UUID; v UUID;
BEGIN
  INSERT INTO auctions (operator_id, warehouse_id, title, status, starts_at, ends_at, pickup_starts_at, pickup_ends_at)
  VALUES ('e2000000-0000-0000-0000-000000000001', 'e2000000-0000-0000-0000-000000000002', 'LSM ' || gen_random_uuid(), 'closed',
          now() - interval '10 days', now() - interval '8 days', now() - interval '7 days', now() - interval '2 days')
  RETURNING id INTO a;
  INSERT INTO invoices (operator_id, auction_id, bidder_id, status)
  VALUES ('e2000000-0000-0000-0000-000000000001', a, 'e2000000-0000-0000-0000-000000000005', p_status)
  RETURNING id INTO v;
  UPDATE invoices SET subtotal_cents = p_subtotal, buyer_premium_cents = p_premium, tax_cents = p_tax,
                      total_cents = p_subtotal + p_premium + p_tax,
                      paid_at = CASE WHEN p_paid THEN now() - interval '8 days' END
   WHERE id = v;
  RETURN v;
END $$;

DO $$
DECLARE
  cL CONSTANT UUID := 'e2000000-0000-0000-0000-000000000010';
  cM CONSTANT UUID := 'e2000000-0000-0000-0000-000000000011';
  a UUID; b UUID; b2 UUID; c UUID; d UUID; f UUID; e UUID; x UUID;
  i1 UUID; i2 UUID; i3 UUID; i4 UUID; i5 UUID; i6 UUID;
BEGIN
  a := pg_temp.lot('LSM-A', cL); b := pg_temp.lot('LSM-B', cL); c := pg_temp.lot('LSM-C', cL);
  d := pg_temp.lot('LSM-D', cL); f := pg_temp.lot('LSM-F', cL); e := pg_temp.lot('LSM-E', cM);
  x := pg_temp.lot('LSM-X', NULL);
  b2 := pg_temp.lot('LSM-B2', NULL, b);

  i1 := pg_temp.inv('paid', 2000, 300, 200, true);
  INSERT INTO invoice_lots (invoice_id, lot_id, winning_bid_cents) VALUES (i1, a, 1500), (i1, x, 500);
  i2 := pg_temp.inv('paid', 1000, 150, 95, true);
  INSERT INTO invoice_lots (invoice_id, lot_id, winning_bid_cents, forfeited_at) VALUES (i2, b, 1000, now() - interval '3 days');
  i3 := pg_temp.inv('partially_refunded', 400, 60, 38, true);
  INSERT INTO invoice_lots (invoice_id, lot_id, winning_bid_cents, refunded_at) VALUES (i3, b2, 400, now() - interval '1 day');
  i4 := pg_temp.inv('refunded', 800, 120, 76, true);
  INSERT INTO invoice_lots (invoice_id, lot_id, winning_bid_cents) VALUES (i4, d, 800);
  i5 := pg_temp.inv('pending', 999, 150, 95, false);
  INSERT INTO invoice_lots (invoice_id, lot_id, winning_bid_cents) VALUES (i5, f, 999);
  i6 := pg_temp.inv('paid', 5000, 750, 475, true);
  INSERT INTO invoice_lots (invoice_id, lot_id, winning_bid_cents) VALUES (i6, e, 5000);
END
$$;

DO $$
DECLARE
  s    json;
  v_fail TEXT := '';
  exp  json := json_build_object(
    'lots', 5, 'sold', 2, 'unsold', 3, 'relist_copies', 1,
    'invoice_lines', 4, 'refunded_lines', 2, 'forfeited_lines', 1,
    'hammer_cents', 3700, 'premium_cents', 555, 'gross_cents', 4255,
    'refunds_cents', 1380, 'net_revenue_cents', 2875,
    'purchase_cost_cents', 10000, 'profit_cents', -7125);
  k TEXT;
  ok BOOLEAN;
BEGIN
  -- manager of the load's operator
  PERFORM set_config('test.uid', 'e2000000-0000-0000-0000-000000000004', true);
  s := public.load_summary('e2000000-0000-0000-0000-000000000010');
  FOR k IN SELECT json_object_keys(exp) LOOP
    IF (s->>k) IS DISTINCT FROM (exp->>k) THEN
      v_fail := v_fail || format(E'\n  %s: got %s, expected %s (hand-checked)', k, s->>k, exp->>k);
    END IF;
  END LOOP;

  -- load with no cost → profit NULL
  s := public.load_summary('e2000000-0000-0000-0000-000000000011');
  IF (s->>'profit_cents') IS NOT NULL OR (s->>'lots')::int <> 1 OR (s->>'net_revenue_cents')::int <> 5750 THEN
    v_fail := v_fail || format(E'\n  load M: %s', s);
  END IF;

  -- picker → forbidden
  PERFORM set_config('test.uid', 'e2000000-0000-0000-0000-000000000006', true);
  ok := false;
  BEGIN PERFORM public.load_summary('e2000000-0000-0000-0000-000000000010');
  EXCEPTION WHEN insufficient_privilege THEN ok := true; END;
  IF NOT ok THEN v_fail := v_fail || E'\n  picker was allowed'; END IF;

  -- another operator's load, and a load that does not exist → forbidden
  PERFORM set_config('test.uid', 'e2000000-0000-0000-0000-000000000004', true);
  ok := false;
  BEGIN PERFORM public.load_summary('e2000000-0000-0000-0000-0000000000a2');
  EXCEPTION WHEN insufficient_privilege THEN ok := true; END;
  IF NOT ok THEN v_fail := v_fail || E'\n  foreign load was readable'; END IF;
  ok := false;
  BEGIN PERFORM public.load_summary('e2000000-0000-0000-0000-0000000000ff');
  EXCEPTION WHEN insufficient_privilege THEN ok := true; END;
  IF NOT ok THEN v_fail := v_fail || E'\n  missing load did not raise 42501'; END IF;

  -- PUBLIC has no EXECUTE
  IF has_function_privilege('public', 'public.load_summary(uuid)', 'EXECUTE') THEN
    v_fail := v_fail || E'\n  PUBLIC can execute load_summary';
  END IF;

  IF v_fail <> '' THEN RAISE EXCEPTION 'load_summary: FAILED%', v_fail; END IF;
  RAISE NOTICE 'load_summary: all checks passed (net 2875, profit -7125, sold 2/5)';
END
$$;

ROLLBACK;
