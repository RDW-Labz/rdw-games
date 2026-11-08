-- Behavioural test for mig 0304's collision-aware scan resolver.
-- Plain-psql assertions, no pgTAP (matches lineage_assign_guard.sql).
--
-- The population under test is the relist identity carryover: after
-- relist_lot_into_auction runs, the raw label on the physical box is BOTH the
-- retired parent's `lot_code` AND the raw half of the live child's
-- `sticker_code`. 855 lot pairs on prod are in that shape. The old first-hit
-- ladder probed lot_code before sticker_code, so every one of those scans
-- landed on the tombstone.
--
-- Two fixtures matter most and are easy to lose in a refactor:
--
--   • the UNLINKED pair. 188 of the 855 have a `relisted_from_lot_id` that does
--     NOT point at the collided ancestor (pre-0192 history, manual re-lotting).
--     A fix built only on walking lineage silently leaves those broken, so the
--     test pins that the two-column code match alone resolves them.
--
--   • the hop-only case, where the scanned code matches ONLY a tombstone. There
--     is no live row to out-rank, so the forward walk down relisted_from_lot_id
--     is the only thing that can answer, and `hopped_from` must say so.
--
-- Also pins: soft-deleted lots never resolve (0057), qr_token still outranks
-- everything, `alternates` reports the ambiguity, batch put-away files stock
-- against the live child, and the pickup desk accepts the code that is actually
-- printed on the box.
--
-- Runs against the migrated-but-empty CI database, inside a transaction that is
-- ROLLED BACK, so the DB is left untouched.

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
INSERT INTO operators (id, slug, business_name, contact_email, code)
VALUES ('f0000000-0000-0000-0000-000000000001', 'scantest', 'Scan Test Co',
        'scan@example.com', 'SCN');

INSERT INTO warehouses (id, operator_id, name, address_line1, city, state, postal_code)
VALUES ('f0000000-0000-0000-0000-000000000002', 'f0000000-0000-0000-0000-000000000001',
        'SCN WH', '1 Scan St', 'Harrison', 'AR', '72601');

ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email TEXT;
INSERT INTO auth.users (id, email)
VALUES ('f0000000-0000-0000-0000-000000000003', 'scan@example.com');
INSERT INTO operator_users (operator_id, user_id, role, email)
VALUES ('f0000000-0000-0000-0000-000000000001', 'f0000000-0000-0000-0000-000000000003',
        'manager', 'scan@example.com');
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT 'f0000000-0000-0000-0000-000000000003'::uuid $$;

-- ── Pair 1: LINKED carryover. Scanning 'PNK111' must reach the live child. ──
INSERT INTO lots (id, operator_id, warehouse_id, lot_code, status, title,
                  sticker_code, relisted_from_lot_id, created_at)
VALUES
  ('f0000000-0000-0000-0000-00000000a001', 'f0000000-0000-0000-0000-000000000001',
   'f0000000-0000-0000-0000-000000000002', 'PNK111', 'relisted', 'ancestor one',
   NULL, NULL, now() - INTERVAL '30 days'),
  ('f0000000-0000-0000-0000-00000000a002', 'f0000000-0000-0000-0000-000000000001',
   'f0000000-0000-0000-0000-000000000002', 'SCN-000001', 'live', 'child one',
   'SCN:PNK111', 'f0000000-0000-0000-0000-00000000a001', now());

-- ── Pair 2: UNLINKED carryover — no relisted_from_lot_id back-pointer. ──────
INSERT INTO lots (id, operator_id, warehouse_id, lot_code, status, title,
                  sticker_code, relisted_from_lot_id, created_at)
VALUES
  ('f0000000-0000-0000-0000-00000000b001', 'f0000000-0000-0000-0000-000000000001',
   'f0000000-0000-0000-0000-000000000002', 'PNK222', 'canceled', 'ancestor two',
   NULL, NULL, now() - INTERVAL '30 days'),
  ('f0000000-0000-0000-0000-00000000b002', 'f0000000-0000-0000-0000-000000000001',
   'f0000000-0000-0000-0000-000000000002', 'SCN-000002', 'won', 'child two',
   'SCN:PNK222', NULL, now());

-- ── Pair 3: hop-only. 'PNK333' matches the tombstone and NOTHING else; the
--    successor carries no sticker, so only the forward walk can answer. ──────
INSERT INTO lots (id, operator_id, warehouse_id, lot_code, status, title,
                  sticker_code, relisted_from_lot_id, created_at)
VALUES
  ('f0000000-0000-0000-0000-00000000c001', 'f0000000-0000-0000-0000-000000000001',
   'f0000000-0000-0000-0000-000000000002', 'PNK333', 'relisted', 'ancestor three',
   NULL, NULL, now() - INTERVAL '30 days'),
  ('f0000000-0000-0000-0000-00000000c002', 'f0000000-0000-0000-0000-000000000001',
   'f0000000-0000-0000-0000-000000000002', 'SCN-000003', 'live', 'child three',
   NULL, 'f0000000-0000-0000-0000-00000000c001', now());

-- ── Soft-deleted lot: must never resolve (0057). ───────────────────────────
INSERT INTO lots (id, operator_id, warehouse_id, lot_code, status, title, deleted_at)
VALUES
  ('f0000000-0000-0000-0000-00000000d001', 'f0000000-0000-0000-0000-000000000001',
   'f0000000-0000-0000-0000-000000000002', 'PNK444', 'in_inventory', 'trashed', now());

-- ---------------------------------------------------------------------------
-- 1. LINKED pair — the child wins, and we know it matched on the sticker.
-- ---------------------------------------------------------------------------
DO $$
DECLARE r JSONB;
BEGIN
  r := public._find_lot_by_scan(ARRAY['PNK111']);
  ASSERT (r->>'ok')::boolean, 'linked pair: expected a match';
  ASSERT (r->'lot'->>'id') = 'f0000000-0000-0000-0000-00000000a002',
    format('linked pair: expected the live child, got %s', r->'lot'->>'lot_code');
  ASSERT (r->>'matched_field') = 'sticker_code',
    format('linked pair: expected sticker_code, got %s', r->>'matched_field');
  -- The tombstone is the alternate the old ladder used to return.
  ASSERT (r->>'alternates')::int = 1,
    format('linked pair: expected 1 alternate, got %s', r->>'alternates');
  ASSERT r->>'hopped_from' IS NULL, 'linked pair: should not need a lineage hop';
END $$;

-- ---------------------------------------------------------------------------
-- 2. UNLINKED pair — resolved by the two-column match ALONE. This is the
--    assertion that a lineage-only fix would fail.
-- ---------------------------------------------------------------------------
DO $$
DECLARE r JSONB;
BEGIN
  r := public._find_lot_by_scan(ARRAY['PNK222']);
  ASSERT (r->'lot'->>'id') = 'f0000000-0000-0000-0000-00000000b002',
    format('unlinked pair: expected the won child, got %s', r->'lot'->>'lot_code');
  ASSERT r->>'hopped_from' IS NULL,
    'unlinked pair: there is no back-pointer, so no hop should have happened';
END $$;

-- ---------------------------------------------------------------------------
-- 3. Hop-only — every match is a tombstone, so walk forward.
-- ---------------------------------------------------------------------------
DO $$
DECLARE r JSONB;
BEGIN
  r := public._find_lot_by_scan(ARRAY['PNK333']);
  ASSERT (r->'lot'->>'id') = 'f0000000-0000-0000-0000-00000000c002',
    format('hop: expected the successor, got %s', r->'lot'->>'lot_code');
  ASSERT (r->>'hopped_from') = 'PNK333',
    format('hop: expected hopped_from=PNK333, got %s', r->>'hopped_from');
END $$;

-- ---------------------------------------------------------------------------
-- 4. Soft-deleted lots never resolve; unknown codes still report not_found.
-- ---------------------------------------------------------------------------
DO $$
DECLARE r JSONB;
BEGIN
  r := public._find_lot_by_scan(ARRAY['PNK444']);
  ASSERT NOT (r->>'ok')::boolean, 'soft-deleted lot must not resolve';
  ASSERT (r->>'reason') = 'lot_not_found', 'soft-deleted lot: wrong reason';

  r := public._find_lot_by_scan(ARRAY['NOSUCHCODE']);
  ASSERT NOT (r->>'ok')::boolean, 'unknown code must not resolve';
END $$;

-- ---------------------------------------------------------------------------
-- 5. qr_token still outranks every text probe, even when the same string would
--    have matched something else. Also: case-insensitive lot_code.
-- ---------------------------------------------------------------------------
DO $$
DECLARE r JSONB; v_token UUID;
BEGIN
  SELECT qr_token INTO v_token FROM lots
   WHERE id = 'f0000000-0000-0000-0000-00000000a001';

  r := public._find_lot_by_scan(ARRAY[v_token::TEXT]);
  ASSERT (r->>'matched_field') = 'qr_token',
    format('qr: expected qr_token, got %s', r->>'matched_field');
  -- The token belongs to the tombstone, which has a live successor, so the
  -- forward walk still applies — a scan of the parent's QR should land on the
  -- item, not on history.
  ASSERT (r->'lot'->>'id') = 'f0000000-0000-0000-0000-00000000a002',
    'qr: a tombstone QR should hop forward to the live child';

  r := public._find_lot_by_scan(ARRAY['scn-000001']);
  ASSERT (r->'lot'->>'id') = 'f0000000-0000-0000-0000-00000000a002',
    'lot_code match must be case-insensitive';
END $$;

-- ---------------------------------------------------------------------------
-- 6. batch_intake_lot_to_bin files the box against the LIVE child.
--    Before 0304 the inline ladder resolved 'PNK111' to the tombstone, so
--    put-away recorded the location on a row nothing points at.
-- ---------------------------------------------------------------------------
INSERT INTO bins (id, warehouse_id, code, aisle, bay, x_px, y_px, qr_token)
VALUES ('f0000000-0000-0000-0000-00000000e001', 'f0000000-0000-0000-0000-000000000002',
        '15-08-01', '15', '08', 0, 0, 'f0000000-0000-0000-0000-00000000e002');

DO $$
DECLARE r RECORD;
BEGIN
  SELECT * INTO r FROM public.batch_intake_lot_to_bin(
    ARRAY['PNK111'], 'f0000000-0000-0000-0000-00000000e002'::UUID);

  ASSERT r.ok, format('batch intake: expected ok, got %s / %s', r.code, r.error);
  ASSERT r.lot_id = 'f0000000-0000-0000-0000-00000000a002',
    format('batch intake: filed against %s, expected the live child', r.lot_code);

  ASSERT (SELECT intake_bin_id FROM lots WHERE id = 'f0000000-0000-0000-0000-00000000a002')
         = 'f0000000-0000-0000-0000-00000000e001',
    'batch intake: child did not get the bin';
  ASSERT (SELECT intake_bin_id FROM lots WHERE id = 'f0000000-0000-0000-0000-00000000a001')
         IS NULL,
    'batch intake: the tombstone must not have been touched';
END $$;

-- ---------------------------------------------------------------------------
-- 7. staff_confirm_pickup accepts the label printed on the box.
--    The invoice references child two (lot_code SCN-000002); the box says
--    PNK222. An exact lot_code match left it counted as missing and refused to
--    complete the pickup.
-- ---------------------------------------------------------------------------
INSERT INTO auctions (id, operator_id, warehouse_id, title, status,
                      starts_at, ends_at, pickup_starts_at, pickup_ends_at)
VALUES ('f0000000-0000-0000-0000-00000000f001', 'f0000000-0000-0000-0000-000000000001',
        'f0000000-0000-0000-0000-000000000002', 'Going… Gone!', 'closed',
        now() - INTERVAL '2 days', now() - INTERVAL '1 day',
        now(), now() + INTERVAL '2 days');

-- bidders.email is locked to the auth.users row of the same id (trigger
-- bidders_lock_email_to_auth), so the auth row has to exist first.
INSERT INTO auth.users (id, email)
VALUES ('f0000000-0000-0000-0000-00000000f002', 'buyer@example.com');
INSERT INTO bidders (id, email, birth_date) VALUES
  ('f0000000-0000-0000-0000-00000000f002', 'buyer@example.com', DATE '1980-01-01');

INSERT INTO invoices (id, operator_id, auction_id, bidder_id, status)
VALUES ('f0000000-0000-0000-0000-00000000f003', 'f0000000-0000-0000-0000-000000000001',
        'f0000000-0000-0000-0000-00000000f001', 'f0000000-0000-0000-0000-00000000f002',
        'paid');

INSERT INTO invoice_lots (invoice_id, lot_id, winning_bid_cents)
VALUES ('f0000000-0000-0000-0000-00000000f003',
        'f0000000-0000-0000-0000-00000000b002', 1500);

INSERT INTO pickups (id, invoice_id, warehouse_id, status)
VALUES ('f0000000-0000-0000-0000-00000000f004', 'f0000000-0000-0000-0000-00000000f003',
        'f0000000-0000-0000-0000-000000000002', 'pending');

DO $$
DECLARE r staff_confirm_pickup_result;
BEGIN
  -- p_allow_incomplete stays FALSE: if the sticker label did not match, the
  -- money-loss guard would RAISE pickup_incomplete and fail this test.
  r := public.staff_confirm_pickup(
    'f0000000-0000-0000-0000-00000000f003'::UUID, ARRAY['PNK222'], FALSE);

  ASSERT r.out_lots_picked_count = 1,
    format('pickup: expected 1 handed over, got %s', r.out_lots_picked_count);
  ASSERT (SELECT picked_up_at FROM invoice_lots
           WHERE invoice_id = 'f0000000-0000-0000-0000-00000000f003') IS NOT NULL,
    'pickup: the invoice lot was never stamped';
  ASSERT (SELECT status FROM pickups WHERE id = 'f0000000-0000-0000-0000-00000000f004')
         = 'completed',
    'pickup: should have completed — nothing is still owed';
END $$;

-- ---------------------------------------------------------------------------
-- 8. lot_code_collision_audit sees both carryover pairs and names the winner.
-- ---------------------------------------------------------------------------
DO $$
DECLARE v_rows INT; v_resolves UUID;
BEGIN
  SELECT count(*) INTO v_rows FROM public.lot_code_collision_audit();
  ASSERT v_rows = 2, format('audit: expected the 2 collision pairs, got %s', v_rows);

  SELECT resolves_to INTO v_resolves
    FROM public.lot_code_collision_audit() WHERE scanned_code = 'PNK111';
  ASSERT v_resolves = 'f0000000-0000-0000-0000-00000000a002',
    'audit: resolves_to disagrees with _find_lot_by_scan';
END $$;

ROLLBACK;

\echo 'scan_resolver_collision.sql: OK'
