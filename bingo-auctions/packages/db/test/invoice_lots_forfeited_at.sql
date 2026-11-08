-- Behavioural test for mig 0301's forfeited_at stamp.
-- Plain-psql assertions, no pgTAP (matches lineage_assign_guard.sql).
--
-- The point of the column is that "is this line still owed?" becomes
-- answerable from invoice_lots ALONE:
--
--   picked_up_at IS NULL AND refunded_at IS NULL AND forfeited_at IS NULL
--
-- Before it, forfeiture lived only on the pickup row, one level up, while
-- collected and refunded lived on the line — which is how the 2026-07-29
-- display bug happened: code reasoning from the line called a forfeited item
-- "Ready to collect" and printed its shelf location.
--
-- Asserted here:
--   • the transition into 'forfeited' stamps still-open lines
--   • lines already collected or refunded keep their own end-state and are
--     NOT overwritten — forfeiture must not rewrite history
--   • re-touching an already-forfeited pickup neither re-stamps nor moves the
--     timestamp (the trigger fires on the transition, not on every update)
--   • a non-forfeit status change leaves lines untouched
--
-- Runs against the migrated-but-empty CI database, inside a transaction that is
-- ROLLED BACK, so the DB is left untouched.

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
INSERT INTO operators (id, slug, business_name, contact_email, code)
VALUES ('f0000000-0000-0000-0000-0000000000b1', 'fftest', 'FF Co', 'ff@example.com', 'FFT');

INSERT INTO warehouses (id, operator_id, name, address_line1, city, state, postal_code)
VALUES ('f0000000-0000-0000-0000-0000000000b2', 'f0000000-0000-0000-0000-0000000000b1',
        'FF WH', '1 F St', 'Harrison', 'AR', '72601');

INSERT INTO auctions (id, operator_id, warehouse_id, title, status,
                      starts_at, ends_at, pickup_starts_at, pickup_ends_at)
VALUES ('f0000000-0000-0000-0000-0000000000b3', 'f0000000-0000-0000-0000-0000000000b1',
        'f0000000-0000-0000-0000-0000000000b2', 'FF A', 'draft',
        now(), now() + interval '2 days', now() + interval '3 days', now() + interval '4 days');

ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email TEXT;
INSERT INTO auth.users (id, email)
VALUES ('f0000000-0000-0000-0000-0000000000b4', 'ffb@example.com');
INSERT INTO bidders (id, email, birth_date)
VALUES ('f0000000-0000-0000-0000-0000000000b4', 'ffb@example.com', DATE '1990-01-01');

INSERT INTO invoices (id, operator_id, auction_id, bidder_id, status)
VALUES ('f0000000-0000-0000-0000-0000000000b5', 'f0000000-0000-0000-0000-0000000000b1',
        'f0000000-0000-0000-0000-0000000000b3', 'f0000000-0000-0000-0000-0000000000b4', 'paid');

INSERT INTO lots (id, operator_id, warehouse_id, lot_code, title, status) VALUES
 ('f0000000-0000-0000-0000-0000000000c1','f0000000-0000-0000-0000-0000000000b1','f0000000-0000-0000-0000-0000000000b2','FF-1','still open','won'),
 ('f0000000-0000-0000-0000-0000000000c2','f0000000-0000-0000-0000-0000000000b1','f0000000-0000-0000-0000-0000000000b2','FF-2','collected','won'),
 ('f0000000-0000-0000-0000-0000000000c3','f0000000-0000-0000-0000-0000000000b1','f0000000-0000-0000-0000-0000000000b2','FF-3','refunded','won');

INSERT INTO invoice_lots (invoice_id, lot_id, winning_bid_cents, picked_up_at, refunded_at) VALUES
 ('f0000000-0000-0000-0000-0000000000b5','f0000000-0000-0000-0000-0000000000c1',1000,NULL,NULL),
 ('f0000000-0000-0000-0000-0000000000b5','f0000000-0000-0000-0000-0000000000c2',1000,now(),NULL),
 ('f0000000-0000-0000-0000-0000000000b5','f0000000-0000-0000-0000-0000000000c3',1000,NULL,now());

INSERT INTO pickups (id, invoice_id, warehouse_id, status)
VALUES ('f0000000-0000-0000-0000-0000000000d9', 'f0000000-0000-0000-0000-0000000000b5',
        'f0000000-0000-0000-0000-0000000000b2', 'pending');

-- ---------------------------------------------------------------------------
-- Assertions
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_fail TEXT := '';
  v_t1   TIMESTAMPTZ;
BEGIN
  -- A status change that is not a forfeit must leave the lines alone.
  UPDATE pickups SET status = 'checked_in'
   WHERE id = 'f0000000-0000-0000-0000-0000000000d9';
  IF EXISTS (SELECT 1 FROM invoice_lots
              WHERE invoice_id = 'f0000000-0000-0000-0000-0000000000b5'
                AND forfeited_at IS NOT NULL) THEN
    v_fail := v_fail || E'\n  a non-forfeit status change stamped lines';
  END IF;

  UPDATE pickups SET status = 'forfeited'
   WHERE id = 'f0000000-0000-0000-0000-0000000000d9';

  -- The still-open line is stamped.
  IF (SELECT forfeited_at FROM invoice_lots
       WHERE lot_id = 'f0000000-0000-0000-0000-0000000000c1') IS NULL THEN
    v_fail := v_fail || E'\n  open line was not stamped on forfeit';
  END IF;

  -- Already-collected and already-refunded lines keep their own end-state.
  IF (SELECT forfeited_at FROM invoice_lots
       WHERE lot_id = 'f0000000-0000-0000-0000-0000000000c2') IS NOT NULL THEN
    v_fail := v_fail || E'\n  a COLLECTED line was marked forfeited — forfeiture must not rewrite history';
  END IF;
  IF (SELECT forfeited_at FROM invoice_lots
       WHERE lot_id = 'f0000000-0000-0000-0000-0000000000c3') IS NOT NULL THEN
    v_fail := v_fail || E'\n  a REFUNDED line was marked forfeited — forfeiture must not rewrite history';
  END IF;

  -- Re-touching an already-forfeited pickup must not move the timestamp.
  SELECT forfeited_at INTO v_t1 FROM invoice_lots
   WHERE lot_id = 'f0000000-0000-0000-0000-0000000000c1';
  UPDATE pickups SET status = 'forfeited'
   WHERE id = 'f0000000-0000-0000-0000-0000000000d9';
  IF (SELECT forfeited_at FROM invoice_lots
       WHERE lot_id = 'f0000000-0000-0000-0000-0000000000c1') IS DISTINCT FROM v_t1 THEN
    v_fail := v_fail || E'\n  re-touching the pickup moved forfeited_at';
  END IF;

  IF v_fail <> '' THEN
    RAISE EXCEPTION 'invoice_lots.forfeited_at assertions failed:%', v_fail;
  END IF;
  RAISE NOTICE 'invoice_lots_forfeited_at: all assertions OK';
END $$;

ROLLBACK;
