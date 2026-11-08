-- rollback for 0386: the two find_import_row_by_scan bodies exactly as they ran on prod
-- before 0386 (pulled with scripts/prod-rig/pull-prod-functions.sql on 2026-10-05),
-- plus removal of the partial index 0386 adds. Apply with the migration workflow
-- in rerun mode, or psql. Tested on the rig the same day.
BEGIN;
CREATE OR REPLACE FUNCTION public.find_import_row_by_scan(p_candidates text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

    -- (0163): server-side candidate expansion. Even if the client sends
    -- only the raw 34-digit composite, we probe with the last-12 suffix too.
    v_expanded := public._normalize_scan_candidates(v_clean);

    FOREACH v_inner IN ARRAY v_expanded LOOP

      -- 1. tracking_number — exact match (fast, hits import_rows_tracking_lookup)
      --    + mig 0156 token-LIKE fallback.
      SELECT * INTO v_row FROM public.import_rows
       WHERE operator_id = v_op
         AND status = 'pending'
         AND (
           tracking_number = v_inner
           OR (LENGTH(v_inner) >= 12 AND (
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

      -- 2-10: probe non-tracking columns only on the ORIGINAL v_clean candidate.
      -- A digit-suffix variant of a 34-digit FedEx composite would otherwise
      -- false-match against e.g. a 12-digit UPC or a short SKU with no
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

      -- 8. product_sku (0186) — Wayfair ProductSKU, Walmart/Lowe's SKU, Amazon
      --    MSKU. Item-level identifier printed on the product label: the
      --    June-4 tester's primary intake scan. Oldest pending row wins
      --    (a manifest can carry multiple units of the same SKU).
      SELECT * INTO v_row FROM public.import_rows
       WHERE operator_id = v_op AND status = 'pending' AND product_sku = v_clean
       ORDER BY created_at ASC
       LIMIT 1;
      IF FOUND AND v_row.id IS NOT NULL THEN
        RETURN jsonb_build_object('ok', true, 'manifest_row', to_jsonb(v_row),
                                  'matched_field', 'product_sku');
      END IF;

      -- 9. site_sku (0186) — Wayfair SiteSKU / Amazon merchant SKU
      SELECT * INTO v_row FROM public.import_rows
       WHERE operator_id = v_op AND status = 'pending' AND site_sku = v_clean
       ORDER BY created_at ASC
       LIMIT 1;
      IF FOUND AND v_row.id IS NOT NULL THEN
        RETURN jsonb_build_object('ok', true, 'manifest_row', to_jsonb(v_row),
                                  'matched_field', 'site_sku');
      END IF;

      -- 10. manufacture_sku (0186) — Wayfair ManufactureSKU / Lowe's-Walmart
      --     Model / MPN, often the manufacturer barcode on the physical box.
      SELECT * INTO v_row FROM public.import_rows
       WHERE operator_id = v_op AND status = 'pending' AND manufacture_sku = v_clean
       ORDER BY created_at ASC
       LIMIT 1;
      IF FOUND AND v_row.id IS NOT NULL THEN
        RETURN jsonb_build_object('ok', true, 'manifest_row', to_jsonb(v_row),
                                  'matched_field', 'manufacture_sku');
      END IF;

    END LOOP; -- v_expanded

  END LOOP; -- p_candidates

  RETURN jsonb_build_object('ok', false, 'reason', 'manifest_row_not_found');
END $function$
;

CREATE OR REPLACE FUNCTION public.find_import_row_by_scan(p_candidates text[], p_kind text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_op       UUID := public.current_operator_id();
  v_kind     TEXT := lower(trim(COALESCE(p_kind, 'auto')));
  v_row      import_rows%ROWTYPE;
  v_cand     TEXT;
  v_clean    TEXT;
  v_expanded TEXT[];
  v_inner    TEXT;
BEGIN
  -- 'auto' (and NULL) → delegate to the canonical multi-column matcher (0186)
  -- VERBATIM. Done before the auth/operator guards because the 1-arg body
  -- performs them itself — re-checking here would be redundant, and delegating
  -- first guarantees zero behavioural drift from the default path.
  IF v_kind = 'auto' THEN
    RETURN public.find_import_row_by_scan(p_candidates);
  END IF;

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

    -- ── tracking: suffix-expanded + token-LIKE fallback (mirrors 0186 probe #1)
    IF v_kind = 'tracking' THEN
      -- Server-side candidate expansion (0163): even if the client sends only
      -- the raw 34-digit composite, probe the last-12 suffix too.
      v_expanded := public._normalize_scan_candidates(v_clean);
      FOREACH v_inner IN ARRAY v_expanded LOOP
        SELECT * INTO v_row FROM public.import_rows
         WHERE operator_id = v_op
           AND status = 'pending'
           AND (
             tracking_number = v_inner
             OR (LENGTH(v_inner) >= 12 AND (
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
      END LOOP; -- v_expanded
      CONTINUE; -- next candidate; tracking kind never falls through to ID probes
    END IF;

    -- ── ID kinds: match the RAW trimmed candidate only (no suffix expansion).
    -- One scoped probe per kind. Oldest pending row wins for the columns that
    -- can legitimately repeat across units (asin/product_sku/site_sku/
    -- manufacture_sku), matching 0186; the unique-ish identity columns
    -- (upc/fnsku/lpn/external_code/pallet_id/catalog_id) take a bare LIMIT 1.
    CASE v_kind
      WHEN 'upc' THEN
        SELECT * INTO v_row FROM public.import_rows
         WHERE operator_id = v_op AND status = 'pending' AND upc = v_clean
         LIMIT 1;
        IF FOUND AND v_row.id IS NOT NULL THEN
          RETURN jsonb_build_object('ok', true, 'manifest_row', to_jsonb(v_row),
                                    'matched_field', 'upc');
        END IF;

      WHEN 'asin' THEN
        SELECT * INTO v_row FROM public.import_rows
         WHERE operator_id = v_op AND status = 'pending' AND asin = v_clean
         ORDER BY created_at ASC
         LIMIT 1;
        IF FOUND AND v_row.id IS NOT NULL THEN
          RETURN jsonb_build_object('ok', true, 'manifest_row', to_jsonb(v_row),
                                    'matched_field', 'asin');
        END IF;

      WHEN 'fnsku' THEN
        SELECT * INTO v_row FROM public.import_rows
         WHERE operator_id = v_op AND status = 'pending' AND fnsku = v_clean
         LIMIT 1;
        IF FOUND AND v_row.id IS NOT NULL THEN
          RETURN jsonb_build_object('ok', true, 'manifest_row', to_jsonb(v_row),
                                    'matched_field', 'fnsku');
        END IF;

      WHEN 'lpn' THEN
        SELECT * INTO v_row FROM public.import_rows
         WHERE operator_id = v_op AND status = 'pending' AND lpn = v_clean
         LIMIT 1;
        IF FOUND AND v_row.id IS NOT NULL THEN
          RETURN jsonb_build_object('ok', true, 'manifest_row', to_jsonb(v_row),
                                    'matched_field', 'lpn');
        END IF;

      WHEN 'external_code' THEN
        SELECT * INTO v_row FROM public.import_rows
         WHERE operator_id = v_op AND status = 'pending' AND external_code = v_clean
         LIMIT 1;
        IF FOUND AND v_row.id IS NOT NULL THEN
          RETURN jsonb_build_object('ok', true, 'manifest_row', to_jsonb(v_row),
                                    'matched_field', 'external_code');
        END IF;

      WHEN 'pallet' THEN
        SELECT * INTO v_row FROM public.import_rows
         WHERE operator_id = v_op AND status = 'pending' AND pallet_id = v_clean
         LIMIT 1;
        IF FOUND AND v_row.id IS NOT NULL THEN
          RETURN jsonb_build_object('ok', true, 'manifest_row', to_jsonb(v_row),
                                    'matched_field', 'pallet_id');
        END IF;

      WHEN 'product_sku' THEN
        SELECT * INTO v_row FROM public.import_rows
         WHERE operator_id = v_op AND status = 'pending' AND product_sku = v_clean
         ORDER BY created_at ASC
         LIMIT 1;
        IF FOUND AND v_row.id IS NOT NULL THEN
          RETURN jsonb_build_object('ok', true, 'manifest_row', to_jsonb(v_row),
                                    'matched_field', 'product_sku');
        END IF;

      WHEN 'site_sku' THEN
        SELECT * INTO v_row FROM public.import_rows
         WHERE operator_id = v_op AND status = 'pending' AND site_sku = v_clean
         ORDER BY created_at ASC
         LIMIT 1;
        IF FOUND AND v_row.id IS NOT NULL THEN
          RETURN jsonb_build_object('ok', true, 'manifest_row', to_jsonb(v_row),
                                    'matched_field', 'site_sku');
        END IF;

      -- 'manufacture_sku' and 'model' both resolve to the manufacture_sku column
      -- (the manufacturer Model / MPN is stored there per 0186), mirroring how
      -- 0189 folds 'model' onto lots.model/mpn.
      WHEN 'manufacture_sku', 'model' THEN
        SELECT * INTO v_row FROM public.import_rows
         WHERE operator_id = v_op AND status = 'pending' AND manufacture_sku = v_clean
         ORDER BY created_at ASC
         LIMIT 1;
        IF FOUND AND v_row.id IS NOT NULL THEN
          RETURN jsonb_build_object('ok', true, 'manifest_row', to_jsonb(v_row),
                                    'matched_field', 'manufacture_sku');
        END IF;

      WHEN 'catalog' THEN
        SELECT * INTO v_row FROM public.import_rows
         WHERE operator_id = v_op AND status = 'pending' AND catalog_id = v_clean
         LIMIT 1;
        IF FOUND AND v_row.id IS NOT NULL THEN
          RETURN jsonb_build_object('ok', true, 'manifest_row', to_jsonb(v_row),
                                    'matched_field', 'catalog_id');
        END IF;

      ELSE
        -- Unrecognised explicit kind: no column to probe. Don't silently fall
        -- back to multi-column (the caller asked to scope) — just no-match.
        NULL;
    END CASE;

  END LOOP; -- p_candidates

  RETURN jsonb_build_object('ok', false, 'reason', 'manifest_row_not_found');
END $function$
;

DROP INDEX IF EXISTS public.import_rows_tracking_list_idx;
COMMIT;
