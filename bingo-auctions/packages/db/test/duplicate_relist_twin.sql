-- Behavioural test for mig 0307's relist-twin retirement.
-- Plain-psql assertions, no pgTAP (matches phantom_relist_child.sql).
--
-- 0306 could only retire an inert child when a sibling held an auction — that
-- sibling was the proof the item still existed somewhere. 0307 handles the rows
-- with no such sibling, where the only surviving record of the box IS one of
-- the duplicates. Cancel the wrong one and the item is gone from inventory with
-- nothing left pointing at it.
--
-- So the predicate leans on `intake_at`: two rows sharing a parent, a title, a
-- bin and an inherited intake_at to the microsecond are one box cloned twice.
-- The shape that must NOT match is the one duplicate_lot (0299) makes on
-- purpose — two identical in_inventory rows for two REAL boxes — and the only
-- things telling them apart are lineage and intake_at. That fixture is the
-- point of this file; if it ever starts matching, the repair deletes real
-- stock that staff have already put on a shelf.
--
-- Runs against the migrated-but-empty CI database, inside a transaction that is
-- ROLLED BACK, so the DB is left untouched.

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
INSERT INTO operators (id, slug, business_name, contact_email, code)
VALUES ('e0000000-0000-0000-0000-000000000001', 'twintest', 'Twin Test Co',
        'twin@example.com', 'TWN');

INSERT INTO warehouses (id, operator_id, name, address_line1, city, state, postal_code)
VALUES ('e0000000-0000-0000-0000-000000000002', 'e0000000-0000-0000-0000-000000000001',
        'TWN WH', '1 Twin St', 'Harrison', 'AR', '72601');

INSERT INTO bins (id, warehouse_id, code, aisle, bay, x_px, y_px, qr_token)
VALUES ('e0000000-0000-0000-0000-0000000000b1', 'e0000000-0000-0000-0000-000000000002',
        '1-18-01', '1', '18', 0, 0, 'e0000000-0000-0000-0000-0000000000c1');

-- ── Tangle A: modelled on TEA3822650. One box, cloned 78 seconds apart by a
--    double-click, and nothing in the lineage ever reached an auction.
INSERT INTO lots (id, operator_id, warehouse_id, lot_code, status, title,
                  relisted_from_lot_id, intake_bin_id, intake_at, auction_id,
                  bid_count, created_at)
VALUES
  ('e0000000-0000-0000-0000-0000000000a0', 'e0000000-0000-0000-0000-000000000001',
   'e0000000-0000-0000-0000-000000000002', 'TWN3822650', 'canceled', 'loft bed',
   NULL, 'e0000000-0000-0000-0000-0000000000b1', TIMESTAMPTZ '2026-05-28 19:00:31.143056Z',
   NULL, 0, TIMESTAMPTZ '2026-05-25Z'),
  -- the older twin — must SURVIVE, it is the item's only remaining record
  ('e0000000-0000-0000-0000-0000000000a1', 'e0000000-0000-0000-0000-000000000001',
   'e0000000-0000-0000-0000-000000000002', 'TWN-002565', 'in_inventory', 'loft bed',
   'e0000000-0000-0000-0000-0000000000a0', 'e0000000-0000-0000-0000-0000000000b1',
   TIMESTAMPTZ '2026-05-28 19:00:31.143056Z', NULL, 0, TIMESTAMPTZ '2026-07-15 13:48:51Z'),
  -- the newer twin — must be cancelled
  ('e0000000-0000-0000-0000-0000000000a2', 'e0000000-0000-0000-0000-000000000001',
   'e0000000-0000-0000-0000-000000000002', 'TWN-002622', 'in_inventory', 'loft bed',
   'e0000000-0000-0000-0000-0000000000a0', 'e0000000-0000-0000-0000-0000000000b1',
   TIMESTAMPTZ '2026-05-28 19:00:31.143056Z', NULL, 0, TIMESTAMPTZ '2026-07-15 13:50:09Z');

-- ── Tangle B: a LONE inert child. No twin, no auctioned sibling — cancelling
--    it erases the item outright.
INSERT INTO lots (id, operator_id, warehouse_id, lot_code, status, title,
                  relisted_from_lot_id, intake_bin_id, intake_at, auction_id,
                  bid_count, created_at)
VALUES
  ('e0000000-0000-0000-0000-0000000000b0', 'e0000000-0000-0000-0000-000000000001',
   'e0000000-0000-0000-0000-000000000002', 'TWN4111111', 'canceled', 'lone item',
   NULL, 'e0000000-0000-0000-0000-0000000000b1', TIMESTAMPTZ '2026-05-28 09:00:00Z',
   NULL, 0, TIMESTAMPTZ '2026-05-25Z'),
  ('e0000000-0000-0000-0000-0000000000b2', 'e0000000-0000-0000-0000-000000000001',
   'e0000000-0000-0000-0000-000000000002', 'TWN-009999', 'in_inventory', 'lone item',
   'e0000000-0000-0000-0000-0000000000b0', 'e0000000-0000-0000-0000-0000000000b1',
   TIMESTAMPTZ '2026-05-28 09:00:00Z', NULL, 0, TIMESTAMPTZ '2026-07-15 13:48:52Z');

-- ── Tangle C: THE fixture. duplicate_lot (0299) output — two genuinely
--    different boxes that are identical products, sharing a title and a bin.
--    0299 leaves relisted_from_lot_id NULL and does not copy intake_at; here
--    both units have been put away since, so both carry a real (differing)
--    intake_at. Cancelling either loses a box that is physically on the shelf.
INSERT INTO lots (id, operator_id, warehouse_id, lot_code, status, title,
                  relisted_from_lot_id, intake_bin_id, intake_at, auction_id,
                  bid_count, created_at)
VALUES
  ('e0000000-0000-0000-0000-0000000000c0', 'e0000000-0000-0000-0000-000000000001',
   'e0000000-0000-0000-0000-000000000002', 'TWN-004001', 'in_inventory', 'bath towel set',
   NULL, 'e0000000-0000-0000-0000-0000000000b1', TIMESTAMPTZ '2026-07-20 10:00:00Z',
   NULL, 0, TIMESTAMPTZ '2026-07-19 10:00:00Z'),
  ('e0000000-0000-0000-0000-0000000000c1', 'e0000000-0000-0000-0000-000000000001',
   'e0000000-0000-0000-0000-000000000002', 'TWN-004002', 'in_inventory', 'bath towel set',
   NULL, 'e0000000-0000-0000-0000-0000000000b1', TIMESTAMPTZ '2026-07-20 10:05:00Z',
   NULL, 0, TIMESTAMPTZ '2026-07-19 10:01:00Z');

-- ── Tangle D: relist twins whose NEWER row carries the sticker stuck to the
--    box. The sticker is a claim on the physical item, so nothing is retired.
INSERT INTO lots (id, operator_id, warehouse_id, lot_code, sticker_code, status, title,
                  relisted_from_lot_id, intake_bin_id, intake_at, auction_id,
                  bid_count, created_at)
VALUES
  ('e0000000-0000-0000-0000-0000000000d0', 'e0000000-0000-0000-0000-000000000001',
   'e0000000-0000-0000-0000-000000000002', 'TWN5550000', NULL, 'canceled', 'stickered box',
   NULL, 'e0000000-0000-0000-0000-0000000000b1', TIMESTAMPTZ '2026-05-28 11:00:00Z',
   NULL, 0, TIMESTAMPTZ '2026-05-25Z'),
  ('e0000000-0000-0000-0000-0000000000d1', 'e0000000-0000-0000-0000-000000000001',
   'e0000000-0000-0000-0000-000000000002', 'TWN-005001', NULL, 'in_inventory', 'stickered box',
   'e0000000-0000-0000-0000-0000000000d0', 'e0000000-0000-0000-0000-0000000000b1',
   TIMESTAMPTZ '2026-05-28 11:00:00Z', NULL, 0, TIMESTAMPTZ '2026-07-15 13:48:52Z'),
  ('e0000000-0000-0000-0000-0000000000d2', 'e0000000-0000-0000-0000-000000000001',
   'e0000000-0000-0000-0000-000000000002', 'TWN-005002', 'BIN:TWN5550000', 'in_inventory',
   'stickered box', 'e0000000-0000-0000-0000-0000000000d0',
   'e0000000-0000-0000-0000-0000000000b1', TIMESTAMPTZ '2026-05-28 11:00:00Z', NULL, 0,
   TIMESTAMPTZ '2026-07-15 13:50:09Z');

-- ── Tangle E: three clicks, one box — plus a fourth row that is the same
--    product in the same bin but a DIFFERENT box (its own intake_at), which
--    must not be swept up with the clone group.
INSERT INTO lots (id, operator_id, warehouse_id, lot_code, status, title,
                  relisted_from_lot_id, intake_bin_id, intake_at, auction_id,
                  bid_count, created_at)
VALUES
  ('e0000000-0000-0000-0000-0000000000e0', 'e0000000-0000-0000-0000-000000000001',
   'e0000000-0000-0000-0000-000000000002', 'TWN6660000', 'canceled', 'vanity',
   NULL, 'e0000000-0000-0000-0000-0000000000b1', TIMESTAMPTZ '2026-05-28 20:42:50.072032Z',
   NULL, 0, TIMESTAMPTZ '2026-05-25Z'),
  ('e0000000-0000-0000-0000-0000000000e1', 'e0000000-0000-0000-0000-000000000001',
   'e0000000-0000-0000-0000-000000000002', 'TWN-006001', 'in_inventory', 'vanity',
   'e0000000-0000-0000-0000-0000000000e0', 'e0000000-0000-0000-0000-0000000000b1',
   TIMESTAMPTZ '2026-05-28 20:42:50.072032Z', NULL, 0, TIMESTAMPTZ '2026-07-15 13:48:52Z'),
  ('e0000000-0000-0000-0000-0000000000e2', 'e0000000-0000-0000-0000-000000000001',
   'e0000000-0000-0000-0000-000000000002', 'TWN-006002', 'in_inventory', 'vanity',
   'e0000000-0000-0000-0000-0000000000e0', 'e0000000-0000-0000-0000-0000000000b1',
   TIMESTAMPTZ '2026-05-28 20:42:50.072032Z', NULL, 0, TIMESTAMPTZ '2026-07-15 13:50:09Z'),
  ('e0000000-0000-0000-0000-0000000000e3', 'e0000000-0000-0000-0000-000000000001',
   'e0000000-0000-0000-0000-000000000002', 'TWN-006003', 'in_inventory', 'vanity',
   'e0000000-0000-0000-0000-0000000000e0', 'e0000000-0000-0000-0000-0000000000b1',
   TIMESTAMPTZ '2026-05-28 20:42:50.072032Z', NULL, 0, TIMESTAMPTZ '2026-07-15 13:51:50Z'),
  -- same product, same bin, same parent — but a second physical box, put away
  -- at its own moment. Must survive.
  ('e0000000-0000-0000-0000-0000000000e4', 'e0000000-0000-0000-0000-000000000001',
   'e0000000-0000-0000-0000-000000000002', 'TWN-006004', 'in_inventory', 'vanity',
   'e0000000-0000-0000-0000-0000000000e0', 'e0000000-0000-0000-0000-0000000000b1',
   TIMESTAMPTZ '2026-06-02 08:15:00Z', NULL, 0, TIMESTAMPTZ '2026-07-15 13:52:00Z');

-- ── Tangle F: twins where the newer row carries BIDS. Inertness still rules.
INSERT INTO lots (id, operator_id, warehouse_id, lot_code, status, title,
                  relisted_from_lot_id, intake_bin_id, intake_at, auction_id,
                  bid_count, created_at)
VALUES
  ('e0000000-0000-0000-0000-0000000000f0', 'e0000000-0000-0000-0000-000000000001',
   'e0000000-0000-0000-0000-000000000002', 'TWN7770000', 'canceled', 'bidded box',
   NULL, 'e0000000-0000-0000-0000-0000000000b1', TIMESTAMPTZ '2026-05-28 12:00:00Z',
   NULL, 0, TIMESTAMPTZ '2026-05-25Z'),
  ('e0000000-0000-0000-0000-0000000000f1', 'e0000000-0000-0000-0000-000000000001',
   'e0000000-0000-0000-0000-000000000002', 'TWN-007001', 'in_inventory', 'bidded box',
   'e0000000-0000-0000-0000-0000000000f0', 'e0000000-0000-0000-0000-0000000000b1',
   TIMESTAMPTZ '2026-05-28 12:00:00Z', NULL, 0, TIMESTAMPTZ '2026-07-15 13:48:52Z'),
  ('e0000000-0000-0000-0000-0000000000f2', 'e0000000-0000-0000-0000-000000000001',
   'e0000000-0000-0000-0000-000000000002', 'TWN-007002', 'in_inventory', 'bidded box',
   'e0000000-0000-0000-0000-0000000000f0', 'e0000000-0000-0000-0000-0000000000b1',
   TIMESTAMPTZ '2026-05-28 12:00:00Z', NULL, 3, TIMESTAMPTZ '2026-07-15 13:50:09Z');

-- ---------------------------------------------------------------------------
-- 1. The sweep retires exactly the newer clones: A's second row, and E's two
--    later clicks. Six other in_inventory rows are left alone.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_n INT;
BEGIN
  v_n := public.retire_duplicate_relist_twins();
  ASSERT v_n = 3, format('expected 3 twins retired, got %s', v_n);

  ASSERT (SELECT status FROM lots WHERE id='e0000000-0000-0000-0000-0000000000a2') = 'canceled',
    'the newer twin of tangle A was not cancelled';
  ASSERT (SELECT canceled_at FROM lots WHERE id='e0000000-0000-0000-0000-0000000000a2') IS NOT NULL,
    'canceled_at not stamped — violates the 0290 cancel-stamp invariant';
  ASSERT (SELECT canceled_by FROM lots WHERE id='e0000000-0000-0000-0000-0000000000a2') IS NULL,
    'canceled_by should stay NULL — a migration is not a user (0290 precedent)';
END $$;

-- ---------------------------------------------------------------------------
-- 2. The oldest of every clone group survives. This is the whole safety
--    argument: with no auctioned sibling to fall back on, the survivor is the
--    only thing keeping the item in inventory.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  ASSERT (SELECT status FROM lots WHERE id='e0000000-0000-0000-0000-0000000000a1') = 'in_inventory',
    'cancelled the OLDEST twin — the item has no surviving record';
  ASSERT (SELECT intake_bin_id FROM lots WHERE id='e0000000-0000-0000-0000-0000000000a1') IS NOT NULL,
    'the surviving twin lost its bin — staff can no longer find the box';
  ASSERT (SELECT status FROM lots WHERE id='e0000000-0000-0000-0000-0000000000e1') = 'in_inventory',
    'three-way group: cancelled the oldest instead of keeping it';
  ASSERT (SELECT count(*) FROM lots
           WHERE relisted_from_lot_id='e0000000-0000-0000-0000-0000000000e0'
             AND status = 'in_inventory') = 2,
    'three-way group should leave the oldest clone plus the separate second box';
END $$;

-- ---------------------------------------------------------------------------
-- 3. Everything that must NOT be touched. Tangle C is the one that matters:
--    duplicate_lot (0299) exists to create identical in_inventory siblings for
--    two real boxes, and only the missing lineage and the differing intake_at
--    separate them from a clone pair.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  ASSERT (SELECT status FROM lots WHERE id='e0000000-0000-0000-0000-0000000000c0') = 'in_inventory',
    'cancelled a duplicate_lot row — that is a second physical box';
  ASSERT (SELECT status FROM lots WHERE id='e0000000-0000-0000-0000-0000000000c1') = 'in_inventory',
    'cancelled a duplicate_lot row — that is a second physical box';
  ASSERT (SELECT status FROM lots WHERE id='e0000000-0000-0000-0000-0000000000e4') = 'in_inventory',
    'cancelled a same-product sibling that has its own intake_at (a real box)';
  ASSERT (SELECT status FROM lots WHERE id='e0000000-0000-0000-0000-0000000000b2') = 'in_inventory',
    'cancelled the LAST row standing — the item would vanish from inventory';
  ASSERT (SELECT status FROM lots WHERE id='e0000000-0000-0000-0000-0000000000d2') = 'in_inventory',
    'cancelled a sticker-bound row — the sticker is a claim on the box';
  ASSERT (SELECT status FROM lots WHERE id='e0000000-0000-0000-0000-0000000000d1') = 'in_inventory',
    'cancelled the older twin because its newer sibling was skipped';
  ASSERT (SELECT status FROM lots WHERE id='e0000000-0000-0000-0000-0000000000f2') = 'in_inventory',
    'cancelled an in_inventory row that carries bids';
END $$;

-- ---------------------------------------------------------------------------
-- 4. Targeting one lineage, and idempotency.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_n INT;
BEGIN
  v_n := public.retire_duplicate_relist_twins();
  ASSERT v_n = 0, format('second sweep should be a no-op, retired %s', v_n);

  v_n := public.retire_duplicate_relist_twins('TWN4111111');
  ASSERT v_n = 0, format('lone child must never be retired when targeted, got %s', v_n);

  v_n := public.retire_duplicate_relist_twins('TWN5550000');
  ASSERT v_n = 0, format('sticker-bound twin must not be retired, got %s', v_n);
END $$;

-- ---------------------------------------------------------------------------
-- 5. The audit shows the tail that phantom_relist_child_audit structurally
--    cannot: none of these lineages has an auctioned sibling, so that function
--    reports nothing here at all.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_rows INT; v_group BIGINT; v_oldest BOOLEAN;
BEGIN
  SELECT count(*) INTO v_rows FROM public.phantom_relist_child_audit();
  ASSERT v_rows = 0,
    format('no lineage here holds an auction; 0306 audit should be empty, got %s', v_rows);

  -- survivors only: A's older twin, B's lone child, D's pair, E's oldest clone
  -- and E's separate box, F's pair. C carries no lineage and is not a child.
  SELECT count(*) INTO v_rows FROM public.unanchored_relist_child_audit();
  ASSERT v_rows = 7, format('expected 7 unanchored children after the sweep, got %s', v_rows);

  SELECT clone_group, is_oldest INTO v_group, v_oldest
    FROM public.unanchored_relist_child_audit() WHERE child_code = 'TWN-009999';
  ASSERT v_group = 1 AND v_oldest,
    'the lone child should read as clone_group 1 / is_oldest — never cancel it';

  -- the sticker-bound pair is the one case the repair leaves behind, so the
  -- audit has to keep showing it as an unresolved duplicate
  SELECT clone_group, is_oldest INTO v_group, v_oldest
    FROM public.unanchored_relist_child_audit() WHERE child_code = 'TWN-005002';
  ASSERT v_group = 2 AND NOT v_oldest,
    'the skipped sticker-bound twin must still report as a duplicate';
END $$;

ROLLBACK;

\echo 'duplicate_relist_twin.sql: OK'
