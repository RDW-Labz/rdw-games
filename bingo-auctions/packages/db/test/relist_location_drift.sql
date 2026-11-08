-- Behavioural test for mig 0305's relist location repair.
-- Plain-psql assertions, no pgTAP (matches lineage_assign_guard.sql).
--
-- Field report 2026-07-31: two customers were sent to the shelf the operator
-- console's "CARRIED OVER" banner named, and the box was not there. It was in
-- the bin the banner calls "last known on this record" — the ANCESTOR's.
--
-- relist_lot_into_auction COPIES intake_at + intake_bin_id onto the child, so
-- both rows agree at relist time. Then staff put the box away and scan its
-- label — and until 0304 the resolvers probed lot_code before sticker_code, so
-- the scan matched the retired ANCESTOR and confirm_move_lot_to_bin wrote the
-- new bin there. The child kept its relist-time copy forever.
--
-- The direction of the repair is the whole risk here: copying the WRONG side
-- would send staff to a shelf the item was never on. The predicate that decides
-- it is `ancestor.intake_at > child.created_at AND > child.intake_at` — the
-- ancestor's location is a physical event that happened after the child
-- existed, the child's is an untouched copy. So the fixtures pin both
-- directions: a drifted pair must be repaired, and a child that was itself
-- re-binned more recently must be left completely alone.
--
-- Also pins idempotency (a second run is a no-op, not a re-copy) and that the
-- audit view agrees with the repair.
--
-- Runs against the migrated-but-empty CI database, inside a transaction that is
-- ROLLED BACK, so the DB is left untouched.

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
INSERT INTO operators (id, slug, business_name, contact_email, code)
VALUES ('c0000000-0000-0000-0000-000000000001', 'drifttest', 'Drift Test Co',
        'drift@example.com', 'DFT');

INSERT INTO warehouses (id, operator_id, name, address_line1, city, state, postal_code)
VALUES ('c0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000001',
        'DFT WH', '1 Drift St', 'Harrison', 'AR', '72601');

-- Two bins: the stale relist-time copy, and where the box actually is.
INSERT INTO bins (id, warehouse_id, code, aisle, bay, x_px, y_px, qr_token) VALUES
  ('c0000000-0000-0000-0000-0000000000b1', 'c0000000-0000-0000-0000-000000000002',
   '5-06-02', '5', '06', 0, 0, 'c0000000-0000-0000-0000-0000000000c1'),
  ('c0000000-0000-0000-0000-0000000000b2', 'c0000000-0000-0000-0000-000000000002',
   '8-03-02', '8', '03', 0, 0, 'c0000000-0000-0000-0000-0000000000c2');

-- ── Pair 1: DRIFTED. Modelled on BRN4374076 / BIN-002059 exactly.
--    Child minted 07-14 15:58 carrying the source's then-current bin 5-06-02
--    (intake_at 05-28, inherited). Ancestor re-binned to 8-03-02 at 07-14
--    16:50 — 52 minutes after the relist — by a scan that hit the tombstone.
INSERT INTO lots (id, operator_id, warehouse_id, lot_code, status, title,
                  sticker_code, relisted_from_lot_id, intake_bin_id, intake_at, created_at)
VALUES
  ('c0000000-0000-0000-0000-0000000000a1', 'c0000000-0000-0000-0000-000000000001',
   'c0000000-0000-0000-0000-000000000002', 'BRN111', 'relisted', 'ancestor drifted',
   NULL, NULL, 'c0000000-0000-0000-0000-0000000000b2',
   TIMESTAMPTZ '2026-07-14 16:50:03Z', TIMESTAMPTZ '2026-05-25 03:27:09Z'),
  ('c0000000-0000-0000-0000-0000000000a2', 'c0000000-0000-0000-0000-000000000001',
   'c0000000-0000-0000-0000-000000000002', 'DFT-000001', 'won', 'child drifted',
   'DFT:BRN111', 'c0000000-0000-0000-0000-0000000000a1', 'c0000000-0000-0000-0000-0000000000b1',
   TIMESTAMPTZ '2026-05-28 16:20:09Z', TIMESTAMPTZ '2026-07-14 15:58:16Z');

-- ── Pair 2: NOT drifted — the CHILD was re-binned more recently. Repairing
--    this one would move the box backwards to a shelf it has left.
INSERT INTO lots (id, operator_id, warehouse_id, lot_code, status, title,
                  sticker_code, relisted_from_lot_id, intake_bin_id, intake_at, created_at)
VALUES
  ('c0000000-0000-0000-0000-0000000000a3', 'c0000000-0000-0000-0000-000000000001',
   'c0000000-0000-0000-0000-000000000002', 'BRN222', 'relisted', 'ancestor stale',
   NULL, NULL, 'c0000000-0000-0000-0000-0000000000b2',
   TIMESTAMPTZ '2026-07-14 16:50:03Z', TIMESTAMPTZ '2026-05-25 03:27:09Z'),
  ('c0000000-0000-0000-0000-0000000000a4', 'c0000000-0000-0000-0000-000000000001',
   'c0000000-0000-0000-0000-000000000002', 'DFT-000002', 'won', 'child rebinned later',
   'DFT:BRN222', 'c0000000-0000-0000-0000-0000000000a3', 'c0000000-0000-0000-0000-0000000000b1',
   TIMESTAMPTZ '2026-07-20 09:00:00Z', TIMESTAMPTZ '2026-07-14 15:58:16Z');

-- ── Pair 3: ancestor is NOT a tombstone (canceled, not relisted). 0305
--    deliberately leaves these — on prod they are one four-way relist tangle
--    that needs a human, not a blanket copy.
INSERT INTO lots (id, operator_id, warehouse_id, lot_code, status, title,
                  sticker_code, relisted_from_lot_id, intake_bin_id, intake_at, created_at)
VALUES
  ('c0000000-0000-0000-0000-0000000000a5', 'c0000000-0000-0000-0000-000000000001',
   'c0000000-0000-0000-0000-000000000002', 'BRN333', 'canceled', 'ancestor canceled',
   NULL, NULL, 'c0000000-0000-0000-0000-0000000000b2',
   TIMESTAMPTZ '2026-07-15 19:52:17Z', TIMESTAMPTZ '2026-05-25 03:27:09Z'),
  ('c0000000-0000-0000-0000-0000000000a6', 'c0000000-0000-0000-0000-000000000001',
   'c0000000-0000-0000-0000-000000000002', 'DFT-000003', 'in_inventory', 'child of canceled',
   'DFT:BRN333', 'c0000000-0000-0000-0000-0000000000a5', 'c0000000-0000-0000-0000-0000000000b1',
   TIMESTAMPTZ '2026-05-28 19:41:38Z', TIMESTAMPTZ '2026-07-14 15:58:16Z');

-- ---------------------------------------------------------------------------
-- 1. The audit sees both drift shapes (tombstone and canceled ancestor) and
--    does NOT flag the pair whose child is the more recently binned one.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_rows INT;
BEGIN
  SELECT count(*) INTO v_rows FROM public.relist_location_drift_audit();
  ASSERT v_rows = 2, format('audit: expected 2 drifted pairs, got %s', v_rows);

  ASSERT NOT EXISTS (
    SELECT 1 FROM public.relist_location_drift_audit() WHERE child_code = 'DFT-000002'
  ), 'audit: flagged a child that was re-binned more recently than its ancestor';

  ASSERT (SELECT ancestor_bin FROM public.relist_location_drift_audit()
           WHERE child_code = 'DFT-000001') = '8-03-02',
    'audit: reported the wrong ancestor bin';
END $$;

-- ---------------------------------------------------------------------------
-- 2. The repair moves the location onto the child — and carries the real
--    put-away time, not now(), so age-in-inventory stays truthful.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_fixed INT;
BEGIN
  v_fixed := public.repair_relist_location_drift();
  ASSERT v_fixed = 1, format('repair: expected 1 lot repaired, got %s', v_fixed);

  ASSERT (SELECT intake_bin_id FROM lots WHERE id = 'c0000000-0000-0000-0000-0000000000a2')
         = 'c0000000-0000-0000-0000-0000000000b2',
    'repair: the child did not get the ancestor''s bin';
  ASSERT (SELECT intake_at FROM lots WHERE id = 'c0000000-0000-0000-0000-0000000000a2')
         = TIMESTAMPTZ '2026-07-14 16:50:03Z',
    'repair: intake_at should be the real put-away time, not now()';
END $$;

-- ---------------------------------------------------------------------------
-- 3. The pairs that must NOT move, did not. This is the direction that would
--    send staff to the wrong shelf if the predicate ever loosened.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  ASSERT (SELECT intake_bin_id FROM lots WHERE id = 'c0000000-0000-0000-0000-0000000000a4')
         = 'c0000000-0000-0000-0000-0000000000b1',
    'repair: moved a child that had been re-binned more recently';
  ASSERT (SELECT intake_at FROM lots WHERE id = 'c0000000-0000-0000-0000-0000000000a4')
         = TIMESTAMPTZ '2026-07-20 09:00:00Z',
    'repair: clobbered a newer intake_at';

  ASSERT (SELECT intake_bin_id FROM lots WHERE id = 'c0000000-0000-0000-0000-0000000000a6')
         = 'c0000000-0000-0000-0000-0000000000b1',
    'repair: touched a child whose ancestor is not a relisted tombstone';
END $$;

-- ---------------------------------------------------------------------------
-- 4. Idempotent: a second run is a no-op, and the repaired pair leaves the
--    audit (the canceled-ancestor pair stays, by design).
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_again INT; v_rows INT;
BEGIN
  v_again := public.repair_relist_location_drift();
  ASSERT v_again = 0, format('repair: second run should be a no-op, repaired %s', v_again);

  SELECT count(*) INTO v_rows FROM public.relist_location_drift_audit();
  ASSERT v_rows = 1, format('audit: expected only the canceled-ancestor pair left, got %s', v_rows);
  ASSERT (SELECT child_code FROM public.relist_location_drift_audit()) = 'DFT-000003',
    'audit: the wrong pair survived the repair';
END $$;

ROLLBACK;

\echo 'relist_location_drift.sql: OK'
