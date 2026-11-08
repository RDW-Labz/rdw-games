-- ============================================================================
-- 0064_bin_token_rotation
--
-- Bins have a UUID qr_token that's printed on physical labels and
-- scanned at intake. Before this migration, a stolen or duplicated
-- label was permanent — anyone with the UUID could intake to the
-- bin forever. RLS only checks `warehouse.operator_id =
-- current_operator_id()`, not token freshness.
--
-- Not urgent for the in-house first operator (the warehouse is
-- physically secure), but mandatory before multi-tenant launch and
-- a good thing to model now while the surface area is small.
--
-- This migration:
--   1. Adds bins.qr_revoked_at TIMESTAMPTZ (NULL = active).
--   2. Adds bins.qr_rotated_at TIMESTAMPTZ for audit trail.
--   3. Updates intake_lot_to_bin + batch_intake_lot_to_bin (re-emit
--      from 0063 with one extra check) to reject revoked tokens.
--   4. Adds rotate_bin_token(p_bin_id UUID) RPC — generates a fresh
--      qr_token UUID, sets qr_rotated_at = now(), nulls qr_revoked_at.
--      Admin/manager only via the function's role check.
--   5. Adds revoke_bin_token(p_bin_id UUID, p_reason TEXT) RPC — sets
--      qr_revoked_at = now() without rotating. Use when a label is
--      stolen and the operator wants future scans to fail until a new
--      label is printed.
--
-- Workflow when a label is compromised:
--   1. Operator clicks "Revoke" on the bin → revoke_bin_token().
--      Scans of the old printed label start failing with `bin_revoked`.
--   2. Operator clicks "Rotate + reprint" → rotate_bin_token() returns
--      the new UUID. UI prints a fresh label. Old UUID is gone.
-- ============================================================================

ALTER TABLE bins
  ADD COLUMN IF NOT EXISTS qr_revoked_at  TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS qr_rotated_at  TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS qr_revoked_by  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS qr_revoked_reason TEXT NULL;

COMMENT ON COLUMN bins.qr_revoked_at IS
  '0064: when non-NULL, scans of this bin''s QR code are rejected by intake_lot_to_bin. Set by revoke_bin_token() when a label is stolen / lost; cleared by rotate_bin_token() when the operator prints a fresh label with a new UUID.';

COMMENT ON COLUMN bins.qr_rotated_at IS
  '0064: timestamp of last rotate_bin_token() call. Audit field — lets the operator see which bins had labels rotated and when.';

-- Filtered index for the active-token lookup that intake does on every
-- scan. The qr_token UNIQUE from 0001 stays.
CREATE INDEX IF NOT EXISTS bins_active_qr_idx
  ON bins (qr_token) WHERE qr_revoked_at IS NULL;

-- ----------------------------------------------------------------------------
-- rotate_bin_token() — fresh UUID + clear revocation.
-- Returns the new qr_token so the caller can immediately reprint.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION rotate_bin_token(p_bin_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller       UUID := auth.uid();
  v_operator_id  UUID;
  v_role         operator_user_role;
  v_bin_operator UUID;
  v_new_token    UUID := uuid_generate_v4();
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT operator_id, role INTO v_operator_id, v_role
  FROM operator_users WHERE user_id = v_caller LIMIT 1;
  IF v_operator_id IS NULL THEN
    RAISE EXCEPTION 'not_staff' USING ERRCODE = '42501';
  END IF;
  IF v_role NOT IN ('admin', 'manager') THEN
    RAISE EXCEPTION 'admin_or_manager_required' USING ERRCODE = '42501';
  END IF;

  -- Bin must belong to caller's operator (via warehouse).
  SELECT w.operator_id INTO v_bin_operator
  FROM bins b JOIN warehouses w ON w.id = b.warehouse_id
  WHERE b.id = p_bin_id LIMIT 1;
  IF v_bin_operator IS NULL THEN
    RAISE EXCEPTION 'bin_not_found' USING ERRCODE = '02000';
  END IF;
  IF v_bin_operator <> v_operator_id THEN
    RAISE EXCEPTION 'bin_other_operator' USING ERRCODE = '42501';
  END IF;

  UPDATE bins
     SET qr_token        = v_new_token,
         qr_rotated_at   = now(),
         qr_revoked_at   = NULL,
         qr_revoked_by   = NULL,
         qr_revoked_reason = NULL
   WHERE id = p_bin_id;

  RETURN v_new_token;
END;
$$;

REVOKE ALL ON FUNCTION rotate_bin_token(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rotate_bin_token(UUID) TO authenticated;

-- ----------------------------------------------------------------------------
-- revoke_bin_token() — block future scans without rotating.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION revoke_bin_token(p_bin_id UUID, p_reason TEXT DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller       UUID := auth.uid();
  v_operator_id  UUID;
  v_role         operator_user_role;
  v_bin_operator UUID;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT operator_id, role INTO v_operator_id, v_role
  FROM operator_users WHERE user_id = v_caller LIMIT 1;
  IF v_operator_id IS NULL THEN
    RAISE EXCEPTION 'not_staff' USING ERRCODE = '42501';
  END IF;
  IF v_role NOT IN ('admin', 'manager') THEN
    RAISE EXCEPTION 'admin_or_manager_required' USING ERRCODE = '42501';
  END IF;

  SELECT w.operator_id INTO v_bin_operator
  FROM bins b JOIN warehouses w ON w.id = b.warehouse_id
  WHERE b.id = p_bin_id LIMIT 1;
  IF v_bin_operator IS NULL THEN
    RAISE EXCEPTION 'bin_not_found' USING ERRCODE = '02000';
  END IF;
  IF v_bin_operator <> v_operator_id THEN
    RAISE EXCEPTION 'bin_other_operator' USING ERRCODE = '42501';
  END IF;

  UPDATE bins
     SET qr_revoked_at = now(),
         qr_revoked_by = v_caller,
         qr_revoked_reason = LEFT(COALESCE(p_reason, ''), 500)
   WHERE id = p_bin_id;
END;
$$;

REVOKE ALL ON FUNCTION revoke_bin_token(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION revoke_bin_token(UUID, TEXT) TO authenticated;

-- ----------------------------------------------------------------------------
-- Re-emit the 0063 intake RPCs to reject revoked tokens. Only diff
-- from 0063: the bin SELECT adds AND qr_revoked_at IS NULL.
-- ----------------------------------------------------------------------------

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

  -- 0064: reject revoked tokens. Active-bin lookup via the new
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

  -- (everything else identical to 0063)
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

  -- Manifest fall-through (unchanged from 0063).
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
    external_code, import_id, import_row_id,
    title, description, category, category_id, condition,
    msrp_cents, starting_bid_cents, cost_cents, photo_urls,
    asin, fnsku, lpn, brand, model,
    source,
    status, intake_bin_id, intake_at, close_at
  ) VALUES (
    v_op_id, NULL, NULL, v_bin.warehouse_id, v_lot_code,
    v_row.external_code, v_row.import_id, v_row.id,
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

-- ----------------------------------------------------------------------------

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

  -- 0064: reject revoked tokens
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
        external_code, import_id, import_row_id,
        title, description, category, category_id, condition,
        msrp_cents, starting_bid_cents, cost_cents, photo_urls,
        asin, fnsku, lpn, brand, model,
        source,
        status, intake_bin_id, intake_at, close_at
      ) VALUES (
        v_op_id, NULL, NULL, v_bin.warehouse_id, v_lot_code,
        v_row.external_code, v_row.import_id, v_row.id,
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
