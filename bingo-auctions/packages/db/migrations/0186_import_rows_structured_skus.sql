-- migration 0186 — structured SKU / identifier columns on import_rows + matcher probes
--
-- WHY (June-4 tester blocker #1 + operator multi-vendor importer plan, Stream A)
-- ---------------------------------------------------------------------------
-- BinGo's pending Wayfair manifest rows carry their product identifiers
-- (ProductSKU / SiteSKU / ManufactureSKU + CatalogID / OrderID / PONumber /
-- SKUActive / ReturnCarrier) ONLY inside raw_data JSONB. import_rows had no
-- queryable column for them, and find_import_row_by_scan (live = mig 0163)
-- never probed them — so scanning a product SKU at intake always returned
-- manifest_row_not_found. Only tracking-number scans matched (the tester's
-- "2 of N worked"). Confirmed in prod: 18,933/18,933 pending BinGo rows carry
-- ProductSKU, 18,596 SiteSKU, 18,846 ManufactureSKU.
--
-- This migration is FORMAT-COUPLED, NOT vendor-coupled (per owner guardrail):
-- the columns model a cross-vendor identifier family — Wayfair ProductSKU,
-- Walmart/Lowe's SKU, Amazon MSKU (product_sku); Wayfair SiteSKU / Amazon
-- merchant SKU (site_sku); Wayfair ManufactureSKU / Lowe's-Walmart Model / MPN
-- (manufacture_sku); etc. No vendor name appears in schema or matcher.
--
-- Pairs with:
--   * 0187_backfill_structured_skus.sql — populates these columns on the
--     EXISTING 18,933 pending rows from raw_data (no re-import needed).
--   * importer follow-up PR — ImportWizard/commitImport write these on NEW
--     imports (so future manifests don't depend on a backfill).
-- ============================================================================

-- ── 1. Columns ──────────────────────────────────────────────────────────────
-- All nullable, additive. IF NOT EXISTS keeps this re-runnable.
ALTER TABLE public.import_rows
  ADD COLUMN IF NOT EXISTS product_sku         TEXT,
  ADD COLUMN IF NOT EXISTS site_sku            TEXT,
  ADD COLUMN IF NOT EXISTS manufacture_sku     TEXT,
  ADD COLUMN IF NOT EXISTS catalog_id          TEXT,
  ADD COLUMN IF NOT EXISTS sku_active          BOOLEAN,
  ADD COLUMN IF NOT EXISTS order_id            TEXT,
  ADD COLUMN IF NOT EXISTS po_number           TEXT,
  ADD COLUMN IF NOT EXISTS return_carrier      TEXT,
  ADD COLUMN IF NOT EXISTS return_initiated_at TIMESTAMPTZ;

-- ── 2. Indexes ───────────────────────────────────────────────────────────────
-- Partial indexes mirror import_rows_tracking_lookup: operator-scoped, the
-- matcher's status='pending' predicate baked in, value not-null. These back the
-- new SKU probes in find_import_row_by_scan (the scannable identifiers).
-- order_id has no 'pending' filter — it is a reporting/dedup key, not a scan
-- probe, so the broader partial index serves both pending + lotted lookups.
CREATE INDEX IF NOT EXISTS import_rows_product_sku_lookup
  ON public.import_rows (operator_id, product_sku)
  WHERE status = 'pending' AND product_sku IS NOT NULL;
CREATE INDEX IF NOT EXISTS import_rows_site_sku_lookup
  ON public.import_rows (operator_id, site_sku)
  WHERE status = 'pending' AND site_sku IS NOT NULL;
CREATE INDEX IF NOT EXISTS import_rows_manufacture_sku_lookup
  ON public.import_rows (operator_id, manufacture_sku)
  WHERE status = 'pending' AND manufacture_sku IS NOT NULL;
CREATE INDEX IF NOT EXISTS import_rows_catalog_id_lookup
  ON public.import_rows (operator_id, catalog_id)
  WHERE status = 'pending' AND catalog_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS import_rows_order_id_idx
  ON public.import_rows (operator_id, order_id)
  WHERE order_id IS NOT NULL;

-- ── 3. Matcher: add SKU probes ───────────────────────────────────────────────
-- CREATE OR REPLACE preserves the signature, grants, SECURITY DEFINER + search
-- path. Body is verbatim from the live definition (mig 0163) EXCEPT three new
-- item-level probes (8/9/10) appended after pallet_id, inside the
-- "v_inner = v_clean only" block. SKUs are NOT expanded as composites and a
-- manifest can carry multiple units of one SKU, so each probes the original
-- candidate and takes the oldest pending row (mirrors the asin probe).
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
END $function$;
