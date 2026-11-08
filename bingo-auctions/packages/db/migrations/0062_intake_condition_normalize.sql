-- ============================================================================
-- 0062_intake_condition_normalize
--
-- The 0059 intake RPCs silently fall back to 'good' when the manifest
-- row's condition isn't already exactly one of the four lot_condition
-- enum strings (`appears_new`, `open_box`, `good`, `as_is`). Real-world
-- manifests use very different language:
--
--   • Amazon LPN tags:     'New', 'Used', 'Used - Like New', 'Salvage'
--   • Lowe's manifests:    'NEW', 'OPEN BOX', 'DAMAGED', 'AS-IS'
--   • Home Depot returns:  'TESTED', 'REFURB', 'CUSTOMER RETURN', 'PARTS'
--
-- The previous CASE statement saw any of those and silently coerced
-- them to `good` — an operator could end up listing salvage as used or
-- new as open-box without any warning. This is a quiet pricing /
-- consumer-trust bug.
--
-- This migration replaces the dumb CASE with a centralised normalizer
-- function `normalize_manifest_condition(TEXT)` that maps common
-- supplier vocabularies to the platform's four-enum target. Both
-- `intake_lot_to_bin` and `batch_intake_lot_to_bin` (created in 0059)
-- are re-emitted to call this function instead of the inline CASE.
--
-- Conservative mapping bias: when in doubt, lean toward the LOWER
-- condition tier. "tested" maps to good (not appears_new); "damaged"
-- maps to as_is (not good). This protects the buyer from over-grading
-- and protects the operator from no-pickup / dispute risk.
--
-- Mapping table (case-insensitive, applied after trim):
--   appears_new ← new, sealed, factory sealed, brand new, nib, appears new, like new
--   open_box    ← open box, openbox, opened, returned-unopened, customer return,
--                  store return, opened-tested, tested-working
--   good        ← good, used, tested, refurbished, refurb, working, complete, used-good
--   as_is       ← as is, as-is, asis, salvage, damaged, parts, broken, untested, scratch and dent
-- ============================================================================

CREATE OR REPLACE FUNCTION normalize_manifest_condition(p_raw TEXT)
RETURNS lot_condition
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_lower TEXT := LOWER(TRIM(COALESCE(p_raw, '')));
BEGIN
  -- Empty / whitespace → default. Same behaviour as old CASE's fallback.
  IF v_lower = '' THEN RETURN 'good'::lot_condition; END IF;

  -- Most-specific first: salvage / damaged before anything containing
  -- 'used' (some manifests say 'used - parts only').
  IF v_lower ~ '(salvage|damage|broken|parts|scratch[- ]and[- ]dent|untested|as[- ]?is|defect)' THEN
    RETURN 'as_is'::lot_condition;
  END IF;

  -- New / sealed / factory states.
  IF v_lower ~ '(brand[- ]?new|^new$|factory[- ]?sealed|sealed|^nib$|like[- ]?new|^appears[ -]?new$)' THEN
    RETURN 'appears_new'::lot_condition;
  END IF;

  -- Open box / customer return states.
  IF v_lower ~ '(open[- ]?box|opened|customer[- ]?return|store[- ]?return|returned)' THEN
    RETURN 'open_box'::lot_condition;
  END IF;

  -- Everything in the "tested/working/used/refurb" middle band → good.
  IF v_lower ~ '(used|tested|working|refurb|complete|good)' THEN
    RETURN 'good'::lot_condition;
  END IF;

  -- Final fallback: still lean toward the lower tier rather than
  -- silently grading up. The supplier's raw value will be visible
  -- on the import_rows row for audit; the lot itself gets 'as_is'
  -- so listings don't over-promise.
  RETURN 'as_is'::lot_condition;
END;
$$;

COMMENT ON FUNCTION normalize_manifest_condition(TEXT) IS
  '0062: maps supplier-vocab condition strings (Amazon LPN, Lowe''s, Home Depot, etc.) to the platform''s lot_condition enum. Conservative bias — unknown values fall to as_is to avoid silently grading up. Used by intake_lot_to_bin and batch_intake_lot_to_bin.';

GRANT EXECUTE ON FUNCTION normalize_manifest_condition(TEXT) TO authenticated;

-- ----------------------------------------------------------------------------
-- Re-emit the two intake RPCs from 0059 with the new normalizer.
--
-- Body is byte-for-byte identical to 0059 except the inline condition
-- CASE in the manifest-fall-through INSERTs is replaced by a call to
-- normalize_manifest_condition().
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

  SELECT * INTO v_bin FROM bins WHERE qr_token = p_bin_qr_token LIMIT 1;
  IF NOT FOUND THEN
    v_result := (false, 'bin_not_found', NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;
  SELECT operator_id INTO v_bin_operator FROM warehouses WHERE id = v_bin.warehouse_id;
  IF v_bin_operator <> v_op_id THEN
    v_result := (false, 'bin_other_operator', NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;

  -- Existing-lot resolution (steps 1-6, unchanged from 0059).
  SELECT * INTO v_lot FROM lots WHERE lot_code = v_id_clean LIMIT 1;

  IF v_lot.id IS NULL THEN
    BEGIN
      SELECT * INTO v_lot FROM lots WHERE id = v_id_clean::UUID;
    EXCEPTION WHEN invalid_text_representation THEN
      v_lot := NULL;
    END;
  END IF;

  IF v_lot.id IS NULL THEN
    SELECT * INTO v_lot FROM lots
    WHERE operator_id = v_op_id AND lpn = v_id_clean LIMIT 1;
  END IF;
  IF v_lot.id IS NULL THEN
    SELECT * INTO v_lot FROM lots
    WHERE operator_id = v_op_id AND fnsku = v_id_clean LIMIT 1;
  END IF;
  IF v_lot.id IS NULL THEN
    SELECT * INTO v_lot FROM lots
    WHERE operator_id = v_op_id AND asin = v_id_clean
    ORDER BY (status = 'pending_intake') DESC, created_at DESC LIMIT 1;
  END IF;
  IF v_lot.id IS NULL THEN
    SELECT * INTO v_lot FROM lots
    WHERE operator_id = v_op_id AND external_code = v_id_clean LIMIT 1;
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
       SET status        = 'in_inventory',
           intake_bin_id = v_bin.id,
           warehouse_id  = v_bin.warehouse_id,
           intake_at     = now(),
           updated_at    = now()
     WHERE id = v_lot.id;

    v_result := (true, 'ok', v_lot.id, v_lot.lot_code, v_bin.code, v_bin.warehouse_id);
    RETURN v_result;
  END IF;

  -- Manifest fall-through (steps 7-12, unchanged).
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
    FROM imports
   WHERE id = v_row.import_id
   LIMIT 1;

  IF v_source_label IS NOT NULL THEN
    v_source_label := LEFT(TRIM(v_source_label), 120);
    IF LENGTH(v_source_label) = 0 THEN v_source_label := NULL; END IF;
  END IF;

  SELECT next_lot_code(v_op_id) INTO v_lot_code;

  v_new_photos := CASE
    WHEN v_row.photo_url IS NOT NULL AND LENGTH(TRIM(v_row.photo_url)) > 0
      THEN ARRAY[v_row.photo_url]
    ELSE '{}'::TEXT[]
  END;

  INSERT INTO lots (
    operator_id, auction_id, lot_number, warehouse_id, lot_code,
    external_code, import_id, import_row_id,
    title, description, category, category_id, condition,
    msrp_cents, starting_bid_cents, photo_urls,
    asin, fnsku, lpn, brand, model,
    source,
    status, intake_bin_id, intake_at, close_at
  ) VALUES (
    v_op_id, NULL, NULL, v_bin.warehouse_id, v_lot_code,
    v_row.external_code, v_row.import_id, v_row.id,
    v_row.title, v_row.description, v_row.category_raw, v_row.category_id,
    -- 0062: replaces the inline four-value CASE from 0059.
    normalize_manifest_condition(v_row.condition),
    v_row.msrp_cents, COALESCE(v_row.starting_bid_cents, 100),
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
-- batch_intake_lot_to_bin — identical body, same normalizer swap.
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

  SELECT * INTO v_bin FROM bins WHERE qr_token = p_bin_qr_token LIMIT 1;
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
      EXCEPTION WHEN invalid_text_representation THEN
        v_lot.id := NULL;
      END;
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
          THEN ARRAY[v_row.photo_url]
        ELSE '{}'::TEXT[]
      END;

      INSERT INTO lots (
        operator_id, auction_id, lot_number, warehouse_id, lot_code,
        external_code, import_id, import_row_id,
        title, description, category, category_id, condition,
        msrp_cents, starting_bid_cents, photo_urls,
        asin, fnsku, lpn, brand, model,
        source,
        status, intake_bin_id, intake_at, close_at
      ) VALUES (
        v_op_id, NULL, NULL, v_bin.warehouse_id, v_lot_code,
        v_row.external_code, v_row.import_id, v_row.id,
        v_row.title, v_row.description, v_row.category_raw, v_row.category_id,
        -- 0062: replaces the inline four-value CASE from 0059.
        normalize_manifest_condition(v_row.condition),
        v_row.msrp_cents, COALESCE(v_row.starting_bid_cents, 100),
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
