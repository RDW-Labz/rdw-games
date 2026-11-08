-- Behavioural test for mig 0314: relist reclaims the box's label from stale
-- kin. Plain-psql assertions, no pgTAP (matches relist_refunded_child_guard).
--
-- The prod shape that motivated it (2026-08-07):
--   TEA4951993 (root, relisted) → BIN-006802 (unsold, wears BIN:TEA4951993)
--   relist the root again        → new child minted STICKERLESS, because
--   0213's derive found the label "already claimed" — by a stale sibling of
--   the same physical box. The customer's pass then shows a BIN-###### the
--   box does not.
--
-- Cases:
--   1. reclaim-from-unsold-sibling — the reported shape. New child must wear
--      the label; the unsold sibling must be stripped.
--   2. reclaim-from-won-refunded sibling — refund-and-restock; same result.
--   3. NO reclaim from a won sibling with an active (un-refunded) claim — a
--      customer is owed that box; new child stays stickerless.
--   4. NO reclaim across trees — an unrelated lot wearing the derived label
--      keeps it; new child stays stickerless.
--   5. source wears the label itself — 0192 handover unchanged by 0314.
--
-- Runs against the migrated-but-empty CI database, inside a transaction that
-- is ROLLED BACK, so the DB is left untouched.

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- Fixtures (column lists mirror relist_refunded_child_guard.sql)
-- ---------------------------------------------------------------------------
INSERT INTO operators (id, slug, business_name, contact_email, code)
VALUES ('b0000000-0000-0000-0000-0000000000e1', 'labelreclaim', 'Label Reclaim Test Co',
        'reclaim@example.com', 'LRC');

INSERT INTO warehouses (id, operator_id, name, address_line1, city, state, postal_code)
VALUES ('b0000000-0000-0000-0000-0000000000e2', 'b0000000-0000-0000-0000-0000000000e1',
        'LRC WH', '1 Reclaim St', 'Harrison', 'AR', '72601');

INSERT INTO auctions (id, operator_id, warehouse_id, title, status,
                      starts_at, ends_at, pickup_starts_at, pickup_ends_at)
VALUES ('b0000000-0000-0000-0000-0000000000e3', 'b0000000-0000-0000-0000-0000000000e1',
        'b0000000-0000-0000-0000-0000000000e2', 'LRC target', 'draft',
        now(), now() + interval '2 days',
        now() + interval '3 days', now() + interval '4 days');

ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email TEXT;
INSERT INTO auth.users (id, email)
VALUES ('b0000000-0000-0000-0000-0000000000e4', 'label-reclaim@example.com');
INSERT INTO bidders (id, email, birth_date)
VALUES ('b0000000-0000-0000-0000-0000000000e4', 'label-reclaim@example.com', DATE '1990-01-01');
INSERT INTO invoices (id, operator_id, auction_id, bidder_id)
VALUES ('b0000000-0000-0000-0000-0000000000e5', 'b0000000-0000-0000-0000-0000000000e1',
        'b0000000-0000-0000-0000-0000000000e3', 'b0000000-0000-0000-0000-0000000000e4');

-- Build root (legacy-coded, relisted, bare — its label moved on long ago) plus
-- one prior lineage member in the given state wearing the derived label, then
-- relist the ROOT and report where the label ended up.
--
-- p_deep controls the wearer's position:
--   false — DIRECT child of the root (the literal prod shape: unsold sibling
--           BIN-006802). Only valid for statuses the D1 guard does not block
--           (unsold / canceled / won-refunded).
--   true  — GRANDCHILD through a 'relisted' tombstone branch. D1 only checks
--           the source's DIRECT children, so this is the shape in which a
--           won-with-active-claim wearer can coexist with a permitted relist —
--           exactly the case reclaim must refuse to steal from.
CREATE FUNCTION pg_temp.reclaim_case(
  p_tag        TEXT,          -- unique per case; used in lot codes
  p_sib_status lot_status,    -- the wearer's status
  p_invoiced   BOOLEAN,       -- does the wearer have an invoice claim?
  p_refunded   BOOLEAN,       -- ... and is that claim refunded?
  p_deep       BOOLEAN        -- wearer is a grandchild via a tombstone branch
) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE
  v_root  UUID;
  v_mid   UUID;
  v_sib   UUID;
  v_new   UUID;
  v_label TEXT := 'LRC:TEA' || p_tag;
  v_new_sticker TEXT;
  v_sib_sticker TEXT;
BEGIN
  INSERT INTO lots (operator_id, warehouse_id, lot_code, title, status, relist_count)
  VALUES ('b0000000-0000-0000-0000-0000000000e1', 'b0000000-0000-0000-0000-0000000000e2',
          'TEA' || p_tag, 'label reclaim fixture', 'relisted', 1)
  RETURNING id INTO v_root;

  IF p_deep THEN
    INSERT INTO lots (operator_id, warehouse_id, lot_code, title, status,
                      relisted_from_lot_id)
    VALUES ('b0000000-0000-0000-0000-0000000000e1', 'b0000000-0000-0000-0000-0000000000e2',
            'BIN-MID-' || p_tag, 'label reclaim fixture', 'relisted', v_root)
    RETURNING id INTO v_mid;
  END IF;

  INSERT INTO lots (operator_id, warehouse_id, lot_code, title, status,
                    relisted_from_lot_id, sticker_code, canceled_at)
  VALUES ('b0000000-0000-0000-0000-0000000000e1', 'b0000000-0000-0000-0000-0000000000e2',
          'BIN-SIB-' || p_tag, 'label reclaim fixture', p_sib_status,
          COALESCE(v_mid, v_root), v_label,
          CASE WHEN p_sib_status = 'canceled' THEN now() ELSE NULL END)
  RETURNING id INTO v_sib;

  IF p_invoiced THEN
    INSERT INTO invoice_lots (invoice_id, lot_id, winning_bid_cents, refunded_at)
    VALUES ('b0000000-0000-0000-0000-0000000000e5', v_sib, 1000,
            CASE WHEN p_refunded THEN now() ELSE NULL END);
  END IF;

  v_new := relist_lot_into_auction(v_root, 'b0000000-0000-0000-0000-0000000000e3');

  SELECT sticker_code INTO v_new_sticker FROM lots WHERE id = v_new;
  SELECT sticker_code INTO v_sib_sticker FROM lots WHERE id = v_sib;

  RETURN CASE
    WHEN v_new_sticker = v_label AND v_sib_sticker IS NULL THEN 'RECLAIMED'
    WHEN v_new_sticker IS NULL AND v_sib_sticker = v_label THEN 'LEFT'
    ELSE format('UNEXPECTED(new=%s sib=%s)', v_new_sticker, v_sib_sticker)
  END;
END $$;

-- ---------------------------------------------------------------------------
-- Assertions
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  r RECORD;
  v_fail TEXT := '';
  v_got  TEXT;
BEGIN
  FOR r IN
    SELECT * FROM (VALUES
      -- tag,  wearer status,           invoiced, refunded, deep,  expected
      ('01', 'unsold'::lot_status,      false,    false,    false, 'RECLAIMED'), -- the report
      ('02', 'won'::lot_status,         true,     true,     false, 'RECLAIMED'), -- refund-and-restock
      ('03', 'won'::lot_status,         true,     false,    true,  'LEFT'),      -- customer owed the box
      ('04', 'won'::lot_status,         false,    false,    true,  'LEFT'),      -- won, invoice lagging
      ('05', 'canceled'::lot_status,    false,    false,    false, 'RECLAIMED'),
      ('06', 'unsold'::lot_status,      false,    false,    true,  'RECLAIMED')  -- deep walk works
    ) AS t(tag, st, invoiced, refunded, deep, expected)
  LOOP
    v_got := pg_temp.reclaim_case(r.tag, r.st, r.invoiced, r.refunded, r.deep);
    IF v_got <> r.expected THEN
      v_fail := v_fail || format(
        E'\n  wearer=%s invoiced=%s refunded=%s deep=%s -> got %s, expected %s',
        r.st, r.invoiced, r.refunded, r.deep, v_got, r.expected);
    END IF;
  END LOOP;

  IF v_fail <> '' THEN
    RAISE EXCEPTION 'relist label reclaim assertions failed:%', v_fail;
  END IF;
  RAISE NOTICE 'relist_label_reclaim: lineage cases OK';
END $$;

-- Case 4 (cross-tree): an UNRELATED lot wears the label the derive step would
-- mint. 0213 already bails; 0314 must not "reclaim" from a different box.
DO $$
DECLARE
  v_root  UUID; v_other UUID; v_new UUID;
  v_new_sticker TEXT; v_other_sticker TEXT;
BEGIN
  INSERT INTO lots (operator_id, warehouse_id, lot_code, title, status, relist_count)
  VALUES ('b0000000-0000-0000-0000-0000000000e1', 'b0000000-0000-0000-0000-0000000000e2',
          'TEA99', 'cross-tree fixture', 'relisted', 1)
  RETURNING id INTO v_root;

  -- Unrelated lot (no lineage tie) wearing LRC:TEA99, and STALE (unsold) —
  -- stale is not enough; it must also be family.
  INSERT INTO lots (operator_id, warehouse_id, lot_code, title, status, sticker_code)
  VALUES ('b0000000-0000-0000-0000-0000000000e1', 'b0000000-0000-0000-0000-0000000000e2',
          'BIN-OTHER', 'cross-tree fixture', 'unsold', 'LRC:TEA99')
  RETURNING id INTO v_other;

  v_new := relist_lot_into_auction(v_root, 'b0000000-0000-0000-0000-0000000000e3');

  SELECT sticker_code INTO v_new_sticker  FROM lots WHERE id = v_new;
  SELECT sticker_code INTO v_other_sticker FROM lots WHERE id = v_other;

  IF v_other_sticker IS DISTINCT FROM 'LRC:TEA99' OR v_new_sticker IS NOT NULL THEN
    RAISE EXCEPTION
      'cross-tree reclaim: stranger sticker=%, new lot sticker=% (expected stranger keeps label, new lot NULL)',
      v_other_sticker, v_new_sticker;
  END IF;
  RAISE NOTICE 'relist_label_reclaim: cross-tree case OK';
END $$;

-- Case 5 (source wears it): the plain 0192 handover must be untouched.
DO $$
DECLARE
  v_src UUID; v_new UUID; v_new_sticker TEXT; v_src_sticker TEXT;
BEGIN
  INSERT INTO lots (operator_id, warehouse_id, lot_code, title, status, sticker_code)
  VALUES ('b0000000-0000-0000-0000-0000000000e1', 'b0000000-0000-0000-0000-0000000000e2',
          'BIN-SRC-WEARS', 'handover fixture', 'unsold', 'LRC:BRN77')
  RETURNING id INTO v_src;

  v_new := relist_lot_into_auction(v_src, 'b0000000-0000-0000-0000-0000000000e3');

  SELECT sticker_code INTO v_new_sticker FROM lots WHERE id = v_new;
  SELECT sticker_code INTO v_src_sticker FROM lots WHERE id = v_src;

  IF v_new_sticker IS DISTINCT FROM 'LRC:BRN77' OR v_src_sticker IS NOT NULL THEN
    RAISE EXCEPTION 'source-wears handover: new=%, src=% (expected new wears, src NULL)',
      v_new_sticker, v_src_sticker;
  END IF;
  RAISE NOTICE 'relist_label_reclaim: source-wears case OK';
END $$;

ROLLBACK;
