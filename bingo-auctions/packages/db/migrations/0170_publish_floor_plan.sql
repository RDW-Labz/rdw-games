-- ============================================================================
-- Migration 0170 — publish_warehouse_floor_plan RPC
--
-- Computes an idealized grid position (x_px, y_px) for every active bin in
-- a warehouse from its code (Aisle-Bay-Level, e.g. "1-01-01") and returns
-- the canvas dimensions the server action needs to generate the SVG and
-- upload it to Supabase Storage.
--
-- The server action (apps/operator-web) handles:
--   • SVG string construction
--   • Supabase Storage upload  → floor-plans/<op_id>/<wh_id>/<version>.svg
--   • UPDATE warehouses SET floor_plan_url, floor_plan_width_px, floor_plan_height_px
--     (setting floor_plan_url triggers the 0094 bump_warehouse_floor_plan_version
--      trigger, which auto-increments floor_plan_version + sets floor_plan_uploaded_at)
--
-- This RPC does NOT generate SVG or touch warehouses — it only writes
-- bins.x_px / bins.y_px and returns the canvas dimensions.
--
-- Grid constants (px):
--   MARGIN        40   — outer padding on all four sides
--   BIN_W         80   — bin rectangle width
--   BIN_H         40   — bin rectangle height
--   AISLE_SPACING 120  — horizontal step per aisle
--   BAY_SPACING    60  — vertical step per bay
--
-- Bin origin: (MARGIN + (aisle-1) * AISLE_SPACING, MARGIN + (bay-1) * BAY_SPACING)
-- Canvas: width  = MARGIN*2 + max_aisle * AISLE_SPACING
--         height = MARGIN*2 + max_bay   * BAY_SPACING
--
-- Auth: caller must be operator staff (operator_users row). Warehouse must
-- belong to the caller's operator. RAISES on failure.
--
-- Idempotent: CREATE OR REPLACE; REVOKE/GRANT guarded by plpgsql (no side
-- effects on re-run beyond overwriting the function body).
-- ============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION publish_warehouse_floor_plan(p_warehouse_id UUID)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  -- Constants
  v_margin        CONSTANT INT := 40;
  v_bin_w         CONSTANT INT := 80;
  v_bin_h         CONSTANT INT := 40;
  v_aisle_spacing CONSTANT INT := 120;
  v_bay_spacing   CONSTANT INT := 60;

  v_op_id     UUID;
  v_wh_op_id  UUID;
  v_max_aisle INT := 0;
  v_max_bay   INT := 0;
  v_bin_count INT := 0;
  v_width_px  INT;
  v_height_px INT;

  v_bin       RECORD;
  v_parts     TEXT[];
  v_aisle     INT;
  v_bay       INT;
  v_x_px      INT;
  v_y_px      INT;
BEGIN
  -- Auth check: caller must be operator staff.
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  v_op_id := current_operator_id();
  IF v_op_id IS NULL THEN
    RAISE EXCEPTION 'not_operator_staff' USING ERRCODE = '42501';
  END IF;

  -- Ownership check: warehouse must belong to caller's operator.
  SELECT operator_id INTO v_wh_op_id
  FROM warehouses
  WHERE id = p_warehouse_id;

  IF v_wh_op_id IS NULL THEN
    RAISE EXCEPTION 'warehouse_not_found' USING ERRCODE = 'P0001';
  END IF;

  IF v_wh_op_id IS DISTINCT FROM v_op_id THEN
    RAISE EXCEPTION 'warehouse_other_operator' USING ERRCODE = '42501';
  END IF;

  -- ── First pass: compute max aisle + max bay across all active bins ───────
  FOR v_bin IN
    SELECT id, code
    FROM bins
    WHERE warehouse_id = p_warehouse_id
      AND retired_at IS NULL
    ORDER BY code
  LOOP
    v_parts := string_to_array(v_bin.code, '-');
    IF array_length(v_parts, 1) < 2 THEN
      CONTINUE; -- Skip bins with non-standard codes (no bay component).
    END IF;

    BEGIN
      v_aisle := v_parts[1]::INT;
      v_bay   := v_parts[2]::INT;
    EXCEPTION WHEN OTHERS THEN
      CONTINUE; -- Skip bins where code parts are non-numeric.
    END;

    IF v_aisle > v_max_aisle THEN v_max_aisle := v_aisle; END IF;
    IF v_bay   > v_max_bay   THEN v_max_bay   := v_bay;   END IF;
    v_bin_count := v_bin_count + 1;
  END LOOP;

  IF v_bin_count = 0 THEN
    RAISE EXCEPTION 'no_active_bins' USING ERRCODE = 'P0001';
  END IF;

  -- Canvas dimensions. At least 1 step wide/tall even for single-bin layouts.
  v_width_px  := v_margin * 2 + v_max_aisle * v_aisle_spacing;
  v_height_px := v_margin * 2 + v_max_bay   * v_bay_spacing;

  -- ── Second pass: write x_px / y_px on every active bin ──────────────────
  FOR v_bin IN
    SELECT id, code
    FROM bins
    WHERE warehouse_id = p_warehouse_id
      AND retired_at IS NULL
  LOOP
    v_parts := string_to_array(v_bin.code, '-');
    IF array_length(v_parts, 1) < 2 THEN
      CONTINUE;
    END IF;

    BEGIN
      v_aisle := v_parts[1]::INT;
      v_bay   := v_parts[2]::INT;
    EXCEPTION WHEN OTHERS THEN
      CONTINUE;
    END;

    -- Origin is the top-left corner of the bin rectangle.
    v_x_px := v_margin + (v_aisle - 1) * v_aisle_spacing;
    v_y_px := v_margin + (v_bay   - 1) * v_bay_spacing;

    UPDATE bins
    SET x_px = v_x_px, y_px = v_y_px, updated_at = now()
    WHERE id = v_bin.id;
  END LOOP;

  RETURN jsonb_build_object(
    'width_px',   v_width_px,
    'height_px',  v_height_px,
    'bin_count',  v_bin_count,
    'max_aisle',  v_max_aisle,
    'max_bay',    v_max_bay,
    'bin_w',      v_bin_w,
    'bin_h',      v_bin_h,
    'margin',     v_margin
  );
END;
$$;

REVOKE ALL ON FUNCTION publish_warehouse_floor_plan(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION publish_warehouse_floor_plan(UUID) TO authenticated;

COMMENT ON FUNCTION publish_warehouse_floor_plan(UUID) IS
  'S10 (mig 0170): Computes idealized grid coordinates for every active bin '
  'in the warehouse from its Aisle-Bay-Level code, writes x_px/y_px on each '
  'bin, and returns { width_px, height_px, bin_count, max_aisle, max_bay, '
  'bin_w, bin_h, margin } for the server action to build and upload the SVG. '
  'Caller must be operator staff and own the warehouse. '
  'Grid constants: MARGIN=40px AISLE_SPACING=120px BAY_SPACING=60px BIN=80x40px.';

COMMIT;
