-- ============================================================================
-- 0048_create_draft_lot_fix_ambiguity
--
-- Hotfix to 0047_create_draft_lot_atomic. The RETURNS TABLE (id UUID, ...)
-- clause creates implicit local variables in the function body that collide
-- with column references inside the INSERT ... RETURNING; this trips
-- "column reference 'id' is ambiguous" (Postgres 42702).
--
-- The cleanest fix is to rename the OUT parameters to unambiguous names
-- (out_id, out_lot_code). Callers don't see the parameter names — they
-- read the result row by position via supabase.rpc().single() — so this
-- is internally-only-visible.
--
-- Idempotent: CREATE OR REPLACE replaces the previous function body.
-- Safe to re-run.
-- ============================================================================

-- Drop the old signature explicitly: changing OUT-parameter names is a
-- new function signature even though the IN-side is identical, so we
-- must drop first to avoid "cannot change name of input parameter"
-- on CREATE OR REPLACE.
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
  p_external_code TEXT
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
  -- Access rule 1: caller must be authenticated.
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'create_draft_lot: not authenticated' USING ERRCODE = '28000';
  END IF;

  -- Access rule 2: p_operator_id must match caller's operator. Service-role
  -- callers bypass auth.uid() (it's NULL for them); we let them through
  -- only when auth.uid() is set, since the SECURITY DEFINER context still
  -- has the caller's JWT for end-users.
  v_caller_op := current_operator_id();
  IF v_caller_op IS NULL THEN
    RAISE EXCEPTION 'create_draft_lot: caller is not operator staff'
      USING ERRCODE = '42501';
  END IF;
  IF v_caller_op IS DISTINCT FROM p_operator_id THEN
    RAISE EXCEPTION 'create_draft_lot: caller % cannot create lot for operator %',
      v_caller_op, p_operator_id USING ERRCODE = '42501';
  END IF;

  -- Atomic seq increment (row lock on operators row).
  UPDATE operators
  SET next_lot_seq = next_lot_seq + 1
  WHERE id = p_operator_id
  RETURNING code, next_lot_seq - 1 INTO v_op_code, v_seq;

  IF v_op_code IS NULL THEN
    RAISE EXCEPTION 'create_draft_lot: operator % not found', p_operator_id
      USING ERRCODE = '02000';
  END IF;

  v_lot_code := v_op_code || '-' || lpad(v_seq::TEXT, 6, '0');

  -- INSERT the lot. If this throws (RLS, FK, UNIQUE on external_code,
  -- CHECK from migration 0046), the surrounding transaction rolls back
  -- the seq increment automatically — no phantom gap.
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
    close_at
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
    NULL
  )
  RETURNING lots.id INTO v_lot_id;

  out_id := v_lot_id;
  out_lot_code := v_lot_code;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION create_draft_lot(
  UUID, TEXT, TEXT, TEXT, UUID, lot_condition, BIGINT, BIGINT, TEXT[], TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_draft_lot(
  UUID, TEXT, TEXT, TEXT, UUID, lot_condition, BIGINT, BIGINT, TEXT[], TEXT
) TO authenticated;

COMMENT ON FUNCTION create_draft_lot(
  UUID, TEXT, TEXT, TEXT, UUID, lot_condition, BIGINT, BIGINT, TEXT[], TEXT
) IS
  'R4.3: atomic seq-increment + INSERT. Replaces the two-step next_lot_code+INSERT pattern in persistence.ts to eliminate phantom-seq-advance on partial failure. SECURITY DEFINER with auth + operator-match guards. OUT params named out_id/out_lot_code to avoid column-ambiguity in INSERT ... RETURNING.';
