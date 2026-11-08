-- 0160_find_import_row_by_scan.sql
-- Universal vendor-agnostic scan-match.
-- Replaces single-field find_import_row_by_tracking with multi-candidate probe.
-- Preserves mig 0156's tracking_number token-match logic.
-- Refactors intake_lot_to_bin's inline probe into shared _find_lot_by_scan helper.
--
-- Functions introduced / modified:
--   NEW  public._find_lot_by_scan(TEXT[])       → jsonb
--   NEW  public.find_import_row_by_scan(TEXT[])  → jsonb
--   SHIM public.find_import_row_by_tracking(TEXT) → delegates to find_import_row_by_scan
--   MOD  public.intake_lot_to_bin(TEXT, UUID)    → uses _find_lot_by_scan; no behaviour change
--
-- Backwards compatibility:
--   find_import_row_by_tracking is retained as a shim for TestFlight staff #54
--   (the in-review binary calls the old single-argument form). Once that build
--   is superseded this shim can be dropped.
--
-- Resolution ladders (operator-scoped throughout):
--   _find_lot_by_scan:         qr_token → lot_code → sticker_code → lpn → fnsku → asin → external_code
--   find_import_row_by_scan:   tracking_number (0156 token-match) → lpn → fnsku → asin → upc → external_code → pallet_id

-- ===========================================================================
-- 1. _find_lot_by_scan(p_candidates TEXT[]) — shared lot-resolution helper.
-- ===========================================================================
-- Iterates over the candidate array, probing the lots table through the same
-- resolution ladder that intake_lot_to_bin previously did inline. First
-- non-null match wins; returns { ok, lot, matched_field } jsonb.
--
-- Resolution order (mirrors mig 0143's intake_lot_to_bin, extended with
-- mig 0032's ASIN/FNSKU/LPN columns and mig 0032's external_code fallback):
--   1. qr_token (UUID) — per-lot universal-link UUID (mig 0103)
--   2. lot_code — human-readable operator code ("BNG-000042")
--   3. sticker_code — "{op.code}:{raw}" pre-stickered form (mig 0141)
--   4. lpn — Amazon License Plate Number, unit-level (mig 0032)
--   5. fnsku — Amazon Fulfillment Network SKU, per-listing (mig 0032)
--   6. asin — Amazon product identifier; prefers pending_intake if multiple (mig 0032)
--   7. external_code — operator-scoped catch-all (mig 0032)

CREATE OR REPLACE FUNCTION public._find_lot_by_scan(
  p_candidates TEXT[]
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_op       UUID := public.current_operator_id();
  v_op_code  TEXT;
  v_lot      lots%ROWTYPE;
  v_cand     TEXT;
  v_sticker  TEXT;
BEGIN
  IF v_op IS NULL THEN
    RAISE EXCEPTION 'unauthorized';
  END IF;

  SELECT code INTO v_op_code FROM public.operators WHERE id = v_op;

  FOREACH v_cand IN ARRAY p_candidates LOOP

    -- 1. qr_token (UUID) — try parse; skip on invalid_text_representation.
    BEGIN
      SELECT * INTO v_lot FROM public.lots
        WHERE qr_token = v_cand::UUID
        LIMIT 1;
      IF FOUND AND v_lot.id IS NOT NULL THEN
        RETURN jsonb_build_object('ok', true, 'lot', to_jsonb(v_lot), 'matched_field', 'qr_token');
      END IF;
    EXCEPTION WHEN invalid_text_representation THEN
      NULL; -- not a UUID — continue to next probe
    END;

    -- 2. lot_code
    SELECT * INTO v_lot FROM public.lots
      WHERE lot_code = v_cand
      LIMIT 1;
    IF FOUND AND v_lot.id IS NOT NULL THEN
      RETURN jsonb_build_object('ok', true, 'lot', to_jsonb(v_lot), 'matched_field', 'lot_code');
    END IF;

    -- 3. sticker_code — build the full "{op_code}:{raw}" form if we have an op code.
    IF v_op_code IS NOT NULL AND v_cand NOT LIKE '%:%' THEN
      v_sticker := v_op_code || ':' || v_cand;
      SELECT * INTO v_lot FROM public.lots
        WHERE sticker_code = v_sticker
        LIMIT 1;
      IF FOUND AND v_lot.id IS NOT NULL THEN
        RETURN jsonb_build_object('ok', true, 'lot', to_jsonb(v_lot), 'matched_field', 'sticker_code');
      END IF;
    END IF;

    -- 4. lpn (mig 0032) — unit-level, operator-scoped.
    SELECT * INTO v_lot FROM public.lots
      WHERE operator_id = v_op AND lpn = v_cand
      LIMIT 1;
    IF FOUND AND v_lot.id IS NOT NULL THEN
      RETURN jsonb_build_object('ok', true, 'lot', to_jsonb(v_lot), 'matched_field', 'lpn');
    END IF;

    -- 5. fnsku (mig 0032) — per-listing, operator-scoped.
    SELECT * INTO v_lot FROM public.lots
      WHERE operator_id = v_op AND fnsku = v_cand
      LIMIT 1;
    IF FOUND AND v_lot.id IS NOT NULL THEN
      RETURN jsonb_build_object('ok', true, 'lot', to_jsonb(v_lot), 'matched_field', 'fnsku');
    END IF;

    -- 6. asin (mig 0032) — per-product; prefer pending_intake if multiple.
    SELECT * INTO v_lot FROM public.lots
      WHERE operator_id = v_op AND asin = v_cand
      ORDER BY (status = 'pending_intake') DESC, created_at DESC
      LIMIT 1;
    IF FOUND AND v_lot.id IS NOT NULL THEN
      RETURN jsonb_build_object('ok', true, 'lot', to_jsonb(v_lot), 'matched_field', 'asin');
    END IF;

    -- 7. external_code (mig 0032) — operator-scoped catch-all.
    SELECT * INTO v_lot FROM public.lots
      WHERE operator_id = v_op AND external_code = v_cand
      LIMIT 1;
    IF FOUND AND v_lot.id IS NOT NULL THEN
      RETURN jsonb_build_object('ok', true, 'lot', to_jsonb(v_lot), 'matched_field', 'external_code');
    END IF;

  END LOOP;

  RETURN jsonb_build_object('ok', false, 'reason', 'lot_not_found');
END
$$;

REVOKE ALL ON FUNCTION public._find_lot_by_scan(TEXT[]) FROM public;
GRANT EXECUTE ON FUNCTION public._find_lot_by_scan(TEXT[]) TO authenticated;

COMMENT ON FUNCTION public._find_lot_by_scan(TEXT[]) IS
  '0160: operator-scoped lot lookup across a candidate array. '
  'Probes qr_token→lot_code→sticker_code→lpn→fnsku→asin→external_code; '
  'first match wins. Returns { ok, lot, matched_field } jsonb. '
  'Called by intake_lot_to_bin and any future scan-match surface.';

-- ===========================================================================
-- 2. find_import_row_by_scan(p_candidates TEXT[]) — universal manifest match.
-- ===========================================================================
-- Iterates over the candidate array, probing import_rows for a PENDING row
-- that matches any of the known identifier columns. First match wins.
--
-- Probe order (all operator-scoped, all status='pending' only):
--   1. tracking_number — preserves mig 0156 token-match (exact + space/comma tokens).
--      Length guard (>= 12) prevents short garbage scans from matching dirty
--      multi-tracking strings. ORDER BY exact DESC so exact beats token.
--   2. lpn (mig 0032)
--   3. fnsku (mig 0032)
--   4. asin (mig 0032) — prefer oldest pending row if multiple
--   5. upc (mig 0029) — digits-only normalized UPC-12/UPC-13
--   6. external_code (mig 0029) — operator's pre-existing identifier
--   7. pallet_id (mig 0032) — pallet-level scan fallback

CREATE OR REPLACE FUNCTION public.find_import_row_by_scan(
  p_candidates TEXT[]
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_op    UUID := public.current_operator_id();
  v_row   import_rows%ROWTYPE;
  v_cand  TEXT;
  v_clean TEXT;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  END IF;
  IF v_op IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_operator_staff');
  END IF;

  FOREACH v_cand IN ARRAY p_candidates LOOP
    v_clean := TRIM(v_cand);
    IF v_clean IS NULL OR LENGTH(v_clean) = 0 THEN
      CONTINUE;
    END IF;

    -- 1. tracking_number — mig 0156 token-match (exact first, token fallback).
    --    Exact match uses the import_rows_tracking_lookup partial index.
    --    Token match handles space/comma-separated dirty multi-tracking strings.
    --    Length guard prevents short tokens ('d', 'DD') from false-matching.
    SELECT * INTO v_row FROM public.import_rows
     WHERE operator_id = v_op
       AND status = 'pending'
       AND (
         tracking_number = v_clean
         OR (LENGTH(v_clean) >= 12 AND (
           tracking_number LIKE v_clean || ' %'
           OR tracking_number LIKE '% ' || v_clean
           OR tracking_number LIKE '% ' || v_clean || ' %'
           OR tracking_number LIKE v_clean || ',%'
           OR tracking_number LIKE '%,' || v_clean
           OR tracking_number LIKE '%,' || v_clean || ',%'
         ))
       )
     ORDER BY (tracking_number = v_clean) DESC, created_at ASC
     LIMIT 1;
    IF FOUND AND v_row.id IS NOT NULL THEN
      RETURN jsonb_build_object('ok', true, 'manifest_row', to_jsonb(v_row), 'matched_field', 'tracking_number');
    END IF;

    -- 2. lpn (mig 0032) — unit-level Amazon LPN.
    SELECT * INTO v_row FROM public.import_rows
     WHERE operator_id = v_op AND status = 'pending' AND lpn = v_clean
     ORDER BY created_at ASC LIMIT 1;
    IF FOUND AND v_row.id IS NOT NULL THEN
      RETURN jsonb_build_object('ok', true, 'manifest_row', to_jsonb(v_row), 'matched_field', 'lpn');
    END IF;

    -- 3. fnsku (mig 0032) — per-listing Amazon FNSKU.
    SELECT * INTO v_row FROM public.import_rows
     WHERE operator_id = v_op AND status = 'pending' AND fnsku = v_clean
     ORDER BY created_at ASC LIMIT 1;
    IF FOUND AND v_row.id IS NOT NULL THEN
      RETURN jsonb_build_object('ok', true, 'manifest_row', to_jsonb(v_row), 'matched_field', 'fnsku');
    END IF;

    -- 4. asin (mig 0032) — Amazon product ID; oldest pending row preferred.
    SELECT * INTO v_row FROM public.import_rows
     WHERE operator_id = v_op AND status = 'pending' AND asin = v_clean
     ORDER BY created_at ASC LIMIT 1;
    IF FOUND AND v_row.id IS NOT NULL THEN
      RETURN jsonb_build_object('ok', true, 'manifest_row', to_jsonb(v_row), 'matched_field', 'asin');
    END IF;

    -- 5. upc (mig 0029) — digits-only normalised UPC-12/EAN-13.
    SELECT * INTO v_row FROM public.import_rows
     WHERE operator_id = v_op AND status = 'pending' AND upc = v_clean
     ORDER BY created_at ASC LIMIT 1;
    IF FOUND AND v_row.id IS NOT NULL THEN
      RETURN jsonb_build_object('ok', true, 'manifest_row', to_jsonb(v_row), 'matched_field', 'upc');
    END IF;

    -- 6. external_code (mig 0029) — operator's pre-existing identifier.
    SELECT * INTO v_row FROM public.import_rows
     WHERE operator_id = v_op AND status = 'pending' AND external_code = v_clean
     ORDER BY created_at ASC LIMIT 1;
    IF FOUND AND v_row.id IS NOT NULL THEN
      RETURN jsonb_build_object('ok', true, 'manifest_row', to_jsonb(v_row), 'matched_field', 'external_code');
    END IF;

    -- 7. pallet_id (mig 0032) — pallet-level scan; may match multiple rows.
    --    Return oldest pending row as the representative.
    SELECT * INTO v_row FROM public.import_rows
     WHERE operator_id = v_op AND status = 'pending' AND pallet_id = v_clean
     ORDER BY created_at ASC LIMIT 1;
    IF FOUND AND v_row.id IS NOT NULL THEN
      RETURN jsonb_build_object('ok', true, 'manifest_row', to_jsonb(v_row), 'matched_field', 'pallet_id');
    END IF;

  END LOOP;

  RETURN jsonb_build_object('ok', false, 'reason', 'manifest_row_not_found');
END
$$;

REVOKE ALL ON FUNCTION public.find_import_row_by_scan(TEXT[]) FROM public;
GRANT EXECUTE ON FUNCTION public.find_import_row_by_scan(TEXT[]) TO authenticated;

COMMENT ON FUNCTION public.find_import_row_by_scan(TEXT[]) IS
  '0160: operator-scoped manifest lookup across a candidate array. '
  'Probes tracking_number (0156 token-match) → lpn → fnsku → asin → upc → external_code → pallet_id; '
  'first PENDING match wins. Returns { ok, manifest_row, matched_field } jsonb. '
  'Replaces the single-field find_import_row_by_tracking on new clients.';

-- ===========================================================================
-- 3. find_import_row_by_tracking(TEXT) shim
-- ===========================================================================
-- Retained for binary compatibility with TestFlight staff #54 (the in-review
-- binary calls the old single-argument RPC). Delegates to find_import_row_by_scan
-- so it gets the full 0156 token-match behaviour and the new multi-field fallbacks.
-- Safe to drop once staff #54 is superseded.

CREATE OR REPLACE FUNCTION public.find_import_row_by_tracking(p_tracking TEXT)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT public.find_import_row_by_scan(ARRAY[p_tracking]);
$$;

REVOKE ALL ON FUNCTION public.find_import_row_by_tracking(TEXT) FROM public;
GRANT EXECUTE ON FUNCTION public.find_import_row_by_tracking(TEXT) TO authenticated;

COMMENT ON FUNCTION public.find_import_row_by_tracking(TEXT) IS
  '0160 shim: delegates to find_import_row_by_scan(ARRAY[p_tracking]). '
  'Retained for TestFlight staff #54 binary compatibility; drop after that '
  'build is superseded.';

-- ===========================================================================
-- 4. intake_lot_to_bin — refactored to use _find_lot_by_scan.
-- ===========================================================================
-- Behaviour is IDENTICAL to mig 0143. The only change is that the inline
-- qr_token→lot_code→sticker_code→lpn→fnsku→asin→external_code probe is
-- replaced by a single call to _find_lot_by_scan(ARRAY[p_lot_identifier]).
-- All outcome codes (ok_intaked / ok_already_here / pending_move / error
-- codes) and the function signature are preserved verbatim.

CREATE OR REPLACE FUNCTION public.intake_lot_to_bin(
  p_lot_identifier TEXT,
  p_bin_qr_token   UUID
)
RETURNS intake_lot_result
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_op_id        UUID;
  v_lot          lots%ROWTYPE;
  v_bin          bins%ROWTYPE;
  v_bin_operator UUID;
  v_id_clean     TEXT := TRIM(p_lot_identifier);
  v_old_bin_id   UUID;
  v_old_bin_code TEXT;
  v_result       intake_lot_result;
  v_find         jsonb;
BEGIN
  IF auth.uid() IS NULL THEN
    v_result := (false, 'not_authenticated', NULL, NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;
  v_op_id := current_operator_id();
  IF v_op_id IS NULL THEN
    v_result := (false, 'not_operator_staff', NULL, NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;

  -- Resolve bin first (unchanged from mig 0143).
  SELECT * INTO v_bin FROM bins
   WHERE qr_token = p_bin_qr_token AND qr_revoked_at IS NULL
   LIMIT 1;
  IF NOT FOUND THEN
    v_result := (false, 'bin_not_found_or_revoked', NULL, NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;
  IF v_bin.retired_at IS NOT NULL THEN
    v_result := (false, 'bin_retired', NULL, NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;
  SELECT operator_id INTO v_bin_operator FROM warehouses WHERE id = v_bin.warehouse_id;
  IF v_bin_operator <> v_op_id THEN
    v_result := (false, 'bin_other_operator', NULL, NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;

  -- Resolve lot via shared helper (replaces inline 0143 probe).
  v_find := public._find_lot_by_scan(ARRAY[v_id_clean]);
  IF NOT (v_find->>'ok')::boolean THEN
    v_result := (false, 'not_lotted_yet', NULL, NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;

  -- Lock the resolved lot row; capture old bin BEFORE any UPDATE.
  SELECT * INTO v_lot FROM lots WHERE id = (v_find->'lot'->>'id')::UUID FOR UPDATE;
  IF v_lot.operator_id <> v_op_id THEN
    v_result := (false, 'lot_other_operator', NULL, NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;
  IF v_lot.status <> 'pending_intake' AND v_lot.status <> 'in_inventory' THEN
    v_result := (false, 'lot_not_in_intake_state', v_lot.id, v_lot.lot_code, NULL, NULL, NULL);
    RETURN v_result;
  END IF;

  v_old_bin_id := v_lot.intake_bin_id;

  -- Branch by outcome (identical to mig 0143).
  IF v_lot.status = 'pending_intake' THEN
    UPDATE lots
       SET status        = 'in_inventory',
           intake_bin_id = v_bin.id,
           warehouse_id  = v_bin.warehouse_id,
           intake_at     = now(),
           updated_at    = now()
     WHERE id = v_lot.id;
    v_result := (true, 'ok_intaked', v_lot.id, v_lot.lot_code, v_bin.code, v_bin.warehouse_id, NULL);
    RETURN v_result;
  END IF;

  -- Status is in_inventory at this point.
  IF v_old_bin_id IS NOT DISTINCT FROM v_bin.id THEN
    v_result := (true, 'ok_already_here', v_lot.id, v_lot.lot_code, v_bin.code, v_bin.warehouse_id, v_bin.code);
    RETURN v_result;
  END IF;

  SELECT code INTO v_old_bin_code FROM bins WHERE id = v_old_bin_id;
  v_result := (false, 'pending_move', v_lot.id, v_lot.lot_code, v_bin.code, v_bin.warehouse_id, v_old_bin_code);
  RETURN v_result;
END
$$;

REVOKE ALL ON FUNCTION public.intake_lot_to_bin(TEXT, UUID) FROM public;
GRANT EXECUTE ON FUNCTION public.intake_lot_to_bin(TEXT, UUID) TO authenticated;

COMMENT ON FUNCTION public.intake_lot_to_bin(TEXT, UUID) IS
  '0160: refactored to delegate lot resolution to _find_lot_by_scan(). '
  'Behaviour is identical to mig 0143 (ok_intaked / ok_already_here / '
  'pending_move outcome codes unchanged). Resolution ladder is now shared '
  'with find_import_row_by_scan: qr_token→lot_code→sticker_code→lpn→fnsku→asin→external_code.';
