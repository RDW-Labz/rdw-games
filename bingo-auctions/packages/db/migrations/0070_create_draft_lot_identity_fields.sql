-- ============================================================================
-- 0070_create_draft_lot_identity_fields
--
-- create_draft_lot (introduced in 0047 / re-emitted through 0056 / 0066)
-- has been silently dropping the AI scan's brand / model / asin / fnsku /
-- lpn fields ever since Quick Lot started using it as its mint path. The
-- mobile flow extracts these in scanPhoto -> LotCandidate but the RPC's
-- INSERT statement only writes operator_id, lot_code, title, description,
-- category, category_id, condition, msrp_cents, starting_bid_cents,
-- photo_urls, status, external_code, close_at, source.
--
-- Observed during dogfooding (2026-05-11): seven consecutive Quick Lot
-- mints (CLU-001022..001028) all came in with brand=null, model=null,
-- asin=null even though the corresponding product_lookups rows had
-- proper brand values ("Coca-Cola", etc.). The Konsait ASIN scan
-- (CLU-001025, title "Konsait X0046QHSX7 Glitter Temporary ...") had
-- the ASIN concatenated into the title because there was nowhere
-- structured to put it.
--
-- This migration:
--   1. Re-emits create_draft_lot with five new optional params
--      (p_brand, p_model, p_asin, p_fnsku, p_lpn). Defaulted to NULL so
--      existing callers (mega-sim, smoke tests, legacy code paths) stay
--      compatible without changes.
--   2. INSERTs those into the matching lots columns (added by 0032).
--   3. Keeps every other 0066 behavior identical — same seq math, same
--      auth guard, same RETURNING (out_id, out_lot_code).
--
-- The function uses `CREATE OR REPLACE` and the same parameter ORDER as
-- 0066 for the first 11 params, so callers that named-arg the RPC don't
-- break. Positional callers would need to be updated, but every caller
-- in our codebase uses named args via supabase.rpc().
-- ============================================================================

-- Drop the prior 11-arg signature first. CREATE OR REPLACE only
-- matches by argument types; with new DEFAULTed args we'd otherwise
-- leave the old 11-arg function alive alongside the new 16-arg one,
-- and PostgREST gets confused about which to call. Dropping the old
-- signature first ensures every supabase.rpc('create_draft_lot', ...)
-- call routes to the new 16-arg version.
DROP FUNCTION IF EXISTS create_draft_lot(UUID, TEXT, TEXT, TEXT, UUID, lot_condition, BIGINT, BIGINT, TEXT[], TEXT, TEXT);

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
  p_source             TEXT DEFAULT NULL,
  -- 0070: identity fields previously dropped by Quick Lot. Optional
  -- for backwards compatibility with callers (manifest path, mega-sim,
  -- smoke tests) that don't have them.
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

  out_id := v_lot_id;
  out_lot_code := v_lot_code;
  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION create_draft_lot(UUID, TEXT, TEXT, TEXT, UUID, lot_condition, BIGINT, BIGINT, TEXT[], TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION create_draft_lot(UUID, TEXT, TEXT, TEXT, UUID, lot_condition, BIGINT, BIGINT, TEXT[], TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO authenticated;

COMMENT ON FUNCTION create_draft_lot(UUID, TEXT, TEXT, TEXT, UUID, lot_condition, BIGINT, BIGINT, TEXT[], TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) IS
  '0070: Quick-Lot mint path. Adds brand/model/asin/fnsku/lpn params so AI-scan identity fields stop getting silently dropped at the RPC boundary.';
