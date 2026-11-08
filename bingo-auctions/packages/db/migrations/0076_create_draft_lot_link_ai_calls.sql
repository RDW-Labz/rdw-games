-- ============================================================================
-- 0076_create_draft_lot_link_ai_calls
--
-- Heuristic backlink: after create_draft_lot inserts a new lot, UPDATE
-- recent unlinked ai_calls rows for the same operator+user with the
-- new lot.id. Closes the production audit gap (2026-05-15):
--
--   "ai_calls.lot_id is null across all recent rows — they aren't being
--    linked to the lot they produced. Makes after-the-fact 'why did
--    THIS lot miss MSRP' inspection harder than it should be."
--
-- Why a heuristic backlink instead of explicit correlation IDs:
--
--   The scan-photo route writes ai_calls BEFORE the mobile client has
--   created the lot — lot_id isn't known at AI-call time. A proper fix
--   would thread a UUID through both the /api/lottr/scan-photo request
--   and the create_draft_lot RPC (mobile change + new column on
--   ai_calls + plumbing through the route). That's a multi-file
--   change blocking a useful debug capability today.
--
--   This migration takes a smaller path: at lot-create time, find any
--   ai_calls rows in the last 2 minutes for the same auth.uid() (the
--   user) where lot_id is still NULL, and link them to the new lot.
--
-- Why the 2-minute window is safe:
--
--   The scan-photo route runs scanPhoto() which produces 1-3 AI calls
--   (photo_identify, optionally web_search_lookup, optionally
--   image_enrich) and returns within ~5-15 seconds. The mobile client
--   then renders the candidate and the operator taps "Save" — usually
--   within 30-90 seconds. 2 minutes is generous; longer than that
--   suggests the operator scanned something else in between (in which
--   case we'd rather not falsely link than over-link, so the WHERE
--   clause's NULL guard limits the damage).
--
--   Concurrent operators in the same operator_id are isolated by
--   user_id (auth.uid()), so two staff scanning simultaneously don't
--   cross-pollute their AI-call rows.
--
-- Edge cases NOT handled here (acceptable tradeoffs):
--
--   1. User scans item A, doesn't save, scans item B, saves item B:
--      item A's ai_calls get linked to lot B. Acceptable — those
--      rows would otherwise be permanently unlinked. The operator
--      knows item A wasn't saved; the cost-attribution noise is
--      bounded.
--
--   2. User scans the same item twice in 2 minutes, saves once: both
--      sets of ai_calls link to the single lot. Slightly over-counts
--      cost-per-lot but correctly attributes spend to the operator.
--
--   3. >2 minute gap between scan and save: ai_calls stay unlinked.
--      Same as today's behavior.
--
-- Migration is idempotent — DROP + CREATE keeps the signature stable.
-- Postgres won't let CREATE OR REPLACE keep DEFAULT params if the
-- function has any default args (42P13 error), so we drop + recreate.
-- No data changes, only the function body.
-- ============================================================================

DROP FUNCTION IF EXISTS create_draft_lot(UUID, TEXT, TEXT, TEXT, UUID, lot_condition, BIGINT, BIGINT, TEXT[], TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT);

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
  p_source             TEXT,
  p_brand              TEXT DEFAULT NULL,
  p_model              TEXT DEFAULT NULL,
  p_asin               TEXT DEFAULT NULL,
  p_fnsku              TEXT DEFAULT NULL,
  p_lpn                TEXT DEFAULT NULL
)
RETURNS TABLE (out_id UUID, out_lot_code TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_op  UUID;
  v_caller_uid UUID;
  v_seq        BIGINT;
  v_op_code    TEXT;
  v_lot_code   TEXT;
  v_lot_id     UUID;
BEGIN
  v_caller_uid := auth.uid();
  IF v_caller_uid IS NULL THEN
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

  -- 0066: NEW-VALUE RETURNING semantic aligned with next_lot_code.
  UPDATE operators
     SET next_lot_seq = next_lot_seq + 1
   WHERE id = p_operator_id
   RETURNING code, next_lot_seq INTO v_op_code, v_seq;

  IF v_op_code IS NULL THEN
    RAISE EXCEPTION 'create_draft_lot: operator % not found', p_operator_id
      USING ERRCODE = '02000';
  END IF;

  v_lot_code := v_op_code || '-' || lpad(v_seq::TEXT, 6, '0');

  -- 0070: now writes brand, model, asin, fnsku, lpn alongside the
  -- previously-supported fields. Empty strings normalize to NULL so the
  -- lot_text_length CHECKs (0050) don't trip on AI extractions that
  -- returned "" for an absent value.
  INSERT INTO lots (
    operator_id, auction_id, lot_number, warehouse_id,
    lot_code, title, description, category, category_id,
    condition, msrp_cents, starting_bid_cents, photo_urls,
    status, external_code, close_at, source,
    brand, model, asin, fnsku, lpn
  ) VALUES (
    p_operator_id, NULL, NULL, NULL,
    v_lot_code, p_title, p_description, p_category, p_category_id,
    COALESCE(p_condition, 'good'::lot_condition),
    p_msrp_cents, p_starting_bid_cents,
    COALESCE(p_photo_urls, ARRAY[]::TEXT[]),
    'pending_intake'::lot_status,
    p_external_code, NULL, p_source,
    NULLIF(TRIM(COALESCE(p_brand, '')), ''),
    NULLIF(TRIM(COALESCE(p_model, '')), ''),
    NULLIF(TRIM(COALESCE(p_asin,  '')), ''),
    NULLIF(TRIM(COALESCE(p_fnsku, '')), ''),
    NULLIF(TRIM(COALESCE(p_lpn,   '')), '')
  )
  RETURNING lots.id INTO v_lot_id;

  -- 0076: heuristic backlink of recent unlinked ai_calls rows. See
  -- migration header for tradeoff rationale. SECURITY DEFINER + same-
  -- user filter (auth.uid()) means RLS doesn't block the UPDATE.
  -- Safe to no-op when the user has no recent unlinked AI activity.
  UPDATE ai_calls
     SET lot_id = v_lot_id
   WHERE user_id   = v_caller_uid
     AND operator_id = p_operator_id
     AND lot_id    IS NULL
     AND created_at > NOW() - INTERVAL '2 minutes';

  out_id := v_lot_id;
  out_lot_code := v_lot_code;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION create_draft_lot(UUID, TEXT, TEXT, TEXT, UUID, lot_condition, BIGINT, BIGINT, TEXT[], TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_draft_lot(UUID, TEXT, TEXT, TEXT, UUID, lot_condition, BIGINT, BIGINT, TEXT[], TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;

COMMENT ON FUNCTION create_draft_lot(UUID, TEXT, TEXT, TEXT, UUID, lot_condition, BIGINT, BIGINT, TEXT[], TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) IS
  '0076: same as 0070 + heuristic lot_id backlink on ai_calls for the calling user within the last 2 minutes. Closes the "which AI calls produced this lot" debug gap.';
