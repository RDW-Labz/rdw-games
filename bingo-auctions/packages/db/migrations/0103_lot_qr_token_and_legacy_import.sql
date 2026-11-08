-- ============================================================================
-- Migration 0103 — Per-lot QR token + legacy code support + bulk import.
--
-- Purpose
-- -------
-- Three new lot-level capabilities, all additive:
--
--   1. Every lot gets a rotatable `qr_token` UUID. Stickers printed by the
--      operator encode  https://clovrbid.com/l/{qr_token}  so:
--        - Outside the app, the URL opens the public lot page on
--          clovrbid.com (browse + sign-in-to-bid).
--        - Inside the bidder app, the universal-link is intercepted and
--          deep-links to the in-app lot screen.
--      qr_token is independent from lot_code: lot_code is the human-readable
--      identifier ("CLR-000087"); qr_token is the public link target. We can
--      rotate qr_token without changing the bin labels on physical items.
--      (Bins follow the same pattern via bins.qr_token in 0001.)
--
--   2. Legacy code support: operators switching from another auction SaaS
--      can import their old per-lot codes via `lots.legacy_lot_code` and
--      `lots.legacy_platform`. Searchable per-operator in the operator
--      console (e.g. "find my old BidFTA lot #57123"). Coexists with our
--      `lot_code` — every lot still gets a CLR-NNNNNN code minted at
--      import time.
--
--   3. Bulk import via `bulk_import_lots()` RPC. Takes a JSONB array of
--      pre-mapped rows from the smart-import wizard UI (drag-around column
--      mapping in operator-web) and atomically:
--        - mints a lot_code from next_lot_code(operator_id)
--        - preserves the legacy_lot_code if the user opted in
--        - inserts into lots with status='in_inventory' (items already
--          physically exist — this is a migration, not a manifest)
--        - records the batch in lot_import_batches for rollback
--
-- Migration is ADDITIVE ONLY. Nothing in 0001..0102 changes shape; we
-- replace `intake_lot_to_bin` to add a qr_token lookup branch but the
-- function signature and return type are unchanged.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. lots.qr_token — per-lot universal-link UUID
-- ---------------------------------------------------------------------------

ALTER TABLE lots
  ADD COLUMN IF NOT EXISTS qr_token        UUID,
  ADD COLUMN IF NOT EXISTS qr_rotated_at   TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS legacy_lot_code TEXT,
  ADD COLUMN IF NOT EXISTS legacy_platform TEXT,
  ADD COLUMN IF NOT EXISTS lot_import_batch_id UUID,
  -- 0032 added upc to import_rows but left lots without it. Bulk imports
  -- and barcode-scan lookups both want a per-lot UPC column.
  ADD COLUMN IF NOT EXISTS upc             TEXT;

CREATE INDEX IF NOT EXISTS lots_upc_idx
  ON lots (operator_id, upc) WHERE upc IS NOT NULL;

-- Backfill qr_token for every existing lot. Done in batches to avoid a
-- long lock on large operator tables; we do not actually have million-lot
-- operators yet, but the pattern is correct.
UPDATE lots SET qr_token = uuid_generate_v4() WHERE qr_token IS NULL;

ALTER TABLE lots ALTER COLUMN qr_token SET NOT NULL;
ALTER TABLE lots ALTER COLUMN qr_token SET DEFAULT uuid_generate_v4();

CREATE UNIQUE INDEX IF NOT EXISTS lots_qr_token_unique ON lots (qr_token);

-- ---------------------------------------------------------------------------
-- 2. Legacy code: per-operator unique, nullable
-- ---------------------------------------------------------------------------
-- An operator running BidFTA and MaxxSold previously can have the same
-- legacy code from each platform (very unlikely but possible). We store
-- legacy_platform so the operator can disambiguate; uniqueness is per
-- (operator_id, legacy_lot_code, legacy_platform) when both are set.

CREATE UNIQUE INDEX IF NOT EXISTS lots_legacy_code_unique
  ON lots (operator_id, legacy_lot_code, legacy_platform)
  WHERE legacy_lot_code IS NOT NULL;

-- Per-operator search index. Allows "find my old BidFTA lot 57123" to be
-- a single index scan even on operators with 100k+ lots.
CREATE INDEX IF NOT EXISTS lots_legacy_search_idx
  ON lots (operator_id, legacy_lot_code)
  WHERE legacy_lot_code IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. lot_import_batches — tracks each bulk import (CSV/XLSX from old SaaS)
-- ---------------------------------------------------------------------------
-- Created when the operator hits "Import" in the smart-import wizard.
-- One row per upload. lots.lot_import_batch_id points back here so we can
-- show import history + offer a "rollback this import" action.

CREATE TABLE IF NOT EXISTS lot_import_batches (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  operator_id     UUID NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  imported_by     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  filename        TEXT,
  -- Source platform name from the wizard ('BidFTA', 'MaxxSold', 'csv').
  -- Used to populate lots.legacy_platform.
  source_label    TEXT,
  row_count       INTEGER NOT NULL DEFAULT 0,
  inserted_count  INTEGER NOT NULL DEFAULT 0,
  skipped_count   INTEGER NOT NULL DEFAULT 0,
  -- Snapshot of the user's column mapping for audit / re-import.
  column_mapping  JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- 'completed' | 'failed' | 'rolled_back'.
  status          TEXT NOT NULL DEFAULT 'completed',
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  rolled_back_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS lot_import_batches_operator_idx
  ON lot_import_batches (operator_id, created_at DESC);

ALTER TABLE lots
  ADD CONSTRAINT lots_lot_import_batch_fk
  FOREIGN KEY (lot_import_batch_id)
  REFERENCES lot_import_batches(id)
  ON DELETE SET NULL;

ALTER TABLE lot_import_batches ENABLE ROW LEVEL SECURITY;

-- RLS: an operator can see + manage their own import batches.
CREATE POLICY lot_import_batches_own_select
  ON lot_import_batches FOR SELECT
  USING (operator_id = current_operator_id());

CREATE POLICY lot_import_batches_own_insert
  ON lot_import_batches FOR INSERT
  WITH CHECK (operator_id = current_operator_id());

CREATE POLICY lot_import_batches_own_update
  ON lot_import_batches FOR UPDATE
  USING (operator_id = current_operator_id())
  WITH CHECK (operator_id = current_operator_id());

-- ---------------------------------------------------------------------------
-- 4. resolve_lot_by_qr_token(p_token UUID)
-- ---------------------------------------------------------------------------
-- Used by:
--   - clovrbid.com/l/{token} route handler (operator-web) — returns
--     lot_code so we can 302 to /lots/{lot_code}.
--   - bidder-app /scan tab — returns auction status so the app can decide
--     to either deep-link into the live bid screen or show "Add to
--     watchlist?" for inventory/scheduled lots.
--
-- SECURITY DEFINER so we can read across RLS for the public route. Returns
-- only safe-to-expose columns (no cost_cents, no internal flags).
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION resolve_lot_by_qr_token(p_token UUID)
RETURNS TABLE (
  lot_id          UUID,
  lot_code        TEXT,
  operator_id     UUID,
  operator_code   TEXT,
  status          lot_status,
  auction_id      UUID,
  auction_status  TEXT,
  title           TEXT,
  thumbnail_url   TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
BEGIN
  RETURN QUERY
  SELECT
    l.id,
    l.lot_code,
    l.operator_id,
    o.code,
    l.status,
    l.auction_id,
    a.status::TEXT,
    l.title,
    -- Pick the first photo as a thumbnail. Empty arrays return NULL safely.
    (CASE WHEN array_length(l.photo_urls, 1) >= 1 THEN l.photo_urls[1] END)::TEXT
  FROM lots l
  JOIN operators o ON o.id = l.operator_id
  LEFT JOIN auctions a ON a.id = l.auction_id
  WHERE l.qr_token = p_token
  LIMIT 1;
END;
$$;

REVOKE ALL ON FUNCTION resolve_lot_by_qr_token(UUID) FROM PUBLIC;
-- Anonymous and authed users both call this — anon (web visitor scanning
-- a sticker with their camera) and authed (bidder-app /scan tab).
GRANT EXECUTE ON FUNCTION resolve_lot_by_qr_token(UUID) TO anon;
GRANT EXECUTE ON FUNCTION resolve_lot_by_qr_token(UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- 5. bulk_import_lots — operator imports their old SaaS inventory
-- ---------------------------------------------------------------------------
-- Inputs:
--   p_batch_source     'BidFTA' | 'MaxxSold' | 'csv' | …
--   p_filename         original filename (display only)
--   p_column_mapping   the user's mapping from drag-around UI (JSON object)
--   p_rows             JSONB array. Each element is a JSONB object with
--                      already-normalized keys:
--                        legacy_lot_code (required)
--                        title           (required)
--                        description     (optional)
--                        category        (optional)
--                        condition       (optional — 'new' | 'good' | …)
--                        msrp_cents      (optional)
--                        starting_bid_cents (optional, default 100)
--                        photo_url       (optional — single URL)
--                        upc/asin/fnsku/lpn (optional identifiers)
--   p_preserve_legacy  if true, sets lots.legacy_lot_code from row; else NULL
--   p_warehouse_id     (optional) default warehouse for all rows
--
-- Behavior:
--   - Atomic. Either all rows insert or none do (single TX).
--   - Each lot gets a fresh CLR-NNNNNN code from next_lot_code().
--   - Status starts 'in_inventory' (the import implies items are present).
--   - Duplicate detection: if a row's legacy_lot_code already exists for
--     this operator+platform, the row is SKIPPED (not an error). Counted
--     in skipped_count for the operator UI.
--   - Returns the new batch_id for the operator-web wizard to show "View
--     batch" / "Rollback".
-- ---------------------------------------------------------------------------

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

  -- Open the batch row first so failures can mark it 'failed'.
  INSERT INTO lot_import_batches (
    operator_id, imported_by, filename, source_label,
    row_count, column_mapping, status
  ) VALUES (
    v_op_id, v_user_id, p_filename, p_batch_source,
    v_total, COALESCE(p_column_mapping, '{}'::jsonb), 'completed'
  )
  RETURNING id INTO v_batch_id;

  -- Iterate rows. SKIP rows missing a title (required) or with a legacy
  -- code that already exists for this operator+platform.
  FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows) LOOP
    -- Required field
    IF coalesce(NULLIF(TRIM(v_row->>'title'), ''), '') = '' THEN
      v_skipped := v_skipped + 1;
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
        v_skipped := v_skipped + 1;
        CONTINUE;
      END IF;
    END IF;

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
      COALESCE((v_row->>'condition')::lot_condition, 'good'),
      NULLIF((v_row->>'msrp_cents'), '')::BIGINT,
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
  END LOOP;

  UPDATE lot_import_batches
     SET inserted_count = v_inserted,
         skipped_count = v_skipped
   WHERE id = v_batch_id;

  RETURN QUERY SELECT v_batch_id, true, 'ok', v_inserted, v_skipped;
END;
$$;

REVOKE ALL ON FUNCTION bulk_import_lots(TEXT, TEXT, JSONB, JSONB, BOOLEAN, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bulk_import_lots(TEXT, TEXT, JSONB, JSONB, BOOLEAN, UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- 6. Extend intake_lot_to_bin: lookup by qr_token before lot_code
-- ---------------------------------------------------------------------------
-- The field-mobile picker scans a printed lot sticker (encodes qr_token
-- as a bare UUID, identical shape to bin tokens). The existing intake RPC
-- already does a 6-way lookup (lot_code, UUID-as-id, lpn, fnsku, asin,
-- external_code). We add a NEW first-priority branch: try the value as a
-- qr_token UUID. UUIDs sort uniquely so a qr_token hit can never collide
-- with a lot_code (lot_codes look like "CLR-000087", not UUIDs).
--
-- Replacement preserves return type `intake_lot_result` and signature
-- (TEXT, UUID) so all callers (intake.tsx, batch_intake_lot_to_bin) work
-- without changes.
-- ---------------------------------------------------------------------------

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

  SELECT * INTO v_bin FROM bins
   WHERE qr_token = p_bin_qr_token AND qr_revoked_at IS NULL
   LIMIT 1;
  IF NOT FOUND THEN
    v_result := (false, 'bin_not_found_or_revoked', NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;
  IF v_bin.retired_at IS NOT NULL THEN
    v_result := (false, 'bin_retired', NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;
  SELECT operator_id INTO v_bin_operator FROM warehouses WHERE id = v_bin.warehouse_id;
  IF v_bin_operator <> v_op_id THEN
    v_result := (false, 'bin_other_operator', NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;

  -- 0103: try qr_token first. If the scanned value parses as a UUID we
  -- attempt a qr_token lookup before anything else; this is the new
  -- in-app sticker flow.
  BEGIN
    SELECT * INTO v_lot FROM lots WHERE qr_token = v_id_clean::UUID;
  EXCEPTION WHEN invalid_text_representation THEN v_lot.id := NULL; END;

  -- Fall through to the existing 6-way lookup if qr_token didn't match.
  IF v_lot.id IS NULL THEN
    SELECT * INTO v_lot FROM lots WHERE lot_code = v_id_clean LIMIT 1;
  END IF;
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
  -- 0103: legacy_lot_code as a final lot-table fallback (operator-scoped).
  IF v_lot.id IS NULL THEN
    SELECT * INTO v_lot FROM lots
    WHERE operator_id = v_op_id AND legacy_lot_code = v_id_clean
    LIMIT 1;
  END IF;

  IF v_lot.id IS NOT NULL THEN
    SELECT * INTO v_lot FROM lots WHERE id = v_lot.id FOR UPDATE;
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

  -- Manifest fall-through — unchanged from 0094.
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

-- ---------------------------------------------------------------------------
-- 7. rotate_lot_qr — rotates a single lot's qr_token (admin operation)
-- ---------------------------------------------------------------------------
-- For when a sticker is lost/stolen and the operator wants the old QR to
-- stop working. Mirrors the pattern in 0064 (bin token rotation). The old
-- token is overwritten, qr_rotated_at is stamped. Public/l/{old_token}
-- starts returning 404 immediately.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION rotate_lot_qr(p_lot_id UUID)
RETURNS TABLE (
  new_qr_token UUID,
  rotated_at   TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_op_id   UUID;
  v_new_tok UUID;
BEGIN
  v_op_id := current_operator_id();
  IF v_op_id IS NULL THEN
    RAISE EXCEPTION 'not_operator_staff' USING ERRCODE = '42501';
  END IF;
  v_new_tok := uuid_generate_v4();
  UPDATE lots
     SET qr_token = v_new_tok,
         qr_rotated_at = now(),
         updated_at = now()
   WHERE id = p_lot_id AND operator_id = v_op_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'lot_not_found_or_other_operator' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY SELECT v_new_tok, now();
END;
$$;

REVOKE ALL ON FUNCTION rotate_lot_qr(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION rotate_lot_qr(UUID) TO authenticated;
