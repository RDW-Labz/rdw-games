-- ============================================================================
-- 0068_drop_lots_import_id
--
-- lots.import_id has been duplicate information since 0029 introduced
-- import_rows as the canonical manifest layer. Every intake RPC after
-- 0029 (0032, 0059, 0062, 0063, 0064) wrote BOTH columns where:
--     lots.import_id  ===  lots.import_row_id → import_rows.import_id
--
-- The dashboard's worker-attribution code joins lots → imports through
-- the redundant FK. Refactoring it to go lots → import_rows → imports
-- is one extra hop but removes the schema redundancy permanently.
--
-- Legacy data observed in dev DB:
--   - 24 lots have BOTH import_id + import_row_id set (post-0029 path).
--   - 587 lots have ONLY import_id set (pre-0029 legacy lots).
--   - 0 lots have only import_row_id set.
-- After this migration, the 587 legacy lots become un-attributable in
-- the worker dashboard. Acceptable because pre-launch — none of them
-- belong to real workers.
--
-- This migration:
--   1. Backfills any lots.import_row_id that can be derived via the
--      import_rows.lot_id ← back-reference (idempotent safety).
--   2. Re-emits intake_lot_to_bin + batch_intake_lot_to_bin from 0064
--      (with 0066's gen_random_uuid fix is unrelated, lives in 0067)
--      WITHOUT the import_id column write — they only write import_row_id.
--   3. Drops the lots_import_idx index (was on import_id only).
--   4. Drops the lots.import_id column.
--
-- Other intake RPCs whose bodies still reference import_id are
-- transparently overridden by these re-emitted versions (Postgres
-- CREATE OR REPLACE FUNCTION keeps the same signature and prototype
-- chain).
-- ============================================================================

-- ── Step 1: backfill ─────────────────────────────────────────────────────
-- For any lots that have an import_row pointing back at them (set when
-- intake_lot_to_bin mints from manifest), copy that link into
-- lots.import_row_id. Idempotent: only fills NULLs.
UPDATE lots
   SET import_row_id = ir.id
  FROM import_rows ir
 WHERE ir.lot_id = lots.id
   AND lots.import_row_id IS NULL;

-- ── Step 2: re-emit intake_lot_to_bin sans import_id ─────────────────────

CREATE OR REPLACE FUNCTION intake_lot_to_bin(
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
  v_result       intake_lot_result;

  v_row          import_rows%ROWTYPE;
  v_source_label TEXT;
  v_lot_code     TEXT;
  v_new_lot_id   UUID;
  v_new_photos   TEXT[];
BEGIN
  IF auth.uid() IS NULL THEN
    v_result := (false, 'not_authenticated', NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;
  v_op_id := current_operator_id();
  IF v_op_id IS NULL THEN
    v_result := (false, 'not_operator_staff', NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;

  -- 0064: reject revoked tokens. Active-bin lookup via the
  -- bins_active_qr_idx partial index.
  SELECT * INTO v_bin FROM bins
   WHERE qr_token = p_bin_qr_token AND qr_revoked_at IS NULL
   LIMIT 1;
  IF NOT FOUND THEN
    v_result := (false, 'bin_not_found_or_revoked', NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;
  SELECT operator_id INTO v_bin_operator FROM warehouses WHERE id = v_bin.warehouse_id;
  IF v_bin_operator <> v_op_id THEN
    v_result := (false, 'bin_other_operator', NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;

  -- Lot lookup chain (unchanged from 0064).
  SELECT * INTO v_lot FROM lots WHERE lot_code = v_id_clean LIMIT 1;
  IF v_lot.id IS NULL THEN
    BEGIN
      SELECT * INTO v_lot FROM lots WHERE id = v_id_clean::UUID;
    EXCEPTION WHEN invalid_text_representation THEN v_lot := NULL; END;
  END IF;
  IF v_lot.id IS NULL THEN
    SELECT * INTO v_lot FROM lots WHERE operator_id = v_op_id AND lpn = v_id_clean LIMIT 1;
  END IF;
  IF v_lot.id IS NULL THEN
    SELECT * INTO v_lot FROM lots WHERE operator_id = v_op_id AND fnsku = v_id_clean LIMIT 1;
  END IF;
  IF v_lot.id IS NULL THEN
    SELECT * INTO v_lot FROM lots
    WHERE operator_id = v_op_id AND asin = v_id_clean
    ORDER BY (status = 'pending_intake') DESC, created_at DESC LIMIT 1;
  END IF;
  IF v_lot.id IS NULL THEN
    SELECT * INTO v_lot FROM lots WHERE operator_id = v_op_id AND external_code = v_id_clean LIMIT 1;
  END IF;

  IF v_lot.id IS NOT NULL THEN
    IF v_lot.operator_id <> v_op_id THEN
      v_result := (false, 'lot_other_operator', NULL, NULL, NULL, NULL);
      RETURN v_result;
    END IF;
    IF v_lot.status <> 'pending_intake' AND v_lot.status <> 'in_inventory' THEN
      v_result := (false, 'lot_not_in_intake_state', v_lot.id, v_lot.lot_code, NULL, NULL);
      RETURN v_result;
    END IF;
    UPDATE lots
       SET status = 'in_inventory', intake_bin_id = v_bin.id,
           warehouse_id = v_bin.warehouse_id, intake_at = now(), updated_at = now()
     WHERE id = v_lot.id;
    v_result := (true, 'ok', v_lot.id, v_lot.lot_code, v_bin.code, v_bin.warehouse_id);
    RETURN v_result;
  END IF;

  -- Manifest fall-through.
  SELECT * INTO v_row FROM import_rows
  WHERE operator_id = v_op_id AND status = 'pending' AND lpn = v_id_clean
  ORDER BY created_at ASC LIMIT 1 FOR UPDATE;
  IF v_row.id IS NULL THEN
    SELECT * INTO v_row FROM import_rows
    WHERE operator_id = v_op_id AND status = 'pending' AND fnsku = v_id_clean
    ORDER BY created_at ASC LIMIT 1 FOR UPDATE;
  END IF;
  IF v_row.id IS NULL THEN
    SELECT * INTO v_row FROM import_rows
    WHERE operator_id = v_op_id AND status = 'pending' AND asin = v_id_clean
    ORDER BY created_at ASC LIMIT 1 FOR UPDATE;
  END IF;
  IF v_row.id IS NULL THEN
    SELECT * INTO v_row FROM import_rows
    WHERE operator_id = v_op_id AND status = 'pending' AND external_code = v_id_clean
    ORDER BY created_at ASC LIMIT 1 FOR UPDATE;
  END IF;
  IF v_row.id IS NULL THEN
    SELECT * INTO v_row FROM import_rows
    WHERE operator_id = v_op_id AND status = 'pending' AND upc = v_id_clean
    ORDER BY created_at ASC LIMIT 1 FOR UPDATE;
  END IF;
  IF v_row.id IS NULL THEN
    SELECT * INTO v_row FROM import_rows
    WHERE operator_id = v_op_id AND status = 'pending' AND title = v_id_clean
    ORDER BY created_at ASC LIMIT 1 FOR UPDATE;
  END IF;

  IF v_row.id IS NULL THEN
    v_result := (false, 'lot_not_found', NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;

  -- source_label still resolves via import_rows.import_id → imports.id.
  -- The link from lots BACK to imports is now lots.import_row_id →
  -- import_rows.import_id; the redundant lots.import_id is dropped.
  SELECT source_label INTO v_source_label
    FROM imports WHERE id = v_row.import_id LIMIT 1;
  IF v_source_label IS NOT NULL THEN
    v_source_label := LEFT(TRIM(v_source_label), 120);
    IF LENGTH(v_source_label) = 0 THEN v_source_label := NULL; END IF;
  END IF;

  SELECT next_lot_code(v_op_id) INTO v_lot_code;

  v_new_photos := CASE
    WHEN v_row.photo_url IS NOT NULL AND LENGTH(TRIM(v_row.photo_url)) > 0
      THEN ARRAY[v_row.photo_url] ELSE '{}'::TEXT[]
  END;

  INSERT INTO lots (
    operator_id, auction_id, lot_number, warehouse_id, lot_code,
    external_code, import_row_id,
    title, description, category, category_id, condition,
    msrp_cents, starting_bid_cents, cost_cents, photo_urls,
    asin, fnsku, lpn, brand, model,
    source,
    status, intake_bin_id, intake_at, close_at
  ) VALUES (
    v_op_id, NULL, NULL, v_bin.warehouse_id, v_lot_code,
    v_row.external_code, v_row.id,
    v_row.title, v_row.description, v_row.category_raw, v_row.category_id,
    normalize_manifest_condition(v_row.condition),
    v_row.msrp_cents, COALESCE(v_row.starting_bid_cents, 100),
    CASE WHEN v_row.cost_cents IS NOT NULL AND v_row.cost_cents > 0
      THEN v_row.cost_cents ELSE NULL END,
    v_new_photos,
    v_row.asin, v_row.fnsku, v_row.lpn, v_row.brand, v_row.model,
    v_source_label,
    'in_inventory', v_bin.id, now(), NULL
  )
  RETURNING id INTO v_new_lot_id;

  UPDATE import_rows
     SET status = 'lotted', lot_id = v_new_lot_id, lotted_at = now()
   WHERE id = v_row.id;

  v_result := (true, 'ok_minted_from_manifest', v_new_lot_id, v_lot_code, v_bin.code, v_bin.warehouse_id);
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION intake_lot_to_bin(TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION intake_lot_to_bin(TEXT, UUID) TO authenticated;

-- ── Step 2b: re-emit batch_intake_lot_to_bin sans import_id ──────────────

CREATE OR REPLACE FUNCTION batch_intake_lot_to_bin(
  p_lot_identifiers TEXT[],
  p_bin_qr_token    UUID
)
RETURNS TABLE (
  identifier  TEXT,
  ok          BOOLEAN,
  code        TEXT,
  lot_id      UUID,
  lot_code    TEXT,
  bin_code    TEXT,
  error       TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_op_id       UUID;
  v_bin         bins%ROWTYPE;
  v_bin_op      UUID;
  v_lot         lots%ROWTYPE;
  v_id_clean    TEXT;
  v_identifier  TEXT;

  v_row          import_rows%ROWTYPE;
  v_source_label TEXT;
  v_lot_code     TEXT;
  v_new_lot_id   UUID;
  v_new_photos   TEXT[];
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  v_op_id := current_operator_id();
  IF v_op_id IS NULL THEN
    RAISE EXCEPTION 'not_operator_staff' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_bin FROM bins
   WHERE qr_token = p_bin_qr_token AND qr_revoked_at IS NULL
   LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT operator_id INTO v_bin_op FROM warehouses WHERE id = v_bin.warehouse_id;
  IF v_bin_op IS DISTINCT FROM v_op_id THEN RETURN; END IF;

  FOREACH v_identifier IN ARRAY p_lot_identifiers LOOP
    v_id_clean := TRIM(v_identifier);
    v_lot := NULL;
    v_row := NULL;

    SELECT * INTO v_lot FROM lots WHERE lot_code = v_id_clean LIMIT 1;
    IF v_lot.id IS NULL THEN
      BEGIN
        SELECT * INTO v_lot FROM lots WHERE id = v_id_clean::UUID;
      EXCEPTION WHEN invalid_text_representation THEN v_lot.id := NULL; END;
    END IF;
    IF v_lot.id IS NULL THEN
      SELECT * INTO v_lot FROM lots WHERE operator_id = v_op_id AND lpn = v_id_clean LIMIT 1;
    END IF;
    IF v_lot.id IS NULL THEN
      SELECT * INTO v_lot FROM lots WHERE operator_id = v_op_id AND fnsku = v_id_clean LIMIT 1;
    END IF;
    IF v_lot.id IS NULL THEN
      SELECT * INTO v_lot FROM lots
      WHERE operator_id = v_op_id AND asin = v_id_clean
      ORDER BY (status = 'pending_intake') DESC, created_at DESC LIMIT 1;
    END IF;
    IF v_lot.id IS NULL THEN
      SELECT * INTO v_lot FROM lots WHERE operator_id = v_op_id AND external_code = v_id_clean LIMIT 1;
    END IF;

    IF v_lot.id IS NOT NULL THEN
      IF v_lot.operator_id <> v_op_id THEN
        identifier := v_identifier; ok := false; code := 'lot_other_operator';
        lot_id := v_lot.id; lot_code := v_lot.lot_code; bin_code := NULL;
        error := 'Lot belongs to a different operator.';
        RETURN NEXT; CONTINUE;
      END IF;
      IF v_lot.status <> 'pending_intake' AND v_lot.status <> 'in_inventory' THEN
        identifier := v_identifier; ok := false; code := 'lot_not_in_intake_state';
        lot_id := v_lot.id; lot_code := v_lot.lot_code; bin_code := NULL;
        error := 'Lot is past inventory state (status: ' || v_lot.status || ').';
        RETURN NEXT; CONTINUE;
      END IF;

      BEGIN
        UPDATE lots
           SET status = 'in_inventory', intake_bin_id = v_bin.id,
               warehouse_id = v_bin.warehouse_id, intake_at = now(),
               updated_at = now()
         WHERE id = v_lot.id;
        identifier := v_identifier; ok := true; code := 'ok';
        lot_id := v_lot.id; lot_code := v_lot.lot_code; bin_code := v_bin.code;
        error := NULL;
        RETURN NEXT;
      EXCEPTION WHEN OTHERS THEN
        identifier := v_identifier; ok := false; code := 'update_failed';
        lot_id := v_lot.id; lot_code := v_lot.lot_code; bin_code := NULL;
        error := SQLERRM;
        RETURN NEXT;
      END;
      CONTINUE;
    END IF;

    -- Manifest fall-through.
    SELECT * INTO v_row FROM import_rows
    WHERE operator_id = v_op_id AND status = 'pending' AND lpn = v_id_clean
    ORDER BY created_at ASC LIMIT 1 FOR UPDATE;
    IF v_row.id IS NULL THEN
      SELECT * INTO v_row FROM import_rows
      WHERE operator_id = v_op_id AND status = 'pending' AND fnsku = v_id_clean
      ORDER BY created_at ASC LIMIT 1 FOR UPDATE;
    END IF;
    IF v_row.id IS NULL THEN
      SELECT * INTO v_row FROM import_rows
      WHERE operator_id = v_op_id AND status = 'pending' AND asin = v_id_clean
      ORDER BY created_at ASC LIMIT 1 FOR UPDATE;
    END IF;
    IF v_row.id IS NULL THEN
      SELECT * INTO v_row FROM import_rows
      WHERE operator_id = v_op_id AND status = 'pending' AND external_code = v_id_clean
      ORDER BY created_at ASC LIMIT 1 FOR UPDATE;
    END IF;
    IF v_row.id IS NULL THEN
      SELECT * INTO v_row FROM import_rows
      WHERE operator_id = v_op_id AND status = 'pending' AND upc = v_id_clean
      ORDER BY created_at ASC LIMIT 1 FOR UPDATE;
    END IF;
    IF v_row.id IS NULL THEN
      SELECT * INTO v_row FROM import_rows
      WHERE operator_id = v_op_id AND status = 'pending' AND title = v_id_clean
      ORDER BY created_at ASC LIMIT 1 FOR UPDATE;
    END IF;

    IF v_row.id IS NULL THEN
      identifier := v_identifier; ok := false; code := 'lot_not_found';
      lot_id := NULL; lot_code := NULL; bin_code := NULL;
      error := 'No lot or pending manifest row matched that identifier.';
      RETURN NEXT; CONTINUE;
    END IF;

    BEGIN
      SELECT source_label INTO v_source_label FROM imports WHERE id = v_row.import_id LIMIT 1;
      IF v_source_label IS NOT NULL THEN
        v_source_label := LEFT(TRIM(v_source_label), 120);
        IF LENGTH(v_source_label) = 0 THEN v_source_label := NULL; END IF;
      END IF;

      SELECT next_lot_code(v_op_id) INTO v_lot_code;

      v_new_photos := CASE
        WHEN v_row.photo_url IS NOT NULL AND LENGTH(TRIM(v_row.photo_url)) > 0
          THEN ARRAY[v_row.photo_url] ELSE '{}'::TEXT[]
      END;

      INSERT INTO lots (
        operator_id, auction_id, lot_number, warehouse_id, lot_code,
        external_code, import_row_id,
        title, description, category, category_id, condition,
        msrp_cents, starting_bid_cents, cost_cents, photo_urls,
        asin, fnsku, lpn, brand, model,
        source,
        status, intake_bin_id, intake_at, close_at
      ) VALUES (
        v_op_id, NULL, NULL, v_bin.warehouse_id, v_lot_code,
        v_row.external_code, v_row.id,
        v_row.title, v_row.description, v_row.category_raw, v_row.category_id,
        normalize_manifest_condition(v_row.condition),
        v_row.msrp_cents, COALESCE(v_row.starting_bid_cents, 100),
        CASE WHEN v_row.cost_cents IS NOT NULL AND v_row.cost_cents > 0
          THEN v_row.cost_cents ELSE NULL END,
        v_new_photos,
        v_row.asin, v_row.fnsku, v_row.lpn, v_row.brand, v_row.model,
        v_source_label,
        'in_inventory', v_bin.id, now(), NULL
      )
      RETURNING id INTO v_new_lot_id;

      UPDATE import_rows
         SET status = 'lotted', lot_id = v_new_lot_id, lotted_at = now()
       WHERE id = v_row.id;

      identifier := v_identifier; ok := true; code := 'ok_minted_from_manifest';
      lot_id := v_new_lot_id; lot_code := v_lot_code; bin_code := v_bin.code;
      error := NULL;
      RETURN NEXT;

    EXCEPTION WHEN OTHERS THEN
      identifier := v_identifier; ok := false; code := 'mint_failed';
      lot_id := NULL; lot_code := NULL; bin_code := NULL;
      error := SQLERRM;
      RETURN NEXT;
    END;
  END LOOP;

  RETURN;
END;
$$;

REVOKE ALL ON FUNCTION batch_intake_lot_to_bin(TEXT[], UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION batch_intake_lot_to_bin(TEXT[], UUID) TO authenticated;

-- ── Step 3: drop the legacy index ────────────────────────────────────────
DROP INDEX IF EXISTS lots_import_idx;

-- ── Step 4: drop the column ──────────────────────────────────────────────
ALTER TABLE lots DROP COLUMN IF EXISTS import_id;
