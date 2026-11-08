-- ============================================================================
-- 0065_create_bins_bulk_rpc
--
-- The mobile /bins/new screen and operator-web's BinForm bulk mode
-- both do the same thing: take (aisle, bays-range, levels-range,
-- positions-range), expand the cross product, INSERT N bins. Until
-- this migration the parsing logic lived in TWO places:
--   • TypeScript at apps/operator-web/.../bins/actions.ts:33 (parseRange + createBinsBulk)
--   • TypeScript at apps/field-mobile/app/(staff)/bins/new.tsx (mirrored parser)
--
-- Two problems:
--   1. The mobile screen used a raw `supabase.from('bins').insert(rows)`
--      with the rows constructed client-side. No server-side audit,
--      no per-row duplicate detection, no place to inject future
--      validation (e.g. warehouse capacity checks).
--   2. The two parsers must stay byte-for-byte identical — when
--      operator-web changes its grid layout math (x_px/y_px), mobile
--      drifts silently.
--
-- This migration consolidates into a single SECURITY DEFINER RPC.
-- Operator-web + mobile both call it with the same args; the RPC
-- handles parsing + cross-product + INSERT atomically + returns per-
-- bin status so the UI can show which codes succeeded / failed.
--
-- Args:
--   p_warehouse_id  UUID — must belong to caller's operator
--   p_aisle         TEXT — letter/short label, 1-20 chars
--   p_bays          TEXT — "1-10" or "1,3,5"
--   p_levels        TEXT — "1" or "1-3" etc; defaults to "1" if empty
--   p_positions     TEXT — same as levels
--
-- Returns:
--   TABLE(code TEXT, ok BOOLEAN, error TEXT)
--   One row per bin attempted. `ok=true, error=null` on success.
--   `ok=false, error='duplicate'` if (warehouse_id, code) already
--   exists. All-or-nothing the operator can decide based on result.
-- ============================================================================

CREATE OR REPLACE FUNCTION create_bins_bulk(
  p_warehouse_id UUID,
  p_aisle        TEXT,
  p_bays         TEXT,
  p_levels       TEXT DEFAULT '1',
  p_positions    TEXT DEFAULT '1'
)
RETURNS TABLE (
  code   TEXT,
  ok     BOOLEAN,
  error  TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_caller      UUID := auth.uid();
  v_operator_id UUID;
  v_role        operator_user_role;
  v_wh_op       UUID;

  v_aisle       TEXT;
  v_bays        INTEGER[];
  v_levels      INTEGER[];
  v_positions   INTEGER[];

  v_bay         INTEGER;
  v_level       INTEGER;
  v_position    INTEGER;
  v_bay_idx     INTEGER := 0;

  v_code        TEXT;
  v_x_px        INTEGER;
  v_y_px        INTEGER;
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

  -- Warehouse must belong to caller's operator.
  SELECT operator_id INTO v_wh_op FROM warehouses WHERE id = p_warehouse_id LIMIT 1;
  IF v_wh_op IS NULL THEN
    RAISE EXCEPTION 'warehouse_not_found' USING ERRCODE = '02000';
  END IF;
  IF v_wh_op <> v_operator_id THEN
    RAISE EXCEPTION 'warehouse_other_operator' USING ERRCODE = '42501';
  END IF;

  v_aisle := TRIM(p_aisle);
  IF v_aisle = '' OR LENGTH(v_aisle) > 20 THEN
    RAISE EXCEPTION 'aisle_invalid_length' USING ERRCODE = '22023';
  END IF;

  v_bays      := parse_int_range(p_bays);
  v_levels    := parse_int_range(COALESCE(NULLIF(TRIM(p_levels),    ''), '1'));
  v_positions := parse_int_range(COALESCE(NULLIF(TRIM(p_positions), ''), '1'));

  IF array_length(v_bays, 1) IS NULL
     OR array_length(v_levels, 1) IS NULL
     OR array_length(v_positions, 1) IS NULL
  THEN
    RAISE EXCEPTION 'range_invalid' USING ERRCODE = '22023';
  END IF;

  FOREACH v_bay IN ARRAY v_bays LOOP
    FOREACH v_level IN ARRAY v_levels LOOP
      FOREACH v_position IN ARRAY v_positions LOOP
        v_code := v_aisle || '-' || LPAD(v_bay::TEXT, 2, '0') || '-' || v_level::TEXT || '-' || LPAD(v_position::TEXT, 2, '0');
        v_x_px := 100 + v_bay_idx * 200 + v_position * 50;
        v_y_px := 100 + v_level * 100;

        BEGIN
          INSERT INTO bins (warehouse_id, code, aisle, bay, level, position, x_px, y_px)
          VALUES (p_warehouse_id, v_code, v_aisle, LPAD(v_bay::TEXT, 2, '0'), v_level, v_position, v_x_px, v_y_px);
          code := v_code; ok := true; error := NULL; RETURN NEXT;
        EXCEPTION WHEN unique_violation THEN
          code := v_code; ok := false; error := 'duplicate'; RETURN NEXT;
        WHEN OTHERS THEN
          code := v_code; ok := false; error := SQLERRM; RETURN NEXT;
        END;
      END LOOP;
    END LOOP;
    v_bay_idx := v_bay_idx + 1;
  END LOOP;

  RETURN;
END;
$$;

REVOKE ALL ON FUNCTION create_bins_bulk(UUID, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_bins_bulk(UUID, TEXT, TEXT, TEXT, TEXT) TO authenticated;

-- ----------------------------------------------------------------------------
-- parse_int_range — shared helper for the range syntax (also reusable
-- by any future bulk-create RPC). Mirrors the JS parseRange exactly:
-- "1-10" → [1..10], "1,3,5" → [1,3,5], "7" → [7], invalid → empty.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION parse_int_range(p_spec TEXT)
RETURNS INTEGER[]
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_trimmed TEXT := TRIM(COALESCE(p_spec, ''));
  v_lo INTEGER;
  v_hi INTEGER;
  v_parts TEXT[];
  v_part TEXT;
  v_n INTEGER;
  v_out INTEGER[] := ARRAY[]::INTEGER[];
BEGIN
  IF v_trimmed = '' THEN RETURN ARRAY[]::INTEGER[]; END IF;

  IF v_trimmed LIKE '%,%' THEN
    v_parts := string_to_array(v_trimmed, ',');
    FOREACH v_part IN ARRAY v_parts LOOP
      v_part := TRIM(v_part);
      BEGIN
        v_n := v_part::INTEGER;
        IF v_n >= 0 THEN v_out := v_out || v_n; END IF;
      EXCEPTION WHEN invalid_text_representation THEN
        -- skip
      END;
    END LOOP;
    RETURN v_out;
  END IF;

  IF v_trimmed ~ '^[0-9]+\s*-\s*[0-9]+$' THEN
    v_lo := SPLIT_PART(v_trimmed, '-', 1)::INTEGER;
    v_hi := SPLIT_PART(v_trimmed, '-', 2)::INTEGER;
    IF v_lo > v_hi THEN RETURN ARRAY[]::INTEGER[]; END IF;
    FOR v_n IN v_lo..v_hi LOOP v_out := v_out || v_n; END LOOP;
    RETURN v_out;
  END IF;

  BEGIN
    v_n := v_trimmed::INTEGER;
    RETURN ARRAY[v_n];
  EXCEPTION WHEN invalid_text_representation THEN
    RETURN ARRAY[]::INTEGER[];
  END;
END;
$$;

GRANT EXECUTE ON FUNCTION parse_int_range(TEXT) TO authenticated;
