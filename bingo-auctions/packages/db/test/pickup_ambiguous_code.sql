-- Behavioural test for mig 0509's unique code resolution in
-- staff_confirm_pickup() (#808).
-- Plain-psql assertions, no pgTAP (matches undo_invoice_line_pickup.sql).
--
-- 0304/0487 matched each supplied code against `lots.lot_code` OR the raw half
-- of `lots.sticker_code` on EVERY line, but stamped only one row chosen by
-- `LIMIT 1` with no ORDER BY. One ambiguous code could therefore look
-- "scanned" for two owed lines (so no pickup_incomplete refusal) while only
-- one arbitrary line was actually handed over.
--
-- This pins the replacement behaviour:
--
--   • a code whose lot_code on line A equals the sticker raw code on line B is
--     refused with 'pickup_code_ambiguous' and changes NOTHING
--   • the same refusal holds when the two lots were inserted in reverse order
--     and the scan list repeats the code
--   • two case-distinct stickers (AMB:dup / AMB:DUP) are ambiguous under the
--     case-insensitive match
--   • ambiguity beats allow_incomplete=true (consent to a partial handover is
--     not consent to guessing which box)
--   • a legitimately unique code with a line missing still raises
--     pickup_incomplete (the 0147 money-loss guard is not weakened)
--   • lot_code and sticker of the SAME line resolve once, stamp once, and a
--     single-line invoice completes normally
--
-- Runs against the migrated-but-empty CI database, inside a transaction that is
-- ROLLED BACK, so the DB is left untouched.

\set ON_ERROR_STOP on

BEGIN;

-- Who is calling: a session setting the stub auth.uid() reads.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;

ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email TEXT;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
INSERT INTO operators (id, slug, business_name, contact_email, code)
VALUES ('a9000000-0000-0000-0000-000000000001', 'ambtest', 'AMB Co',
        'amb@example.com', 'AMB');

INSERT INTO warehouses (id, operator_id, name, address_line1, city, state, postal_code)
VALUES ('a9000000-0000-0000-0000-000000000002', 'a9000000-0000-0000-0000-000000000001',
        'AMB WH', '1 A St', 'Harrison', 'AR', '72601');

-- invoices are UNIQUE (auction_id, bidder_id), so each fixture invoice needs
-- its own auction.
INSERT INTO auctions (id, operator_id, warehouse_id, title, status,
                      starts_at, ends_at, pickup_starts_at, pickup_ends_at) VALUES
  ('a9000000-0000-0000-0000-000000000003', 'a9000000-0000-0000-0000-000000000001',
   'a9000000-0000-0000-0000-000000000002', 'AMB Cross Column', 'draft',
   now(), now() + interval '2 days', now() + interval '3 days', now() + interval '4 days'),
  ('a9000000-0000-0000-0000-000000000004', 'a9000000-0000-0000-0000-000000000001',
   'a9000000-0000-0000-0000-000000000002', 'AMB Reversed Dup', 'draft',
   now(), now() + interval '2 days', now() + interval '3 days', now() + interval '4 days'),
  ('a9000000-0000-0000-0000-000000000005', 'a9000000-0000-0000-0000-000000000001',
   'a9000000-0000-0000-0000-000000000002', 'AMB Case Stickers', 'draft',
   now(), now() + interval '2 days', now() + interval '3 days', now() + interval '4 days'),
  ('a9000000-0000-0000-0000-000000000006', 'a9000000-0000-0000-0000-000000000001',
   'a9000000-0000-0000-0000-000000000002', 'AMB Dedupe', 'draft',
   now(), now() + interval '2 days', now() + interval '3 days', now() + interval '4 days');

INSERT INTO auth.users (id, email) VALUES
  ('a9000000-0000-0000-0000-000000000010', 'amb-staff@example.com'),
  -- bidders_lock_email_to_auth() requires every bidder id to exist in auth.users
  ('a9000000-0000-0000-0000-000000000011', 'amb-buyer@example.com');

INSERT INTO operator_users (operator_id, user_id, role, email) VALUES
  ('a9000000-0000-0000-0000-000000000001', 'a9000000-0000-0000-0000-000000000010',
   'admin', 'amb-staff@example.com');

INSERT INTO bidders (id, email, birth_date)
VALUES ('a9000000-0000-0000-0000-000000000011', 'amb-buyer@example.com', DATE '1990-01-01');

INSERT INTO invoices (id, operator_id, auction_id, bidder_id, status, paid_at, total_cents) VALUES
  ('a9000000-0000-0000-0000-000000000020', 'a9000000-0000-0000-0000-000000000001',
   'a9000000-0000-0000-0000-000000000003', 'a9000000-0000-0000-0000-000000000011',
   'paid', now(), 2000),
  ('a9000000-0000-0000-0000-000000000021', 'a9000000-0000-0000-0000-000000000001',
   'a9000000-0000-0000-0000-000000000004', 'a9000000-0000-0000-0000-000000000011',
   'paid', now(), 2000),
  ('a9000000-0000-0000-0000-000000000022', 'a9000000-0000-0000-0000-000000000001',
   'a9000000-0000-0000-0000-000000000005', 'a9000000-0000-0000-0000-000000000011',
   'paid', now(), 2000),
  ('a9000000-0000-0000-0000-000000000023', 'a9000000-0000-0000-0000-000000000001',
   'a9000000-0000-0000-0000-000000000006', 'a9000000-0000-0000-0000-000000000011',
   'paid', now(), 1000);

-- A: cross-column collision. Scanning the raw code 'SCAN1' matches A1's
-- sticker ('AMB:SCAN1') AND A2's canonical lot_code ('SCAN1').
INSERT INTO lots (id, operator_id, warehouse_id, lot_code, title, status, sticker_code) VALUES
  ('a9000000-0000-0000-0000-000000000041', 'a9000000-0000-0000-0000-000000000001',
   'a9000000-0000-0000-0000-000000000002', 'AMB-A1', 'sticker collides', 'won', 'AMB:SCAN1'),
  ('a9000000-0000-0000-0000-000000000042', 'a9000000-0000-0000-0000-000000000001',
   'a9000000-0000-0000-0000-000000000002', 'SCAN1', 'lot code collides', 'won', 'AMB:A2'),
  -- B: the same collision with the insertion order reversed (B2 before B1),
  -- so neither a "first row wins" nor a "last row wins" scan may pass.
  ('a9000000-0000-0000-0000-000000000044', 'a9000000-0000-0000-0000-000000000001',
   'a9000000-0000-0000-0000-000000000002', 'AMB-B2', 'inserted first', 'won', 'AMB:SCAN2'),
  ('a9000000-0000-0000-0000-000000000043', 'a9000000-0000-0000-0000-000000000001',
   'a9000000-0000-0000-0000-000000000002', 'SCAN2', 'inserted second', 'won', 'AMB:B1'),
  -- C: two case-distinct stickers. The match upper-cases, so 'DUP' hits both.
  ('a9000000-0000-0000-0000-000000000045', 'a9000000-0000-0000-0000-000000000001',
   'a9000000-0000-0000-0000-000000000002', 'AMB-C1', 'lower sticker', 'won', 'AMB:dup'),
  ('a9000000-0000-0000-0000-000000000046', 'a9000000-0000-0000-0000-000000000001',
   'a9000000-0000-0000-0000-000000000002', 'AMB-C2', 'upper sticker', 'won', 'AMB:DUP'),
  -- D: one line, two codes for it — lot_code and sticker must dedupe.
  ('a9000000-0000-0000-0000-000000000047', 'a9000000-0000-0000-0000-000000000001',
   'a9000000-0000-0000-0000-000000000002', 'AMB-D1', 'unique line', 'won', 'AMB:UNIQ');

INSERT INTO invoice_lots (invoice_id, lot_id, winning_bid_cents) VALUES
  ('a9000000-0000-0000-0000-000000000020', 'a9000000-0000-0000-0000-000000000041', 1000),
  ('a9000000-0000-0000-0000-000000000020', 'a9000000-0000-0000-0000-000000000042', 1000),
  ('a9000000-0000-0000-0000-000000000021', 'a9000000-0000-0000-0000-000000000043', 1000),
  ('a9000000-0000-0000-0000-000000000021', 'a9000000-0000-0000-0000-000000000044', 1000),
  ('a9000000-0000-0000-0000-000000000022', 'a9000000-0000-0000-0000-000000000045', 1000),
  ('a9000000-0000-0000-0000-000000000022', 'a9000000-0000-0000-0000-000000000046', 1000),
  ('a9000000-0000-0000-0000-000000000023', 'a9000000-0000-0000-0000-000000000047', 1000);

INSERT INTO pickups (id, invoice_id, warehouse_id, status, checked_in_at) VALUES
  ('a9000000-0000-0000-0000-000000000030', 'a9000000-0000-0000-0000-000000000020',
   'a9000000-0000-0000-0000-000000000002', 'checked_in', now()),
  ('a9000000-0000-0000-0000-000000000031', 'a9000000-0000-0000-0000-000000000021',
   'a9000000-0000-0000-0000-000000000002', 'checked_in', now()),
  ('a9000000-0000-0000-0000-000000000032', 'a9000000-0000-0000-0000-000000000022',
   'a9000000-0000-0000-0000-000000000002', 'checked_in', now()),
  ('a9000000-0000-0000-0000-000000000033', 'a9000000-0000-0000-0000-000000000023',
   'a9000000-0000-0000-0000-000000000002', 'checked_in', now());

-- ---------------------------------------------------------------------------
-- A helper: assert the round was refused as ambiguous and nothing moved.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION _test_0509_assert_ambiguous(
  p_invoice UUID,
  p_codes   TEXT[],
  p_allow   BOOLEAN
) RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  BEGIN
    PERFORM staff_confirm_pickup(p_invoice, p_codes, p_allow);
    RAISE EXCEPTION 'expected pickup_code_ambiguous for % on %', p_codes, p_invoice;
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'pickup_code_ambiguous%' THEN
      RAISE EXCEPTION 'expected pickup_code_ambiguous for % on %, got %',
        p_codes, p_invoice, SQLERRM;
    END IF;
  END;

  IF EXISTS (
    SELECT 1 FROM invoice_lots
     WHERE invoice_id = p_invoice AND picked_up_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'ambiguous scan stamped a line on %', p_invoice;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pickups
     WHERE invoice_id = p_invoice
       AND (status::text <> 'checked_in' OR completed_at IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'ambiguous scan moved the pickup on %', p_invoice;
  END IF;
  IF EXISTS (
    SELECT 1 FROM operator_audit_log
     WHERE target_id = p_invoice AND action_type = 'pickup.partial_handover'
  ) THEN
    RAISE EXCEPTION 'ambiguous scan wrote an audit row on %', p_invoice;
  END IF;
  IF EXISTS (
    SELECT 1 FROM notifications_outbox
     WHERE idempotency_key = 'pickup_confirmed:staff:' || p_invoice::text
  ) THEN
    RAISE EXCEPTION 'ambiguous scan queued a notification on %', p_invoice;
  END IF;
END;
$$;

DO $$
BEGIN
  PERFORM set_config('test.uid', 'a9000000-0000-0000-0000-000000000010', true);

  -- A: cross-column collision, incomplete consent off.
  PERFORM _test_0509_assert_ambiguous(
    'a9000000-0000-0000-0000-000000000020', ARRAY['SCAN1']::text[], FALSE);

  -- B: reversed insertion order and a repeated scan, incomplete consent ON.
  -- Consent to a partial handover is not consent to guess which box.
  PERFORM _test_0509_assert_ambiguous(
    'a9000000-0000-0000-0000-000000000021',
    ARRAY['SCAN2', 'SCAN2']::text[], TRUE);

  -- C: upper() folds two case-distinct stickers into one ambiguous code.
  PERFORM _test_0509_assert_ambiguous(
    'a9000000-0000-0000-0000-000000000022', ARRAY['DUP']::text[], FALSE);

  RAISE NOTICE '0509 #808: ambiguous codes refuse before any mutation';
END $$;

-- A unique code with a sibling still owed must keep the 0147 money-loss guard.
DO $$
BEGIN
  PERFORM set_config('test.uid', 'a9000000-0000-0000-0000-000000000010', true);

  BEGIN
    PERFORM staff_confirm_pickup(
      'a9000000-0000-0000-0000-000000000021', ARRAY['B1']::text[], FALSE);
    RAISE EXCEPTION 'expected pickup_incomplete for a single scanned line';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM NOT LIKE 'pickup_incomplete%' THEN
      RAISE EXCEPTION 'expected pickup_incomplete, got %', SQLERRM;
    END IF;
  END;

  IF EXISTS (
    SELECT 1 FROM invoice_lots
     WHERE invoice_id = 'a9000000-0000-0000-0000-000000000021'
       AND picked_up_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'a refused partial round stamped a line';
  END IF;

  RAISE NOTICE '0509 #808: unique code still trips pickup_incomplete when owed';
END $$;

-- Two codes for one line resolve once, stamp once, and complete normally.
DO $$
DECLARE
  v_res staff_confirm_pickup_result;
BEGIN
  PERFORM set_config('test.uid', 'a9000000-0000-0000-0000-000000000010', true);

  v_res := staff_confirm_pickup(
    'a9000000-0000-0000-0000-000000000023',
    ARRAY['AMB-D1', 'UNIQ']::text[], FALSE);

  IF v_res.out_lots_picked_count <> 1 THEN
    RAISE EXCEPTION 'two codes for one line stamped % lots', v_res.out_lots_picked_count;
  END IF;
  IF v_res.out_warning IS NOT NULL THEN
    RAISE EXCEPTION 'two codes for one line warned: %', v_res.out_warning;
  END IF;
  IF (SELECT picked_up_at FROM invoice_lots
       WHERE invoice_id = 'a9000000-0000-0000-0000-000000000023'
         AND lot_id = 'a9000000-0000-0000-0000-000000000047') IS NULL THEN
    RAISE EXCEPTION 'the unique line was not stamped';
  END IF;
  IF (SELECT status::text FROM pickups
       WHERE invoice_id = 'a9000000-0000-0000-0000-000000000023') <> 'completed' THEN
    RAISE EXCEPTION 'the single-line pickup did not complete';
  END IF;

  RAISE NOTICE '0509 #808: lot_code + sticker dedupe to one stamp';
END $$;

ROLLBACK;
