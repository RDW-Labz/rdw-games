-- ============================================================================
-- 0059_manifest_intake_unified
--
-- Architectural shift: enforce "manifest = intent, lot = real, intake makes
-- it real." Imports populate `import_rows` (already true since 0029); now
-- the **only** path that creates a `lots` row from a manifest line is a
-- physical intake scan. The lot is born already-in-`in_inventory` — there
-- is no pre-binned `pending_intake` step for manifest-derived lots.
--
-- Why this matters:
--   • Before: clicking "Lot N selected" in the manifest pool minted lot_codes
--     and pending_intake lots for items still on a truck somewhere. Those
--     leaked into /lotting/inventory and conflated "expected" with "real".
--   • After: manifest rows stay manifest rows until somebody scans the
--     physical item next to a bin QR. At that moment a fully-populated
--     in_inventory lot springs into existence.
--   • Field-lotted lots (Quick Lot / Photo Scan / Shelf Scan) are unaffected:
--     they still create pending_intake lots because the operator IS holding
--     the item and printing a thermal label, just hasn't placed it in a bin
--     yet. Those lots ARE real — they have lot_codes printed on labels.
--
-- Changes in this migration:
--   1. DROP `lot_import_rows(uuid[])` RPC (the premature-lot path).
--   2. REPLACE `intake_lot_to_bin(text, uuid)` to fall through to manifest
--      pool when no existing lot matches the identifier. Mints a lot
--      directly into `in_inventory` with all identity fields copied from
--      the import_row PLUS source_label propagated from imports.
--   3. REPLACE `batch_intake_lot_to_bin(text[], uuid)` with the same
--      fall-through behavior, per-identifier.
--
-- Bug fixes folded in (independent of the architectural change but in
-- the blast radius — the new RPCs do them right by construction):
--   A. `lot_import_rows` previously dropped: source (from imports.source_label),
--      sub_category_raw (no column on lots), pallet_id (no column on lots),
--      cost_cents (no column on lots), quantity (lots are 1:1 by design),
--      return_reason (no column on lots), sku (no column). Of those, only
--      source was reachable on lots; we now propagate it. The rest stay on
--      import_rows for forensics.
--   B. asin/fnsku/lpn/brand/model were already being copied by 0032's update
--      to lot_import_rows; the new path keeps copying them.
--
-- Concurrency:
--   FOR UPDATE row-locks the import_row before mint, so two pickers
--   intaking the same UPC simultaneously can't double-mint. The loser
--   re-checks status='pending' and bails with manifest_already_lotted.
--
-- Backwards compatibility:
--   • Existing pending_intake lots that came from old `lot_import_rows`
--     calls (count: zero, verified live) intentionally not migrated.
--     Field-lotted pending_intake lots are unaffected.
--   • `import_rows.lot_id` semantics tighten: was "a lot exists for this
--     row (possibly pending)"; now "a lot was minted at intake (always
--     in_inventory or further along)".
--   • Operator-web `imports/[id]/actions.ts` `lotSelectedRows` and the
--     "Lot N selected" button must be removed in the same release. See
--     follow-up commit.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Drop the premature-lot path.
-- ----------------------------------------------------------------------------

DROP FUNCTION IF EXISTS lot_import_rows(UUID[]);

COMMENT ON COLUMN import_rows.lot_id IS
  'Set when a lot is minted at physical intake via intake_lot_to_bin / batch_intake_lot_to_bin (0059). Was previously set by lot_import_rows pre-intake; that RPC is gone.';

-- ----------------------------------------------------------------------------
-- 2. Extended intake_lot_to_bin with manifest fall-through.
--
-- Resolution order (unchanged from 0032 for the existing-lot path):
--   1. lots.lot_code              (app-wide unique)
--   2. lots.id (UUID)             (app-wide unique)
--   3. lots.lpn                   (Amazon — operator-scoped)
--   4. lots.fnsku                 (Amazon — operator-scoped)
--   5. lots.asin                  (Amazon — operator-scoped, prefer pending)
--   6. lots.external_code         (operator-scoped catch-all)
--
-- NEW fall-through to manifest pool (operator-scoped, status='pending'):
--   7. import_rows.lpn
--   8. import_rows.fnsku
--   9. import_rows.asin
--  10. import_rows.external_code
--  11. import_rows.upc
--  12. import_rows.title (exact match — many supplier manifests put their
--      SKU in the title column, e.g. Lowe's "2026VA-30-372-900L". Exact
--      match only — descriptive titles like "DeWalt 20V Drill" won't be
--      a barcode scan target so this is safe. Tie-break on oldest pending.)
--
-- When 7-11 hits, mint a brand-new lot in `in_inventory` and mark the
-- import_row 'lotted'. The result row is shaped identically to the
-- existing-lot path so callers can't tell the difference.
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

  -- ── Resolve bin first — if the bin is bad, neither lookup nor mint
  --    should happen. Same logic as before, just hoisted above so the
  --    manifest mint path doesn't waste work on a bad bin scan.
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

  -- ── Existing-lot path (unchanged from 0032). ────────────────────────────
  -- 1. lot_code
  SELECT * INTO v_lot FROM lots WHERE lot_code = v_id_clean LIMIT 1;

  -- 2. UUID
  IF v_lot.id IS NULL THEN
    BEGIN
      SELECT * INTO v_lot FROM lots WHERE id = v_id_clean::UUID;
    EXCEPTION WHEN invalid_text_representation THEN
      v_lot := NULL;
    END;
  END IF;

  -- 3. LPN
  IF v_lot.id IS NULL THEN
    SELECT * INTO v_lot FROM lots
    WHERE operator_id = v_op_id AND lpn = v_id_clean LIMIT 1;
  END IF;

  -- 4. FNSKU
  IF v_lot.id IS NULL THEN
    SELECT * INTO v_lot FROM lots
    WHERE operator_id = v_op_id AND fnsku = v_id_clean LIMIT 1;
  END IF;

  -- 5. ASIN
  IF v_lot.id IS NULL THEN
    SELECT * INTO v_lot FROM lots
    WHERE operator_id = v_op_id AND asin = v_id_clean
    ORDER BY (status = 'pending_intake') DESC, created_at DESC
    LIMIT 1;
  END IF;

  -- 6. external_code
  IF v_lot.id IS NULL THEN
    SELECT * INTO v_lot FROM lots
    WHERE operator_id = v_op_id AND external_code = v_id_clean LIMIT 1;
  END IF;

  -- ── Existing-lot HIT: original update path ──────────────────────────────
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

  -- ── Manifest fall-through path (NEW in 0059). ───────────────────────────
  -- Look for a pending import_row whose any identifier matches the scanned
  -- string. Most-specific first (LPN unit-level → FNSKU → ASIN → external →
  -- UPC). Tie-break on oldest pending — first-in-first-out for the pool.
  --
  -- FOR UPDATE locks the import_row so concurrent intakes of the same UPC
  -- on two devices can't both mint. The loser sees status='lotted' on
  -- re-check and falls through to manifest_already_lotted.

  -- 7. import_rows.lpn
  SELECT * INTO v_row FROM import_rows
  WHERE operator_id = v_op_id AND status = 'pending' AND lpn = v_id_clean
  ORDER BY created_at ASC LIMIT 1
  FOR UPDATE;

  -- 8. import_rows.fnsku
  IF v_row.id IS NULL THEN
    SELECT * INTO v_row FROM import_rows
    WHERE operator_id = v_op_id AND status = 'pending' AND fnsku = v_id_clean
    ORDER BY created_at ASC LIMIT 1
    FOR UPDATE;
  END IF;

  -- 9. import_rows.asin
  IF v_row.id IS NULL THEN
    SELECT * INTO v_row FROM import_rows
    WHERE operator_id = v_op_id AND status = 'pending' AND asin = v_id_clean
    ORDER BY created_at ASC LIMIT 1
    FOR UPDATE;
  END IF;

  -- 10. import_rows.external_code
  IF v_row.id IS NULL THEN
    SELECT * INTO v_row FROM import_rows
    WHERE operator_id = v_op_id AND status = 'pending' AND external_code = v_id_clean
    ORDER BY created_at ASC LIMIT 1
    FOR UPDATE;
  END IF;

  -- 11. import_rows.upc
  IF v_row.id IS NULL THEN
    SELECT * INTO v_row FROM import_rows
    WHERE operator_id = v_op_id AND status = 'pending' AND upc = v_id_clean
    ORDER BY created_at ASC LIMIT 1
    FOR UPDATE;
  END IF;

  -- 12. import_rows.title (exact match — covers supplier-SKU-as-title)
  IF v_row.id IS NULL THEN
    SELECT * INTO v_row FROM import_rows
    WHERE operator_id = v_op_id AND status = 'pending' AND title = v_id_clean
    ORDER BY created_at ASC LIMIT 1
    FOR UPDATE;
  END IF;

  -- Nothing matched anywhere.
  IF v_row.id IS NULL THEN
    v_result := (false, 'lot_not_found', NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;

  -- Manifest hit — mint the lot.
  -- Pull source_label from the parent import (operators tag a manifest
  -- with "Truck 47L 5/9" etc.; that propagates to lots.source for
  -- profitability-by-truck reporting).
  SELECT source_label INTO v_source_label
    FROM imports
   WHERE id = v_row.import_id
   LIMIT 1;

  -- Trim source to lots.source CHECK (length ≤ 120; see 0055).
  IF v_source_label IS NOT NULL THEN
    v_source_label := LEFT(TRIM(v_source_label), 120);
    IF LENGTH(v_source_label) = 0 THEN v_source_label := NULL; END IF;
  END IF;

  -- Mint next lot_code.
  SELECT next_lot_code(v_op_id) INTO v_lot_code;

  -- photo_url is single TEXT on import_rows; lots wants TEXT[].
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
    -- import_rows.condition is TEXT; lots.condition is the lot_condition
    -- enum (appears_new/open_box/good/as_is — see 0001). Validate before
    -- cast so a stray manifest value doesn't 22P02 the whole intake.
    CASE
      WHEN v_row.condition IN ('appears_new','open_box','good','as_is')
        THEN v_row.condition::lot_condition
      ELSE 'good'::lot_condition
    END,
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

COMMENT ON FUNCTION intake_lot_to_bin(TEXT, UUID) IS
  '0059: scans an identifier (lot_code/UUID/LPN/FNSKU/ASIN/external_code/UPC) plus a bin QR. Updates an existing lot to in_inventory if found; otherwise falls through to manifest pool (import_rows where status=pending) and mints a fresh lot directly into in_inventory with source_label propagated from imports. Result composite intake_lot_result has reason=ok for existing-lot updates and reason=ok_minted_from_manifest for fresh manifest-derived lots; mobile clients only need to switch on result.ok (the reason string is informational).';

-- ----------------------------------------------------------------------------
-- 3. Extended batch_intake_lot_to_bin with the same manifest fall-through.
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

  -- Resolve bin once.
  SELECT * INTO v_bin FROM bins WHERE qr_token = p_bin_qr_token LIMIT 1;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT operator_id INTO v_bin_op FROM warehouses WHERE id = v_bin.warehouse_id;
  IF v_bin_op IS DISTINCT FROM v_op_id THEN RETURN; END IF;

  FOREACH v_identifier IN ARRAY p_lot_identifiers LOOP
    v_id_clean := TRIM(v_identifier);
    v_lot := NULL;
    v_row := NULL;

    -- ── Existing-lot resolution (steps 1-6, identical to 0036). ────────────
    -- NB: qualify `lots.lot_code` to disambiguate from the RETURNS TABLE
    -- column of the same name. PG sees both as candidates without the
    -- table prefix and bails with 42702.
    SELECT * INTO v_lot FROM lots WHERE lots.lot_code = v_id_clean LIMIT 1;

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

    -- ── Existing-lot path: same as 0036. ──────────────────────────────────
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

    -- ── Manifest fall-through (NEW in 0059, same priority as single-lot RPC). ─
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

    -- Mint a new lot from the manifest row.
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
        -- import_rows.condition is TEXT; lots.condition is the lot_condition
    -- enum (appears_new/open_box/good/as_is — see 0001). Validate before
    -- cast so a stray manifest value doesn't 22P02 the whole intake.
    CASE
      WHEN v_row.condition IN ('appears_new','open_box','good','as_is')
        THEN v_row.condition::lot_condition
      ELSE 'good'::lot_condition
    END,
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

COMMENT ON FUNCTION batch_intake_lot_to_bin(TEXT[], UUID) IS
  '0059: batch version of intake_lot_to_bin with the same manifest fall-through. Per-row code=ok for existing-lot updates, ok_minted_from_manifest for fresh manifest-derived lots, lot_not_found if neither match. Bin resolution failure returns zero rows.';
