-- ============================================================================
-- Phase 5: Amazon-aware identifiers + expanded import field set.
--
-- Real-world manifests carry more than UPC + title. Amazon FC return
-- manifests in particular always ship ASIN, FNSKU, and LPN — those are
-- the codes pickers actually scan at the auction pickup center. The
-- platform's intake flow needs to resolve any of them to the right lot.
--
-- This migration:
--   A. Adds Amazon identifiers (asin, fnsku, lpn) to import_rows + lots
--   B. Adds extra import fields (brand, model, pallet_id, quantity,
--      cost_cents, sub_category_raw, return_reason) to import_rows
--   C. Extends lot_import_rows() RPC to copy the new fields when minting
--      a lot from a manifest row
--   D. Extends intake_lot_to_bin() RPC to resolve scans by ASIN, FNSKU,
--      LPN, or UPC in addition to lot_code / UUID / external_code
--
-- ASIN/FNSKU relationship:
--   - One ASIN (product) → many FNSKUs (per-seller-per-condition listings)
--   - One FNSKU → many LPNs (each return shipment unit gets a unique LPN)
--   - All three are scanned at intake; the RPC tries them in turn.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- A. Add columns to import_rows.
-- ----------------------------------------------------------------------------

ALTER TABLE import_rows
  ADD COLUMN IF NOT EXISTS asin              TEXT,
  ADD COLUMN IF NOT EXISTS fnsku             TEXT,
  ADD COLUMN IF NOT EXISTS lpn               TEXT,
  ADD COLUMN IF NOT EXISTS brand             TEXT,
  ADD COLUMN IF NOT EXISTS model             TEXT,
  ADD COLUMN IF NOT EXISTS pallet_id         TEXT,
  ADD COLUMN IF NOT EXISTS quantity          INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS cost_cents        BIGINT,
  ADD COLUMN IF NOT EXISTS sub_category_raw  TEXT,
  ADD COLUMN IF NOT EXISTS return_reason     TEXT;

COMMENT ON COLUMN import_rows.asin IS 'Amazon Standard Identification Number — one per product, scannable at intake.';
COMMENT ON COLUMN import_rows.fnsku IS 'Amazon Fulfillment Network SKU — per-seller-per-condition. Many FNSKUs can share one ASIN.';
COMMENT ON COLUMN import_rows.lpn IS 'Amazon License Plate Number — unique per return shipment unit. Pickers scan these on the box label.';
COMMENT ON COLUMN import_rows.quantity IS 'Units this manifest row represents. Defaults to 1; >1 means the row could spawn multiple lots when lotted.';

-- ----------------------------------------------------------------------------
-- B. Add columns to lots (subset that should propagate from import_rows).
-- ----------------------------------------------------------------------------

ALTER TABLE lots
  ADD COLUMN IF NOT EXISTS asin     TEXT,
  ADD COLUMN IF NOT EXISTS fnsku    TEXT,
  ADD COLUMN IF NOT EXISTS lpn      TEXT,
  ADD COLUMN IF NOT EXISTS brand    TEXT,
  ADD COLUMN IF NOT EXISTS model    TEXT;

-- ----------------------------------------------------------------------------
-- C. Indexes — sparse partial indexes since most operators won't have ASINs.
-- All scoped per-operator (operator_id leading) so cross-tenant scans don't
-- collide on the same Amazon ASIN at two operators.
-- ----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS import_rows_asin_idx
  ON import_rows (operator_id, asin) WHERE asin IS NOT NULL;
CREATE INDEX IF NOT EXISTS import_rows_fnsku_idx
  ON import_rows (operator_id, fnsku) WHERE fnsku IS NOT NULL;
CREATE INDEX IF NOT EXISTS import_rows_lpn_idx
  ON import_rows (operator_id, lpn) WHERE lpn IS NOT NULL;
CREATE INDEX IF NOT EXISTS import_rows_pallet_idx
  ON import_rows (operator_id, pallet_id) WHERE pallet_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS lots_asin_idx
  ON lots (operator_id, asin) WHERE asin IS NOT NULL;
CREATE INDEX IF NOT EXISTS lots_fnsku_idx
  ON lots (operator_id, fnsku) WHERE fnsku IS NOT NULL;
CREATE INDEX IF NOT EXISTS lots_lpn_idx
  ON lots (operator_id, lpn) WHERE lpn IS NOT NULL;

-- Brand index for bidder browse / operator filtering. Trgm GIN so partial
-- matches work ("dewa" → DeWalt).
CREATE INDEX IF NOT EXISTS lots_brand_trgm_idx
  ON lots USING GIN (brand gin_trgm_ops) WHERE brand IS NOT NULL;
CREATE INDEX IF NOT EXISTS import_rows_brand_trgm_idx
  ON import_rows USING GIN (brand gin_trgm_ops) WHERE brand IS NOT NULL;

-- ----------------------------------------------------------------------------
-- D. Update lot_import_rows RPC to copy the new fields when minting a lot.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION lot_import_rows(
  p_import_row_ids UUID[]
)
RETURNS TABLE (
  import_row_id UUID,
  lot_id UUID,
  lot_code TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller UUID := auth.uid();
  v_operator_id UUID;
  v_role operator_user_role;
  v_row RECORD;
  v_lot_code TEXT;
  v_lot_id UUID;
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

  FOR v_row IN
    SELECT *
    FROM import_rows
    WHERE id = ANY(p_import_row_ids)
      AND operator_id = v_operator_id
      AND status = 'pending'
    FOR UPDATE
  LOOP
    SELECT next_lot_code(v_operator_id) INTO v_lot_code;

    INSERT INTO lots (
      operator_id, auction_id, lot_number, warehouse_id, lot_code,
      external_code, import_id, import_row_id,
      title, description, category, category_id, condition,
      msrp_cents, starting_bid_cents, photo_urls, status, close_at,
      asin, fnsku, lpn, brand, model
    ) VALUES (
      v_operator_id, NULL, NULL, v_row.warehouse_id, v_lot_code,
      v_row.external_code, v_row.import_id, v_row.id,
      v_row.title, v_row.description, v_row.category_raw, v_row.category_id,
      COALESCE(v_row.condition, 'good'),
      v_row.msrp_cents, COALESCE(v_row.starting_bid_cents, 100),
      CASE WHEN v_row.photo_url IS NOT NULL THEN ARRAY[v_row.photo_url] ELSE '{}'::TEXT[] END,
      'pending_intake', NULL,
      v_row.asin, v_row.fnsku, v_row.lpn, v_row.brand, v_row.model
    )
    RETURNING id INTO v_lot_id;

    UPDATE import_rows
       SET status = 'lotted', lot_id = v_lot_id, lotted_at = now()
     WHERE id = v_row.id;

    import_row_id := v_row.id;
    lot_id := v_lot_id;
    lot_code := v_lot_code;
    RETURN NEXT;
  END LOOP;

  RETURN;
END;
$$;

REVOKE EXECUTE ON FUNCTION lot_import_rows(UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION lot_import_rows(UUID[]) TO authenticated;

-- ----------------------------------------------------------------------------
-- E. Update intake_lot_to_bin to resolve by ASIN / FNSKU / LPN / UPC too.
--
-- New resolution order (operator-scoped where applicable):
--   1. lot_code (app-wide unique, our primary)
--   2. UUID (app-wide unique)
--   3. LPN (Amazon — most specific, unit-level)
--   4. FNSKU (Amazon — per-listing)
--   5. ASIN (Amazon — per-product, may be ambiguous if operator has
--      multiple lots from the same ASIN; we take the most-recently-
--      intaked pending one)
--   6. UPC (lots.external_code numeric form, plus the new lots.upc
--      column where present — actually UPC isn't stored on lots
--      directly; we match against external_code where the value is
--      digits-only 8-14)
--   7. external_code (operator-scoped fallback)
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
  v_op_id UUID;
  v_lot lots%ROWTYPE;
  v_bin bins%ROWTYPE;
  v_bin_operator UUID;
  v_result intake_lot_result;
  v_id_clean TEXT := TRIM(p_lot_identifier);
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

  -- 1. lot_code (unique per operator code series)
  SELECT * INTO v_lot FROM lots WHERE lot_code = v_id_clean LIMIT 1;

  -- 2. UUID
  IF v_lot.id IS NULL THEN
    BEGIN
      SELECT * INTO v_lot FROM lots WHERE id = v_id_clean::UUID;
    EXCEPTION WHEN invalid_text_representation THEN
      v_lot := NULL;
    END;
  END IF;

  -- 3. LPN (Amazon — unit-level, operator-scoped)
  IF v_lot.id IS NULL THEN
    SELECT * INTO v_lot FROM lots
    WHERE operator_id = v_op_id AND lpn = v_id_clean
    LIMIT 1;
  END IF;

  -- 4. FNSKU (Amazon — operator-scoped)
  IF v_lot.id IS NULL THEN
    SELECT * INTO v_lot FROM lots
    WHERE operator_id = v_op_id AND fnsku = v_id_clean
    LIMIT 1;
  END IF;

  -- 5. ASIN (Amazon — operator-scoped, prefer the most recent
  --    pending_intake lot if multiple match)
  IF v_lot.id IS NULL THEN
    SELECT * INTO v_lot FROM lots
    WHERE operator_id = v_op_id AND asin = v_id_clean
    ORDER BY (status = 'pending_intake') DESC, created_at DESC
    LIMIT 1;
  END IF;

  -- 6. external_code (operator-scoped catch-all — covers UPCs imported
  --    as external_code, supplier SKUs, route stops, etc.)
  IF v_lot.id IS NULL THEN
    SELECT * INTO v_lot FROM lots
    WHERE operator_id = v_op_id AND external_code = v_id_clean
    LIMIT 1;
  END IF;

  IF v_lot.id IS NULL THEN
    v_result := (false, 'lot_not_found', NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;
  IF v_lot.operator_id <> v_op_id THEN
    v_result := (false, 'lot_other_operator', NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;
  IF v_lot.status <> 'pending_intake' AND v_lot.status <> 'in_inventory' THEN
    v_result := (false, 'lot_not_in_intake_state', v_lot.id, v_lot.lot_code, NULL, NULL);
    RETURN v_result;
  END IF;

  -- Resolve bin
  SELECT * INTO v_bin FROM bins WHERE qr_token = p_bin_qr_token LIMIT 1;
  IF NOT FOUND THEN
    v_result := (false, 'bin_not_found', v_lot.id, v_lot.lot_code, NULL, NULL);
    RETURN v_result;
  END IF;
  SELECT operator_id INTO v_bin_operator FROM warehouses WHERE id = v_bin.warehouse_id;
  IF v_bin_operator <> v_op_id THEN
    v_result := (false, 'bin_other_operator', v_lot.id, v_lot.lot_code, NULL, NULL);
    RETURN v_result;
  END IF;

  UPDATE lots
  SET status = 'in_inventory',
      intake_bin_id = v_bin.id,
      warehouse_id = v_bin.warehouse_id,
      intake_at = now(),
      updated_at = now()
  WHERE id = v_lot.id;

  v_result := (
    true,
    'ok',
    v_lot.id,
    v_lot.lot_code,
    v_bin.code,
    v_bin.warehouse_id
  );
  RETURN v_result;
END;
$$;
