-- ============================================================================
-- Migration 0131 — bulk_import_lots reliability fixes (B2 + B6 from 2026-05-24 audit)
--
-- Purpose
-- -------
-- Two bugs in the bulk_import_lots RPC from migration 0103 that block BinGo
-- go-live:
--
--   B2 — lot_import_batches row was inserted with status='completed' BEFORE
--        the per-row insert loop runs. If the loop crashes mid-way, all the
--        lots get rolled back (good) but the batch row stays 'completed'
--        (bad: operator UI reports a green import that never happened).
--
--        Lines 276-283 of 0103: INSERT INTO lot_import_batches (...status...)
--        VALUES (..., 'completed').
--
--   B6 — When the per-row loop SKIPs a row (missing title, duplicate legacy
--        code, etc), it only bumps v_skipped counter. No per-row reason is
--        recorded. Operator sees "58 imported, 2 skipped" and has no way to
--        figure out which 2 rows or why.
--
--        Lines 289-306 of 0103: CONTINUE; with no audit row.
--
-- Approach
-- --------
-- Additive only. We DO NOT touch migration 0103. Instead we:
--   1. Add a new table `lot_import_batch_skips` for per-row skip audit.
--   2. CREATE OR REPLACE the bulk_import_lots function with the same
--      signature + return shape, but with:
--        a) status starts as 'processing' (not 'completed').
--        b) BEGIN ... EXCEPTION WHEN OTHERS THEN UPDATE … status='failed',
--           error_message=SQLERRM; RAISE; END; wraps the row loop.
--        c) Every CONTINUE skip path now INSERTs a lot_import_batch_skips
--           row with a stable reason code + the offending row JSONB.
--      The final UPDATE … SET status='completed' at end of function still
--      fires on success, so the success path is unchanged.
--
-- Function signature (TEXT, TEXT, JSONB, JSONB, BOOLEAN, UUID) and return
-- TABLE (batch_id UUID, ok BOOLEAN, reason TEXT, inserted_count INTEGER,
-- skipped_count INTEGER) are preserved — operator-web callers do not change.
--
-- The skip reason codes are stable strings the UI can switch on:
--   - 'missing_required_field'   (title is required and was empty/null)
--   - 'duplicate_lot_code'       (legacy_lot_code already exists for this
--                                 operator+platform — preserved-legacy mode)
--   - 'invalid_msrp'             (msrp_cents was provided but couldn't parse)
--   - 'invalid_condition'        (condition value not in lot_condition enum)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. lot_import_batch_skips — per-row skip audit (B6)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS lot_import_batch_skips (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  import_batch_id UUID NOT NULL
                  REFERENCES lot_import_batches(id) ON DELETE CASCADE,
  -- 0-based index into the original JSONB array the operator submitted.
  -- Lets the UI highlight the offending row in the original spreadsheet.
  row_index       INT NOT NULL,
  -- Stable reason code (see header). Operator-web has a localized
  -- description table keyed off these codes.
  skip_reason     TEXT NOT NULL,
  -- The actual JSONB row that was skipped. Stored so the operator can
  -- export a "rejected rows" CSV and re-upload after fixing. Nullable
  -- only because future skip paths might not have a meaningful row
  -- payload, but the current paths all populate it.
  row_data        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lot_import_batch_skips_batch_idx
  ON lot_import_batch_skips (import_batch_id);

ALTER TABLE lot_import_batch_skips ENABLE ROW LEVEL SECURITY;

-- RLS: operator can SELECT their own batch's skip rows via the parent
-- lot_import_batches.operator_id → current_operator_id() join.
-- No INSERT/UPDATE/DELETE policy — only the SECURITY DEFINER bulk_import_lots
-- function writes to this table.
DROP POLICY IF EXISTS lot_import_batch_skips_operator_read ON lot_import_batch_skips;
CREATE POLICY lot_import_batch_skips_operator_read
  ON lot_import_batch_skips
  FOR SELECT
  USING (
    import_batch_id IN (
      SELECT id FROM lot_import_batches WHERE operator_id = current_operator_id()
    )
  );

-- ---------------------------------------------------------------------------
-- 2. bulk_import_lots — replace with B2 + B6 fixes
-- ---------------------------------------------------------------------------
-- Same signature as 0103 lines 227-234.
-- Same return shape as 0103 lines 235-241.
-- Changes vs 0103:
--   - Initial status is 'processing' (was 'completed').
--   - Row loop wrapped in BEGIN ... EXCEPTION WHEN OTHERS THEN mark failed.
--   - Every CONTINUE path inserts a lot_import_batch_skips row first.
--   - On clean completion the final UPDATE flips status back to 'completed'.

CREATE OR REPLACE FUNCTION bulk_import_lots(
  p_batch_source    TEXT,
  p_filename        TEXT,
  p_column_mapping  JSONB,
  p_rows            JSONB,
  p_preserve_legacy BOOLEAN DEFAULT TRUE,
  p_warehouse_id    UUID DEFAULT NULL
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
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RETURN QUERY SELECT NULL::UUID, false, 'not_authenticated', 0, 0;
    RETURN;
  END IF;
  v_op_id := current_operator_id();
  IF v_op_id IS NULL THEN
    RETURN QUERY SELECT NULL::UUID, false, 'not_operator_staff', 0, 0;
    RETURN;
  END IF;

  IF jsonb_typeof(p_rows) <> 'array' THEN
    RETURN QUERY SELECT NULL::UUID, false, 'rows_must_be_array', 0, 0;
    RETURN;
  END IF;

  v_total := jsonb_array_length(p_rows);

  -- B2 fix: open the batch row with status='processing'. The trailing
  -- UPDATE at end of function flips it to 'completed' only on success.
  INSERT INTO lot_import_batches (
    operator_id, imported_by, filename, source_label,
    row_count, column_mapping, status
  ) VALUES (
    v_op_id, v_user_id, p_filename, p_batch_source,
    v_total, COALESCE(p_column_mapping, '{}'::jsonb), 'processing'
  )
  RETURNING id INTO v_batch_id;

  -- B2 fix: any failure inside the per-row loop marks the batch as
  -- 'failed' with the SQLERRM before re-raising. The RAISE then rolls
  -- back the lots inserts inside this TX, but the batch row UPDATE will
  -- have run in the same TX so it rolls back too — caller sees a clean
  -- "no batch row exists" state for a TX-level failure, OR if the failure
  -- is caught in a subtransaction (eg. a SAVEPOINT in a future PL caller)
  -- the failed-status row survives. Either way no false 'completed'.
  BEGIN
    FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
      -- Required field: title.
      IF coalesce(NULLIF(TRIM(v_row->>'title'), ''), '') = '' THEN
        INSERT INTO lot_import_batch_skips (
          import_batch_id, row_index, skip_reason, row_data
        ) VALUES (
          v_batch_id, v_row_index, 'missing_required_field', v_row
        );
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
          ) VALUES (
            v_batch_id, v_row_index, 'duplicate_lot_code', v_row
          );
          v_skipped := v_skipped + 1;
          v_row_index := v_row_index + 1;
          CONTINUE;
        END IF;
      END IF;

      -- Validate msrp_cents if present. 0103 did a bare ::BIGINT cast that
      -- would crash the whole batch on a bad value; here we catch + skip.
      v_msrp_cents := NULL;
      IF NULLIF((v_row->>'msrp_cents'), '') IS NOT NULL THEN
        BEGIN
          v_msrp_cents := (v_row->>'msrp_cents')::BIGINT;
        EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
          INSERT INTO lot_import_batch_skips (
            import_batch_id, row_index, skip_reason, row_data
          ) VALUES (
            v_batch_id, v_row_index, 'invalid_msrp', v_row
          );
          v_skipped := v_skipped + 1;
          v_row_index := v_row_index + 1;
          CONTINUE;
        END;
      END IF;

      -- Validate condition if present (enum cast).
      BEGIN
        v_condition := COALESCE((v_row->>'condition')::lot_condition, 'good');
      EXCEPTION WHEN invalid_text_representation THEN
        INSERT INTO lot_import_batch_skips (
          import_batch_id, row_index, skip_reason, row_data
        ) VALUES (
          v_batch_id, v_row_index, 'invalid_condition', v_row
        );
        v_skipped := v_skipped + 1;
        v_row_index := v_row_index + 1;
        CONTINUE;
      END;

      -- Mint a fresh app-wide lot_code.
      SELECT next_lot_code(v_op_id) INTO v_lot_code;

      INSERT INTO lots (
        operator_id, auction_id, lot_number, warehouse_id, lot_code,
        title, description, category, condition,
        msrp_cents, starting_bid_cents, cost_cents,
        photo_urls,
        upc, asin, fnsku, lpn, brand, model,
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
        CASE
          WHEN NULLIF(TRIM(v_row->>'photo_url'), '') IS NOT NULL
            THEN ARRAY[TRIM(v_row->>'photo_url')]
          ELSE '{}'::TEXT[]
        END,
        NULLIF(TRIM(v_row->>'upc'), ''),
        NULLIF(TRIM(v_row->>'asin'), ''),
        NULLIF(TRIM(v_row->>'fnsku'), ''),
        NULLIF(TRIM(v_row->>'lpn'), ''),
        NULLIF(TRIM(v_row->>'brand'), ''),
        NULLIF(TRIM(v_row->>'model'), ''),
        CASE WHEN p_preserve_legacy THEN v_legacy_code ELSE NULL END,
        CASE WHEN p_preserve_legacy AND v_legacy_code IS NOT NULL
          THEN p_batch_source ELSE NULL END,
        v_batch_id,
        COALESCE(p_batch_source, 'import'),
        'in_inventory',
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
         status = 'completed'
   WHERE id = v_batch_id;

  RETURN QUERY SELECT v_batch_id, true, 'ok', v_inserted, v_skipped;
END;
$$;

REVOKE ALL ON FUNCTION bulk_import_lots(TEXT, TEXT, JSONB, JSONB, BOOLEAN, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bulk_import_lots(TEXT, TEXT, JSONB, JSONB, BOOLEAN, UUID) TO authenticated;
