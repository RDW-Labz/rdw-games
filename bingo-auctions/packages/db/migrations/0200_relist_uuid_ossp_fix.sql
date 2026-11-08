-- ============================================================================
-- Migration 0200 — fix relist_lot_into_auction: uuid_generate_v4() -> gen_random_uuid()
--
-- BUG (confirmed on live prod, 2026-06-10 tester recap)
-- ----------------------------------------------------
-- Operator "Carry Over Lots" / Relist (worklist + lots/[id] + auto_relist cron)
-- calls relist_lot_into_auction, whose live body (mig 0192, RELIST-2) does:
--     qr_token = uuid_generate_v4()
-- inside a function pinned to `SET search_path = public`. On Supabase the
-- uuid-ossp extension lives in the `extensions` schema, NOT public, so the
-- pinned search_path hides it and the call raises:
--     42883  function uuid_generate_v4() does not exist
-- This is the SAME failure mode already fixed once in 0067 (rotate_bin_token).
-- A column DEFAULT uuid_generate_v4() works (evaluated in the column's
-- default-expression context); a direct body call does not.
--
-- FIX
-- ---
-- Replace the single body-level uuid_generate_v4() with gen_random_uuid(),
-- built into Postgres 13+ (pg_catalog, always on every search_path). Same
-- output. Established repo convention (0067/0068/0081/0088/0131/0136/0159/0163).
--
-- Body reproduced VERBATIM from 0192 — the ONLY change is the qr_token source-
-- clear line. Signature, return type, advisory lock, lot_code mint, INSERT
-- column list, both identity UPDATEs, and the REVOKE/GRANT are unchanged, so
-- every caller (auto_relist_unsold_lots, manual relist actions, worklist
-- relistWorklistLot) stays intact.
-- ============================================================================

CREATE OR REPLACE FUNCTION relist_lot_into_auction(
  p_lot_id     UUID,
  p_auction_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_src        lots%ROWTYPE;
  v_auction    auctions%ROWTYPE;
  v_new_code   TEXT;
  v_new_lot_id UUID;
  v_lot_number INT;
  v_op_id      UUID;
  -- 0192 (RELIST-2): capture the source's physical identity so we can move it
  -- onto the new lot. Read off v_src, which is already SELECTed FOR UPDATE
  -- below — no extra query.
  v_src_sticker_code TEXT;
  v_src_qr_token     UUID;
BEGIN
  SELECT * INTO v_src FROM lots WHERE id = p_lot_id FOR UPDATE;
  IF v_src.id IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_src.status NOT IN ('unsold', 'in_inventory', 'relisted') THEN
    RAISE EXCEPTION 'relist_source_wrong_status: %', v_src.status
      USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO v_auction FROM auctions WHERE id = p_auction_id;
  IF v_auction.id IS NULL THEN
    RAISE EXCEPTION 'relist_target_auction_not_found' USING ERRCODE = 'P0001';
  END IF;
  IF v_auction.operator_id <> v_src.operator_id THEN
    RAISE EXCEPTION 'relist_cross_tenant' USING ERRCODE = '42501';
  END IF;
  IF v_auction.warehouse_id <> v_src.warehouse_id THEN
    RAISE EXCEPTION 'relist_target_different_warehouse' USING ERRCODE = 'P0001';
  END IF;
  IF v_auction.status NOT IN ('draft', 'scheduled') THEN
    RAISE EXCEPTION 'relist_target_wrong_status: %', v_auction.status
      USING ERRCODE = 'P0001';
  END IF;

  v_op_id := v_src.operator_id;

  -- Stash the source's physical identity before we touch any row. sticker_code
  -- may be NULL (operator never used the operator-chosen sticker lane);
  -- qr_token is always present (NOT NULL DEFAULT).
  v_src_sticker_code := v_src.sticker_code;
  v_src_qr_token     := v_src.qr_token;

  SELECT next_lot_code(v_op_id) INTO v_new_code;
  IF v_new_code IS NULL THEN
    RAISE EXCEPTION 'relist_lot_code_mint_failed' USING ERRCODE = 'P0001';
  END IF;

  -- 0099 fix: take the advisory lock for the auction BEFORE computing
  -- the next lot_number. Concurrent relist attempts (manual + auto) on
  -- the same target auction serialize here instead of racing on MAX+1.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_auction_id::TEXT, 0));

  SELECT COALESCE(MAX(lot_number), 0) + 1 INTO v_lot_number
  FROM lots WHERE auction_id = p_auction_id;

  INSERT INTO lots (
    operator_id, auction_id, warehouse_id,
    lot_code, lot_number,
    title, description, category, condition,
    msrp_cents, starting_bid_cents, photo_urls,
    close_at, status,
    relisted_from_lot_id, relist_count, last_relisted_at,
    source, external_code,
    intake_at, intake_bin_id
  )
  VALUES (
    v_op_id, p_auction_id, v_src.warehouse_id,
    v_new_code, v_lot_number,
    v_src.title, v_src.description, v_src.category, v_src.condition,
    v_src.msrp_cents, v_src.starting_bid_cents, COALESCE(v_src.photo_urls, '{}'::TEXT[]),
    v_auction.ends_at, 'draft',
    v_src.id, COALESCE(v_src.relist_count, 0) + 1, now(),
    v_src.source, v_src.external_code,
    v_src.intake_at, v_src.intake_bin_id
  )
  RETURNING id INTO v_new_lot_id;

  -- 0192 (RELIST-2) — STEP 1 of 2: CLEAR the source's physical identity FIRST.
  -- The unique partial index lots_sticker_code_unique_idx (0141) and
  -- lots_qr_token_unique (0103) forbid two rows holding the same value at once,
  -- so the source must release sticker_code (-> NULL) and qr_token (-> a FRESH
  -- uuid, since qr_token is NOT NULL) BEFORE the new lot can take them. Folded
  -- into the existing status='relisted' UPDATE that 0097/0099 already did.
  -- 0200: was uuid_generate_v4() — fails 42883 under SET search_path = public
  -- because uuid-ossp lives in the `extensions` schema on Supabase. Replaced
  -- with gen_random_uuid() (core PG13+, pg_catalog, always resolvable). Same
  -- output guarantees; identical to the 0067 fix for rotate_bin_token.
  UPDATE lots
  SET status = 'relisted',
      sticker_code = NULL,
      qr_token = gen_random_uuid(),
      last_relisted_at = now(),
      updated_at = now()
  WHERE id = p_lot_id;

  -- 0192 (RELIST-2) — STEP 2 of 2: move the source's OLD identity onto the new
  -- (live) lot, so the unchanged physical label/QR on the box now resolves to
  -- it. Only set sticker_code when the source actually had one — otherwise
  -- leave the new lot's NULL untouched (the partial index has no NULL entries,
  -- and the format CHECK only fires on non-NULL). qr_token is always moved.
  UPDATE lots
  SET qr_token = v_src_qr_token,
      sticker_code = CASE
        WHEN v_src_sticker_code IS NOT NULL THEN v_src_sticker_code
        ELSE sticker_code
      END,
      updated_at = now()
  WHERE id = v_new_lot_id;

  RETURN v_new_lot_id;
END;
$$;

REVOKE ALL ON FUNCTION relist_lot_into_auction(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION relist_lot_into_auction(UUID, UUID) TO authenticated;
