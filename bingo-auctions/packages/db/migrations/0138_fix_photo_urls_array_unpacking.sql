-- ============================================================================
-- Migration 0138 — fix photo_urls array unpacking in bulk_import_lots
--
-- The 0137 RPC has a subtle bug: passing photo_urls as a JSONB array
-- ['a','b'] from the import script results in an empty array landing on
-- the lots row. Verified via isolated probe:
--   p_rows[0].photo_urls = ['https://x/a.jpg', 'https://x/b.jpg']
--   → SELECT photo_urls FROM lots WHERE lot_code = ...  →  []
--
-- The original code used `SELECT ... INTO v_photo_urls FROM ... WHERE`
-- with `value::text` (relying on the default column name from
-- jsonb_array_elements_text). The reproduce was 100% — same input shape,
-- same empty output. Some rows in the 100-row smoke happened to get
-- photos because they had Enriched Images JSON populated (a different
-- code path) — coincidence, not coverage.
--
-- Fix: rewrite with the idiomatic ARRAY(SELECT ...) form + an explicit
-- alias so there's no ambiguity around `value`. Same semantics, no
-- empty-strings, NULL-safe via COALESCE.
-- ============================================================================

DROP FUNCTION IF EXISTS bulk_import_lots(
  TEXT, TEXT, JSONB, JSONB, BOOLEAN, UUID, lot_status, BOOLEAN, UUID
);

CREATE OR REPLACE FUNCTION bulk_import_lots(
  p_batch_source          TEXT,
  p_filename              TEXT,
  p_column_mapping        JSONB,
  p_rows                  JSONB,
  p_preserve_legacy       BOOLEAN  DEFAULT TRUE,
  p_warehouse_id          UUID     DEFAULT NULL,
  p_initial_status        lot_status DEFAULT 'in_inventory',
  p_use_provided_lot_code BOOLEAN    DEFAULT FALSE,
  p_operator_id_override  UUID       DEFAULT NULL
)
RETURNS TABLE (
  batch_id        UUID,
  ok              BOOLEAN,
  reason          TEXT,
  inserted_count  INTEGER,
  skipped_count   INTEGER
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_op_id         UUID;
  v_batch_id      UUID;
  v_row           JSONB;
  v_legacy_code   TEXT;
  v_lot_code      TEXT;
  v_inserted      INTEGER := 0;
  v_skipped       INTEGER := 0;
  v_total         INTEGER := 0;
  v_user_id       UUID;
  v_row_index     INTEGER := 0;
  v_condition     lot_condition;
  v_msrp_cents    BIGINT;
  v_photo_urls    TEXT[];
BEGIN
  v_user_id := auth.uid();

  IF p_operator_id_override IS NOT NULL THEN
    v_op_id := p_operator_id_override;
    IF NOT EXISTS (SELECT 1 FROM operators WHERE id = v_op_id) THEN
      RETURN QUERY SELECT NULL::UUID, false, 'unknown_operator', 0, 0;
      RETURN;
    END IF;
  ELSE
    IF v_user_id IS NULL THEN
      RETURN QUERY SELECT NULL::UUID, false, 'not_authenticated', 0, 0;
      RETURN;
    END IF;
    v_op_id := current_operator_id();
    IF v_op_id IS NULL THEN
      RETURN QUERY SELECT NULL::UUID, false, 'not_operator_staff', 0, 0;
      RETURN;
    END IF;
  END IF;

  IF jsonb_typeof(p_rows) <> 'array' THEN
    RETURN QUERY SELECT NULL::UUID, false, 'rows_must_be_array', 0, 0;
    RETURN;
  END IF;

  v_total := jsonb_array_length(p_rows);

  INSERT INTO lot_import_batches (
    operator_id, imported_by, filename, source_label,
    row_count, column_mapping, status
  ) VALUES (
    v_op_id, v_user_id, p_filename, p_batch_source,
    v_total, COALESCE(p_column_mapping, '{}'::jsonb), 'processing'
  )
  RETURNING id INTO v_batch_id;

  BEGIN
    FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
      IF coalesce(NULLIF(TRIM(v_row->>'title'), ''), '') = '' THEN
        INSERT INTO lot_import_batch_skips (
          import_batch_id, row_index, skip_reason, row_data
        ) VALUES (v_batch_id, v_row_index, 'missing_required_field', v_row);
        v_skipped := v_skipped + 1;
        v_row_index := v_row_index + 1;
        CONTINUE;
      END IF;

      v_legacy_code := NULLIF(TRIM(v_row->>'legacy_lot_code'), '');

      IF p_preserve_legacy AND v_legacy_code IS NOT NULL THEN
        IF EXISTS (
          SELECT 1 FROM lots
          WHERE operator_id = v_op_id
            AND legacy_lot_code = v_legacy_code
            AND legacy_platform IS NOT DISTINCT FROM p_batch_source
        ) THEN
          INSERT INTO lot_import_batch_skips (
            import_batch_id, row_index, skip_reason, row_data
          ) VALUES (v_batch_id, v_row_index, 'duplicate_lot_code', v_row);
          v_skipped := v_skipped + 1;
          v_row_index := v_row_index + 1;
          CONTINUE;
        END IF;
      END IF;

      v_msrp_cents := NULL;
      IF NULLIF((v_row->>'msrp_cents'), '') IS NOT NULL THEN
        BEGIN
          v_msrp_cents := (v_row->>'msrp_cents')::BIGINT;
        EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
          INSERT INTO lot_import_batch_skips (
            import_batch_id, row_index, skip_reason, row_data
          ) VALUES (v_batch_id, v_row_index, 'invalid_msrp', v_row);
          v_skipped := v_skipped + 1;
          v_row_index := v_row_index + 1;
          CONTINUE;
        END;
      END IF;

      BEGIN
        v_condition := COALESCE((v_row->>'condition')::lot_condition, 'good');
      EXCEPTION WHEN invalid_text_representation THEN
        INSERT INTO lot_import_batch_skips (
          import_batch_id, row_index, skip_reason, row_data
        ) VALUES (v_batch_id, v_row_index, 'invalid_condition', v_row);
        v_skipped := v_skipped + 1;
        v_row_index := v_row_index + 1;
        CONTINUE;
      END;

      IF p_use_provided_lot_code THEN
        v_lot_code := NULLIF(TRIM(v_row->>'lot_code'), '');
        IF v_lot_code IS NULL THEN
          INSERT INTO lot_import_batch_skips (
            import_batch_id, row_index, skip_reason, row_data
          ) VALUES (v_batch_id, v_row_index, 'missing_lot_code', v_row);
          v_skipped := v_skipped + 1;
          v_row_index := v_row_index + 1;
          CONTINUE;
        END IF;
        IF EXISTS (
          SELECT 1 FROM lots
          WHERE lot_code = v_lot_code
            AND deleted_at IS NULL
        ) THEN
          INSERT INTO lot_import_batch_skips (
            import_batch_id, row_index, skip_reason, row_data
          ) VALUES (v_batch_id, v_row_index, 'duplicate_provided_lot_code', v_row);
          v_skipped := v_skipped + 1;
          v_row_index := v_row_index + 1;
          CONTINUE;
        END IF;
      ELSE
        SELECT next_lot_code(v_op_id) INTO v_lot_code;
      END IF;

      -- 0138 — photo_urls unpacking. ARRAY(SELECT ...) with explicit
      -- alias so there's no ambiguity around the column name. Filters
      -- out empty/whitespace-only URLs in one pass.
      v_photo_urls := ARRAY(
        SELECT TRIM(elem)
          FROM jsonb_array_elements_text(
                 COALESCE(v_row->'photo_urls', '[]'::jsonb)
               ) AS t(elem)
         WHERE NULLIF(TRIM(elem), '') IS NOT NULL
      );

      -- Fallback to legacy single-URL key only if the array path produced
      -- nothing AND a photo_url field is present.
      IF (v_photo_urls IS NULL OR cardinality(v_photo_urls) = 0)
         AND NULLIF(TRIM(v_row->>'photo_url'), '') IS NOT NULL THEN
        v_photo_urls := ARRAY[TRIM(v_row->>'photo_url')];
      END IF;

      -- Final safety: never NULL (lots.photo_urls is NOT NULL).
      IF v_photo_urls IS NULL THEN
        v_photo_urls := '{}'::TEXT[];
      END IF;

      INSERT INTO lots (
        operator_id, auction_id, lot_number, warehouse_id, lot_code,
        title, description, category, condition,
        msrp_cents, starting_bid_cents, cost_cents,
        photo_urls,
        upc, asin, fnsku, lpn, brand, model,
        mpn, load_number,
        legacy_lot_code, legacy_platform, lot_import_batch_id,
        source, status, intake_at, close_at
      ) VALUES (
        v_op_id, NULL, NULL, p_warehouse_id, v_lot_code,
        TRIM(v_row->>'title'),
        NULLIF(TRIM(v_row->>'description'), ''),
        NULLIF(TRIM(v_row->>'category'), ''),
        v_condition,
        v_msrp_cents,
        COALESCE(NULLIF((v_row->>'starting_bid_cents'), '')::BIGINT, 100),
        NULLIF((v_row->>'cost_cents'), '')::BIGINT,
        v_photo_urls,
        NULLIF(TRIM(v_row->>'upc'), ''),
        NULLIF(TRIM(v_row->>'asin'), ''),
        NULLIF(TRIM(v_row->>'fnsku'), ''),
        NULLIF(TRIM(v_row->>'lpn'), ''),
        NULLIF(TRIM(v_row->>'brand'), ''),
        NULLIF(TRIM(v_row->>'model'), ''),
        NULLIF(TRIM(v_row->>'mpn'), ''),
        NULLIF(TRIM(v_row->>'load_number'), ''),
        CASE WHEN p_preserve_legacy THEN v_legacy_code ELSE NULL END,
        CASE WHEN p_preserve_legacy AND v_legacy_code IS NOT NULL
          THEN p_batch_source ELSE NULL END,
        v_batch_id,
        COALESCE(p_batch_source, 'import'),
        p_initial_status,
        now(),
        NULL
      );
      v_inserted := v_inserted + 1;
      v_row_index := v_row_index + 1;
    END LOOP;
  EXCEPTION WHEN OTHERS THEN
    UPDATE lot_import_batches
       SET status = 'failed',
           error_message = SQLERRM,
           inserted_count = v_inserted,
           skipped_count = v_skipped
     WHERE id = v_batch_id;
    RAISE;
  END;

  UPDATE lot_import_batches
     SET inserted_count = v_inserted,
         skipped_count = v_skipped,
         status = CASE WHEN v_skipped > 0 THEN 'partial' ELSE 'completed' END
   WHERE id = v_batch_id;

  RETURN QUERY SELECT v_batch_id, true,
    CASE WHEN v_skipped > 0 THEN 'partial' ELSE 'ok' END,
    v_inserted, v_skipped;
END;
$$;

COMMENT ON FUNCTION bulk_import_lots IS
  'Bulk-insert lots from a CSV. 0138 fixes photo_urls array unpacking — '
  'ARRAY(SELECT) with explicit alias t(elem) instead of relying on '
  'jsonb_array_elements_text''s implicit `value` column name.';
