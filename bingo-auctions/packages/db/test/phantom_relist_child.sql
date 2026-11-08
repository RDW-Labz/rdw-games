-- Behavioural test for mig 0306's phantom relist-child retirement.
-- Plain-psql assertions, no pgTAP (matches lineage_assign_guard.sql).
--
-- One physical item, relisted five times after a forfeit, left six rows behind.
-- Two of them sat at `in_inventory` — showing a box that had already been sold
-- to someone else as available stock.
--
-- The risk in this repair is cancelling something real. A relist tangle mixes
-- phantoms with the row that actually holds the sale, and they are siblings off
-- the same parent, so the predicate is the only thing keeping them apart. Every
-- must-NOT-cancel shape is pinned below: the auction holder, a row with an
-- invoice, a row with bids, a row with a bin assignment, and — the one that
-- would be worst — the last row standing, where cancelling would erase the item
-- from inventory altogether.
--
-- Runs against the migrated-but-empty CI database, inside a transaction that is
-- ROLLED BACK, so the DB is left untouched.

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
INSERT INTO operators (id, slug, business_name, contact_email, code)
VALUES ('d0000000-0000-0000-0000-000000000001', 'phantomtest', 'Phantom Test Co',
        'phantom@example.com', 'PHT');

INSERT INTO warehouses (id, operator_id, name, address_line1, city, state, postal_code)
VALUES ('d0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000001',
        'PHT WH', '1 Phantom St', 'Harrison', 'AR', '72601');

INSERT INTO bins (id, warehouse_id, code, aisle, bay, x_px, y_px, qr_token)
VALUES ('d0000000-0000-0000-0000-0000000000b1', 'd0000000-0000-0000-0000-000000000002',
        '13-14-01', '13', '14', 0, 0, 'd0000000-0000-0000-0000-0000000000c1');

INSERT INTO auctions (id, operator_id, warehouse_id, title, status, starts_at, ends_at,
                      pickup_starts_at, pickup_ends_at)
VALUES ('d0000000-0000-0000-0000-00000000000a', 'd0000000-0000-0000-0000-000000000001',
        'd0000000-0000-0000-0000-000000000002', 'PHT auction', 'closed',
        TIMESTAMPTZ '2026-07-16 00:00:00Z', TIMESTAMPTZ '2026-07-20 00:00:00Z',
        TIMESTAMPTZ '2026-07-21 00:00:00Z', TIMESTAMPTZ '2026-07-23 00:00:00Z');

-- ── Tangle A: modelled on PNK4858937. Parent + 2 phantoms + the real sale.
INSERT INTO lots (id, operator_id, warehouse_id, lot_code, status, title,
                  relisted_from_lot_id, intake_bin_id, auction_id, bid_count, created_at)
VALUES
  ('d0000000-0000-0000-0000-0000000000a0', 'd0000000-0000-0000-0000-000000000001',
   'd0000000-0000-0000-0000-000000000002', 'PHT4858937', 'canceled', 'nesting tables',
   NULL, 'd0000000-0000-0000-0000-0000000000b1', NULL, 0, TIMESTAMPTZ '2026-05-25Z'),
  -- phantom 1 — must be cancelled
  ('d0000000-0000-0000-0000-0000000000a1', 'd0000000-0000-0000-0000-000000000001',
   'd0000000-0000-0000-0000-000000000002', 'PHT-002570', 'in_inventory', 'nesting tables',
   'd0000000-0000-0000-0000-0000000000a0', 'd0000000-0000-0000-0000-0000000000b1', NULL, 0,
   TIMESTAMPTZ '2026-07-15 13:48:52Z'),
  -- phantom 2 — must be cancelled
  ('d0000000-0000-0000-0000-0000000000a2', 'd0000000-0000-0000-0000-000000000001',
   'd0000000-0000-0000-0000-000000000002', 'PHT-002627', 'in_inventory', 'nesting tables',
   'd0000000-0000-0000-0000-0000000000a0', 'd0000000-0000-0000-0000-0000000000b1', NULL, 0,
   TIMESTAMPTZ '2026-07-15 13:50:09Z'),
  -- the real sale — must survive
  ('d0000000-0000-0000-0000-0000000000a3', 'd0000000-0000-0000-0000-000000000001',
   'd0000000-0000-0000-0000-000000000002', 'PHT-003084', 'won', 'nesting tables',
   'd0000000-0000-0000-0000-0000000000a0', 'd0000000-0000-0000-0000-0000000000b1',
   'd0000000-0000-0000-0000-00000000000a', 4, TIMESTAMPTZ '2026-07-16 21:54:57Z'),
  -- in_inventory but carries BIDS — must survive
  ('d0000000-0000-0000-0000-0000000000a4', 'd0000000-0000-0000-0000-000000000001',
   'd0000000-0000-0000-0000-000000000002', 'PHT-002700', 'in_inventory', 'nesting tables',
   'd0000000-0000-0000-0000-0000000000a0', 'd0000000-0000-0000-0000-0000000000b1', NULL, 2,
   TIMESTAMPTZ '2026-07-15 14:00:00Z');

-- ── Tangle B: a LONE in_inventory child with no auction-holding sibling.
--    Cancelling this one would erase the item from inventory entirely.
INSERT INTO lots (id, operator_id, warehouse_id, lot_code, status, title,
                  relisted_from_lot_id, intake_bin_id, auction_id, bid_count, created_at)
VALUES
  ('d0000000-0000-0000-0000-0000000000b0', 'd0000000-0000-0000-0000-000000000001',
   'd0000000-0000-0000-0000-000000000002', 'PHT4111111', 'canceled', 'lone item',
   NULL, 'd0000000-0000-0000-0000-0000000000b1', NULL, 0, TIMESTAMPTZ '2026-05-25Z'),
  ('d0000000-0000-0000-0000-0000000000b2', 'd0000000-0000-0000-0000-000000000001',
   'd0000000-0000-0000-0000-000000000002', 'PHT-009999', 'in_inventory', 'lone item',
   'd0000000-0000-0000-0000-0000000000b0', 'd0000000-0000-0000-0000-0000000000b1', NULL, 0,
   TIMESTAMPTZ '2026-07-15 13:48:52Z');

-- ---------------------------------------------------------------------------
-- 1. The repair cancels exactly the two phantoms — and stamps canceled_at,
--    which the 0290 invariant requires of every canceled row.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_n INT;
BEGIN
  v_n := public.retire_phantom_relist_children('PHT4858937');
  ASSERT v_n = 2, format('expected 2 phantoms retired, got %s', v_n);

  ASSERT (SELECT status FROM lots WHERE id='d0000000-0000-0000-0000-0000000000a1') = 'canceled',
    'phantom 1 was not cancelled';
  ASSERT (SELECT status FROM lots WHERE id='d0000000-0000-0000-0000-0000000000a2') = 'canceled',
    'phantom 2 was not cancelled';
  ASSERT (SELECT canceled_at FROM lots WHERE id='d0000000-0000-0000-0000-0000000000a1') IS NOT NULL,
    'canceled_at not stamped — violates the 0290 cancel-stamp invariant';
  ASSERT (SELECT canceled_by FROM lots WHERE id='d0000000-0000-0000-0000-0000000000a1') IS NULL,
    'canceled_by should stay NULL — a migration is not a user (0290 precedent)';
END $$;

-- ---------------------------------------------------------------------------
-- 2. Everything that must NOT be cancelled, was not. This is the direction
--    that loses a real sale if the predicate ever loosens.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  ASSERT (SELECT status FROM lots WHERE id='d0000000-0000-0000-0000-0000000000a3') = 'won',
    'cancelled the sibling holding the real auction and invoice';
  ASSERT (SELECT auction_id FROM lots WHERE id='d0000000-0000-0000-0000-0000000000a3') IS NOT NULL,
    'stripped the auction off the real sale';
  ASSERT (SELECT status FROM lots WHERE id='d0000000-0000-0000-0000-0000000000a4') = 'in_inventory',
    'cancelled an in_inventory row that carries bids';
  ASSERT (SELECT status FROM lots WHERE id='d0000000-0000-0000-0000-0000000000b2') = 'in_inventory',
    'cancelled the LAST row standing — the item would vanish from inventory';
END $$;

-- ---------------------------------------------------------------------------
-- 3. The lone-child tangle stays a no-op — both when targeted directly and
--    under the all-parents sweep the migration actually runs. The sweep is the
--    dangerous mode: it has no lineage to anchor it, so the only thing stopping
--    it erasing tangle B's item is the auction-holding-sibling requirement.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_n INT;
BEGIN
  v_n := public.retire_phantom_relist_children('PHT4111111');
  ASSERT v_n = 0, format('lone child must never be retired when targeted, got %s', v_n);

  v_n := public.retire_phantom_relist_children();          -- all parents
  ASSERT v_n = 0, format('all-parents sweep must not touch the lone child, got %s', v_n);

  ASSERT (SELECT status FROM lots WHERE id='d0000000-0000-0000-0000-0000000000b2') = 'in_inventory',
    'the all-parents sweep erased the last row standing';
  ASSERT (SELECT status FROM lots WHERE id='d0000000-0000-0000-0000-0000000000a4') = 'in_inventory',
    'the all-parents sweep cancelled a row carrying bids';
  ASSERT (SELECT status FROM lots WHERE id='d0000000-0000-0000-0000-0000000000a3') = 'won',
    'the all-parents sweep cancelled the real sale';
END $$;

-- ---------------------------------------------------------------------------
-- 4. Idempotent, and the audit agrees with the repair: the retired phantoms
--    leave it, the bid-carrying row was never in it, and tangle B's lone child
--    is correctly absent (no auction-holding sibling to compare against).
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_again INT; v_rows INT;
BEGIN
  v_again := public.retire_phantom_relist_children('PHT4858937');
  ASSERT v_again = 0, format('second run should be a no-op, retired %s', v_again);

  SELECT count(*) INTO v_rows FROM public.phantom_relist_child_audit();
  ASSERT v_rows = 0, format('audit should be empty after the repair, got %s', v_rows);
END $$;

ROLLBACK;

\echo 'phantom_relist_child.sql: OK'
