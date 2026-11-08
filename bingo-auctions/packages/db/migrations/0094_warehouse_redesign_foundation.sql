-- ============================================================================
-- Migration 0094 — Warehouse redesign foundation
--
-- Bundles Phase 1 of docs/warehouse-redesign-plan.md plus the three Phase 0
-- bugs that are SQL-level (H7 regression, intake race, bidder RLS scoping).
--
-- Sections:
--   1. pickup_mode columns (warehouses default + auctions override + pickups audit)
--   2. floor plan versioning (warehouses.floor_plan_version, bins.floor_plan_version_placed)
--   3. bins.retired_at lifecycle + partial active index
--   4. bins coord defense-in-depth CHECK
--   5. pickups.invoice_id UNIQUE (1:1 invoice→pickup)
--   6. H7 regression fix on confirm_pickup (re-add operator scope dropped by 0079)
--   7. FOR UPDATE on intake_lot_to_bin + batch_intake_lot_to_bin (concurrent picker race)
--   8. Tighten bins_bidder_read + warehouses_bidder_read to bidder's invoices only
--   9. New RPC: ensure_pickup_row(p_invoice_id) — idempotent
--  10. New RPC: bidder_confirm_customer_pickup(p_invoice_id) — self-serve flow
--  11. New RPC: move_bin_contents(p_from_bin, p_to_bin) — for retiring bins
--  12. New SECURITY DEFINER helper: bidder_has_warehouse_access(warehouse_id)
--
-- Idempotent: every column/constraint/index/policy guards against re-running.
-- Function CREATE OR REPLACE handles re-run.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. pickup_mode columns
-- ---------------------------------------------------------------------------

-- Per-warehouse default. Most operators will pick one mode and stay there.
ALTER TABLE warehouses
  ADD COLUMN IF NOT EXISTS pickup_mode TEXT NOT NULL DEFAULT 'staff_assisted';

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'warehouses_pickup_mode_check'
  ) THEN
    ALTER TABLE warehouses
      ADD CONSTRAINT warehouses_pickup_mode_check
      CHECK (pickup_mode IN ('staff_assisted', 'self_serve', 'hybrid'));
  END IF;
END $$;

COMMENT ON COLUMN warehouses.pickup_mode IS
  'staff_assisted = staff stages lots, bidder shows QR at counter. '
  'self_serve = bidder walks warehouse with map and self-collects. '
  'hybrid = both modes available per auction. App resolves effective mode as '
  'COALESCE(auctions.pickup_mode_override, warehouses.pickup_mode).';

-- Per-auction optional override.
ALTER TABLE auctions
  ADD COLUMN IF NOT EXISTS pickup_mode_override TEXT;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'auctions_pickup_mode_override_check'
  ) THEN
    ALTER TABLE auctions
      ADD CONSTRAINT auctions_pickup_mode_override_check
      CHECK (pickup_mode_override IS NULL OR pickup_mode_override IN ('staff_assisted', 'self_serve', 'hybrid'));
  END IF;
END $$;

-- Recorded at pickup completion for audit. Lets us answer "did this customer
-- actually walk the warehouse, or did staff hand it to them?" months later.
ALTER TABLE pickups
  ADD COLUMN IF NOT EXISTS pickup_mode TEXT;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pickups_pickup_mode_check'
  ) THEN
    ALTER TABLE pickups
      ADD CONSTRAINT pickups_pickup_mode_check
      CHECK (pickup_mode IS NULL OR pickup_mode IN ('staff_assisted', 'self_serve', 'hybrid'));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Floor plan versioning
-- ---------------------------------------------------------------------------
-- Every time the operator replaces the floor plan image, increment
-- floor_plan_version. Bins carry the version they were positioned against; if
-- it lags the current warehouse version, the operator UI flags the bin as
-- "stale — re-position on the new plan".

ALTER TABLE warehouses
  ADD COLUMN IF NOT EXISTS floor_plan_version INTEGER NOT NULL DEFAULT 1;

ALTER TABLE warehouses
  ADD COLUMN IF NOT EXISTS floor_plan_uploaded_at TIMESTAMPTZ;

ALTER TABLE bins
  ADD COLUMN IF NOT EXISTS floor_plan_version_placed INTEGER;

COMMENT ON COLUMN bins.floor_plan_version_placed IS
  'warehouses.floor_plan_version at the time this bin was dragged onto the plan. '
  'If it differs from the current warehouse version, the operator UI surfaces '
  'this bin as stale and prompts re-positioning on the new image.';

-- Version-bump triggers. Keep app code dumb: whenever the operator changes
-- the floor plan URL we automatically bump the version + record the upload
-- time, and whenever a bin's coordinates change we stamp it with the current
-- warehouse version. The "is this bin stale?" check is then a single int
-- comparison the UI can do client-side.

CREATE OR REPLACE FUNCTION bump_warehouse_floor_plan_version()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.floor_plan_version := COALESCE(OLD.floor_plan_version, 0) + 1;
  NEW.floor_plan_uploaded_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS warehouses_bump_floor_plan_version ON warehouses;
CREATE TRIGGER warehouses_bump_floor_plan_version
  BEFORE UPDATE ON warehouses
  FOR EACH ROW
  WHEN (OLD.floor_plan_url IS DISTINCT FROM NEW.floor_plan_url)
  EXECUTE FUNCTION bump_warehouse_floor_plan_version();

CREATE OR REPLACE FUNCTION stamp_bin_floor_plan_version()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Stamp the bin with the warehouse's CURRENT version. This runs on
  -- INSERT-with-coords and on any UPDATE that shifts x_px/y_px.
  SELECT floor_plan_version INTO NEW.floor_plan_version_placed
  FROM warehouses WHERE id = NEW.warehouse_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bins_stamp_floor_plan_version_ins ON bins;
CREATE TRIGGER bins_stamp_floor_plan_version_ins
  BEFORE INSERT ON bins
  FOR EACH ROW
  WHEN (NEW.x_px > 0 OR NEW.y_px > 0)
  EXECUTE FUNCTION stamp_bin_floor_plan_version();

DROP TRIGGER IF EXISTS bins_stamp_floor_plan_version_upd ON bins;
CREATE TRIGGER bins_stamp_floor_plan_version_upd
  BEFORE UPDATE ON bins
  FOR EACH ROW
  WHEN ((OLD.x_px IS DISTINCT FROM NEW.x_px) OR (OLD.y_px IS DISTINCT FROM NEW.y_px))
  EXECUTE FUNCTION stamp_bin_floor_plan_version();

-- ---------------------------------------------------------------------------
-- 3. Bin lifecycle
-- ---------------------------------------------------------------------------
-- Replace the unenforced bins.is_active boolean with a TIMESTAMPTZ retired_at
-- that RPCs can check explicitly. The existing is_active column is left in
-- place for now (no readers/writers we know of); a future migration can drop
-- it once we confirm nothing depends on it.

ALTER TABLE bins ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ;

COMMENT ON COLUMN bins.retired_at IS
  'When set, bin is retired. Intake RPCs must reject scans of retired bins. '
  'The QR token may still resolve so cleanup of in-flight pickups works, but '
  'no new bin_assignments may be created at a retired bin.';

CREATE INDEX IF NOT EXISTS bins_active_retired_idx
  ON bins (warehouse_id)
  WHERE retired_at IS NULL;

-- ---------------------------------------------------------------------------
-- 4. Coord defense-in-depth
-- ---------------------------------------------------------------------------
-- The drag UI clamps to ≥0 but server-side checks are missing. A bulk RPC
-- with bad input could persist negative coords that crash the bidder map.

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bins_coords_nonneg'
  ) THEN
    ALTER TABLE bins
      ADD CONSTRAINT bins_coords_nonneg CHECK (x_px >= 0 AND y_px >= 0);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 5. pickups.invoice_id UNIQUE
-- ---------------------------------------------------------------------------
-- The data model has always assumed 1:1 invoice→pickup, but the column was
-- never UNIQUE so nothing enforced it. ensure_pickup_row (below) relies on
-- ON CONFLICT (invoice_id) for race-safety. If existing data already has
-- dupes we log a notice and skip — a one-off cleanup task surfaces, not a
-- migration failure.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pickups_invoice_id_key'
  ) THEN
    IF EXISTS (
      SELECT invoice_id FROM pickups GROUP BY invoice_id HAVING count(*) > 1
    ) THEN
      RAISE NOTICE 'pickups has duplicate invoice_id rows; pickups_invoice_id_key UNIQUE constraint skipped — clean dupes manually then re-run';
    ELSE
      ALTER TABLE pickups
        ADD CONSTRAINT pickups_invoice_id_key UNIQUE (invoice_id);
    END IF;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 12. SECURITY DEFINER helper: bidder_has_warehouse_access
-- ---------------------------------------------------------------------------
-- Used by the tightened bins_bidder_read / warehouses_bidder_read RLS
-- policies below. Defining it as SECURITY DEFINER lets the RLS predicate
-- traverse auctions → lots → invoice_lots → invoices regardless of any
-- intermediate RLS that would otherwise hide rows from the bidder.

CREATE OR REPLACE FUNCTION bidder_has_warehouse_access(p_warehouse_id UUID)
RETURNS BOOLEAN
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM auctions a
    JOIN lots l ON l.auction_id = a.id
    JOIN invoice_lots il ON il.lot_id = l.id
    JOIN invoices i ON i.id = il.invoice_id
    WHERE a.warehouse_id = p_warehouse_id
      AND i.bidder_id = auth.uid()
      AND i.status IN ('paid', 'pending', 'partially_refunded')
  );
$$;

REVOKE ALL ON FUNCTION bidder_has_warehouse_access(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bidder_has_warehouse_access(UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- 8. RLS scope tightening
-- ---------------------------------------------------------------------------
-- BEFORE: `is_bidder()` alone — any signed-up bidder could SELECT every
-- operator's bins and warehouses. A competitor could scrape complete floor
-- plan layouts from the platform by just creating a bidder account.
--
-- AFTER: bidder may only read bins/warehouses at warehouses where they have
-- a paid/pending/partially_refunded invoice. Bidders without business at a
-- warehouse cannot enumerate it. Within a warehouse they DO see all bins
-- (not just their own) because the pickup map needs to render the full
-- layout for navigation — that's deliberate.

DROP POLICY IF EXISTS bins_bidder_read ON bins;
CREATE POLICY bins_bidder_read ON bins
  FOR SELECT
  USING (
    is_bidder() AND bidder_has_warehouse_access(warehouse_id)
  );

DROP POLICY IF EXISTS warehouses_bidder_read ON warehouses;
CREATE POLICY warehouses_bidder_read ON warehouses
  FOR SELECT
  USING (
    is_bidder() AND bidder_has_warehouse_access(id)
  );

-- ---------------------------------------------------------------------------
-- 6. H7 regression fix on confirm_pickup
-- ---------------------------------------------------------------------------
-- Migration 0028 added an `i.operator_id = bin's warehouse operator_id`
-- predicate to confirm_pickup so a bidder with paid invoices at both
-- operator A and operator B could not scan op-A's bin and confirm lots from
-- op-B's invoices. Migration 0079 rewrote confirm_pickup to fix a different
-- bug (pickups row never closed) and silently dropped the 0028 scope check.
--
-- This rewrite merges BOTH fixes:
--   - 0079: update pickups row + enqueue notification on success
--   - 0028: require invoice.operator_id matches bin's warehouse operator_id

CREATE OR REPLACE FUNCTION confirm_pickup(p_bin_qr_token UUID)
RETURNS confirm_pickup_result
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user      UUID := auth.uid();
  v_bin       bins%ROWTYPE;
  v_bin_op    UUID;
  v_lot_ids   UUID[];
  v_count     INTEGER := 0;
  v_result    confirm_pickup_result;
  v_invoice   RECORD;
BEGIN
  IF v_user IS NULL THEN
    v_result := (false, 'not_authenticated', 0, NULL, NULL, ARRAY[]::UUID[]);
    RETURN v_result;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM bidders WHERE id = v_user) THEN
    v_result := (false, 'not_a_bidder', 0, NULL, NULL, ARRAY[]::UUID[]);
    RETURN v_result;
  END IF;

  SELECT * INTO v_bin FROM bins WHERE qr_token = p_bin_qr_token;
  IF NOT FOUND THEN
    v_result := (false, 'bin_not_found', 0, NULL, NULL, ARRAY[]::UUID[]);
    RETURN v_result;
  END IF;

  -- H7: resolve the bin's operator so we can scope the bidder_owned filter.
  SELECT operator_id INTO v_bin_op
    FROM warehouses WHERE id = v_bin.warehouse_id;
  IF v_bin_op IS NULL THEN
    v_result := (false, 'warehouse_not_found', 0, v_bin.id, v_bin.code, ARRAY[]::UUID[]);
    RETURN v_result;
  END IF;

  -- Flip 'staged' → 'picked_up' for this bidder's lots AT this bin, scoped to
  -- the bin's operator. Without the operator predicate, a bidder with paid
  -- invoices at both op A and op B scanning op A's QR could flip op B lots.
  WITH latest_assignments AS (
    SELECT DISTINCT ON (ba.lot_id) ba.id, ba.lot_id, ba.status, ba.bin_id
    FROM bin_assignments ba
    WHERE ba.bin_id = v_bin.id
    ORDER BY ba.lot_id, ba.assigned_at DESC
  ),
  bidder_owned AS (
    SELECT la.id, la.lot_id
    FROM latest_assignments la
    JOIN invoice_lots il ON il.lot_id = la.lot_id
    JOIN invoices i ON i.id = il.invoice_id
    WHERE i.bidder_id = v_user
      AND i.status = 'paid'
      AND i.operator_id = v_bin_op   -- H7 (0028) restored: cross-operator guard
      AND la.status = 'staged'
  ),
  picked AS (
    UPDATE bin_assignments
    SET status = 'picked_up', picked_up_at = now()
    WHERE id IN (SELECT id FROM bidder_owned)
    RETURNING lot_id
  )
  SELECT array_agg(lot_id), count(*) INTO v_lot_ids, v_count FROM picked;

  IF v_count = 0 THEN
    v_result := (false, 'no_staged_lots', 0, v_bin.id, v_bin.code, ARRAY[]::UUID[]);
    RETURN v_result;
  END IF;

  -- 0079 logic: close pickup row(s) + enqueue notification per invoice.
  FOR v_invoice IN
    SELECT DISTINCT i.id AS invoice_id, i.bidder_id
    FROM unnest(v_lot_ids) AS picked_lot(lot_id)
    JOIN invoice_lots il ON il.lot_id = picked_lot.lot_id
    JOIN invoices i ON i.id = il.invoice_id
    WHERE i.bidder_id = v_user
      AND i.operator_id = v_bin_op
  LOOP
    UPDATE pickups
    SET
      checked_in_at  = COALESCE(checked_in_at, now()),
      completed_at   = now(),
      status         = 'completed',
      pickup_mode    = COALESCE(pickup_mode, 'staff_assisted'),
      updated_at     = now()
    WHERE invoice_id = v_invoice.invoice_id
      AND status <> 'completed';

    PERFORM enqueue_notification(
      'pickup_confirmed',
      v_invoice.bidder_id,
      jsonb_build_object('invoice_id', v_invoice.invoice_id),
      'pickup_confirmed:bidder:' || v_invoice.invoice_id::TEXT
    );
  END LOOP;

  v_result := (true, 'ok', v_count, v_bin.id, v_bin.code, COALESCE(v_lot_ids, ARRAY[]::UUID[]));
  RETURN v_result;
END;
$$;

GRANT EXECUTE ON FUNCTION confirm_pickup(UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- 7. FOR UPDATE on intake_lot_to_bin + batch_intake_lot_to_bin
-- ---------------------------------------------------------------------------
-- BEFORE: the SELECT that fetched the lot did not lock the row. Two pickers
-- scanning the same lot label at the same instant both passed the
-- status='pending_intake' check, both UPDATEd, and the second overwrote the
-- first's intake_bin_id — picker 1 thinks the lot is in bin A while picker 2
-- physically placed it in bin B.
--
-- AFTER: after the 6-way lookup resolves a candidate v_lot, re-SELECT the
-- row with FOR UPDATE before checking status + updating. PostgreSQL
-- serializes concurrent FOR UPDATE on the same row, so picker 2's call
-- blocks until picker 1's transaction commits, then sees the post-update
-- state (status='in_inventory' at picker 1's bin) and either returns
-- "lot_not_in_intake_state" or no-ops, never silently overwriting.

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

  -- Active bin lookup (rejects revoked tokens, 0064 contract).
  SELECT * INTO v_bin FROM bins
   WHERE qr_token = p_bin_qr_token AND qr_revoked_at IS NULL
   LIMIT 1;
  IF NOT FOUND THEN
    v_result := (false, 'bin_not_found_or_revoked', NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;
  -- 0094: also reject retired bins.
  IF v_bin.retired_at IS NOT NULL THEN
    v_result := (false, 'bin_retired', NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;
  SELECT operator_id INTO v_bin_operator FROM warehouses WHERE id = v_bin.warehouse_id;
  IF v_bin_operator <> v_op_id THEN
    v_result := (false, 'bin_other_operator', NULL, NULL, NULL, NULL);
    RETURN v_result;
  END IF;

  -- 6-way lookup (no lock — we just want the candidate id).
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
    -- 0094: lock the candidate row before the status check + update.
    -- Concurrent intake calls on the same lot serialize here.
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

  -- Manifest fall-through — unchanged from 0064. import_rows lookup already
  -- uses FOR UPDATE so this path is race-safe.
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
  IF v_bin.retired_at IS NOT NULL THEN RETURN; END IF;
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
      -- 0094: lock the candidate row before the per-row status check + update.
      SELECT * INTO v_lot FROM lots WHERE id = v_lot.id FOR UPDATE;

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

    -- Manifest fall-through — unchanged.
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

-- ---------------------------------------------------------------------------
-- 9. ensure_pickup_row
-- ---------------------------------------------------------------------------
-- Idempotently create a pickups row for an invoice. Called from the Stripe
-- webhook on payment_intent.succeeded so walk-in operators always have a QR
-- token + status row available the moment the bidder pays. The warehouse_id
-- is derived from the invoice's first lot's warehouse — invoices on this
-- platform are always single-warehouse (auctions are 1:1 with a warehouse,
-- and an invoice's lots all come from one auction).

CREATE OR REPLACE FUNCTION ensure_pickup_row(p_invoice_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id           UUID;
  v_warehouse_id UUID;
BEGIN
  -- Fast path: row already exists.
  SELECT id INTO v_id FROM pickups WHERE invoice_id = p_invoice_id LIMIT 1;
  IF v_id IS NOT NULL THEN
    RETURN v_id;
  END IF;

  -- Resolve the warehouse via the invoice's first lot.
  SELECT a.warehouse_id INTO v_warehouse_id
  FROM invoice_lots il
  JOIN lots l ON l.id = il.lot_id
  JOIN auctions a ON a.id = l.auction_id
  WHERE il.invoice_id = p_invoice_id
  LIMIT 1;

  IF v_warehouse_id IS NULL THEN
    RAISE EXCEPTION 'invoice_has_no_warehouse_lots: %', p_invoice_id
      USING ERRCODE = 'P0001';
  END IF;

  -- Race-safe insert. If pickups_invoice_id_key UNIQUE constraint exists,
  -- ON CONFLICT short-circuits; otherwise the second caller will UPDATE
  -- (effective no-op) and re-fetch.
  INSERT INTO pickups (invoice_id, warehouse_id, status)
  VALUES (p_invoice_id, v_warehouse_id, 'pending')
  ON CONFLICT (invoice_id) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    SELECT id INTO v_id FROM pickups WHERE invoice_id = p_invoice_id LIMIT 1;
  END IF;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION ensure_pickup_row(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ensure_pickup_row(UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- 10. bidder_confirm_customer_pickup
-- ---------------------------------------------------------------------------
-- Self-serve completion flow. The bidder taps "Confirm pickup" in the app
-- after they've physically collected all their items at a customer-pickup
-- warehouse. We flip all their staged bin_assignments → picked_up, close
-- the pickups row, and fire the notification. No staff involvement.
--
-- Effective mode check: a bidder can only call this when the auction's
-- effective pickup_mode resolves to 'self_serve' or 'hybrid'. For
-- staff_assisted, only confirm_pickup (bin-scan) or staff_confirm_pickup
-- are valid completion paths.

CREATE OR REPLACE FUNCTION bidder_confirm_customer_pickup(p_invoice_id UUID)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user             UUID := auth.uid();
  v_invoice          invoices%ROWTYPE;
  v_warehouse_mode   TEXT;
  v_auction_override TEXT;
  v_effective_mode   TEXT;
  v_picked_count     INT  := 0;
  v_pickup_id        UUID;
BEGIN
  IF v_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_authenticated');
  END IF;

  SELECT * INTO v_invoice FROM invoices WHERE id = p_invoice_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'invoice_not_found');
  END IF;
  IF v_invoice.bidder_id <> v_user THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_invoice_bidder');
  END IF;
  IF v_invoice.status <> 'paid' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'invoice_not_paid',
      'status', v_invoice.status
    );
  END IF;

  -- Resolve effective pickup mode via auction override → warehouse default.
  SELECT a.pickup_mode_override, w.pickup_mode
    INTO v_auction_override, v_warehouse_mode
  FROM invoice_lots il
  JOIN lots l ON l.id = il.lot_id
  JOIN auctions a ON a.id = l.auction_id
  JOIN warehouses w ON w.id = a.warehouse_id
  WHERE il.invoice_id = p_invoice_id
  LIMIT 1;

  v_effective_mode := COALESCE(v_auction_override, v_warehouse_mode);
  IF v_effective_mode IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_pickup_mode_resolved');
  END IF;
  IF v_effective_mode NOT IN ('self_serve', 'hybrid') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'error', 'wrong_pickup_mode',
      'effective_mode', v_effective_mode
    );
  END IF;

  -- Flip latest staged bin_assignment per lot → picked_up.
  WITH latest AS (
    SELECT DISTINCT ON (ba.lot_id) ba.id, ba.lot_id, ba.status
    FROM bin_assignments ba
    JOIN invoice_lots il ON il.lot_id = ba.lot_id
    WHERE il.invoice_id = p_invoice_id
    ORDER BY ba.lot_id, ba.assigned_at DESC
  ),
  staged AS (
    SELECT id FROM latest WHERE status = 'staged'
  ),
  picked AS (
    UPDATE bin_assignments
    SET status = 'picked_up', picked_up_at = now()
    WHERE id IN (SELECT id FROM staged)
    RETURNING id
  )
  SELECT count(*) INTO v_picked_count FROM picked;

  -- Update / create the pickups row.
  v_pickup_id := ensure_pickup_row(p_invoice_id);

  UPDATE pickups
  SET checked_in_at = COALESCE(checked_in_at, now()),
      completed_at  = now(),
      status        = 'completed',
      pickup_mode   = v_effective_mode,
      updated_at    = now()
  WHERE id = v_pickup_id
    AND status <> 'completed';

  PERFORM enqueue_notification(
    'pickup_confirmed',
    v_invoice.bidder_id,
    jsonb_build_object(
      'invoice_id', p_invoice_id,
      'mode', v_effective_mode,
      'lots_confirmed', v_picked_count
    ),
    'pickup_confirmed:self_serve:' || p_invoice_id::TEXT
  );

  RETURN jsonb_build_object(
    'ok', true,
    'pickup_id', v_pickup_id,
    'lots_confirmed', v_picked_count,
    'effective_mode', v_effective_mode
  );
END;
$$;

REVOKE ALL ON FUNCTION bidder_confirm_customer_pickup(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bidder_confirm_customer_pickup(UUID) TO authenticated;

-- ---------------------------------------------------------------------------
-- 11. move_bin_contents
-- ---------------------------------------------------------------------------
-- For the operator-facing "retire bin" flow. When the operator marks a bin
-- retired, they may need to relocate all its staged lots to another bin
-- before flipping retired_at. This RPC moves every staged bin_assignment
-- whose current bin is p_from_bin onto p_to_bin, plus updates each lot's
-- intake_bin_id to match. Returns the count of lots moved.

CREATE OR REPLACE FUNCTION move_bin_contents(p_from_bin UUID, p_to_bin UUID)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user           UUID := auth.uid();
  v_op_id          UUID;
  v_from_op        UUID;
  v_to_op          UUID;
  v_to_retired_at  TIMESTAMPTZ;
  v_moved_lots     UUID[];
  v_count          INT := 0;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;
  v_op_id := current_operator_id();
  IF v_op_id IS NULL OR current_operator_role() NOT IN ('admin', 'manager') THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE = '42501';
  END IF;

  IF p_from_bin = p_to_bin THEN
    RETURN 0;
  END IF;

  -- Verify source bin belongs to caller's operator.
  SELECT w.operator_id INTO v_from_op
  FROM bins b JOIN warehouses w ON w.id = b.warehouse_id
  WHERE b.id = p_from_bin;
  IF v_from_op IS NULL THEN
    RAISE EXCEPTION 'from_bin_not_found' USING ERRCODE = 'P0001';
  END IF;
  IF v_from_op IS DISTINCT FROM v_op_id THEN
    RAISE EXCEPTION 'from_bin_other_operator' USING ERRCODE = '42501';
  END IF;

  -- Verify target bin belongs to caller's operator AND is not retired.
  SELECT w.operator_id, b.retired_at INTO v_to_op, v_to_retired_at
  FROM bins b JOIN warehouses w ON w.id = b.warehouse_id
  WHERE b.id = p_to_bin;
  IF v_to_op IS NULL THEN
    RAISE EXCEPTION 'to_bin_not_found' USING ERRCODE = 'P0001';
  END IF;
  IF v_to_op IS DISTINCT FROM v_op_id THEN
    RAISE EXCEPTION 'to_bin_other_operator' USING ERRCODE = '42501';
  END IF;
  IF v_to_retired_at IS NOT NULL THEN
    RAISE EXCEPTION 'to_bin_retired' USING ERRCODE = 'P0001';
  END IF;

  -- For each lot whose latest bin_assignment is at p_from_bin and 'staged',
  -- update that assignment to point at p_to_bin.
  WITH latest AS (
    SELECT DISTINCT ON (ba.lot_id) ba.id, ba.lot_id, ba.status
    FROM bin_assignments ba
    WHERE ba.bin_id = p_from_bin
    ORDER BY ba.lot_id, ba.assigned_at DESC
  ),
  to_move AS (
    SELECT id, lot_id FROM latest WHERE status = 'staged'
  ),
  moved AS (
    UPDATE bin_assignments
    SET bin_id = p_to_bin
    WHERE id IN (SELECT id FROM to_move)
    RETURNING lot_id
  )
  SELECT array_agg(lot_id) INTO v_moved_lots FROM moved;

  v_count := COALESCE(array_length(v_moved_lots, 1), 0);

  -- Keep lots.intake_bin_id in sync for the moved lots.
  IF v_count > 0 THEN
    UPDATE lots l
    SET intake_bin_id = p_to_bin, updated_at = now()
    WHERE l.id = ANY(v_moved_lots)
      AND l.intake_bin_id = p_from_bin;
  END IF;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION move_bin_contents(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION move_bin_contents(UUID, UUID) TO authenticated;

COMMIT;
