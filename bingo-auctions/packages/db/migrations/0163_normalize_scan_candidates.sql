-- 0163_normalize_scan_candidates.sql
--
-- Make scan→manifest matching resilient to ANY client variant by moving the
-- composite-barcode extraction server-side, and clean the ~97 dirty BinGo
-- import_rows from the 2026-05-28 Wayfair manifest in one go.
--
-- WHY:
--   The client-side extractor (packages/scan-extract) emits last-12 suffix
--   candidates for 20-40 digit composites. That works when the right JS
--   bundle reaches the phone via OTA. It doesn't work when the bundle is
--   stale (a real failure on 2026-05-30 — staff TestFlight #54 was on a
--   pre-PR-#138 bundle and rejected `itf-14` symbology). The server should
--   not depend on what JS the client is running. Hence: expand candidates
--   server-side too.
--
-- WHAT:
--   1. NEW `public._normalize_scan_candidates(p_scan TEXT) -> TEXT[]`
--      Expands one raw scan to: raw + digits-only + right(digits, N) for
--      N in {22, 20, 18, 16, 14, 12}. Skips UPS shape (`1Z` + 16 alphanumeric)
--      whose stored value IS the full 18-char string.
--
--   2. MODIFIED `public.find_import_row_by_scan(TEXT[]) -> jsonb`
--      Calls _normalize_scan_candidates on every input candidate and probes
--      all expansions against tracking_number. Non-tracking probes
--      (lpn/fnsku/asin/upc/external_code/pallet_id) only fire on the ORIGINAL
--      v_clean candidate — not on digit-suffix variants — to prevent false
--      positives on short numeric IDs.
--
--   3. DATA MIGRATION (DO block at end)
--      For every `import_rows` row where `tracking_number` has internal
--      whitespace AND status='pending', split on `[\s,]+`, filter to 12-14
--      digit tokens, UPDATE the original to the first token, INSERT
--      siblings for additional tokens. Use ON CONFLICT (operator_id,
--      tracking_number) DO NOTHING so a re-import that already added a
--      clean row doesn't break the migration.
--
-- SAFETY:
--   - `find_import_row_by_tracking(TEXT)` shim from 0160 is untouched and
--     automatically gains expansion (it delegates to find_import_row_by_scan).
--     The in-review iOS staff #54 binary keeps working unchanged.
--   - `_find_lot_by_scan` (0160) is untouched.
--   - DELETE is never used on import_rows — UPDATE + INSERT preserves the
--     `lots.import_row_id` FK back-pointer for any row already lotted.
--   - mig 0156's 6-arm token-LIKE fallback in find_import_row_by_scan is
--     RETAINED with a TODO marker. Drop in 0164 after 7 days prod stability.

-- ===========================================================================
-- 1. _normalize_scan_candidates(p_scan TEXT) — server-side candidate expander
-- ===========================================================================

CREATE OR REPLACE FUNCTION public._normalize_scan_candidates(p_scan TEXT)
RETURNS TEXT[]
LANGUAGE plpgsql IMMUTABLE STRICT PARALLEL SAFE
SET search_path = public
AS $$
DECLARE
  v_trim    TEXT;
  v_digits  TEXT;
  v_len     INT;
  v_n       INT;
  v_seen    TEXT[] := ARRAY[]::TEXT[];
  v_result  TEXT[] := ARRAY[]::TEXT[];
  v_suf     TEXT;
BEGIN
  -- 1. Raw value always first, exact as supplied (preserves catalog lookups
  --    that key on UUIDs / non-numeric identifiers).
  v_seen   := array_append(v_seen, p_scan);
  v_result := array_append(v_result, p_scan);

  v_trim := trim(p_scan);

  -- 2. UPS shape (1Z + 16 alphanumeric, 18 chars total) — the raw IS the
  --    tracking. Do NOT emit digit-suffix variants; the trailing 12 chars
  --    of a UPS code are meaningless on their own and would collide with
  --    a different 12-digit FedEx tracking under the same operator.
  IF v_trim ~ '^1Z[A-Z0-9]{16}$' THEN
    IF NOT (v_trim = ANY(v_seen)) THEN
      v_seen   := array_append(v_seen, v_trim);
      v_result := array_append(v_result, v_trim);
    END IF;
    RETURN v_result;
  END IF;

  -- 3. Digits-only normalized version (strip non-numeric so GS1-128 prefixes,
  --    SSCC AIs, and stray spaces collapse to a pure digit string).
  v_digits := regexp_replace(v_trim, '[^0-9]', '', 'g');
  IF length(v_digits) > 0 AND NOT (v_digits = ANY(v_seen)) THEN
    v_seen   := array_append(v_seen, v_digits);
    v_result := array_append(v_result, v_digits);
  END IF;

  v_len := length(v_digits);

  -- 4. right(digits, N) suffix candidates, longest-first.
  --    Covers FedEx Ground 96-bit outer-pack (34-digit composite carrying the
  --    12-digit human-readable suffix), 22-digit SSCC, 20-22-digit USPS IMpb,
  --    and any shipper that wraps a 12-digit core in 14/16/18/20-digit AI
  --    fields. We only emit a suffix when the digits string is STRICTLY
  --    longer than N (skipping equal-length avoids emitting a duplicate of
  --    v_digits itself).
  FOREACH v_n IN ARRAY ARRAY[22, 20, 18, 16, 14, 12] LOOP
    IF v_len > v_n THEN
      v_suf := right(v_digits, v_n);
      IF NOT (v_suf = ANY(v_seen)) THEN
        v_seen   := array_append(v_seen, v_suf);
        v_result := array_append(v_result, v_suf);
      END IF;
    END IF;
  END LOOP;

  RETURN v_result;
END $$;

REVOKE ALL ON FUNCTION public._normalize_scan_candidates(TEXT) FROM public;
GRANT EXECUTE ON FUNCTION public._normalize_scan_candidates(TEXT) TO authenticated;

COMMENT ON FUNCTION public._normalize_scan_candidates(TEXT) IS
  '0163: expand one raw scan into deduped candidates: raw + digits-only + '
  'right(digits,N) for N in {22,20,18,16,14,12}. Skips UPS shape '
  '(1Z + 16 alphanumeric) which stores as full 18-char value.';

-- ===========================================================================
-- 2. find_import_row_by_scan(TEXT[]) — adds server-side expansion + tightens
--    non-tracking probes to original candidate only.
-- ===========================================================================
-- Probe order (preserved from 0160):
--   1. tracking_number (mig 0156 token-LIKE retained; TODO drop in 0164)
--   2. lpn
--   3. fnsku
--   4. asin
--   5. upc
--   6. external_code
--   7. pallet_id

CREATE OR REPLACE FUNCTION public.find_import_row_by_scan(
  p_candidates TEXT[]
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_op       UUID := public.current_operator_id();
  v_row      import_rows%ROWTYPE;
  v_cand     TEXT;
  v_clean    TEXT;
  v_expanded TEXT[];
  v_inner    TEXT;
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

    -- NEW (0163): server-side candidate expansion. Even if the client sends
    -- only the raw 34-digit composite, we probe with the last-12 suffix too.
    v_expanded := public._normalize_scan_candidates(v_clean);

    FOREACH v_inner IN ARRAY v_expanded LOOP

      -- 1. tracking_number — exact match (fast, hits import_rows_tracking_lookup)
      --    + mig 0156 token-LIKE fallback. After 0163's data migration cleans
      --    the 97 dirty BinGo rows the LIKE arms are dead code; mark for
      --    removal in 0164 once we've verified 7 days of prod stability.
      SELECT * INTO v_row FROM public.import_rows
       WHERE operator_id = v_op
         AND status = 'pending'
         AND (
           tracking_number = v_inner
           OR (LENGTH(v_inner) >= 12 AND (
             -- TODO(0164): drop the 6-arm token-LIKE fallback once C2 verified.
             tracking_number LIKE v_inner || ' %'
             OR tracking_number LIKE '% ' || v_inner
             OR tracking_number LIKE '% ' || v_inner || ' %'
             OR tracking_number LIKE v_inner || ',%'
             OR tracking_number LIKE '%,' || v_inner
             OR tracking_number LIKE '%,' || v_inner || ',%'
           ))
         )
       ORDER BY (tracking_number = v_inner) DESC, created_at ASC
       LIMIT 1;
      IF FOUND AND v_row.id IS NOT NULL THEN
        RETURN jsonb_build_object('ok', true, 'manifest_row', to_jsonb(v_row),
                                  'matched_field', 'tracking_number');
      END IF;

      -- 2-7: probe non-tracking columns only on the ORIGINAL v_clean candidate.
      -- A digit-suffix variant of a 34-digit FedEx composite would otherwise
      -- false-match against e.g. a 12-digit UPC or external_code with no
      -- relationship to the scanned package.
      CONTINUE WHEN v_inner <> v_clean;

      -- 2. lpn (Amazon License Plate Number — unit-level identifier)
      SELECT * INTO v_row FROM public.import_rows
       WHERE operator_id = v_op AND status = 'pending' AND lpn = v_clean
       LIMIT 1;
      IF FOUND AND v_row.id IS NOT NULL THEN
        RETURN jsonb_build_object('ok', true, 'manifest_row', to_jsonb(v_row),
                                  'matched_field', 'lpn');
      END IF;

      -- 3. fnsku (Amazon Fulfillment Network SKU — per-listing)
      SELECT * INTO v_row FROM public.import_rows
       WHERE operator_id = v_op AND status = 'pending' AND fnsku = v_clean
       LIMIT 1;
      IF FOUND AND v_row.id IS NOT NULL THEN
        RETURN jsonb_build_object('ok', true, 'manifest_row', to_jsonb(v_row),
                                  'matched_field', 'fnsku');
      END IF;

      -- 4. asin (Amazon product identifier — oldest pending row wins)
      SELECT * INTO v_row FROM public.import_rows
       WHERE operator_id = v_op AND status = 'pending' AND asin = v_clean
       ORDER BY created_at ASC
       LIMIT 1;
      IF FOUND AND v_row.id IS NOT NULL THEN
        RETURN jsonb_build_object('ok', true, 'manifest_row', to_jsonb(v_row),
                                  'matched_field', 'asin');
      END IF;

      -- 5. upc (digits-only UPC-12/UPC-13)
      SELECT * INTO v_row FROM public.import_rows
       WHERE operator_id = v_op AND status = 'pending' AND upc = v_clean
       LIMIT 1;
      IF FOUND AND v_row.id IS NOT NULL THEN
        RETURN jsonb_build_object('ok', true, 'manifest_row', to_jsonb(v_row),
                                  'matched_field', 'upc');
      END IF;

      -- 6. external_code (operator's pre-existing identifier)
      SELECT * INTO v_row FROM public.import_rows
       WHERE operator_id = v_op AND status = 'pending' AND external_code = v_clean
       LIMIT 1;
      IF FOUND AND v_row.id IS NOT NULL THEN
        RETURN jsonb_build_object('ok', true, 'manifest_row', to_jsonb(v_row),
                                  'matched_field', 'external_code');
      END IF;

      -- 7. pallet_id (pallet-level scan fallback)
      SELECT * INTO v_row FROM public.import_rows
       WHERE operator_id = v_op AND status = 'pending' AND pallet_id = v_clean
       LIMIT 1;
      IF FOUND AND v_row.id IS NOT NULL THEN
        RETURN jsonb_build_object('ok', true, 'manifest_row', to_jsonb(v_row),
                                  'matched_field', 'pallet_id');
      END IF;

    END LOOP; -- v_expanded

  END LOOP; -- p_candidates

  RETURN jsonb_build_object('ok', false, 'reason', 'manifest_row_not_found');
END $$;

REVOKE ALL ON FUNCTION public.find_import_row_by_scan(TEXT[]) FROM public;
GRANT EXECUTE ON FUNCTION public.find_import_row_by_scan(TEXT[]) TO authenticated;

COMMENT ON FUNCTION public.find_import_row_by_scan(TEXT[]) IS
  '0163: operator-scoped manifest match across a candidate array, with '
  'server-side normalization (digit-suffix expansion for composite barcodes). '
  'Non-tracking probes (lpn/fnsku/asin/upc/external_code/pallet_id) fire only '
  'on the original candidate, not on digit-suffix variants. '
  'Returns {ok, manifest_row, matched_field} on hit; {ok:false, reason} otherwise.';

-- ===========================================================================
-- 3. DATA MIGRATION — split dirty multi-tracking rows
-- ===========================================================================
-- Splits every row where tracking_number contains internal whitespace into
-- one-clean-token-per-row. Idempotent: the WHERE clause selects zero rows
-- on second run (all dirty rows updated to single-token values the first
-- time). Uses ON CONFLICT (operator_id, tracking_number) DO NOTHING so
-- sibling inserts don't fail if a clean token already exists from a
-- subsequent import.

DO $$
DECLARE
  v_dirty   RECORD;
  v_tokens  TEXT[];
  v_first   TEXT;
  v_n       INT;
  v_total   INT := 0;
  v_dirty_count INT := 0;
  i         INT;
BEGIN
  FOR v_dirty IN
    SELECT id, operator_id, import_id, raw_data, title, description, brand,
           model, category_raw, sub_category_raw, category_id, upc, asin,
           fnsku, lpn, external_code, pallet_id, quantity, msrp_cents,
           cost_cents, starting_bid_cents, photo_url, condition,
           return_reason, tracking_number, warehouse_id, status, created_at
    FROM public.import_rows
    WHERE tracking_number IS NOT NULL
      AND tracking_number ~ '\s'      -- has internal whitespace = "dirty"
      AND status = 'pending'
    FOR UPDATE
  LOOP
    v_dirty_count := v_dirty_count + 1;

    -- Split on whitespace or comma, filter to 12-14 digit tokens.
    SELECT array_agg(tok ORDER BY ord) INTO v_tokens
    FROM (
      SELECT trim(t) AS tok, row_number() OVER () AS ord
      FROM regexp_split_to_table(v_dirty.tracking_number, '[\s,]+') AS t
      WHERE trim(t) ~ '^\d{12,14}$'
    ) sub;

    IF v_tokens IS NULL OR array_length(v_tokens, 1) = 0 THEN
      -- Cell had whitespace but no valid token (e.g. "d/d courtesy" only).
      -- Null out so the row stops being a scan-match candidate.
      UPDATE public.import_rows SET tracking_number = NULL WHERE id = v_dirty.id;
      CONTINUE;
    END IF;

    v_first := v_tokens[1];
    v_n     := array_length(v_tokens, 1);

    -- Update original row to first valid token (preserves lots.import_row_id FK).
    -- Use a guard: if a row with this clean token already exists for the
    -- operator (collision with a later clean import), null out instead.
    BEGIN
      UPDATE public.import_rows
         SET tracking_number = v_first
       WHERE id = v_dirty.id;
    EXCEPTION WHEN unique_violation THEN
      UPDATE public.import_rows SET tracking_number = NULL WHERE id = v_dirty.id;
      RAISE NOTICE '0163: row % first-token collision on %, nulled', v_dirty.id, v_first;
      CONTINUE;
    END;

    -- Insert siblings for tokens 2..N. ON CONFLICT handles cases where a
    -- subsequent clean import already added the token as its own row.
    FOR i IN 2..v_n LOOP
      INSERT INTO public.import_rows (
        id, operator_id, import_id, raw_data, title, description, brand,
        model, category_raw, sub_category_raw, category_id, upc, asin,
        fnsku, lpn, external_code, pallet_id, quantity, msrp_cents,
        cost_cents, starting_bid_cents, photo_url, condition,
        return_reason, tracking_number, warehouse_id, status, created_at
      ) VALUES (
        gen_random_uuid(),
        v_dirty.operator_id, v_dirty.import_id, v_dirty.raw_data,
        v_dirty.title, v_dirty.description, v_dirty.brand, v_dirty.model,
        v_dirty.category_raw, v_dirty.sub_category_raw, v_dirty.category_id,
        v_dirty.upc, v_dirty.asin, v_dirty.fnsku, v_dirty.lpn,
        v_dirty.external_code, v_dirty.pallet_id, v_dirty.quantity,
        v_dirty.msrp_cents, v_dirty.cost_cents, v_dirty.starting_bid_cents,
        v_dirty.photo_url, v_dirty.condition, v_dirty.return_reason,
        v_tokens[i],
        v_dirty.warehouse_id, v_dirty.status, v_dirty.created_at
      )
      ON CONFLICT (operator_id, tracking_number) DO NOTHING;
      v_total := v_total + 1;
    END LOOP;
  END LOOP;

  RAISE NOTICE '0163 data migration: scanned % dirty rows, inserted % siblings',
               v_dirty_count, v_total;
END $$;
