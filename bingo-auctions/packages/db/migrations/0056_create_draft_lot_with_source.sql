-- ============================================================================
-- 0056_create_draft_lot_with_source
--
-- Extends the create_draft_lot RPC to accept a free-form source label
-- (e.g. "Truck 47L 5/9"). Persists to lots.source from migration 0055.
--
-- Adding a new IN parameter changes the function signature, so we DROP
-- the old function and CREATE a new one with the additional p_source
-- argument at the end. Callers who don't pass it use the default NULL,
-- preserving backward compatibility for any code that hasn't migrated
-- to the new shape yet.
--
-- The function body is otherwise identical to migration 0048 (the
-- ambiguity-fix variant). Keeping behavior identical reduces blast
-- radius — only the source column write changes.
-- ============================================================================

DROP FUNCTION IF EXISTS create_draft_lot(
  UUID, TEXT, TEXT, TEXT, UUID, lot_condition, BIGINT, BIGINT, TEXT[], TEXT
);

CREATE FUNCTION create_draft_lot(
  p_operator_id UUID,
  p_title TEXT,
  p_description TEXT,
  p_category TEXT,
  p_category_id UUID,
  p_condition lot_condition,
  p_msrp_cents BIGINT,
  p_starting_bid_cents BIGINT,
  p_photo_urls TEXT[],
  p_external_code TEXT,
  p_source TEXT DEFAULT NULL
)
RETURNS TABLE (out_id UUID, out_lot_code TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_op UUID;
  v_seq BIGINT;
  v_op_code TEXT;
  v_lot_code TEXT;
  v_lot_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'create_draft_lot: not authenticated' USING ERRCODE = '28000';
  END IF;

  v_caller_op := current_operator_id();
  IF v_caller_op IS NULL THEN
    RAISE EXCEPTION 'create_draft_lot: caller is not operator staff'
      USING ERRCODE = '42501';
  END IF;
  IF v_caller_op IS DISTINCT FROM p_operator_id THEN
    RAISE EXCEPTION 'create_draft_lot: caller % cannot create lot for operator %',
      v_caller_op, p_operator_id USING ERRCODE = '42501';
  END IF;

  UPDATE operators
  SET next_lot_seq = next_lot_seq + 1
  WHERE id = p_operator_id
  RETURNING code, next_lot_seq - 1 INTO v_op_code, v_seq;

  IF v_op_code IS NULL THEN
    RAISE EXCEPTION 'create_draft_lot: operator % not found', p_operator_id
      USING ERRCODE = '02000';
  END IF;

  v_lot_code := v_op_code || '-' || lpad(v_seq::TEXT, 6, '0');

  INSERT INTO lots (
    operator_id,
    auction_id,
    lot_number,
    warehouse_id,
    lot_code,
    title,
    description,
    category,
    category_id,
    condition,
    msrp_cents,
    starting_bid_cents,
    photo_urls,
    status,
    external_code,
    close_at,
    source
  ) VALUES (
    p_operator_id,
    NULL,
    NULL,
    NULL,
    v_lot_code,
    p_title,
    p_description,
    p_category,
    p_category_id,
    COALESCE(p_condition, 'good'::lot_condition),
    p_msrp_cents,
    p_starting_bid_cents,
    COALESCE(p_photo_urls, ARRAY[]::TEXT[]),
    'pending_intake'::lot_status,
    p_external_code,
    NULL,
    p_source  -- NULL when caller hasn't set a source label yet
  )
  RETURNING lots.id INTO v_lot_id;

  out_id := v_lot_id;
  out_lot_code := v_lot_code;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION create_draft_lot(
  UUID, TEXT, TEXT, TEXT, UUID, lot_condition, BIGINT, BIGINT, TEXT[], TEXT, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_draft_lot(
  UUID, TEXT, TEXT, TEXT, UUID, lot_condition, BIGINT, BIGINT, TEXT[], TEXT, TEXT
) TO authenticated;

COMMENT ON FUNCTION create_draft_lot(
  UUID, TEXT, TEXT, TEXT, UUID, lot_condition, BIGINT, BIGINT, TEXT[], TEXT, TEXT
) IS
  '0056: atomic seq-increment + INSERT, plus source/truck label column. Replaces 0048; adds p_source argument with NULL default for backward compat.';
