-- ============================================================================
-- Migration 0137 — bulk_import_lots extended for legacy-platform migrations
--
-- BinGo go-live needs to bring in ~91k lots from a prior platform's manifest
-- where:
--   * Physical lot labels (e.g. "BRN4038964") already exist on inventory and
--     must be preserved verbatim as `lot_code` so staff can scan them tomorrow.
--   * Lots carry up to 6+ photo URLs each; the previous RPC only stored one.
--   * Lots arrive in an "intermediary" state — physically on shelves at the
--     warehouse but not yet placed into BinGo's bin system. Put-away
--     (scan label → scan bin QR) is what flips them to in_inventory.
--   * The CSV carries MPN, License Plate Number, Load Number columns that the
--     `lots` table didn't have homes for.
--   * An admin-run import script using the service-role connection has no
--     `auth.uid()`, so the RPC's first check rejects unconditionally.
--
-- Approach (additive only — backward compat preserved):
--   1. ALTER TABLE lots ADD COLUMN mpn, load_number (+ partial index).
--   2. CREATE OR REPLACE bulk_import_lots with three new params + new row
--      keys (lot_code, photo_urls, mpn, load_number). All defaults match
--      the prior behavior so existing operator-web wizard callers see no
--      change.
--
-- Backward compat:
--   * Existing wizard call (no new params, single photo_url, no lot_code in
--     rows) behaves identically to mig 0131 — minted lot_code, single-photo
--     array, status='in_inventory'.
--   * New legacy-import callers pass p_use_provided_lot_code=true,
--     p_initial_status='pending_intake', p_operator_id_override=<uuid>,
--     and row.photo_urls as JSONB array.
-- ============================================================================

-- ── Schema additions ─────────────────────────────────────────────────────────

ALTER TABLE lots ADD COLUMN IF NOT EXISTS mpn         TEXT;
ALTER TABLE lots ADD COLUMN IF NOT EXISTS load_number TEXT;

-- Index for "find lots that came in on the Wayfair 12-29 truck" queries that
-- staff will run when reconciling missing inventory against the manifest.
-- Partial: most lots won't have a load_number (only legacy imports do).
CREATE INDEX IF NOT EXISTS lots_load_number_idx
  ON lots (operator_id, load_number)
  WHERE load_number IS NOT NULL;

COMMENT ON COLUMN lots.mpn IS
  'Manufacturer Part Number — product identifier from supplier. Search hint, '
  'NOT unique (multiple lots can share an MPN across operators). Added by 0137.';

COMMENT ON COLUMN lots.load_number IS
  'Source load identifier (e.g. "Wayfair 12 29" — truck/delivery batch from a '
  'legacy platform). Used for reconciling against the original manifest. '
  'Added by 0137 for the BinGo legacy import.';

-- ── RPC: bulk_import_lots (extended) ────────────────────────────────────────

-- DROP the prior 6-param signature first. CREATE OR REPLACE only replaces a
-- function with the *exact* same argument list; adding params creates an
-- overload, leaving both versions in the catalog and making
-- COMMENT ON FUNCTION ambiguous. Backward compat is preserved because the
-- new function defaults the three new params to values that match prior
-- behavior — existing wizard callers see no semantic change.
DROP FUNCTION IF EXISTS bulk_import_lots(TEXT, TEXT, JSONB, JSONB, BOOLEAN, UUID);

CREATE OR REPLACE FUNCTION bulk_import_lots(
  p_batch_source          TEXT,
  p_filename              TEXT,
  p_column_mapping        JSONB,
  p_rows                  JSONB,
  p_preserve_legacy       BOOLEAN  DEFAULT TRUE,
  p_warehouse_id          UUID     DEFAULT NULL,
  -- 0137 additions ↓
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
  -- Identify the calling user. NULL is OK when p_operator_id_override is
  -- passed (admin / service-role legacy-import path).
  v_user_id := auth.uid();

  -- Resolve operator scope. The override path is for server-side admin
  -- imports running via the service role (no auth context); the normal
  -- path requires both authenticated user AND operator staff membership.
  IF p_operator_id_override IS NOT NULL THEN
    v_op_id := p_operator_id_override;
    -- Validate the override actually exists to avoid orphan batches.
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
      -- Required field: title.
      IF coalesce(NULLIF(TRIM(v_row->>'title'), ''), '') = '' THEN
        INSERT INTO lot_import_batch_skips (
          import_batch_id, row_index, skip_reason, row_data
        ) VALUES (v_batch_id, v_row_index, 'missing_required_field', v_row);
        v_skipped := v_skipped + 1;
        v_row_index := v_row_index + 1;
        CONTINUE;
      END IF;

      v_legacy_code := NULLIF(TRIM(v_row->>'legacy_lot_code'), '');

      -- Duplicate-by-legacy-code check (operator+platform scoped).
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

      -- Validate msrp_cents if present.
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

      -- Validate condition.
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

      -- 0137 — lot_code source:
      --   * legacy migration path: use the provided code verbatim, validate
      --     uniqueness across operator scope (lot_code is globally unique
      --     under the partial unique index, so check existing lots).
      --   * normal path: mint via next_lot_code(v_op_id).
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

      -- 0137 — photo_urls source:
      --   * row.photo_urls (JSONB array)  → use as TEXT[]
      --   * else row.photo_url (single)   → wrap as 1-element array
      --   * else empty array
      v_photo_urls := '{}'::TEXT[];
      IF jsonb_typeof(v_row->'photo_urls') = 'array'
         AND jsonb_array_length(v_row->'photo_urls') > 0 THEN
        SELECT array_agg(value::text)
          INTO v_photo_urls
          FROM jsonb_array_elements_text(v_row->'photo_urls')
         WHERE NULLIF(TRIM(value::text), '') IS NOT NULL;
      ELSIF NULLIF(TRIM(v_row->>'photo_url'), '') IS NOT NULL THEN
        v_photo_urls := ARRAY[TRIM(v_row->>'photo_url')];
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

  -- B6-aware end-of-batch: if any rows skipped, mark partial; else completed.
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
  'Bulk-insert lots from a CSV. 0137 adds legacy-migration support: '
  'provide lot_code in row data + p_use_provided_lot_code=true to preserve '
  'physical labels; photo_urls JSONB array for multi-photo lots; '
  'p_initial_status="pending_intake" so staff put-away scans flip status; '
  'p_operator_id_override for service-role admin imports without auth.uid().';

-- ── Verification ─────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_cols INTEGER;
BEGIN
  SELECT count(*) INTO v_cols
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name = 'lots'
     AND column_name IN ('mpn', 'load_number');
  IF v_cols <> 2 THEN
    RAISE EXCEPTION '0137 verification failed: expected mpn + load_number on lots, got %', v_cols;
  END IF;
  RAISE NOTICE '0137 verified: lots.mpn + lots.load_number present; bulk_import_lots extended';
END $$;
