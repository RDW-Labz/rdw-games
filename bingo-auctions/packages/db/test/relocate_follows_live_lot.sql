-- Behavioural test for mig 0311 — "Move here" follows the live lot.
-- Plain-psql assertions, no pgTAP (matches relist_location_drift.sql).
--
-- Field report 2026-08-03: relisted items still not in the bin the app names.
-- Staff found them by opening the OLD record, whose page labels its bin
-- "Location (last known on this record)".
--
-- Two halves, and the fixtures pin both:
--
--   1. audit_relocate_lot redirects a location write aimed at a retired
--      tombstone onto its one live successor. This is what stops new drift.
--      Redirect ONLY on exactly one live successor — zero or several means we
--      cannot know which row holds the box, and guessing is how the drift
--      started.
--   2. repair_relist_location_drift_v2 fixes children already stranded by that
--      path. 0305 could not see them: it keys on `intake_at`, and the
--      relocate path deliberately does not stamp it.
--
-- The DIRECTION is the whole risk, exactly as in 0305 — copying the wrong side
-- sends staff to a shelf the box was never on. Every fixture that must NOT
-- move is pinned as hard as the one that must.
--
-- Runs against the migrated-but-empty CI database, inside a transaction that is
-- ROLLED BACK, so the DB is left untouched.

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
INSERT INTO operators (id, slug, business_name, contact_email, code)
VALUES ('d0000000-0000-0000-0000-000000000001', 'reloctest', 'Reloc Test Co',
        'reloc@example.com', 'RLC');

INSERT INTO warehouses (id, operator_id, name, address_line1, city, state, postal_code)
VALUES ('d0000000-0000-0000-0000-000000000002', 'd0000000-0000-0000-0000-000000000001',
        'RLC WH', '1 Reloc St', 'Harrison', 'AR', '72601');

INSERT INTO bins (id, warehouse_id, code, aisle, bay, x_px, y_px, qr_token) VALUES
  ('d0000000-0000-0000-0000-0000000000b1', 'd0000000-0000-0000-0000-000000000002',
   '5-06-02', '5', '06', 0, 0, 'd0000000-0000-0000-0000-0000000000c1'),
  ('d0000000-0000-0000-0000-0000000000b2', 'd0000000-0000-0000-0000-000000000002',
   '8-03-02', '8', '03', 0, 0, 'd0000000-0000-0000-0000-0000000000c2'),
  ('d0000000-0000-0000-0000-0000000000b3', 'd0000000-0000-0000-0000-000000000002',
   '9-01-01', '9', '01', 0, 0, 'd0000000-0000-0000-0000-0000000000c3');

-- ===========================================================================
-- PART 1 — the repair
-- ===========================================================================

-- ── Pair A: STRANDED by the relocate path. intake_at identical on both rows
--    (no scan put-away since the relist), and the tombstone was written after
--    the child was born — the "Move here" fingerprint. Must be repaired.
INSERT INTO lots (id, operator_id, warehouse_id, lot_code, status, title,
                  sticker_code, relisted_from_lot_id, intake_bin_id, intake_at,
                  created_at, updated_at)
VALUES
  ('d0000000-0000-0000-0000-0000000000a1', 'd0000000-0000-0000-0000-000000000001',
   'd0000000-0000-0000-0000-000000000002', 'RLC111', 'relisted', 'ancestor moved',
   NULL, NULL, 'd0000000-0000-0000-0000-0000000000b2',
   TIMESTAMPTZ '2026-05-28 16:20:09Z',
   TIMESTAMPTZ '2026-05-25 03:27:09Z', TIMESTAMPTZ '2026-07-23 18:15:00Z'),
  ('d0000000-0000-0000-0000-0000000000a2', 'd0000000-0000-0000-0000-000000000001',
   'd0000000-0000-0000-0000-000000000002', 'RLC-000001', 'won', 'child stranded',
   'RLC:RLC111', 'd0000000-0000-0000-0000-0000000000a1', 'd0000000-0000-0000-0000-0000000000b1',
   TIMESTAMPTZ '2026-05-28 16:20:09Z',
   TIMESTAMPTZ '2026-07-14 15:58:16Z', TIMESTAMPTZ '2026-07-14 15:58:16Z');

-- ── Pair B: the CHILD was scan-binned more recently (intake_at differs).
--    The child is the correct row; repairing would move the box backwards.
INSERT INTO lots (id, operator_id, warehouse_id, lot_code, status, title,
                  sticker_code, relisted_from_lot_id, intake_bin_id, intake_at,
                  created_at, updated_at)
VALUES
  ('d0000000-0000-0000-0000-0000000000a3', 'd0000000-0000-0000-0000-000000000001',
   'd0000000-0000-0000-0000-000000000002', 'RLC222', 'relisted', 'ancestor stale',
   NULL, NULL, 'd0000000-0000-0000-0000-0000000000b2',
   TIMESTAMPTZ '2026-05-28 16:20:09Z',
   TIMESTAMPTZ '2026-05-25 03:27:09Z', TIMESTAMPTZ '2026-07-23 18:15:00Z'),
  ('d0000000-0000-0000-0000-0000000000a4', 'd0000000-0000-0000-0000-000000000001',
   'd0000000-0000-0000-0000-000000000002', 'RLC-000002', 'won', 'child rebinned later',
   'RLC:RLC222', 'd0000000-0000-0000-0000-0000000000a3', 'd0000000-0000-0000-0000-0000000000b1',
   TIMESTAMPTZ '2026-07-20 09:00:00Z',
   TIMESTAMPTZ '2026-07-14 15:58:16Z', TIMESTAMPTZ '2026-07-20 09:00:00Z');

-- ── Pair C: tombstone never touched after the child was born. No evidence a
--    relocate happened at all, so there is nothing to conclude. Leave alone.
INSERT INTO lots (id, operator_id, warehouse_id, lot_code, status, title,
                  sticker_code, relisted_from_lot_id, intake_bin_id, intake_at,
                  created_at, updated_at)
VALUES
  ('d0000000-0000-0000-0000-0000000000a5', 'd0000000-0000-0000-0000-000000000001',
   'd0000000-0000-0000-0000-000000000002', 'RLC333', 'relisted', 'ancestor untouched',
   NULL, NULL, 'd0000000-0000-0000-0000-0000000000b2',
   TIMESTAMPTZ '2026-05-28 16:20:09Z',
   TIMESTAMPTZ '2026-05-25 03:27:09Z', TIMESTAMPTZ '2026-07-14 15:58:16Z'),
  ('d0000000-0000-0000-0000-0000000000a6', 'd0000000-0000-0000-0000-000000000001',
   'd0000000-0000-0000-0000-000000000002', 'RLC-000003', 'won', 'child of untouched',
   'RLC:RLC333', 'd0000000-0000-0000-0000-0000000000a5', 'd0000000-0000-0000-0000-0000000000b1',
   TIMESTAMPTZ '2026-05-28 16:20:09Z',
   TIMESTAMPTZ '2026-07-14 15:58:16Z', TIMESTAMPTZ '2026-07-14 15:58:16Z');

DO $$
DECLARE v_fixed INT;
BEGIN
  SELECT public.repair_relist_location_drift_v2() INTO v_fixed;
  ASSERT v_fixed = 1, format('repair: expected 1 row repaired, got %s', v_fixed);
END $$;

DO $$
BEGIN
  -- A moved onto the ancestor's bin…
  ASSERT (SELECT intake_bin_id FROM lots WHERE lot_code = 'RLC-000001')
         = 'd0000000-0000-0000-0000-0000000000b2',
    'repair: stranded child did not take the ancestor bin';
  -- …but its put-away time must NOT shift: neither row was re-put-away, so
  -- age-in-inventory has to stay where it was.
  ASSERT (SELECT intake_at FROM lots WHERE lot_code = 'RLC-000001')
         = TIMESTAMPTZ '2026-05-28 16:20:09Z',
    'repair: intake_at moved — age-in-inventory would be wrong';
  -- B and C untouched.
  ASSERT (SELECT intake_bin_id FROM lots WHERE lot_code = 'RLC-000002')
         = 'd0000000-0000-0000-0000-0000000000b1',
    'repair: moved a child that was itself re-binned more recently';
  ASSERT (SELECT intake_bin_id FROM lots WHERE lot_code = 'RLC-000003')
         = 'd0000000-0000-0000-0000-0000000000b1',
    'repair: moved a child whose ancestor was never relocated';
END $$;

-- Idempotent: the bins now agree, so a second run matches nothing.
DO $$
DECLARE v_again INT;
BEGIN
  SELECT public.repair_relist_location_drift_v2() INTO v_again;
  ASSERT v_again = 0, format('repair: second run should be a no-op, fixed %s', v_again);
END $$;

-- ===========================================================================
-- PART 1b — CHAINS (mig 0312)
--
-- Relist lineage is a chain, not a pair, and the repair propagates exactly one
-- generation per run. Applying 0311 to prod proved it: pass 1 fixed the 40 it
-- predicted and EXPOSED 6 more, pass 2 exposed 2 more, pass 3 converged.
--
-- Why the middle generation is invisible at first: a relocate on the root
-- writes the true bin there, and BOTH descendants keep the same relist-time
-- copy — so root-vs-parent disagree (detected) while parent-vs-child agree
-- (invisible). The child is just as wrong; nothing pairwise can see it until
-- the parent is fixed.
-- ===========================================================================

-- ── Chain D: root(relocated) -> mid(tombstone) -> leaf(live). All three share
--    one intake_at, so no scan touched any generation. The whole chain must
--    end up on the root's bin — and must take MORE than one pass to get there.
INSERT INTO lots (id, operator_id, warehouse_id, lot_code, status, title,
                  sticker_code, relisted_from_lot_id, intake_bin_id, intake_at,
                  created_at, updated_at)
VALUES
  -- root: someone tapped "Move here" on it, so it holds the true bin (8-03-02)
  ('d0000000-0000-0000-0000-0000000000d1', 'd0000000-0000-0000-0000-000000000001',
   'd0000000-0000-0000-0000-000000000002', 'RLC666', 'relisted', 'chain root',
   NULL, NULL, 'd0000000-0000-0000-0000-0000000000b2',
   TIMESTAMPTZ '2026-05-28 16:20:09Z',
   TIMESTAMPTZ '2026-05-25 03:27:09Z', TIMESTAMPTZ '2026-07-23 18:15:00Z'),
  -- mid + leaf: both still carry the stale relist-time copy (5-06-02), so they
  -- agree with each other and only mid is detectable on pass 1.
  ('d0000000-0000-0000-0000-0000000000d2', 'd0000000-0000-0000-0000-000000000001',
   'd0000000-0000-0000-0000-000000000002', 'RLC-000006', 'relisted', 'chain mid',
   NULL, 'd0000000-0000-0000-0000-0000000000d1', 'd0000000-0000-0000-0000-0000000000b1',
   TIMESTAMPTZ '2026-05-28 16:20:09Z',
   TIMESTAMPTZ '2026-07-14 15:58:16Z', TIMESTAMPTZ '2026-07-14 15:58:16Z'),
  ('d0000000-0000-0000-0000-0000000000d3', 'd0000000-0000-0000-0000-000000000001',
   'd0000000-0000-0000-0000-000000000002', 'RLC-000007', 'won', 'chain leaf',
   NULL, 'd0000000-0000-0000-0000-0000000000d2', 'd0000000-0000-0000-0000-0000000000b1',
   TIMESTAMPTZ '2026-05-28 16:20:09Z',
   TIMESTAMPTZ '2026-07-17 10:00:00Z', TIMESTAMPTZ '2026-07-17 10:00:00Z');

-- ── Chain E: same shape, but the leaf WAS scan-binned after the relist
--    (distinct intake_at). Propagation must stop at mid and leave the leaf —
--    a scan is a physical event and outranks an inherited copy.
INSERT INTO lots (id, operator_id, warehouse_id, lot_code, status, title,
                  sticker_code, relisted_from_lot_id, intake_bin_id, intake_at,
                  created_at, updated_at)
VALUES
  ('d0000000-0000-0000-0000-0000000000e1', 'd0000000-0000-0000-0000-000000000001',
   'd0000000-0000-0000-0000-000000000002', 'RLC777', 'relisted', 'chain2 root',
   NULL, NULL, 'd0000000-0000-0000-0000-0000000000b2',
   TIMESTAMPTZ '2026-05-28 16:20:09Z',
   TIMESTAMPTZ '2026-05-25 03:27:09Z', TIMESTAMPTZ '2026-07-23 18:15:00Z'),
  ('d0000000-0000-0000-0000-0000000000e2', 'd0000000-0000-0000-0000-000000000001',
   'd0000000-0000-0000-0000-000000000002', 'RLC-000008', 'relisted', 'chain2 mid',
   NULL, 'd0000000-0000-0000-0000-0000000000e1', 'd0000000-0000-0000-0000-0000000000b1',
   TIMESTAMPTZ '2026-05-28 16:20:09Z',
   TIMESTAMPTZ '2026-07-14 15:58:16Z', TIMESTAMPTZ '2026-07-14 15:58:16Z'),
  ('d0000000-0000-0000-0000-0000000000e3', 'd0000000-0000-0000-0000-000000000001',
   'd0000000-0000-0000-0000-000000000002', 'RLC-000009', 'won', 'chain2 leaf rescanned',
   NULL, 'd0000000-0000-0000-0000-0000000000e2', 'd0000000-0000-0000-0000-0000000000b3',
   TIMESTAMPTZ '2026-07-25 08:00:00Z',
   TIMESTAMPTZ '2026-07-17 10:00:00Z', TIMESTAMPTZ '2026-07-25 08:00:00Z');

-- One pass reaches only the middle generation — this is the 0311 gap, pinned.
DO $$
DECLARE v_pass1 INT;
BEGIN
  SELECT public.repair_relist_location_drift_v2() INTO v_pass1;
  ASSERT v_pass1 = 2, format('chain: pass 1 should reach 2 mids, got %s', v_pass1);
  ASSERT (SELECT intake_bin_id FROM lots WHERE lot_code = 'RLC-000006')
         = 'd0000000-0000-0000-0000-0000000000b2', 'chain: mid not repaired on pass 1';
  ASSERT (SELECT intake_bin_id FROM lots WHERE lot_code = 'RLC-000007')
         = 'd0000000-0000-0000-0000-0000000000b1',
    'chain: leaf moved on pass 1 — one pass cannot see past the middle generation';
END $$;

-- The fixpoint driver finishes the job in one call.
DO $$
DECLARE v_passes INT; v_rows INT;
BEGIN
  SELECT p.passes, p.rows_repaired INTO v_passes, v_rows
    FROM public.repair_relist_location_drift_to_fixpoint() p;

  ASSERT v_passes > 1, 'fixpoint: converged in one pass — the chain fixture is not biting';
  ASSERT v_rows = 1, format('fixpoint: expected 1 further row (chain D leaf), got %s', v_rows);

  -- Chain D fully propagated to the root's bin.
  ASSERT (SELECT intake_bin_id FROM lots WHERE lot_code = 'RLC-000007')
         = 'd0000000-0000-0000-0000-0000000000b2',
    'fixpoint: chain leaf did not reach the root bin';
  -- …without disturbing put-away time anywhere in the chain.
  ASSERT (SELECT intake_at FROM lots WHERE lot_code = 'RLC-000007')
         = TIMESTAMPTZ '2026-05-28 16:20:09Z',
    'fixpoint: chain leaf intake_at moved';
  -- Chain E stopped at the re-scanned leaf: a scan outranks an inherited copy.
  ASSERT (SELECT intake_bin_id FROM lots WHERE lot_code = 'RLC-000009')
         = 'd0000000-0000-0000-0000-0000000000b3',
    'fixpoint: propagated onto a leaf that had been scan-binned since the relist';
END $$;

-- Converged and stable — no oscillation between two rows claiming each other.
DO $$
DECLARE v_passes INT; v_rows INT;
BEGIN
  SELECT p.passes, p.rows_repaired INTO v_passes, v_rows
    FROM public.repair_relist_location_drift_to_fixpoint() p;
  ASSERT v_passes = 1 AND v_rows = 0,
    format('fixpoint: not stable — re-ran %s pass(es), %s row(s)', v_passes, v_rows);
END $$;

-- ===========================================================================
-- PART 2 — the redirect (what stops new drift)
-- ===========================================================================

-- audit_relocate_lot is SECURITY DEFINER and gates on auth.uid(). CI stubs
-- auth.uid() to NULL, so point it at a fixture staff user for this
-- transaction; the ROLLBACK puts the stub back.
INSERT INTO auth.users (id) VALUES ('d0000000-0000-0000-0000-00000000f001');
INSERT INTO operator_users (user_id, operator_id, role, email)
VALUES ('d0000000-0000-0000-0000-00000000f001',
        'd0000000-0000-0000-0000-000000000001', 'admin', 'staff@example.com');

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
AS $$ SELECT 'd0000000-0000-0000-0000-00000000f001'::uuid $$;

-- ── Case 1: relocating the TOMBSTONE writes the live successor instead.
--    Pair A's tombstone RLC111 has exactly one live child (RLC-000001, won).
DO $$
DECLARE v_res json;
BEGIN
  SELECT public.audit_relocate_lot(
           'd0000000-0000-0000-0000-0000000000a1',   -- the tombstone
           'd0000000-0000-0000-0000-0000000000b3')   -- 9-01-01
    INTO v_res;

  ASSERT (v_res->>'ok')::boolean, 'redirect: rpc did not return ok';
  ASSERT (v_res->>'lot_id') = 'd0000000-0000-0000-0000-0000000000a2',
    format('redirect: wrote %s, expected the live child', v_res->>'lot_id');
  ASSERT (v_res->>'redirected_from') = 'd0000000-0000-0000-0000-0000000000a1',
    'redirect: did not report the tombstone it was redirected from';

  ASSERT (SELECT intake_bin_id FROM lots WHERE lot_code = 'RLC-000001')
         = 'd0000000-0000-0000-0000-0000000000b3',
    'redirect: live child did not receive the new bin';
  -- The tombstone must NOT be moved: its bin is what the "last known on this
  -- record" banner reads, and rewriting it would erase the only history of
  -- where the box used to be.
  ASSERT (SELECT intake_bin_id FROM lots WHERE lot_code = 'RLC111')
         = 'd0000000-0000-0000-0000-0000000000b2',
    'redirect: tombstone bin was overwritten';
  -- A `won` lot is location-only — status must not flip.
  ASSERT (SELECT status FROM lots WHERE lot_code = 'RLC-000001') = 'won',
    'redirect: location-only move changed the status';
END $$;

-- ── Case 2: a live lot is written directly, with no redirect.
DO $$
DECLARE v_res json;
BEGIN
  SELECT public.audit_relocate_lot(
           'd0000000-0000-0000-0000-0000000000a4',   -- live child, not a tombstone
           'd0000000-0000-0000-0000-0000000000b3')
    INTO v_res;

  ASSERT (v_res->>'lot_id') = 'd0000000-0000-0000-0000-0000000000a4',
    'no-redirect: rewrote a lot that was already live';
  ASSERT (v_res->>'redirected_from') IS NULL,
    'no-redirect: reported a redirect that did not happen';
END $$;

-- ── Case 3: TWO live successors — ambiguous, so no redirect. Writing the
--    tombstone we were told to write is the honest outcome; picking one of
--    two boxes is the guess that started this whole defect.
INSERT INTO lots (id, operator_id, warehouse_id, lot_code, status, title,
                  sticker_code, relisted_from_lot_id, intake_bin_id, intake_at,
                  created_at, updated_at)
VALUES
  ('d0000000-0000-0000-0000-0000000000a7', 'd0000000-0000-0000-0000-000000000001',
   'd0000000-0000-0000-0000-000000000002', 'RLC444', 'relisted', 'ancestor tangled',
   NULL, NULL, 'd0000000-0000-0000-0000-0000000000b2',
   TIMESTAMPTZ '2026-05-28 16:20:09Z',
   TIMESTAMPTZ '2026-05-25 03:27:09Z', TIMESTAMPTZ '2026-05-25 03:27:09Z'),
  ('d0000000-0000-0000-0000-0000000000a8', 'd0000000-0000-0000-0000-000000000001',
   'd0000000-0000-0000-0000-000000000002', 'RLC-000004', 'in_inventory', 'twin one',
   NULL, 'd0000000-0000-0000-0000-0000000000a7', 'd0000000-0000-0000-0000-0000000000b1',
   TIMESTAMPTZ '2026-05-28 16:20:09Z',
   TIMESTAMPTZ '2026-07-14 15:58:16Z', TIMESTAMPTZ '2026-07-14 15:58:16Z'),
  ('d0000000-0000-0000-0000-0000000000a9', 'd0000000-0000-0000-0000-000000000001',
   'd0000000-0000-0000-0000-000000000002', 'RLC-000005', 'in_inventory', 'twin two',
   NULL, 'd0000000-0000-0000-0000-0000000000a7', 'd0000000-0000-0000-0000-0000000000b1',
   TIMESTAMPTZ '2026-05-28 16:20:09Z',
   TIMESTAMPTZ '2026-07-14 15:58:16Z', TIMESTAMPTZ '2026-07-14 15:58:16Z');

DO $$
DECLARE v_res json;
BEGIN
  SELECT public.audit_relocate_lot(
           'd0000000-0000-0000-0000-0000000000a7',
           'd0000000-0000-0000-0000-0000000000b3')
    INTO v_res;

  ASSERT (v_res->>'lot_id') = 'd0000000-0000-0000-0000-0000000000a7',
    'ambiguous: redirected despite two live successors';
  ASSERT (v_res->>'redirected_from') IS NULL,
    'ambiguous: reported a redirect';
  ASSERT (SELECT count(*) FROM lots
           WHERE lot_code IN ('RLC-000004','RLC-000005')
             AND intake_bin_id = 'd0000000-0000-0000-0000-0000000000b3') = 0,
    'ambiguous: moved one of two twins on a guess';
END $$;

-- ── Case 4: tombstone with NO live successor — nothing inherited the box, so
--    write where we were told rather than swallowing the move.
INSERT INTO lots (id, operator_id, warehouse_id, lot_code, status, title,
                  sticker_code, relisted_from_lot_id, intake_bin_id, intake_at,
                  created_at, updated_at)
VALUES
  ('d0000000-0000-0000-0000-0000000000aa', 'd0000000-0000-0000-0000-000000000001',
   'd0000000-0000-0000-0000-000000000002', 'RLC555', 'relisted', 'ancestor childless',
   NULL, NULL, 'd0000000-0000-0000-0000-0000000000b1',
   TIMESTAMPTZ '2026-05-28 16:20:09Z',
   TIMESTAMPTZ '2026-05-25 03:27:09Z', TIMESTAMPTZ '2026-05-25 03:27:09Z');

DO $$
DECLARE v_res json;
BEGIN
  SELECT public.audit_relocate_lot(
           'd0000000-0000-0000-0000-0000000000aa',
           'd0000000-0000-0000-0000-0000000000b3')
    INTO v_res;

  ASSERT (v_res->>'lot_id') = 'd0000000-0000-0000-0000-0000000000aa',
    'childless: did not write the row it was given';
  ASSERT (SELECT intake_bin_id FROM lots WHERE lot_code = 'RLC555')
         = 'd0000000-0000-0000-0000-0000000000b3',
    'childless: the move was swallowed';
END $$;

ROLLBACK;
