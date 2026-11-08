-- ============================================================================
-- Migration 0102 — Warehouse walk-mode foundation (additive)
--
-- Replaces the desktop-style "upload a floor plan PNG, drag bins onto it"
-- flow with a mobile-first "walk the warehouse, scan each bin QR" model.
--
-- Background
-- ----------
-- The 0001 schema modeled bin position as `(x_px, y_px)` pixel coordinates
-- on an operator-uploaded floor plan image. That worked at a desk but was
-- actively painful on a phone or iPad — operator had to:
--   1. Upload a floor plan PNG
--   2. Take a photo of the warehouse OR sketch it on the device
--   3. Drag each bin chip onto the right spot on that image
--   4. Repeat after every layout change
-- iPad-test feedback (2026-05-19 to 2026-05-21) was unambiguous: "drop
-- position field", "no undo on bin drag", "can't edit/delete bins", "SVG
-- save fails". The mental model itself was wrong for mobile.
--
-- Walk-and-scan model
-- -------------------
-- The phone is held by an operator standing in the warehouse:
--   1. They scan one bin QR — that's the origin anchor.
--   2. They walk to the next bin, scan it. ARKit (Phase 2) stamps an
--      absolute (x_meters, y_meters) relative to the origin. Without
--      ARKit (Phase 1, this migration's data model), the position is
--      derived from the bin code (Aisle / Bay / Level) onto an
--      idealized grid.
--   3. Landmarks (loading dock, shipping table, will-call counter,
--      returns area) are tapped + named while walking. Stored in a
--      new `warehouse_landmarks` table.
--   4. The bidder PickupMap renders bins + landmarks at scale once
--      ARKit positions exist; until then, idealized grid.
--
-- This migration is ADDITIVE ONLY. The 0001 fields (warehouses.floor_plan_url,
-- bins.x_px, bins.y_px) remain in place so the existing operator-web flow
-- keeps working while the walk-mode UI is built out. A follow-up migration
-- (0103+) will drop them once the new flow is verified end-to-end on
-- TestFlight.
--
-- Migration 0094 added bins.retired_at and floor_plan_version_placed;
-- both stay relevant. Floor plan VERSIONING goes away with the floor plan
-- itself in 0103.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. bins: absolute walk-mode coordinates (in METERS, not pixels)
-- ---------------------------------------------------------------------------
--
-- coord_x_m / coord_y_m: NULLable. NULL means "this bin has not yet been
-- physically walked-and-scanned in walk-mode." The bidder PickupMap falls
-- back to a grid position derived from the bin code (A-3-2 -> aisle column
-- A, bay row 3, level layer 2 on a unit grid).
--
-- scanned_at: when an operator successfully verified the bin via walk-mode.
-- NULL = never scanned in walk-mode. Distinct from `created_at` (when the
-- bin was bulk-added on the web) and `updated_at` (any change).
--
-- scan_pose: arbitrary JSON the walk-mode client emits at scan time —
-- ARKit anchor id, heading, confidence, drift since last anchor scan, etc.
-- Schema is intentionally open because the walk client may evolve.

ALTER TABLE bins ADD COLUMN IF NOT EXISTS coord_x_m DECIMAL(8, 3);
ALTER TABLE bins ADD COLUMN IF NOT EXISTS coord_y_m DECIMAL(8, 3);
ALTER TABLE bins ADD COLUMN IF NOT EXISTS scanned_at TIMESTAMPTZ;
ALTER TABLE bins ADD COLUMN IF NOT EXISTS scan_pose JSONB;

COMMENT ON COLUMN bins.coord_x_m IS
  'Walk-mode X coordinate in meters relative to the warehouse origin (the '
  'bin scanned first when the walk started). NULL until the operator '
  'verifies the bin via walk-and-scan. Bidder PickupMap falls back to an '
  'idealized grid derived from the bin code (aisle/bay/level) when NULL.';

COMMENT ON COLUMN bins.coord_y_m IS
  'Walk-mode Y coordinate in meters relative to the warehouse origin. '
  'See coord_x_m. NULL semantics match.';

COMMENT ON COLUMN bins.scanned_at IS
  'Timestamp the bin was physically verified via the field-mobile walk-mode '
  'flow. Distinct from created_at (bulk-add on web) and updated_at (any '
  'change). NULL = never walked. Re-scans during a re-walk overwrite this.';

COMMENT ON COLUMN bins.scan_pose IS
  'JSONB metadata captured at scan time by the walk-mode client. Expected '
  'keys (all optional): { arkit_anchor_id, heading_deg, confidence (0..1), '
  'drift_m_since_anchor, app_version }. Schema is intentionally open — the '
  'walk client may add fields. NULL means scanned without ARKit (Phase 1).';

CREATE INDEX IF NOT EXISTS bins_scanned_idx
  ON bins (warehouse_id, scanned_at)
  WHERE scanned_at IS NOT NULL;

COMMENT ON INDEX bins_scanned_idx IS
  'Lets the operator hub answer "how many bins are walk-verified for this '
  'warehouse?" in O(verified count) instead of O(total bins).';

-- ---------------------------------------------------------------------------
-- 2. warehouse_landmarks: non-bin spots the operator marks while walking
-- ---------------------------------------------------------------------------
--
-- Loading docks, shipping tables, returns counters, will-call windows.
-- These are NOT bins (they hold no inventory) but they DO have a position
-- and a name, and bidders need them on the map to navigate.
--
-- kind: loose enum-ish — frontend renders different icons per kind. NULL
-- allowed so operators can mark something we don't have a kind for yet.

CREATE TABLE IF NOT EXISTS warehouse_landmarks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  kind TEXT,
  name TEXT NOT NULL,
  coord_x_m DECIMAL(8, 3) NOT NULL,
  coord_y_m DECIMAL(8, 3) NOT NULL,
  scan_pose JSONB,
  scanned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS warehouse_landmarks_warehouse_idx
  ON warehouse_landmarks (warehouse_id);

COMMENT ON TABLE warehouse_landmarks IS
  'Non-bin physical locations operators mark via the walk-mode flow: '
  'loading docks, shipping tables, returns counters, will-call windows. '
  'Bidders see these on PickupMap with kind-specific icons.';

COMMENT ON COLUMN warehouse_landmarks.kind IS
  'Soft enum used to pick an icon on the bidder map. Recommended values: '
  'loading_dock | shipping_table | returns | will_call | restroom | '
  'water_fountain | entrance | exit. NULL falls back to a generic pin.';

-- updated_at trigger — same pattern as bins / warehouses
CREATE OR REPLACE FUNCTION set_warehouse_landmarks_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS warehouse_landmarks_updated_at ON warehouse_landmarks;
CREATE TRIGGER warehouse_landmarks_updated_at
  BEFORE UPDATE ON warehouse_landmarks
  FOR EACH ROW
  EXECUTE FUNCTION set_warehouse_landmarks_updated_at();

-- ---------------------------------------------------------------------------
-- 3. RLS for warehouse_landmarks
-- ---------------------------------------------------------------------------
--
-- Mirrors the bins RLS (migration 0094):
--   • Operator staff can read/write landmarks for their warehouses.
--   • Bidders can read landmarks for warehouses they have access to
--     (via bidder_has_warehouse_access from 0094).
--
-- The reads of `current_operator_id()` and `bidder_has_warehouse_access`
-- pre-exist this migration.

ALTER TABLE warehouse_landmarks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS warehouse_landmarks_staff_all ON warehouse_landmarks;
CREATE POLICY warehouse_landmarks_staff_all
  ON warehouse_landmarks
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM warehouses w
      WHERE w.id = warehouse_landmarks.warehouse_id
        AND w.operator_id = current_operator_id()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM warehouses w
      WHERE w.id = warehouse_landmarks.warehouse_id
        AND w.operator_id = current_operator_id()
    )
  );

DROP POLICY IF EXISTS warehouse_landmarks_bidder_read ON warehouse_landmarks;
CREATE POLICY warehouse_landmarks_bidder_read
  ON warehouse_landmarks
  FOR SELECT
  TO authenticated
  USING (
    bidder_has_warehouse_access(warehouse_landmarks.warehouse_id)
  );

-- ---------------------------------------------------------------------------
-- 4. RPC: stamp_bin_walk_position
-- ---------------------------------------------------------------------------
--
-- Called by the walk-mode mobile client when an operator scans a bin QR
-- during a walk. Updates bins.coord_x_m / coord_y_m / scanned_at / scan_pose
-- atomically and returns the new row so the client can confirm.
--
-- Security: the policy on bins already restricts UPDATE to staff of the
-- bin's warehouse, so SECURITY INVOKER + the existing policy is enough.
-- We still wrap in a function so the mobile call site stays compact.
--
-- The function tolerates NULL coords (an operator may use walk-mode just
-- to confirm a bin EXISTS without ARKit tracking).

CREATE OR REPLACE FUNCTION stamp_bin_walk_position(
  p_bin_id UUID,
  p_coord_x_m DECIMAL,
  p_coord_y_m DECIMAL,
  p_scan_pose JSONB DEFAULT NULL
)
RETURNS bins
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_row bins;
BEGIN
  UPDATE bins
     SET coord_x_m = p_coord_x_m,
         coord_y_m = p_coord_y_m,
         scan_pose = COALESCE(p_scan_pose, scan_pose),
         scanned_at = now(),
         updated_at = now()
   WHERE id = p_bin_id
     AND retired_at IS NULL
  RETURNING * INTO v_row;

  IF v_row.id IS NULL THEN
    RAISE EXCEPTION 'bin not found, retired, or not accessible: %', p_bin_id
      USING ERRCODE = '02000';
  END IF;

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION stamp_bin_walk_position(UUID, DECIMAL, DECIMAL, JSONB) TO authenticated;

COMMENT ON FUNCTION stamp_bin_walk_position(UUID, DECIMAL, DECIMAL, JSONB) IS
  'Called by field-mobile walk-mode when the operator scans a bin QR. '
  'Updates bins.coord_x_m / coord_y_m / scanned_at / scan_pose and returns '
  'the updated row. Rejects retired bins. Coords may be NULL — useful when '
  'the operator wants to verify physical placement without ARKit tracking.';

-- ---------------------------------------------------------------------------
-- 5. RPC: add_warehouse_landmark
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION add_warehouse_landmark(
  p_warehouse_id UUID,
  p_kind TEXT,
  p_name TEXT,
  p_coord_x_m DECIMAL,
  p_coord_y_m DECIMAL,
  p_scan_pose JSONB DEFAULT NULL
)
RETURNS warehouse_landmarks
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_row warehouse_landmarks;
  v_trimmed TEXT;
BEGIN
  v_trimmed := trim(coalesce(p_name, ''));
  IF length(v_trimmed) = 0 THEN
    RAISE EXCEPTION 'landmark name is required' USING ERRCODE = '22023';
  END IF;
  IF length(v_trimmed) > 80 THEN
    v_trimmed := substring(v_trimmed FROM 1 FOR 80);
  END IF;

  INSERT INTO warehouse_landmarks (
    warehouse_id, kind, name, coord_x_m, coord_y_m, scan_pose
  ) VALUES (
    p_warehouse_id,
    nullif(trim(coalesce(p_kind, '')), ''),
    v_trimmed,
    p_coord_x_m,
    p_coord_y_m,
    p_scan_pose
  )
  RETURNING * INTO v_row;

  RETURN v_row;
END;
$$;

GRANT EXECUTE ON FUNCTION add_warehouse_landmark(UUID, TEXT, TEXT, DECIMAL, DECIMAL, JSONB) TO authenticated;

COMMENT ON FUNCTION add_warehouse_landmark(UUID, TEXT, TEXT, DECIMAL, DECIMAL, JSONB) IS
  'Called by field-mobile walk-mode when the operator marks a non-bin '
  'landmark (loading dock, shipping table, etc). Returns the new row so '
  'the mobile client can immediately render it on the mini-map.';

-- ---------------------------------------------------------------------------
-- 6. View: walk_progress_per_warehouse
-- ---------------------------------------------------------------------------
--
-- Used by the operator-web warehouse setup hub to show "32 of 47 bins
-- walk-verified" without each consumer having to write the join.

CREATE OR REPLACE VIEW walk_progress_per_warehouse AS
SELECT
  w.id AS warehouse_id,
  w.operator_id,
  COUNT(b.id) AS total_bins,
  COUNT(b.id) FILTER (WHERE b.scanned_at IS NOT NULL) AS verified_bins,
  COUNT(b.id) FILTER (WHERE b.coord_x_m IS NOT NULL AND b.coord_y_m IS NOT NULL) AS positioned_bins,
  (
    SELECT COUNT(*) FROM warehouse_landmarks wl
    WHERE wl.warehouse_id = w.id
  ) AS landmarks,
  MAX(b.scanned_at) AS last_walk_at
FROM warehouses w
LEFT JOIN bins b
  ON b.warehouse_id = w.id
 AND b.retired_at IS NULL
GROUP BY w.id, w.operator_id;

COMMENT ON VIEW walk_progress_per_warehouse IS
  'Per-warehouse walk-mode coverage stats. total_bins = active (non-retired) '
  'bins. verified_bins = bins with a walk-mode scan timestamp. positioned_bins '
  '= bins with absolute (x_m, y_m) coords (ARKit-mode subset of verified). '
  'landmarks = count of warehouse_landmarks rows. last_walk_at = most recent '
  'scanned_at across bins in the warehouse.';
