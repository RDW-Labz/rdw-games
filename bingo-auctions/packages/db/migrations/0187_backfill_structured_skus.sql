-- migration 0187 — backfill 0186 structured columns from raw_data (existing rows)
--
-- WHY
-- ---
-- 0186 added product_sku / site_sku / manufacture_sku / catalog_id / order_id /
-- po_number / return_carrier / sku_active and taught find_import_row_by_scan to
-- probe the SKUs. But BinGo's 18,933 pending rows were imported BEFORE those
-- columns existed — their identifiers live only in raw_data JSONB. This one-off
-- data migration lifts them into the structured columns so the matcher can find
-- them with NO re-import. The follow-up importer PR writes these columns on new
-- imports; this covers everything already in the table.
--
-- IDEMPOTENT + SAFE
-- -----------------
--  * COALESCE(col, …) never overwrites a value that's already set.
--  * WHERE (… IS NULL) limits the write to rows that still need it (re-runnable).
--  * NULLIF(TRIM(…),'') treats blank/whitespace JSON values as absent.
--  * raw_data ?| ARRAY[…] restricts the scan to rows that actually carry one of
--    the keys (no-op for non-Wayfair-shaped manifests).
--  * Format-coupled to the EXACT keys confirmed present in prod. Vendor-variant
--    key fallback (productsku / mainsku / mpn / …) is deferred to the importer's
--    vendor-aware mapping (operator plan Stream B) — not needed for this data.
--  * return_initiated_at is intentionally NOT backfilled here: its source
--    (ReturnInitiatedDate) has no guaranteed parseable format, so the importer
--    parses it with proper validation rather than risk a cast error mid-migration.
-- ============================================================================

UPDATE public.import_rows
   SET product_sku     = COALESCE(product_sku,     NULLIF(TRIM(raw_data->>'ProductSKU'),     '')),
       site_sku        = COALESCE(site_sku,        NULLIF(TRIM(raw_data->>'SiteSKU'),        '')),
       manufacture_sku = COALESCE(manufacture_sku, NULLIF(TRIM(raw_data->>'ManufactureSKU'), '')),
       catalog_id      = COALESCE(catalog_id,      NULLIF(TRIM(raw_data->>'CatalogID'),      '')),
       order_id        = COALESCE(order_id,        NULLIF(TRIM(raw_data->>'OrderID'),        '')),
       po_number       = COALESCE(po_number,       NULLIF(TRIM(raw_data->>'PONumber'),       '')),
       return_carrier  = COALESCE(return_carrier,  NULLIF(TRIM(raw_data->>'ReturnCarrier'),  '')),
       sku_active      = COALESCE(sku_active,
                           CASE lower(NULLIF(TRIM(raw_data->>'SKUActive'), ''))
                             WHEN 'true'     THEN TRUE
                             WHEN '1'        THEN TRUE
                             WHEN 'yes'      THEN TRUE
                             WHEN 'y'        THEN TRUE
                             WHEN 'active'   THEN TRUE
                             WHEN 'false'    THEN FALSE
                             WHEN '0'        THEN FALSE
                             WHEN 'no'       THEN FALSE
                             WHEN 'n'        THEN FALSE
                             WHEN 'inactive' THEN FALSE
                             ELSE NULL
                           END)
 WHERE raw_data IS NOT NULL
   AND raw_data ?| ARRAY['ProductSKU','SiteSKU','ManufactureSKU','CatalogID','OrderID','PONumber','ReturnCarrier','SKUActive']
   AND (
         product_sku IS NULL OR site_sku IS NULL OR manufacture_sku IS NULL
      OR catalog_id IS NULL OR order_id IS NULL OR po_number IS NULL
      OR return_carrier IS NULL OR sku_active IS NULL
   );
