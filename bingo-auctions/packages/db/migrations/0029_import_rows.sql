-- ============================================================================
-- Manifest pool — separate import lines from real lots.
--
-- BEFORE: every CSV row immediately became a `lots` row (status='pending_intake')
--         with a permanent lot_code. Even if the truck never arrived or the item
--         turned out unsellable, the platform burned a code.
--
-- AFTER:  CSV rows land in `import_rows` with no lot_code. Operator (or LotTR)
--         decides which to lot — that action creates real `lots` rows with
--         codes. Imported-but-never-lotted rows stay as manifest history,
--         never burn an identifier.
--
-- The intake flow is unchanged: once a row is "lotted" it follows the existing
-- pending_intake → in_inventory pipeline (picker scans QR + bin QR).
--
-- Backwards compatibility:
--   - imports table stays as-is (audit row per upload).
--   - lots.import_id column stays for legacy lots that came in via the old
--     path. New lots created via lotImportRows() get import_row_id set instead.
--   - Existing pending_intake lots are NOT migrated — they stay as lots.
--     Only NEW imports use the new flow.
-- ============================================================================

CREATE TABLE IF NOT EXISTS import_rows (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  import_id       UUID NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  operator_id     UUID NOT NULL REFERENCES operators(id) ON DELETE CASCADE,

  -- Original CSV row preserved for forensics. Columns the wizard didn't map
  -- still live here so the operator can re-process later if needed.
  raw_data        JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Parsed fields after column mapping. Same shape as the old lot insert.
  title           TEXT NOT NULL,
  description     TEXT,
  category_raw    TEXT,
  category_id     UUID REFERENCES categories(id) ON DELETE SET NULL,
  upc             TEXT,                                  -- digits-only normalized; see 0027 product_lookups
  external_code   TEXT,                                  -- operator's pre-existing identifier
  msrp_cents      BIGINT,
  starting_bid_cents BIGINT,
  photo_url       TEXT,                                  -- single URL from import (if any)
  condition       TEXT,
  warehouse_id    UUID REFERENCES warehouses(id) ON DELETE SET NULL,  -- importer's hint, not authoritative

  -- Lifecycle. 'pending' = in manifest pool, no lot yet.
  --             'lotted'  = operator created a lot from this row; lot_id is set.
  --             'dropped' = operator marked this as not-sellable; reason is set.
  status          TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'lotted', 'dropped')),
  lot_id          UUID REFERENCES lots(id) ON DELETE SET NULL,
  lotted_at       TIMESTAMPTZ,
  dropped_at      TIMESTAMPTZ,
  dropped_reason  TEXT,
  dropped_by      UUID REFERENCES auth.users(id) ON DELETE SET NULL,

  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE import_rows IS
  'Manifest pool. CSV imports land here; lots only get created when an operator (or LotTR) explicitly lots a row. Imported-but-never-lotted rows stay as manifest history.';

COMMENT ON COLUMN import_rows.status IS
  'pending = in manifest pool. lotted = lot_id set, real lot exists. dropped = marked not-sellable.';

-- ----------------------------------------------------------------------------
-- Indexes — tuned for "show me my pending manifest" + "show me a specific
-- import's contents" + "did I already see this UPC in a previous manifest?"
-- ----------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS import_rows_pool_idx
  ON import_rows (operator_id, status, created_at DESC)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS import_rows_import_idx
  ON import_rows (import_id, status, created_at);

CREATE INDEX IF NOT EXISTS import_rows_lot_idx
  ON import_rows (lot_id) WHERE lot_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS import_rows_upc_idx
  ON import_rows (upc) WHERE upc IS NOT NULL;

-- Trgm index on title so the LotTR queue can do fuzzy keyword search
-- across pending manifest rows, same UX it currently has on lots.
CREATE INDEX IF NOT EXISTS import_rows_title_trgm_idx
  ON import_rows USING GIN (title gin_trgm_ops)
  WHERE status = 'pending';

-- ----------------------------------------------------------------------------
-- Updated_at trigger.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION import_rows_touch_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS import_rows_touch_updated_at ON import_rows;
CREATE TRIGGER import_rows_touch_updated_at
  BEFORE UPDATE ON import_rows
  FOR EACH ROW EXECUTE FUNCTION import_rows_touch_updated_at();

-- ----------------------------------------------------------------------------
-- RLS — same pattern as lots: staff read their own, admin/manager write.
-- ----------------------------------------------------------------------------

ALTER TABLE import_rows ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS import_rows_staff_read ON import_rows;
DROP POLICY IF EXISTS import_rows_staff_insert ON import_rows;
DROP POLICY IF EXISTS import_rows_staff_update ON import_rows;
DROP POLICY IF EXISTS import_rows_staff_delete ON import_rows;

CREATE POLICY import_rows_staff_read ON import_rows
  FOR SELECT
  USING (operator_id = current_operator_id());

CREATE POLICY import_rows_staff_insert ON import_rows
  FOR INSERT
  WITH CHECK (
    operator_id = current_operator_id()
    AND current_operator_role() IN ('admin', 'manager')
  );

CREATE POLICY import_rows_staff_update ON import_rows
  FOR UPDATE
  USING (
    operator_id = current_operator_id()
    AND current_operator_role() IN ('admin', 'manager')
  )
  WITH CHECK (
    operator_id = current_operator_id()
    AND current_operator_role() IN ('admin', 'manager')
  );

CREATE POLICY import_rows_staff_delete ON import_rows
  FOR DELETE
  USING (
    operator_id = current_operator_id()
    AND current_operator_role() = 'admin'
  );

-- ----------------------------------------------------------------------------
-- lots.import_row_id back-pointer (NEW). Lets us trace a lot back to the
-- specific manifest line it came from. lots.import_id (existing column)
-- still works for the audit trail at the import-batch level.
-- ----------------------------------------------------------------------------

ALTER TABLE lots
  ADD COLUMN IF NOT EXISTS import_row_id UUID REFERENCES import_rows(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS lots_import_row_idx
  ON lots (import_row_id) WHERE import_row_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- lot_import_rows() RPC — bulk-create lots from a list of pending import_rows.
--
-- Atomic: either all lots are created and all import_rows flip to 'lotted',
-- or nothing changes (transaction wraps everything).
--
-- Caller must be admin/manager of the operator. RPC is SECURITY DEFINER so
-- it can call next_lot_code() (which has its own caller check we explicitly
-- bypass via the auth.uid() IS NULL path... no, wait, we keep the check.
-- Caller-must-be-staff guard works because auth.uid() is the user's id and
-- the operator_users join in next_lot_code resolves to the operator).
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

  -- Iterate the requested rows. We lock each import_row to prevent two
  -- operators from lotting the same row concurrently.
  FOR v_row IN
    SELECT *
    FROM import_rows
    WHERE id = ANY(p_import_row_ids)
      AND operator_id = v_operator_id
      AND status = 'pending'
    FOR UPDATE
  LOOP
    -- Mint the next lot code atomically.
    SELECT next_lot_code(v_operator_id) INTO v_lot_code;

    INSERT INTO lots (
      operator_id, auction_id, lot_number, warehouse_id, lot_code,
      external_code, import_id, import_row_id,
      title, description, category, category_id, condition,
      msrp_cents, starting_bid_cents, photo_urls, status, close_at
    ) VALUES (
      v_operator_id, NULL, NULL, v_row.warehouse_id, v_lot_code,
      v_row.external_code, v_row.import_id, v_row.id,
      v_row.title, v_row.description, v_row.category_raw, v_row.category_id,
      COALESCE(v_row.condition, 'good'),
      v_row.msrp_cents, COALESCE(v_row.starting_bid_cents, 100),
      CASE WHEN v_row.photo_url IS NOT NULL THEN ARRAY[v_row.photo_url] ELSE '{}'::TEXT[] END,
      'pending_intake', NULL
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
-- drop_import_rows() RPC — bulk-mark rows as not-sellable.
-- Audit trail is preserved (rows aren't deleted, just status='dropped').
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION drop_import_rows(
  p_import_row_ids UUID[],
  p_reason TEXT DEFAULT NULL
)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller UUID := auth.uid();
  v_operator_id UUID;
  v_role operator_user_role;
  v_count INTEGER;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  SELECT operator_id, role INTO v_operator_id, v_role
  FROM operator_users WHERE user_id = v_caller LIMIT 1;
  IF v_operator_id IS NULL OR v_role NOT IN ('admin','manager') THEN
    RAISE EXCEPTION 'admin_or_manager_required' USING ERRCODE = '42501';
  END IF;

  UPDATE import_rows
     SET status = 'dropped',
         dropped_at = now(),
         dropped_reason = p_reason,
         dropped_by = v_caller
   WHERE id = ANY(p_import_row_ids)
     AND operator_id = v_operator_id
     AND status = 'pending';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION drop_import_rows(UUID[], TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION drop_import_rows(UUID[], TEXT) TO authenticated;
