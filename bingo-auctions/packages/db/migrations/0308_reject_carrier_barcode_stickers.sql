-- 0308 — stop carrier shipping barcodes binding themselves as lot stickers
--
-- Field report 2026-08-02: three lots created that morning showed a FedEx
-- tracking number where the lot code belongs. BIN-007416 carried
-- `sticker_code = 'BIN:533500296376'`, which is the `TRK# 5335 0029 6376`
-- printed on the box. The worklist renders `lotDisplayCode()` (sticker first,
-- lot_code as fallback), so the tracking number is what staff and the pickup
-- desk read.
--
-- It did NOT start that morning, and no code shipped that morning. The bind
-- path has been unchanged since 0283 (2026-07-23). What moved was the box mix:
--
--     date     Wayfair July lots   mis-scans
--     07-31    69                  1
--     08-01    56                  1
--     08-02     4                  3      <- 16 lots into the day
--
-- Wayfair direct-to-liquidation returns arrive on FedEx labels, and that label
-- puts a large high-contrast 1D barcode (plus a 34-digit `9622…` ancillary
-- block) on the face the picker aims at. The camera locks it before it finds
-- the pink/brown/teal sticker. Across all history the split is 12 mis-scans in
-- 1,721 Wayfair lots (0.70%) against 5 in 4,661 everything-else (0.11%) — a
-- six-fold rate that a 400-lot day dilutes into a single unnoticed row and a
-- 16-lot morning does not.
--
-- WHY NOTHING CAUGHT IT. `looksLikeProductBarcode()` in the app rejects a
-- 12-14 digit numeric only when it carries a valid GS1 check digit. It was
-- built in July for retail UPCs and it does still catch those. FedEx tracking
-- is 12 digits with a mod-11 check, so it fails the GTIN test and is waved
-- through; the 34-digit form is not even a testable length. Neither
-- claim_sticker_code nor rebind_sticker_code checked shape at all — they
-- validate length, colons and collisions only.
--
-- THE RULE. A real sticker is never a bare number. BinGo's own pre-printed
-- stock is colour-prefixed alphanumeric (PNK…/BRN…/TEA…, 6,319 of the 6,382
-- bound codes), the rest are LPNs, vendor SKUs and ASINs (`LPNNB6JW2WVJT`,
-- `SZQW-US-VD035-WE-A-M05`, `X004Q9MODX`), and pre-printed BinGo QRs are UUIDs
-- routed to claim_prestickered_qr long before this function. Every one of the
-- 17 all-numeric codes on prod is a mis-scan: FedEx tracking, the FedEx 96
-- block, a USPS/GS1 20-digit, and the three retail UPCs from the 07-08 incident
-- that prompted the original guard. Zero false positives in 6,382 rows.
--
-- So: refuse an 8+ digit bare numeric, and refuse the UPS `1Z…` form for the
-- same reason. 8 is the floor because the shortest observed mis-scan is 8
-- digits (`06854652`) and no legitimate sticker is numeric at any length.
--
-- Enforced HERE and not only in the app because the app is a shipped Expo
-- build: a client-only guard protects nobody until the iPads take an update,
-- while this covers every build the moment it applies.
--
-- THE OVERRIDE. `p_override_barcode_guard` exists so a human who genuinely
-- means it can still bind a numeric code by typing it — the sticker-correction
-- flow (0300) and the manual entry field pass true. Camera scans never do,
-- because a camera scan is exactly the thing being defended against. Adding a
-- parameter means DROPping the 2-arg forms: a defaulted third argument would
-- otherwise make `claim_sticker_code(uuid, text)` ambiguous. PostgREST calls by
-- named parameter, so app builds that send only {p_lot_id, p_raw_code} keep
-- working and get the guard enforced (default false) — which is the point.
-- Verified no other DB function invokes either RPC (two mention them in
-- comments only: resolve_lot_by_sticker, clear_sticker_code).
--
-- REPAIR. The 17 existing offenders are all `pending_intake` with no bin
-- assignment, no bids and no claimed pool row — nothing has been filed against
-- these codes, so unbinding them costs nothing and forces the correct sticker
-- to be scanned at put-away. Idempotent: re-running clears whatever new
-- offenders exist, which after this migration should be none.
--
-- Reversible: the guard is two IF blocks; the repair is recorded per-lot in
-- operator_audit_log with the old value, so any row can be re-bound by hand.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The shape predicate, factored out so the RPCs, the audit view and the
--    test all agree on one definition.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._looks_like_carrier_barcode(p_raw TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path TO 'public'
AS $function$
  SELECT p_raw IS NOT NULL
     AND (
       -- Bare numeric, 8+ digits: FedEx tracking (12), the FedEx 96 ancillary
       -- block (34), USPS IMpb / GS1 SSCC (20/22/26/30), UPC-A/EAN-13/GTIN-14
       -- (12/13/14) and EAN-8 (8). No legitimate sticker is bare numeric.
       p_raw ~ '^[0-9]{8,}$'
       -- UPS 1Z tracking. Alphanumeric, so the numeric rule misses it, but it
       -- is the same failure: a carrier label read instead of a lot sticker.
       OR p_raw ~* '^1Z[0-9A-Z]{16}$'
     );
$function$;

COMMENT ON FUNCTION public._looks_like_carrier_barcode(TEXT) IS
  '0308: true when a raw scanned value has the shape of a carrier shipping '
  'label or retail barcode rather than a lot sticker — a bare 8+ digit numeric '
  'or a UPS 1Z code. Every all-numeric sticker_code on prod at the time of '
  'writing (17 of 6,382) was a mis-scan; no real sticker is bare numeric. '
  'Used by claim_sticker_code / rebind_sticker_code and numeric_sticker_audit().';

-- ---------------------------------------------------------------------------
-- 2. claim_sticker_code — add the shape guard + the deliberate-entry override.
--    Body is 0283's verbatim apart from the new parameter and the new IF.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.claim_sticker_code(UUID, TEXT);

CREATE OR REPLACE FUNCTION public.claim_sticker_code(
  p_lot_id                 UUID,
  p_raw_code               TEXT,
  p_override_barcode_guard BOOLEAN DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_op_id          UUID;
  v_op_code        TEXT;
  v_lot            lots%ROWTYPE;
  v_other_lot      UUID;
  v_other_lot_code TEXT;
  v_clean_raw      TEXT := TRIM(p_raw_code);
  v_full_code      TEXT;
BEGIN
  v_op_id := current_operator_id();
  IF v_op_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_operator_staff');
  END IF;

  IF v_clean_raw IS NULL OR LENGTH(v_clean_raw) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'empty_raw_code');
  END IF;

  -- Sanity cap on raw length. The format CHECK on the column doesn't bound
  -- length explicitly; we cap here to keep the column workable. 200 chars
  -- is generous (a UUID is 36 chars, an LPN is < 30, an EAN-13 is 13).
  IF LENGTH(v_clean_raw) > 200 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'raw_code_too_long');
  END IF;

  -- Reject if the raw code itself contains a colon — that would create
  -- ambiguity between operator prefix and operator-chosen content.
  IF v_clean_raw LIKE '%:%' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'raw_code_contains_colon');
  END IF;

  -- ── Carrier / retail barcode guard (0308) ────────────────────────────────
  -- A camera pointed at a returns box sees the FedEx label before it sees the
  -- colour sticker. Refuse the shape outright; a human who means it types the
  -- code and the caller passes p_override_barcode_guard.
  IF NOT p_override_barcode_guard AND _looks_like_carrier_barcode(v_clean_raw) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'raw_code_looks_like_carrier_barcode');
  END IF;

  SELECT code INTO v_op_code FROM operators WHERE id = v_op_id;
  IF v_op_code IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'operator_code_missing');
  END IF;

  v_full_code := v_op_code || ':' || v_clean_raw;

  SELECT * INTO v_lot FROM lots WHERE id = p_lot_id;
  IF v_lot.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_not_found');
  END IF;
  IF v_lot.operator_id <> v_op_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_other_operator');
  END IF;

  -- Already bound to this exact code? Idempotent success.
  IF v_lot.sticker_code = v_full_code THEN
    RETURN jsonb_build_object('ok', true, 'lot_id', p_lot_id,
      'sticker_code', v_full_code, 'idempotent', true);
  END IF;

  -- Bound to a DIFFERENT sticker_code? Reject. Re-binding would orphan the
  -- old physical sticker — caller must explicitly rotate (rebind_sticker_code).
  IF v_lot.sticker_code IS NOT NULL AND v_lot.sticker_code <> v_full_code THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'lot_already_has_different_sticker',
      'existing_sticker_code', v_lot.sticker_code
    );
  END IF;

  -- ── Duplicate-twin prevention (Jared 2026-07-22, mig 0283) ───────────────
  SELECT id, lot_code INTO v_other_lot, v_other_lot_code
    FROM lots
    WHERE operator_id = v_op_id
      AND lot_code = v_clean_raw
      AND id <> p_lot_id
      AND deleted_at IS NULL
      AND status NOT IN ('canceled', 'relisted', 'disposed')
    LIMIT 1;
  IF v_other_lot IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'raw_code_is_live_lot_code',
      'other_lot_id', v_other_lot, 'other_lot_code', v_other_lot_code
    );
  END IF;

  -- Full sticker_code used by another lot? Reject.
  SELECT id INTO v_other_lot
    FROM lots
    WHERE sticker_code = v_full_code AND id <> p_lot_id
    LIMIT 1;
  IF v_other_lot IS NOT NULL THEN
    RETURN jsonb_build_object(
      'ok', false, 'reason', 'sticker_code_already_used',
      'other_lot_id', v_other_lot
    );
  END IF;

  -- Mark pool row claimed if a pre-printed sticker matches (only relevant
  -- when the raw code was a UUID from a mint_blank_qr_batch batch).
  UPDATE lot_sticker_pool
     SET claimed_at = COALESCE(claimed_at, now()),
         claimed_by_lot_id = COALESCE(claimed_by_lot_id, p_lot_id)
   WHERE sticker_code = v_full_code
     AND operator_id = v_op_id
     AND claimed_at IS NULL;

  -- Write the lot's sticker_code.
  UPDATE lots
     SET sticker_code = v_full_code,
         updated_at = now()
   WHERE id = p_lot_id;

  RETURN jsonb_build_object(
    'ok', true,
    'lot_id', p_lot_id,
    'sticker_code', v_full_code,
    'idempotent', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.claim_sticker_code(UUID, TEXT, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_sticker_code(UUID, TEXT, BOOLEAN) TO authenticated;

COMMENT ON FUNCTION public.claim_sticker_code(UUID, TEXT, BOOLEAN) IS
  'W2-bonus + 0283 + 0308: bind an operator-chosen RAW physical sticker code to '
  'a lot. Server prefixes with `{caller.operator.code}:`. Idempotent on same '
  'code. Rejects rebinding to a different code (use rebind_sticker_code), a raw '
  'code that is a DIFFERENT live lot''s lot_code (raw_code_is_live_lot_code), '
  'and — new in 0308 — a carrier/retail barcode shape '
  '(raw_code_looks_like_carrier_barcode) unless p_override_barcode_guard is '
  'passed by a deliberate manual entry.';

-- ---------------------------------------------------------------------------
-- 3. rebind_sticker_code — same guard, same override.
-- ---------------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.rebind_sticker_code(UUID, TEXT);

CREATE OR REPLACE FUNCTION public.rebind_sticker_code(
  p_lot_id                 UUID,
  p_raw_code               TEXT,
  p_override_barcode_guard BOOLEAN DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_op_id          UUID;
  v_op_code        TEXT;
  v_lot            lots%ROWTYPE;
  v_other_lot      UUID;
  v_other_lot_code TEXT;
  v_clean_raw      TEXT := TRIM(p_raw_code);
  v_full_code      TEXT;
BEGIN
  v_op_id := current_operator_id();
  IF v_op_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_operator_staff');
  END IF;

  IF v_clean_raw IS NULL OR LENGTH(v_clean_raw) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'empty_raw_code');
  END IF;
  IF LENGTH(v_clean_raw) > 200 THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'raw_code_too_long');
  END IF;
  IF v_clean_raw LIKE '%:%' THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'raw_code_contains_colon');
  END IF;

  -- Carrier / retail barcode guard (0308). Same rule as claim_sticker_code:
  -- the "Fix sticker / code" flow is the one staff reach for AFTER a mis-scan,
  -- so letting a second mis-scan through here would defeat the repair.
  IF NOT p_override_barcode_guard AND _looks_like_carrier_barcode(v_clean_raw) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'raw_code_looks_like_carrier_barcode');
  END IF;

  SELECT code INTO v_op_code FROM operators WHERE id = v_op_id;
  IF v_op_code IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'operator_code_missing');
  END IF;

  v_full_code := v_op_code || ':' || v_clean_raw;

  SELECT * INTO v_lot FROM lots WHERE id = p_lot_id;
  IF v_lot.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_not_found');
  END IF;
  IF v_lot.operator_id <> v_op_id THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_other_operator');
  END IF;

  -- Same floor-recovery scope as discard_lot.
  IF v_lot.status NOT IN ('pending_intake', 'in_inventory', 'draft') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_not_editable',
      'status', v_lot.status);
  END IF;

  -- Idempotent for the same code.
  IF v_lot.sticker_code = v_full_code THEN
    RETURN jsonb_build_object('ok', true, 'lot_id', p_lot_id,
      'sticker_code', v_full_code, 'idempotent', true);
  END IF;

  -- Duplicate-twin prevention (0283): the rebound code must not be a DIFFERENT
  -- live lot's canonical lot_code (see claim_sticker_code above).
  SELECT id, lot_code INTO v_other_lot, v_other_lot_code
    FROM lots
    WHERE operator_id = v_op_id
      AND lot_code = v_clean_raw
      AND id <> p_lot_id
      AND deleted_at IS NULL
      AND status NOT IN ('canceled', 'relisted', 'disposed')
    LIMIT 1;
  IF v_other_lot IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'raw_code_is_live_lot_code',
      'other_lot_id', v_other_lot, 'other_lot_code', v_other_lot_code);
  END IF;

  -- New full sticker_code must be unused by any other lot.
  SELECT id INTO v_other_lot
    FROM lots
    WHERE sticker_code = v_full_code AND id <> p_lot_id
    LIMIT 1;
  IF v_other_lot IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'sticker_code_already_used',
      'other_lot_id', v_other_lot);
  END IF;

  -- Claim the matching pre-printed pool row (if any), same as claim_sticker_code.
  UPDATE lot_sticker_pool
     SET claimed_at = COALESCE(claimed_at, now()),
         claimed_by_lot_id = COALESCE(claimed_by_lot_id, p_lot_id)
   WHERE sticker_code = v_full_code
     AND operator_id = v_op_id
     AND claimed_at IS NULL;

  UPDATE lots
     SET sticker_code = v_full_code, updated_at = now()
   WHERE id = p_lot_id;

  INSERT INTO operator_audit_log
    (operator_id, actor_user_id, action_type, target_id, before_state, after_state, reason_note)
  VALUES
    (v_op_id, auth.uid(), 'lot_sticker_rebound', p_lot_id,
     jsonb_build_object('sticker_code', v_lot.sticker_code),
     jsonb_build_object('sticker_code', v_full_code),
     'rebound from lotting scan recovery');

  RETURN jsonb_build_object('ok', true, 'lot_id', p_lot_id,
    'sticker_code', v_full_code, 'idempotent', false,
    'previous_sticker_code', v_lot.sticker_code);
END;
$function$;

REVOKE ALL ON FUNCTION public.rebind_sticker_code(UUID, TEXT, BOOLEAN) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rebind_sticker_code(UUID, TEXT, BOOLEAN) TO authenticated;

COMMENT ON FUNCTION public.rebind_sticker_code(UUID, TEXT, BOOLEAN) IS
  '0249 + 0283 + 0308: replace a lot''s existing sticker_code, audit-logged. '
  'Carries the same carrier/retail barcode guard as claim_sticker_code — this '
  'is the flow staff use to FIX a mis-scan, so a second mis-scan must not pass.';

-- ---------------------------------------------------------------------------
-- 4. Audit — what is still bound to a barcode shape, so the tail is visible
--    rather than inferred. Mirrors the *_audit() convention of 0306/0307.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.numeric_sticker_audit()
RETURNS TABLE (
  lot_code      TEXT,
  raw_code      TEXT,
  title         TEXT,
  status        TEXT,
  source        TEXT,
  created_at    TIMESTAMPTZ,
  bin_rows      BIGINT,
  bids          BIGINT,
  repairable    BOOLEAN
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  SELECT l.lot_code,
         regexp_replace(l.sticker_code, '^[^:]*:', '') AS raw_code,
         l.title,
         l.status::TEXT,
         l.source,
         l.created_at,
         (SELECT count(*) FROM bin_assignments ba WHERE ba.lot_id = l.id),
         (SELECT count(*) FROM bids b WHERE b.lot_id = l.id),
         -- Safe to unbind without stranding anything already filed by the code.
         l.status = 'pending_intake'
           AND NOT EXISTS (SELECT 1 FROM bin_assignments ba WHERE ba.lot_id = l.id)
           AND NOT EXISTS (SELECT 1 FROM bids b WHERE b.lot_id = l.id)
  FROM lots l
  WHERE l.sticker_code IS NOT NULL
    AND l.operator_id = current_operator_id()
    AND _looks_like_carrier_barcode(regexp_replace(l.sticker_code, '^[^:]*:', ''))
  ORDER BY l.created_at DESC;
$function$;

REVOKE ALL ON FUNCTION public.numeric_sticker_audit() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.numeric_sticker_audit() TO authenticated;

COMMENT ON FUNCTION public.numeric_sticker_audit() IS
  '0308: lots whose bound sticker_code is a carrier/retail barcode shape rather '
  'than a real sticker. `repairable` marks the ones safe to unbind — '
  'pending_intake, no bin assignment, no bids. Read-only; ops visibility.';

-- ---------------------------------------------------------------------------
-- 5. Repair the existing 17. All are pending_intake with no bin row, no bids
--    and no claimed pool row, so unbinding strands nothing — it just forces the
--    real sticker to be scanned at put-away, which is what should have
--    happened. Audit-logged per lot so any one of them can be put back.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_row   RECORD;
  v_count INT := 0;
BEGIN
  FOR v_row IN
    SELECT l.id, l.operator_id, l.lot_code, l.sticker_code
    FROM lots l
    WHERE l.sticker_code IS NOT NULL
      AND _looks_like_carrier_barcode(regexp_replace(l.sticker_code, '^[^:]*:', ''))
      AND l.status = 'pending_intake'
      AND NOT EXISTS (SELECT 1 FROM bin_assignments ba WHERE ba.lot_id = l.id)
      AND NOT EXISTS (SELECT 1 FROM bids b WHERE b.lot_id = l.id)
  LOOP
    -- Release the pool row only where THIS lot still holds it (0300's rule),
    -- so a sticker another lot legitimately claimed is never freed.
    UPDATE lot_sticker_pool
       SET claimed_at = NULL, claimed_by_lot_id = NULL
     WHERE sticker_code = v_row.sticker_code
       AND operator_id = v_row.operator_id
       AND claimed_by_lot_id = v_row.id;

    UPDATE lots
       SET sticker_code = NULL, updated_at = now()
     WHERE id = v_row.id;

    INSERT INTO operator_audit_log
      (operator_id, actor_user_id, action_type, target_id,
       before_state, after_state, reason_note)
    VALUES
      (v_row.operator_id, NULL, 'lot_sticker_cleared', v_row.id,
       jsonb_build_object('sticker_code', v_row.sticker_code),
       jsonb_build_object('sticker_code', NULL),
       'mig 0308: carrier/retail barcode bound as sticker by mis-scan');

    v_count := v_count + 1;
  END LOOP;

  RAISE NOTICE '0308: cleared % carrier-barcode sticker(s)', v_count;
END;
$$;

COMMIT;
