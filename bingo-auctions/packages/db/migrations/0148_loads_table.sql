-- ============================================================================
-- 0148_loads_table — Loads (truck/pallet purchases) — manager-tracked
--
-- Per PLAN-field-mobile-restructure-2026-05-25.md W9 slice 3:
--   - New `loads` table for tracking trucks/pallets a manager has bought.
--   - Two flavors:
--       'auto-import' — created by trigger when an `imports` row lands.
--       'manual'      — created via /loads/new for unmanifested trucks.
--   - `lots.load_id` FK so field staff can pick a load at lotting time and
--     profit tracking groups lots by load. Replaces freeform `lots.source`.
--   - RLS: any operator staff can READ; only admin/manager can WRITE
--     (resolved decision D8 — "field people should not be able to edit/
--     mess that up easily").
--   - Trigger backfills 'auto-import' rows from new imports.
--   - Backfill: every existing imports row gets a matching auto-import load.
--
-- Resolved decisions:
--   D1 — ONE combined /loads page with type filter chip (not two pages).
--   D8 — Field-mobile is read-only. Managers control loads.
-- ============================================================================

CREATE TABLE IF NOT EXISTS loads (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  operator_id           UUID NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
  type                  TEXT NOT NULL CHECK (type IN ('auto-import', 'manual')),
  source_name           TEXT NOT NULL CHECK (length(source_name) BETWEEN 1 AND 200),
  purchase_cost_cents   BIGINT CHECK (purchase_cost_cents IS NULL OR purchase_cost_cents >= 0),
  purchase_date         DATE,
  notes                 TEXT CHECK (notes IS NULL OR length(notes) <= 2000),
  import_id             UUID REFERENCES imports(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by            UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  archived_at           TIMESTAMPTZ
);

-- One auto-import load per import. Partial unique index so manual loads
-- (import_id IS NULL) don't conflict with each other.
CREATE UNIQUE INDEX IF NOT EXISTS loads_import_unique_idx
  ON loads (import_id)
  WHERE import_id IS NOT NULL;

-- Operator-scoped recency index (most-recent first; hide archived).
CREATE INDEX IF NOT EXISTS loads_operator_recent_idx
  ON loads (operator_id, created_at DESC)
  WHERE archived_at IS NULL;

-- Filter by type for the /loads filter chip.
CREATE INDEX IF NOT EXISTS loads_operator_type_idx
  ON loads (operator_id, type, created_at DESC)
  WHERE archived_at IS NULL;

COMMENT ON TABLE loads IS
  '0148: Manager-tracked load (truck/pallet/program). auto-import rows are '
  'created by a trigger on imports; manual rows are entered via /loads/new '
  'for unmanifested trucks. lots.load_id links a lot to its load for profit '
  'tracking. Field-mobile is read-only.';

-- ── lots.load_id FK ─────────────────────────────────────────────────────────

ALTER TABLE lots
  ADD COLUMN IF NOT EXISTS load_id UUID REFERENCES loads(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS lots_load_idx ON lots (load_id) WHERE load_id IS NOT NULL;

COMMENT ON COLUMN lots.load_id IS
  '0148: Structured load reference. Replaces freeform lots.source for profit '
  'tracking. NULL is fine (e.g. legacy lots, lots from pre-0148 imports).';

-- ── Backfill: one auto-import load per existing import ─────────────────────

INSERT INTO loads (
  operator_id, type, source_name, import_id, created_at, created_by, purchase_date
)
SELECT
  i.operator_id,
  'auto-import',
  COALESCE(NULLIF(i.source_label, ''), i.filename) AS source_name,
  i.id,
  i.created_at,
  i.created_by,
  i.created_at::date
FROM imports i
WHERE NOT EXISTS (SELECT 1 FROM loads l WHERE l.import_id = i.id);

-- NOTE on lots.load_id backfill — INTENTIONALLY DEFERRED:
-- For operators with large lot tables (e.g. BinGo's 91k legacy lots),
-- a single UPDATE here would lock too many rows while workers are
-- actively scanning put-away. Backfill should be done in chunks via a
-- standalone admin script after this migration lands. Until then, old
-- lots show as "not linked to a load" — that's correct and harmless.
-- New imports auto-link via the trigger below; new lots created via
-- the (future) Load picker in field-mobile will set load_id directly.

-- ── Auto-create-on-import trigger ──────────────────────────────────────────

CREATE OR REPLACE FUNCTION auto_create_load_from_import()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Idempotent: re-trigger fire won't create a duplicate. NOT EXISTS preferred
  -- over ON CONFLICT because the partial unique index makes ON CONFLICT
  -- inference brittle.
  INSERT INTO loads (
    operator_id, type, source_name, import_id, created_at, created_by, purchase_date
  )
  SELECT
    NEW.operator_id,
    'auto-import',
    COALESCE(NULLIF(NEW.source_label, ''), NEW.filename),
    NEW.id,
    NEW.created_at,
    NEW.created_by,
    NEW.created_at::date
  WHERE NOT EXISTS (SELECT 1 FROM loads WHERE import_id = NEW.id);

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION auto_create_load_from_import IS
  '0148: AFTER INSERT trigger on imports. Creates an auto-import load row '
  'so the imports list and loads list stay 1:1 without manual operator work. '
  'SECURITY DEFINER so a non-manager service-role import still creates the load.';

DROP TRIGGER IF EXISTS imports_auto_load_trigger ON imports;
CREATE TRIGGER imports_auto_load_trigger
AFTER INSERT ON imports
FOR EACH ROW
EXECUTE FUNCTION auto_create_load_from_import();

-- ── RLS ─────────────────────────────────────────────────────────────────────

ALTER TABLE loads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS loads_staff_read      ON loads;
DROP POLICY IF EXISTS loads_manager_insert  ON loads;
DROP POLICY IF EXISTS loads_manager_update  ON loads;
DROP POLICY IF EXISTS loads_admin_delete    ON loads;

-- Any operator staff can READ their own operator's loads (field-mobile + web).
CREATE POLICY loads_staff_read ON loads
  FOR SELECT
  USING (operator_id = current_operator_id());

-- INSERT/UPDATE restricted to admin and manager.
CREATE POLICY loads_manager_insert ON loads
  FOR INSERT
  WITH CHECK (
    operator_id = current_operator_id()
    AND current_operator_role() IN ('admin', 'manager')
  );

CREATE POLICY loads_manager_update ON loads
  FOR UPDATE
  USING (
    operator_id = current_operator_id()
    AND current_operator_role() IN ('admin', 'manager')
  )
  WITH CHECK (
    operator_id = current_operator_id()
    AND current_operator_role() IN ('admin', 'manager')
  );

-- DELETE: admin only (escape hatch; archived_at is the normal path).
CREATE POLICY loads_admin_delete ON loads
  FOR DELETE
  USING (
    operator_id = current_operator_id()
    AND current_operator_role() = 'admin'
  );

-- ── RPCs ────────────────────────────────────────────────────────────────────

-- Manual load creation. RLS already enforces admin/manager, but the RPC also
-- explicitly checks so the error message is clearer than a generic RLS deny.
CREATE OR REPLACE FUNCTION create_manual_load(
  p_source_name         TEXT,
  p_purchase_cost_cents BIGINT DEFAULT NULL,
  p_purchase_date       DATE   DEFAULT NULL,
  p_notes               TEXT   DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_operator_id UUID := current_operator_id();
  v_role        TEXT;
  v_load_id     UUID;
BEGIN
  IF v_operator_id IS NULL THEN
    RAISE EXCEPTION 'not_an_operator';
  END IF;

  v_role := current_operator_role()::text;
  IF v_role NOT IN ('admin', 'manager') THEN
    RAISE EXCEPTION 'forbidden: only admin or manager can create loads';
  END IF;

  IF p_source_name IS NULL OR length(trim(p_source_name)) = 0 THEN
    RAISE EXCEPTION 'source_name_required';
  END IF;

  IF length(trim(p_source_name)) > 200 THEN
    RAISE EXCEPTION 'source_name_too_long';
  END IF;

  IF p_notes IS NOT NULL AND length(p_notes) > 2000 THEN
    RAISE EXCEPTION 'notes_too_long';
  END IF;

  INSERT INTO loads (
    operator_id, type, source_name, purchase_cost_cents, purchase_date, notes, created_by
  )
  VALUES (
    v_operator_id,
    'manual',
    trim(p_source_name),
    p_purchase_cost_cents,
    p_purchase_date,
    p_notes,
    auth.uid()
  )
  RETURNING id INTO v_load_id;

  RETURN v_load_id;
END;
$$;

COMMENT ON FUNCTION create_manual_load IS
  '0148: Creates a manual load (unmanifested truck/pallet). admin/manager '
  'only. Field-mobile cannot call this — staff can only READ /loads.';

-- Soft-archive a load. Lots keep their load_id reference (no cascade).
CREATE OR REPLACE FUNCTION archive_load(p_load_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_operator_id UUID := current_operator_id();
  v_role        TEXT;
BEGIN
  v_role := current_operator_role()::text;
  IF v_role NOT IN ('admin', 'manager') THEN
    RAISE EXCEPTION 'forbidden: only admin or manager can archive loads';
  END IF;

  UPDATE loads
     SET archived_at = NOW()
   WHERE id = p_load_id
     AND operator_id = v_operator_id
     AND archived_at IS NULL;

  RETURN FOUND;
END;
$$;

COMMENT ON FUNCTION archive_load IS
  '0148: Soft-archive a load. Hides it from /loads default view. lots.load_id '
  'is preserved so historical reports still work.';

-- Lot-count helper. Returns one row per load with the number of lots linked
-- to it. Used by /loads list page and the field-mobile Lotting hub counter.
-- SECURITY INVOKER so the caller's RLS scopes results to their operator.
CREATE OR REPLACE FUNCTION loads_with_lot_counts()
RETURNS TABLE (
  load_id   UUID,
  lot_count INTEGER
)
LANGUAGE SQL
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT load_id, COUNT(*)::INTEGER AS lot_count
    FROM lots
   WHERE load_id IS NOT NULL
   GROUP BY load_id;
$$;

COMMENT ON FUNCTION loads_with_lot_counts IS
  '0148: One row per load with lot count. RLS scopes lots to operator. '
  'Used by /loads list page (count column) and Lotting hub.';

-- ── Grants ──────────────────────────────────────────────────────────────────

GRANT EXECUTE ON FUNCTION create_manual_load(TEXT, BIGINT, DATE, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION archive_load(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION loads_with_lot_counts() TO authenticated;
