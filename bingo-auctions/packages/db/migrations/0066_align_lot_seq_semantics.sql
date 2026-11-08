-- ============================================================================
-- 0066_align_lot_seq_semantics
--
-- Platform bug found by mega-sim Phase 1 when both Quick Lot and
-- manifest-intake paths run in the same session: lot_code sequence
-- has gaps and eventually collides with a 23505 unique violation.
--
-- Root cause: TWO RPCs consume operators.next_lot_seq with DIFFERENT
-- RETURNING semantics.
--
--   • create_draft_lot (0047, 0048, 0056) — Quick Lot path
--       UPDATE operators SET next_lot_seq = next_lot_seq + 1
--       RETURNING code, next_lot_seq - 1 INTO v_op_code, v_seq;
--       Uses OLD VALUE (post-increment minus 1). Initial seq=1 →
--       first lot_code -000001. Leaves seq=2.
--
--   • next_lot_code (0021, rewritten 0028) — intake path
--       UPDATE operators SET next_lot_seq = next_lot_seq + 1
--       RETURNING code || '-' || LPAD(next_lot_seq::TEXT, 6, '0');
--       Uses NEW VALUE. After Quick Lot left seq=2, first manifest
--       intake increments to 3 and emits -000003. SKIPS -000002.
--
-- When the two paths interleave:
--   Quick Lot 1 → seq 1→2, emits -000001 (uses 1, the old)
--   Intake 1   → seq 2→3, emits -000003 (uses 3, the new)
--   Intake 2   → seq 3→4, emits -000004
--   …
--   Intake N   → seq N→N+1, emits -(N+1)
--   Quick Lot 2 → seq N+1→N+2, emits -(N+1) ← collision with Intake N
--
-- Production impact: every operator that uses both Quick Lot and
-- manifest intake will eventually hit this 23505 silently — the
-- next call's UPDATE rolls back, so the seq stays where it was, and
-- the bug accumulates. Mega-sim exposed it on the 10th lot of a
-- fresh operator.
--
-- Fix: align both RPCs on the NEW VALUE semantic (the one
-- next_lot_code uses). This is the safer choice:
--   • next_lot_code is called from MORE places (intake_lot_to_bin,
--     batch_intake_lot_to_bin, anywhere that mints from a manifest
--     row) — keeping its semantics minimizes blast radius.
--   • Existing operators' next_lot_seq + max(lot_code) are already
--     out of sync; this just stops the drift from getting worse.
--     Future create_draft_lot calls will jump past the highest
--     existing seq value cleanly.
--   • No backfill required. Existing lots are immutable; only future
--     codes change.
--
-- This re-emits create_draft_lot with body identical to 0056 EXCEPT
-- the RETURNING clause drops the `- 1`. Everything else stays.
-- ============================================================================

CREATE OR REPLACE FUNCTION create_draft_lot(
  p_operator_id        UUID,
  p_title              TEXT,
  p_description        TEXT,
  p_category           TEXT,
  p_category_id        UUID,
  p_condition          lot_condition,
  p_msrp_cents         BIGINT,
  p_starting_bid_cents BIGINT,
  p_photo_urls         TEXT[],
  p_external_code      TEXT,
  p_source             TEXT DEFAULT NULL
)
RETURNS TABLE (out_id UUID, out_lot_code TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_op UUID;
  v_seq       BIGINT;
  v_op_code   TEXT;
  v_lot_code  TEXT;
  v_lot_id    UUID;
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

  -- 0066: aligned with next_lot_code's NEW-VALUE RETURNING semantic.
  -- Was `next_lot_seq - 1` (OLD value) in 0048/0056; that drifted
  -- from next_lot_code (intake path) which uses NEW value. The two
  -- paths now produce the same sequence so mixing Quick Lot + manifest
  -- intake doesn't cause collisions.
  UPDATE operators
     SET next_lot_seq = next_lot_seq + 1
   WHERE id = p_operator_id
   RETURNING code, next_lot_seq INTO v_op_code, v_seq;

  IF v_op_code IS NULL THEN
    RAISE EXCEPTION 'create_draft_lot: operator % not found', p_operator_id
      USING ERRCODE = '02000';
  END IF;

  v_lot_code := v_op_code || '-' || lpad(v_seq::TEXT, 6, '0');

  INSERT INTO lots (
    operator_id, auction_id, lot_number, warehouse_id,
    lot_code, title, description, category, category_id,
    condition, msrp_cents, starting_bid_cents, photo_urls,
    status, external_code, close_at, source
  ) VALUES (
    p_operator_id, NULL, NULL, NULL,
    v_lot_code, p_title, p_description, p_category, p_category_id,
    COALESCE(p_condition, 'good'::lot_condition),
    p_msrp_cents, p_starting_bid_cents,
    COALESCE(p_photo_urls, ARRAY[]::TEXT[]),
    'pending_intake'::lot_status,
    p_external_code, NULL, p_source
  )
  RETURNING lots.id INTO v_lot_id;

  out_id := v_lot_id;
  out_lot_code := v_lot_code;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION create_draft_lot(UUID, TEXT, TEXT, TEXT, UUID, lot_condition, BIGINT, BIGINT, TEXT[], TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_draft_lot(UUID, TEXT, TEXT, TEXT, UUID, lot_condition, BIGINT, BIGINT, TEXT[], TEXT, TEXT) TO authenticated;

COMMENT ON FUNCTION create_draft_lot(UUID, TEXT, TEXT, TEXT, UUID, lot_condition, BIGINT, BIGINT, TEXT[], TEXT, TEXT) IS
  '0066: aligned RETURNING semantic with next_lot_code so both Quick Lot and manifest-intake paths emit the same sequence. Was returning OLD value (next_lot_seq - 1); now returns NEW value to match next_lot_code.';
