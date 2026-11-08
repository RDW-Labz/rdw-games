-- ============================================================================
-- 0047_create_draft_lot_atomic
--
-- Single-transaction lot creation: increments operators.next_lot_seq AND
-- inserts the lots row in one atomic operation. Replaces the two-step
-- pattern in createDraftLotFromCandidate (next_lot_code RPC + INSERT)
-- which leaves a "phantom seq advance" gap if the network drops between
-- the two calls.
--
-- Effects vs two-step:
--   - On success: identical (returns new lot id + lot_code).
--   - On INSERT failure (FK violation, RLS, duplicate UPC): the seq
--     increment is rolled back automatically, so no gap.
--   - On RPC failure (operator missing, etc.): same as before — caller
--     gets the error and no lot exists.
--
-- Security:
--   SECURITY DEFINER (because we need to UPDATE operators.next_lot_seq
--   which the calling user doesn't own). We enforce two access rules
--   inside the function:
--     1. Caller must be authenticated (auth.uid() not null).
--     2. p_operator_id must match the caller's current_operator_id()
--        — i.e. operators can only create lots for their own org.
--   Both rules emit a typed exception so persistence.ts can map them
--   onto the discriminated failure code from R1.1.
--
-- The previous next_lot_code() function and the existing two-step path
-- in persistence.ts continue to work — this is additive. persistence.ts
-- will be migrated to use the new RPC in the same R4.3 commit, but the
-- old function is kept around for any external callers / one-off scripts.
-- ============================================================================

CREATE OR REPLACE FUNCTION create_draft_lot(
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
RETURNS TABLE (id UUID, lot_code TEXT)
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
  -- because they're trusted import / admin paths. For end-user callers,
  -- current_operator_id() resolves via operator_users.
  v_caller_op := current_operator_id();
  IF v_caller_op IS NULL THEN
    -- No operator_users row — the caller is a bidder or unauthenticated.
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

  RETURN QUERY SELECT v_lot_id, v_lot_code;
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
  'R4.3: atomic seq-increment + INSERT. Replaces the two-step next_lot_code+INSERT pattern in persistence.ts to eliminate phantom-seq-advance on partial failure. SECURITY DEFINER with auth + operator-match guards.';
