-- Behavioural test for mig 0316: a scanned label resolves to the box's CURRENT
-- record. Plain-psql assertions, no pgTAP (matches scan_resolver_collision.sql).
--
-- The prod shape that motivated it (2026-08-10):
--   TEA4951993 (root, 'relisted' — legacy import, label is its lot_code)
--     ├── BIN-006802 ('unsold', wears BIN:TEA4951993)  created earlier
--     └── BIN-007904 ('won',    sticker NULL)          created later
--   Scanning TEA4951993 returned the superseded unsold BIN-006802, because it
--   is the row that literally wears the sticker and 'unsold' is not one of the
--   tombstone statuses that triggered 0304's forward walk. The item the
--   customer won is the SIBLING, which a descend-only walk can never reach.
--
-- Cases:
--   1. THE REPORTED BUG — sibling shape: scan resolves to the newer won record,
--      and reports hopped_from so the caller can explain the jump.
--   2. no hop when the matched row IS already the current member (the common
--      case must be untouched, including hopped_from staying NULL).
--   3. tombstone ancestor still resolves forward (0304's behaviour preserved).
--   4. a scan that matches a lot with NO lineage is returned as-is.
--   5. matched_field still describes how the CODE matched, not the row hopped to.
--   6. a CYCLIC lineage returns the matched row instead of failing.
--
-- Runs against the migrated-but-empty CI database, inside a transaction that is
-- ROLLED BACK, so the DB is left untouched.

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
INSERT INTO operators (id, slug, business_name, contact_email, code)
VALUES ('e0000000-0000-0000-0000-0000000000a1', 'scancurrent', 'Scan Current Test Co',
        'scancurrent@example.com', 'SCN');

INSERT INTO warehouses (id, operator_id, name, address_line1, city, state, postal_code)
VALUES ('e0000000-0000-0000-0000-0000000000a2', 'e0000000-0000-0000-0000-0000000000a1',
        'SCN WH', '1 Scan St', 'Harrison', 'AR', '72601');

-- _find_lot_by_scan is SECURITY DEFINER and keys off current_operator_id().
-- Stub it to our fixture operator for the duration of the transaction, then let
-- ROLLBACK restore the real one.
CREATE OR REPLACE FUNCTION public.current_operator_id() RETURNS UUID
LANGUAGE sql STABLE AS $$ SELECT 'e0000000-0000-0000-0000-0000000000a1'::uuid $$;

-- created_at is explicit: ordering by it is what picks the current record, so
-- the test must not depend on insertion timing.
CREATE FUNCTION pg_temp.mk_lot(
  p_code    TEXT,
  p_sticker TEXT,
  p_parent  UUID,
  p_status  lot_status,
  p_created TIMESTAMPTZ
) RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE
  v_id UUID := gen_random_uuid();
BEGIN
  INSERT INTO lots (id, operator_id, warehouse_id, lot_code, sticker_code,
                    relisted_from_lot_id, title, condition, status, created_at)
  VALUES (v_id, 'e0000000-0000-0000-0000-0000000000a1',
          'e0000000-0000-0000-0000-0000000000a2', p_code, p_sticker,
          p_parent, 'Scan test ' || p_code, 'good', p_status, p_created);
  RETURN v_id;
END
$$;

CREATE FUNCTION pg_temp.scan(p_code TEXT) RETURNS JSONB LANGUAGE sql AS $$
  SELECT public._find_lot_by_scan(ARRAY[p_code])
$$;

CREATE FUNCTION pg_temp.expect(p_case TEXT, p_got TEXT, p_want TEXT)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  IF p_got IS DISTINCT FROM p_want THEN
    RAISE EXCEPTION '% — expected %, got %', p_case,
      COALESCE(p_want, 'NULL'), COALESCE(p_got, 'NULL');
  END IF;
  RAISE NOTICE 'ok: % -> %', p_case, COALESCE(p_got, 'NULL');
END
$$;

-- ---------------------------------------------------------------------------
-- 1. THE REPORTED BUG — the current record is a SIBLING of the sticker holder.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_root UUID; v_twin UUID; v_won UUID; v_res JSONB;
BEGIN
  v_root := pg_temp.mk_lot('TEA4951993', NULL, NULL, 'relisted', now() - interval '60 days');
  v_twin := pg_temp.mk_lot('BIN-006802', 'SCN:TEA4951993', v_root, 'unsold', now() - interval '11 days');
  v_won  := pg_temp.mk_lot('BIN-007904', NULL, v_root, 'won', now() - interval '3 days');

  v_res := pg_temp.scan('TEA4951993');
  PERFORM pg_temp.expect('1 scan lands on the current record',
                         v_res -> 'lot' ->> 'lot_code', 'BIN-007904');
  PERFORM pg_temp.expect('1 reports what it hopped from',
                         v_res ->> 'hopped_from', 'BIN-006802');
  -- Scanning the internal code of the superseded twin must land in the same
  -- place: it is the same physical box.
  PERFORM pg_temp.expect('1 twin internal code resolves forward too',
                         pg_temp.scan('BIN-006802') -> 'lot' ->> 'lot_code', 'BIN-007904');
END
$$;

-- ---------------------------------------------------------------------------
-- 2. NO HOP when the matched row is already current. The common case must be
--    byte-for-byte unchanged, hopped_from included.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_root UUID; v_cur UUID; v_res JSONB;
BEGIN
  v_root := pg_temp.mk_lot('BRN4371902', NULL, NULL, 'relisted', now() - interval '40 days');
  v_cur  := pg_temp.mk_lot('BIN-009001', 'SCN:BRN4371902', v_root, 'live', now() - interval '2 days');

  v_res := pg_temp.scan('BRN4371902');
  PERFORM pg_temp.expect('2 already-current row wins',
                         v_res -> 'lot' ->> 'lot_code', 'BIN-009001');
  PERFORM pg_temp.expect('2 no hop reported', v_res ->> 'hopped_from', NULL);
END
$$;

-- ---------------------------------------------------------------------------
-- 3. 0304's tombstone forward-walk behaviour is preserved: scanning a retired
--    ancestor's own code still lands on the live descendant.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_root UUID; v_mid UUID; v_leaf UUID;
BEGIN
  v_root := pg_temp.mk_lot('GRA4020769', NULL, NULL, 'relisted', now() - interval '50 days');
  v_mid  := pg_temp.mk_lot('BIN-009101', NULL, v_root, 'relisted', now() - interval '20 days');
  v_leaf := pg_temp.mk_lot('BIN-009102', NULL, v_mid, 'in_inventory', now() - interval '1 day');

  PERFORM pg_temp.expect('3 tombstone chain resolves to the live leaf',
                         pg_temp.scan('GRA4020769') -> 'lot' ->> 'lot_code', 'BIN-009102');
END
$$;

-- ---------------------------------------------------------------------------
-- 4. A lot with no lineage at all is returned as-is.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_id UUID; v_res JSONB;
BEGIN
  v_id  := pg_temp.mk_lot('BIN-009200', 'SCN:PNK4858852', NULL, 'in_inventory', now() - interval '5 days');
  v_res := pg_temp.scan('PNK4858852');
  PERFORM pg_temp.expect('4 standalone lot unchanged',
                         v_res -> 'lot' ->> 'lot_code', 'BIN-009200');
  PERFORM pg_temp.expect('4 no hop', v_res ->> 'hopped_from', NULL);
END
$$;

-- ---------------------------------------------------------------------------
-- 5. matched_field describes how the CODE matched (on the row that literally
--    matched), not the row we hopped to — callers use it to explain the scan.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_root UUID; v_twin UUID; v_new UUID; v_res JSONB;
BEGIN
  v_root := pg_temp.mk_lot('BIN-009300', NULL, NULL, 'relisted', now() - interval '30 days');
  v_twin := pg_temp.mk_lot('BIN-009301', 'SCN:PPE1234567', v_root, 'unsold', now() - interval '9 days');
  v_new  := pg_temp.mk_lot('BIN-009302', NULL, v_root, 'scheduled', now() - interval '1 day');

  v_res := pg_temp.scan('PPE1234567');
  PERFORM pg_temp.expect('5 hopped to the current record',
                         v_res -> 'lot' ->> 'lot_code', 'BIN-009302');
  PERFORM pg_temp.expect('5 matched_field is how the code matched',
                         v_res ->> 'matched_field', 'sticker_code');
END
$$;

-- ---------------------------------------------------------------------------
-- 7. A box a customer has BOUGHT and not yet collected outranks a newer relist
--    of the same box. This is the pickup counter: landing on the newer record
--    would show staff somebody else's lot while the buyer stands there. The
--    relist guards should make this shape unreachable; the ordering must not
--    depend on that.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_root UUID; v_sold UUID; v_newer UUID;
  v_auction UUID := gen_random_uuid();
  v_bidder  UUID := gen_random_uuid();
  v_invoice UUID := gen_random_uuid();
BEGIN
  v_root  := pg_temp.mk_lot('BIN-009500', NULL, NULL, 'relisted', now() - interval '30 days');
  v_sold  := pg_temp.mk_lot('BIN-009501', 'SCN:BRN4444444', v_root, 'won', now() - interval '10 days');
  v_newer := pg_temp.mk_lot('BIN-009502', NULL, v_root, 'unsold', now() - interval '1 day');

  INSERT INTO auctions (id, operator_id, warehouse_id, title, status,
                        starts_at, ends_at, pickup_starts_at, pickup_ends_at)
  VALUES (v_auction, 'e0000000-0000-0000-0000-0000000000a1',
          'e0000000-0000-0000-0000-0000000000a2', 'SCN auction', 'draft',
          now(), now() + interval '2 days',
          now() + interval '3 days', now() + interval '4 days');

  ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email TEXT;
  INSERT INTO auth.users (id, email) VALUES (v_bidder, 'scan-current@example.com');
  INSERT INTO bidders (id, email, birth_date)
  VALUES (v_bidder, 'scan-current@example.com', DATE '1990-01-01');
  INSERT INTO invoices (id, operator_id, auction_id, bidder_id)
  VALUES (v_invoice, 'e0000000-0000-0000-0000-0000000000a1', v_auction, v_bidder);
  -- Bought, paid for, NOT yet collected.
  INSERT INTO invoice_lots (invoice_id, lot_id, winning_bid_cents)
  VALUES (v_invoice, v_sold, 1200);

  PERFORM pg_temp.expect('7 unpicked purchase outranks a newer relist',
                         pg_temp.scan('BRN4444444') -> 'lot' ->> 'lot_code', 'BIN-009501');

  -- Once collected, the newer record becomes current again.
  UPDATE invoice_lots SET picked_up_at = now()
   WHERE invoice_id = v_invoice AND lot_id = v_sold;
  PERFORM pg_temp.expect('7 after collection the newer record is current',
                         pg_temp.scan('BRN4444444') -> 'lot' ->> 'lot_code', 'BIN-009502');
END
$$;

-- ---------------------------------------------------------------------------
-- 6. A CYCLIC lineage must not fail the scan. The tree CTE finds no NULL-parent
--    root, so it resolves empty and the directly-matched row is returned.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_x UUID; v_y UUID;
BEGIN
  v_x := pg_temp.mk_lot('BIN-009400', 'SCN:TEA9999999', NULL, 'in_inventory', now() - interval '6 days');
  v_y := pg_temp.mk_lot('BIN-009401', NULL, v_x, 'in_inventory', now() - interval '4 days');
  UPDATE lots SET relisted_from_lot_id = v_y WHERE id = v_x;  -- close the loop

  PERFORM pg_temp.expect('6 cycle returns the matched row',
                         pg_temp.scan('TEA9999999') -> 'lot' ->> 'lot_code', 'BIN-009400');
END
$$;

ROLLBACK;
