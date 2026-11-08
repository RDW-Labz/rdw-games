-- Behavioural test for mig 0308's carrier/retail barcode sticker guard.
-- Plain-psql assertions, no pgTAP (matches scan_resolver_collision.sql).
--
-- The failure being pinned: a picker aims the camera at a Wayfair returns box,
-- the FedEx label's 1D barcode wins the frame, and `533500296376` binds itself
-- as the lot's sticker_code. Because lotDisplayCode() renders sticker before
-- lot_code, the tracking number becomes what staff and the pickup desk read.
--
-- The guard is a SHAPE rule, and a shape rule is exactly the kind of thing that
-- silently over-fires, so the accept cases below matter more than the reject
-- cases. 6,319 of prod's 6,382 bound stickers are colour-prefixed alphanumeric
-- (PNK…/BRN…/TEA…) and the rest are LPNs, vendor SKUs and ASINs — every one of
-- those shapes is pinned as ACCEPTED here. If a future tightening starts
-- refusing `SZQW-US-VD035-WE-A-M05` or `X004Q9MODX`, lotting stops on the floor.
--
-- Also pinned:
--   • the override, so deliberate manual entry of a numeric code still works
--     (that is the documented escape hatch and the reason the parameter exists);
--   • rebind_sticker_code refusing too, because that is the flow staff reach
--     for AFTER a mis-scan and a second mis-scan there would defeat the repair;
--   • 0283's raw_code_is_live_lot_code guard still firing, since 0308 rewrites
--     the whole function body and that guard is easy to drop in a paste;
--   • numeric_sticker_audit().repairable being FALSE once a lot has a bin
--     assignment — the migration's repair must never unbind a code that put-away
--     has already filed against.
--
-- Runs against the migrated-but-empty CI database, inside a transaction that is
-- ROLLED BACK, so the DB is left untouched.

\set ON_ERROR_STOP on

BEGIN;

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
INSERT INTO operators (id, slug, business_name, contact_email, code)
VALUES ('c0000000-0000-0000-0000-000000000001', 'cbtest', 'Carrier Barcode Test Co',
        'cb@example.com', 'CBT');

INSERT INTO warehouses (id, operator_id, name, address_line1, city, state, postal_code)
VALUES ('c0000000-0000-0000-0000-000000000002', 'c0000000-0000-0000-0000-000000000001',
        'CBT WH', '1 Carrier St', 'Harrison', 'AR', '72601');

ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email TEXT;
INSERT INTO auth.users (id, email)
VALUES ('c0000000-0000-0000-0000-000000000003', 'cb@example.com');
INSERT INTO operator_users (operator_id, user_id, role, email)
VALUES ('c0000000-0000-0000-0000-000000000001', 'c0000000-0000-0000-0000-000000000003',
        'manager', 'cb@example.com');
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
$$ SELECT 'c0000000-0000-0000-0000-000000000003'::uuid $$;

-- One unbound lot per case, so each claim starts from a clean slate.
INSERT INTO lots (id, operator_id, warehouse_id, lot_code, status, title)
SELECT ('c0000000-0000-0000-0000-0000000b' || lpad(g::text, 4, '0'))::uuid,
       'c0000000-0000-0000-0000-000000000001',
       'c0000000-0000-0000-0000-000000000002',
       'CBT-' || lpad(g::text, 4, '0'),
       'pending_intake',
       'fixture lot ' || g
FROM generate_series(1, 20) g;

-- ---------------------------------------------------------------------------
-- 1. The predicate itself — cheap, exhaustive, and the thing both RPCs and the
--    audit share. Real prod values on both sides.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_reject TEXT[] := ARRAY[
    '533500296376',                       -- FedEx tracking, the 2026-08-02 report
    '533500190515',                       -- FedEx tracking
    '533499739230',                       -- FedEx tracking
    '9622013140001309096900533500618795', -- FedEx 96 ancillary block, 34 digits
    '00401955552480570222',               -- USPS/GS1 20-digit
    '5407007656684',                      -- EAN-13, the 07-08 pillowcase incident
    '0013562300662',                      -- UPC-A
    '06854652',                           -- 8 digits, the shortest observed
    '1Z999AA10123456784',                 -- UPS 1Z
    '1z999aa10123456784'                  -- UPS 1Z, lowercase
  ];
  v_accept TEXT[] := ARRAY[
    'PNK4819555',             -- BinGo pink sticker — 6,319 rows look like this
    'BRN4380112',             -- BinGo brown
    'TEA3822650',             -- BinGo teal
    'brn4046321',             -- lowercase, as scanned
    'LPNNB6JW2WVJT',          -- Amazon LPN
    'X004Q9MODX',             -- ASIN
    'SZQW-US-VD035-WE-A-M05', -- vendor SKU, digits inside
    'CY-71012B-DG',           -- vendor SKU
    'RDB-15-01-01',           -- vendor SKU, mostly digits but not bare
    'N729P285543K',           -- vendor ref
    '39Y69JBA',               -- 8 chars, alphanumeric
    '1234567',                -- 7 digits: below the floor, deliberately allowed
    '1Z999AA1012345678'       -- 1Z but wrong length — not the UPS form
  ];
  v TEXT;
BEGIN
  FOREACH v IN ARRAY v_reject LOOP
    IF NOT _looks_like_carrier_barcode(v) THEN
      RAISE EXCEPTION 'FAIL: % should be flagged as a carrier/retail barcode', v;
    END IF;
  END LOOP;
  FOREACH v IN ARRAY v_accept LOOP
    IF _looks_like_carrier_barcode(v) THEN
      RAISE EXCEPTION 'FAIL: % is a REAL sticker shape and must not be flagged', v;
    END IF;
  END LOOP;
  RAISE NOTICE 'OK 1: predicate rejects % carrier shapes, accepts % sticker shapes',
    array_length(v_reject, 1), array_length(v_accept, 1);
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. claim_sticker_code refuses the FedEx tracking number off the actual box.
-- ---------------------------------------------------------------------------
DO $$
DECLARE r JSONB;
BEGIN
  r := claim_sticker_code('c0000000-0000-0000-0000-0000000b0001'::uuid, '533500296376');
  IF (r->>'ok')::boolean IS NOT FALSE THEN
    RAISE EXCEPTION 'FAIL: FedEx tracking was accepted as a sticker: %', r;
  END IF;
  IF r->>'reason' <> 'raw_code_looks_like_carrier_barcode' THEN
    RAISE EXCEPTION 'FAIL: wrong refusal reason for FedEx tracking: %', r;
  END IF;
  -- And nothing was written.
  IF EXISTS (SELECT 1 FROM lots
              WHERE id = 'c0000000-0000-0000-0000-0000000b0001'::uuid
                AND sticker_code IS NOT NULL) THEN
    RAISE EXCEPTION 'FAIL: refused claim still wrote sticker_code';
  END IF;
  RAISE NOTICE 'OK 2: claim_sticker_code refuses FedEx tracking and writes nothing';
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. The 34-digit FedEx block and the UPS form are refused the same way.
-- ---------------------------------------------------------------------------
DO $$
DECLARE r JSONB;
BEGIN
  r := claim_sticker_code('c0000000-0000-0000-0000-0000000b0002'::uuid,
                          '9622013140001309096900533500618795');
  IF r->>'reason' <> 'raw_code_looks_like_carrier_barcode' THEN
    RAISE EXCEPTION 'FAIL: 34-digit FedEx block not refused: %', r;
  END IF;

  r := claim_sticker_code('c0000000-0000-0000-0000-0000000b0003'::uuid,
                          '1Z999AA10123456784');
  IF r->>'reason' <> 'raw_code_looks_like_carrier_barcode' THEN
    RAISE EXCEPTION 'FAIL: UPS 1Z not refused: %', r;
  END IF;
  RAISE NOTICE 'OK 3: FedEx 96-block and UPS 1Z both refused';
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. THE ONE THAT MATTERS: the real pre-sticker flow is untouched. A pink
--    sticker, an LPN and a vendor SKU all still bind.
-- ---------------------------------------------------------------------------
DO $$
DECLARE r JSONB;
BEGIN
  r := claim_sticker_code('c0000000-0000-0000-0000-0000000b0004'::uuid, 'PNK4819555');
  IF (r->>'ok')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: BinGo pink sticker was refused: %', r;
  END IF;
  IF r->>'sticker_code' <> 'CBT:PNK4819555' THEN
    RAISE EXCEPTION 'FAIL: pink sticker stored wrong: %', r;
  END IF;

  r := claim_sticker_code('c0000000-0000-0000-0000-0000000b0005'::uuid, 'LPNNB6JW2WVJT');
  IF (r->>'ok')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: LPN was refused: %', r;
  END IF;

  r := claim_sticker_code('c0000000-0000-0000-0000-0000000b0006'::uuid,
                          'SZQW-US-VD035-WE-A-M05');
  IF (r->>'ok')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: vendor SKU was refused: %', r;
  END IF;

  -- 7 digits sits below the floor on purpose.
  r := claim_sticker_code('c0000000-0000-0000-0000-0000000b0007'::uuid, '1234567');
  IF (r->>'ok')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: 7-digit code was refused: %', r;
  END IF;
  RAISE NOTICE 'OK 4: pink sticker, LPN, vendor SKU and sub-floor numeric all bind';
END;
$$;

-- ---------------------------------------------------------------------------
-- 5. The override. A human who types the number gets it — that is the
--    documented escape hatch, and without it staff have no way out.
-- ---------------------------------------------------------------------------
DO $$
DECLARE r JSONB;
BEGIN
  r := claim_sticker_code('c0000000-0000-0000-0000-0000000b0008'::uuid,
                          '533500296376', true);
  IF (r->>'ok')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: override did not permit a deliberate numeric code: %', r;
  END IF;
  IF r->>'sticker_code' <> 'CBT:533500296376' THEN
    RAISE EXCEPTION 'FAIL: override stored wrong value: %', r;
  END IF;
  RAISE NOTICE 'OK 5: p_override_barcode_guard lets deliberate manual entry through';
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. rebind_sticker_code carries the same guard — and still honours 0249's
--    audit-log write on the happy path.
-- ---------------------------------------------------------------------------
DO $$
DECLARE r JSONB;
BEGIN
  -- Bind a legitimate sticker first, then try to "fix" it with a mis-scan.
  r := claim_sticker_code('c0000000-0000-0000-0000-0000000b0009'::uuid, 'PNK4900001');
  IF (r->>'ok')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: setup claim failed: %', r;
  END IF;

  r := rebind_sticker_code('c0000000-0000-0000-0000-0000000b0009'::uuid, '533500190515');
  IF r->>'reason' <> 'raw_code_looks_like_carrier_barcode' THEN
    RAISE EXCEPTION 'FAIL: rebind accepted a carrier barcode: %', r;
  END IF;
  IF (SELECT sticker_code FROM lots WHERE id = 'c0000000-0000-0000-0000-0000000b0009'::uuid)
     <> 'CBT:PNK4900001' THEN
    RAISE EXCEPTION 'FAIL: refused rebind mutated the sticker anyway';
  END IF;

  -- A real correction still works, and is still audit-logged.
  r := rebind_sticker_code('c0000000-0000-0000-0000-0000000b0009'::uuid, 'PNK4900002');
  IF (r->>'ok')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: legitimate rebind was refused: %', r;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM operator_audit_log
                  WHERE target_id = 'c0000000-0000-0000-0000-0000000b0009'::uuid
                    AND action_type = 'lot_sticker_rebound') THEN
    RAISE EXCEPTION 'FAIL: 0249 audit-log write was lost in the 0308 rewrite';
  END IF;
  RAISE NOTICE 'OK 6: rebind refuses carrier codes, still rebinds + audits real ones';
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. Regression: 0283's duplicate-twin guard survived the rewrite. 0308
--    replaces both function bodies wholesale, so this is the guard most likely
--    to be lost silently.
-- ---------------------------------------------------------------------------
DO $$
DECLARE r JSONB;
BEGIN
  INSERT INTO lots (id, operator_id, warehouse_id, lot_code, status, title)
  VALUES ('c0000000-0000-0000-0000-0000000c0001', 'c0000000-0000-0000-0000-000000000001',
          'c0000000-0000-0000-0000-000000000002', 'PNKLIVE001', 'in_inventory',
          'a live lot whose code is on a box');

  r := claim_sticker_code('c0000000-0000-0000-0000-0000000b0010'::uuid, 'PNKLIVE001');
  IF r->>'reason' <> 'raw_code_is_live_lot_code' THEN
    RAISE EXCEPTION 'FAIL: 0283 duplicate-twin guard lost in the 0308 rewrite: %', r;
  END IF;
  IF r->>'other_lot_code' <> 'PNKLIVE001' THEN
    RAISE EXCEPTION 'FAIL: 0283 refusal no longer names the other lot: %', r;
  END IF;

  -- And the collision + colon + length refusals are all still in place.
  r := claim_sticker_code('c0000000-0000-0000-0000-0000000b0011'::uuid, 'PNK4819555');
  IF r->>'reason' <> 'sticker_code_already_used' THEN
    RAISE EXCEPTION 'FAIL: sticker collision guard lost: %', r;
  END IF;
  r := claim_sticker_code('c0000000-0000-0000-0000-0000000b0012'::uuid, 'PNK:123');
  IF r->>'reason' <> 'raw_code_contains_colon' THEN
    RAISE EXCEPTION 'FAIL: colon guard lost: %', r;
  END IF;
  r := claim_sticker_code('c0000000-0000-0000-0000-0000000b0013'::uuid, repeat('A', 201));
  IF r->>'reason' <> 'raw_code_too_long' THEN
    RAISE EXCEPTION 'FAIL: length guard lost: %', r;
  END IF;
  RAISE NOTICE 'OK 7: 0283 twin guard + collision/colon/length guards all intact';
END;
$$;

-- ---------------------------------------------------------------------------
-- 8. numeric_sticker_audit(): reports the offender, and marks a lot that
--    put-away has already filed as NOT repairable. The migration's repair is
--    keyed on exactly this condition, so an over-broad `repairable` would have
--    it unbind a code the floor is using.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_repairable BOOLEAN;
  v_rows       INT;
BEGIN
  -- b0008 holds 'CBT:533500296376' from the override case above: carrier-shaped,
  -- pending_intake, nothing filed against it → repairable.
  SELECT count(*) INTO v_rows FROM numeric_sticker_audit();
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'FAIL: audit should see exactly the 1 carrier-shaped lot, saw %', v_rows;
  END IF;
  SELECT repairable INTO v_repairable FROM numeric_sticker_audit();
  IF v_repairable IS NOT TRUE THEN
    RAISE EXCEPTION 'FAIL: an unfiled pending_intake lot should be repairable';
  END IF;

  -- File it into a bin. It must immediately stop being repairable.
  INSERT INTO bins (id, warehouse_id, code, aisle, bay, x_px, y_px, qr_token)
  VALUES ('c0000000-0000-0000-0000-0000000d0001',
          'c0000000-0000-0000-0000-000000000002', '9-99-99', '9', '99', 0, 0,
          'c0000000-0000-0000-0000-0000000d0002');
  INSERT INTO bin_assignments (lot_id, bin_id)
  VALUES ('c0000000-0000-0000-0000-0000000b0008', 'c0000000-0000-0000-0000-0000000d0001');

  SELECT repairable INTO v_repairable FROM numeric_sticker_audit();
  IF v_repairable IS NOT FALSE THEN
    RAISE EXCEPTION 'FAIL: a lot already filed into a bin must NOT be auto-unbound';
  END IF;
  RAISE NOTICE 'OK 8: audit reports the offender; a binned lot is not repairable';
END;
$$;

ROLLBACK;
