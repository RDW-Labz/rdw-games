-- Behavioural test for mig 0350: place_bid's self-raise must never LOWER a
-- bidder's maximum. Plain-psql assertions, no pgTAP (matches duplicate_lot.sql).
--
-- WHY THIS TEST EXISTS
-- The defect shipped in 0216 and was then copied forward VERBATIM into 0221 and
-- 0263 — three rewrites of place_bid, each carrying the same missing guard. It
-- cost 16 bidders a win over two months before anyone noticed, because the
-- self-raise path is an UPDATE with no history row: the bidder never sees their
-- maximum change. A rewrite that reintroduces it would be equally silent, so
-- the guard needs a test rather than a comment.
--
-- Cases:
--   1. Leader raises their own maximum      → maximum increases.
--   2. Leader submits a LOWER maximum       → maximum is PRESERVED (the bug).
--   3. The lowering attempt leaves price, leader and history untouched.
--
-- Runs against the migrated-but-empty CI database inside a transaction that is
-- ROLLED BACK, so the DB is left untouched.

\set ON_ERROR_STOP on

BEGIN;

INSERT INTO operators (id, slug, business_name, contact_email, code)
VALUES ('d1000000-0000-0000-0000-000000000001', 'selfraise', 'Self Raise Test Co',
        'selfraise@example.com', 'SRT');

INSERT INTO warehouses (id, operator_id, name, address_line1, city, state, postal_code)
VALUES ('d1000000-0000-0000-0000-000000000002', 'd1000000-0000-0000-0000-000000000001',
        'SRT WH', '1 Bid St', 'Harrison', 'AR', '72601');

INSERT INTO auctions (id, operator_id, warehouse_id, title, status,
                      starts_at, ends_at, pickup_starts_at, pickup_ends_at)
VALUES ('d1000000-0000-0000-0000-000000000003', 'd1000000-0000-0000-0000-000000000001',
        'd1000000-0000-0000-0000-000000000002', 'SRT auction', 'live',
        now() - interval '1 hour', now() + interval '2 days',
        now() + interval '3 days', now() + interval '4 days');

INSERT INTO lots (id, operator_id, warehouse_id, auction_id, lot_code, title,
                  status, starting_bid_cents, close_at)
VALUES ('d1000000-0000-0000-0000-000000000004', 'd1000000-0000-0000-0000-000000000001',
        'd1000000-0000-0000-0000-000000000002', 'd1000000-0000-0000-0000-000000000003',
        'SRT-1', 'Self raise subject', 'live', 100, now() + interval '2 days');

-- default_payment_method_id set so the §A card gate passes regardless of
-- whether platform_settings.payments_disabled happens to be on in CI.
-- bidders_lock_email_to_auth() requires a matching auth.users row.
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email TEXT;
INSERT INTO auth.users (id, email)
VALUES ('d1000000-0000-0000-0000-0000000000b1', 'selfraise-bidder@example.com');

INSERT INTO bidders (id, email, birth_date, default_payment_method_id, unpaid_fees_cents)
VALUES ('d1000000-0000-0000-0000-0000000000b1', 'selfraise-bidder@example.com',
        DATE '1990-01-01', 'pm_test_selfraise', 0);

-- place_bid resolves the caller via auth.uid(). The CI harness stubs that to
-- `SELECT NULL::uuid` (ci.yml, "Apply migrations in order"), so setting the
-- request.jwt.claims GUC is NOT enough here even though it is what works
-- against a real Supabase database — the stub never reads it. Redefine the
-- function, same as lot_worker_attribution.sql does. Rolled back with the
-- transaction.
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT 'd1000000-0000-0000-0000-0000000000b1'::uuid $$;

DO $t$
DECLARE
  v_lot  CONSTANT uuid := 'd1000000-0000-0000-0000-000000000004';
  v_bid  CONSTANT uuid := 'd1000000-0000-0000-0000-0000000000b1';
  v_res  place_bid_result;
  v_max  bigint;
  v_price bigint;
  v_leader uuid;
  v_rows int;
BEGIN
  -- Become the leader with a genuine maximum of $50.00.
  v_res := place_bid(v_lot, 5000);
  IF NOT v_res.ok THEN
    RAISE EXCEPTION 'setup: opening bid rejected (%)', v_res.reason;
  END IF;

  SELECT max_amount_cents INTO v_max FROM bids
   WHERE lot_id = v_lot AND bidder_id = v_bid ORDER BY placed_at DESC LIMIT 1;
  IF v_max <> 5000 THEN
    RAISE EXCEPTION 'setup: expected max 5000, got %', v_max;
  END IF;

  SELECT current_bid_cents, winner_bidder_id INTO v_price, v_leader
    FROM lots WHERE id = v_lot;
  SELECT count(*) INTO v_rows FROM bids WHERE lot_id = v_lot;

  -- CASE 2 — the bug. The leader submits a LOWER maximum, exactly what the
  -- app's one-tap Quick bid does when you are already winning: it sends the
  -- next increment above the CURRENT PRICE, not above your own maximum.
  v_res := place_bid(v_lot, v_price + 100);
  IF NOT v_res.ok THEN
    RAISE EXCEPTION 'case 2: lower-max call was rejected outright (%) — expected a silent no-op', v_res.reason;
  END IF;

  SELECT max_amount_cents INTO v_max FROM bids
   WHERE lot_id = v_lot AND bidder_id = v_bid ORDER BY placed_at DESC LIMIT 1;
  IF v_max <> 5000 THEN
    RAISE EXCEPTION 'REGRESSION (mig 0350): a lower self-raise overwrote the maximum, 5000 -> %', v_max;
  END IF;

  -- CASE 3 — the rejected lowering must not disturb anything else.
  IF (SELECT current_bid_cents FROM lots WHERE id = v_lot) <> v_price THEN
    RAISE EXCEPTION 'case 3: price moved on a self-raise';
  END IF;
  IF (SELECT winner_bidder_id FROM lots WHERE id = v_lot) <> v_leader THEN
    RAISE EXCEPTION 'case 3: leader changed on a self-raise';
  END IF;
  IF (SELECT count(*) FROM bids WHERE lot_id = v_lot) <> v_rows THEN
    RAISE EXCEPTION 'case 3: self-raise added a visible history row';
  END IF;

  -- CASE 1 — a real raise still works.
  v_res := place_bid(v_lot, 9000);
  IF NOT v_res.ok THEN
    RAISE EXCEPTION 'case 1: genuine raise rejected (%)', v_res.reason;
  END IF;
  SELECT max_amount_cents INTO v_max FROM bids
   WHERE lot_id = v_lot AND bidder_id = v_bid ORDER BY placed_at DESC LIMIT 1;
  IF v_max <> 9000 THEN
    RAISE EXCEPTION 'case 1: expected max 9000 after a genuine raise, got %', v_max;
  END IF;

  RAISE NOTICE 'place_bid self-raise guard: all cases passed';
END
$t$;

ROLLBACK;
