-- Behavioural test for mig 0296's D1 guard on relist_lot_into_auction.
-- Plain-psql assertions, no pgTAP (matches lineage_assign_guard.sql).
--
-- Proves BOTH directions of the "unable to relot refunded items" report
-- (2026-07-29):
--   unblocked  — a parent whose child was WON and then REFUNDED can be
--                relisted. The refund put the item back on the shelf, but 0285
--                keyed D1 on canceled_at, and a won-then-refunded child carries
--                no cancel stamp, so the parent was blocked forever.
--   still shut — a child that is draft/scheduled/live, or won and NOT refunded,
--                still refuses. Those items are genuinely spoken for: one has a
--                live listing, the other belongs to a customer.
--
-- The canceled/unsold rows are the 0285 behaviour this migration must NOT
-- regress — a parent whose children are all dead is the legitimate re-relist
-- case D1 was always meant to allow.
--
-- Fixtures stamp canceled_at only on the canceled child, matching the 0290
-- invariant. Without that the test would "pass" against 0285 for the wrong
-- reason and stop discriminating.
--
-- Runs against the migrated-but-empty CI database, inside a transaction that is
-- ROLLED BACK, so the DB is left untouched.

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
-- Column list mirrors lineage_assign_guard.sql, which is the working reference
-- for the NOT NULL set on these tables (operators.slug in particular).
INSERT INTO operators (id, slug, business_name, contact_email, code)
VALUES ('a0000000-0000-0000-0000-0000000000d1', 'relotguardtest', 'Relist Guard Test Co',
        'relot@example.com', 'RLT');

INSERT INTO warehouses (id, operator_id, name, address_line1, city, state, postal_code)
VALUES ('a0000000-0000-0000-0000-0000000000d2', 'a0000000-0000-0000-0000-0000000000d1',
        'RLT WH', '1 Relot St', 'Harrison', 'AR', '72601');

INSERT INTO auctions (id, operator_id, warehouse_id, title, status,
                      starts_at, ends_at, pickup_starts_at, pickup_ends_at)
VALUES ('a0000000-0000-0000-0000-0000000000d3', 'a0000000-0000-0000-0000-0000000000d1',
        'a0000000-0000-0000-0000-0000000000d2', 'RLT target', 'draft',
        now(), now() + interval '2 days',
        now() + interval '3 days', now() + interval '4 days');

-- invoice_lots.invoice_id is FK-bound, so the refunded/not-refunded signal
-- needs a real invoice behind it: auth.users -> bidders -> invoices.
--
-- The CI harness stubs auth.users as just (id uuid), but the
-- bidders_lock_email_to_auth trigger reads auth.users.email, and
-- enforce_bidder_age reads birth_date. Real Supabase has the email column;
-- add it here so the stub matches. Inside the rolled-back transaction, so
-- nothing leaks to the next test.
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email TEXT;

INSERT INTO auth.users (id, email)
VALUES ('a0000000-0000-0000-0000-0000000000d4', 'relot-guard@example.com');

INSERT INTO bidders (id, email, birth_date)
VALUES ('a0000000-0000-0000-0000-0000000000d4', 'relot-guard@example.com', DATE '1990-01-01');

INSERT INTO invoices (id, operator_id, auction_id, bidder_id)
VALUES ('a0000000-0000-0000-0000-0000000000d5', 'a0000000-0000-0000-0000-0000000000d1',
        'a0000000-0000-0000-0000-0000000000d3', 'a0000000-0000-0000-0000-0000000000d4');

-- Build a parent ('relisted' tombstone) plus one child in the given state, and
-- report whether relisting the parent is ALLOWED or BLOCKED. The inner block
-- swallows the expected raise so one blocked case cannot poison the rest of the
-- run (a plain script aborts the whole transaction on the first ERROR).
CREATE FUNCTION pg_temp.try_relist(
  p_label   TEXT,
  p_status  lot_status,
  p_refunded BOOLEAN
) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  v_par UUID;
  v_ch  UUID;
  v_res UUID;
BEGIN
  INSERT INTO lots (operator_id, warehouse_id, lot_code, title, status, relist_count)
  VALUES ('a0000000-0000-0000-0000-0000000000d1', 'a0000000-0000-0000-0000-0000000000d2',
          p_label || '-PARENT', 'relist guard fixture', 'relisted', 1)
  RETURNING id INTO v_par;

  -- 0290 invariant: canceled lots carry a cancel stamp, active ones must not.
  INSERT INTO lots (operator_id, warehouse_id, lot_code, title, status,
                    relisted_from_lot_id, canceled_at)
  VALUES ('a0000000-0000-0000-0000-0000000000d1', 'a0000000-0000-0000-0000-0000000000d2',
          p_label || '-CHILD', 'relist guard fixture', p_status, v_par,
          CASE WHEN p_status = 'canceled' THEN now() ELSE NULL END)
  RETURNING id INTO v_ch;

  -- invoice_lots.winning_bid_cents is NOT NULL. The guard only reads
  -- refunded_at, but the row still has to be legal.
  INSERT INTO invoice_lots (invoice_id, lot_id, winning_bid_cents, refunded_at)
  VALUES ('a0000000-0000-0000-0000-0000000000d5', v_ch, 1000,
          CASE WHEN p_refunded THEN now() ELSE NULL END);

  BEGIN
    v_res := relist_lot_into_auction(v_par, 'a0000000-0000-0000-0000-0000000000d3');
    RETURN CASE WHEN v_res IS NOT NULL THEN 'ALLOWED' ELSE 'NULL' END;
  EXCEPTION WHEN OTHERS THEN
    RETURN 'BLOCKED';
  END;
END $$;

-- ---------------------------------------------------------------------------
-- Assertions
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r RECORD;
  v_fail TEXT := '';
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      -- label, child status,        refunded, expected
      ('A', 'won'::lot_status,        true,    'ALLOWED'),  -- the reported bug
      ('B', 'won'::lot_status,        false,   'BLOCKED'),  -- customer owns it
      ('C', 'live'::lot_status,       false,   'BLOCKED'),
      ('D', 'scheduled'::lot_status,  false,   'BLOCKED'),
      ('E', 'draft'::lot_status,      false,   'BLOCKED'),
      ('F', 'canceled'::lot_status,   false,   'ALLOWED'),  -- 0285 behaviour kept
      ('G', 'unsold'::lot_status,     false,   'ALLOWED')
    ) AS t(label, st, refunded, expected)
  LOOP
    DECLARE
      v_got TEXT := pg_temp.try_relist(r.label, r.st, r.refunded);
    BEGIN
      IF v_got <> r.expected THEN
        v_fail := v_fail || format(
          E'\n  child=%s refunded=%s -> got %s, expected %s',
          r.st, r.refunded, v_got, r.expected);
      END IF;
    END;
  END LOOP;

  IF v_fail <> '' THEN
    RAISE EXCEPTION 'relist D1 guard assertions failed:%', v_fail;
  END IF;
  RAISE NOTICE 'relist_refunded_child_guard: all 7 cases OK';
END $$;

ROLLBACK;
