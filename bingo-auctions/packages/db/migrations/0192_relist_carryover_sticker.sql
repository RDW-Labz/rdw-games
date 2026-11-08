-- ============================================================================
-- Migration 0192 — RELIST-2: carry the physical sticker identity forward on relist
--
-- BUG (RELIST-2, confirmed on live prod)
-- --------------------------------------
-- When an unsold lot is relisted, relist_lot_into_auction (last defined in
-- 0099, body originally from 0097) mints a NEW lots row and copies
-- intake_bin_id forward, but does NOT carry sticker_code or qr_token. The new
-- row therefore lands with sticker_code = NULL and a FRESH default qr_token
-- (qr_token is NOT NULL DEFAULT uuid_generate_v4(), see 0103). Meanwhile the
-- physical box still wears the ORIGINAL label/QR, which keeps resolving to the
-- SOURCE row — now status='relisted'. Both put-away and bidder paths break:
--   * intake_lot_to_bin (0103) resolves qr_token/lot_code/sticker_code, then
--     rejects anything not in ('pending_intake','in_inventory') with
--     'lot_not_in_intake_state' → the relisted item is unscannable at
--     put-away / re-shelf.
--   * resolve_lot_by_sticker (0150) and resolve_lot_by_qr_token (0103) follow
--     whichever live row holds the code/token, so the bidder /l/<token> link
--     and in-app sticker scan also point at the dead 'relisted' source.
-- Live impact at time of fix: 25/25 relist children had NULL sticker_code.
--
-- OWNER DECISION (greenlit): MOVE THE PHYSICAL IDENTITY FORWARD
-- -------------------------------------------------------------
-- The box's existing label is the source of truth — staff are NOT going to
-- re-sticker every relisted item. So the relisted (NEW) lot must inherit the
-- source lot's sticker_code + qr_token, and the source (now 'relisted', a dead
-- end) must surrender them. After this, the unchanged label/QR on the physical
-- box resolves to the LIVE relisted lot at every surface — intake_lot_to_bin,
-- resolve_lot_by_sticker, resolve_lot_by_qr_token — with no client changes.
--
-- CRITICAL ORDERING (do not reorder)
-- ----------------------------------
-- The global partial UNIQUE index lots_sticker_code_unique_idx (0141) forbids
-- two rows holding the same non-NULL sticker_code at the same instant. So we
-- must CLEAR the source FIRST, THEN set the new lot — never the reverse, or the
-- second UPDATE 23505s. qr_token also has a UNIQUE index (lots_qr_token_unique,
-- 0103) and is NOT NULL, so the source must be reassigned a FRESH uuid (never
-- NULL) before the new lot can take the source's old token. We fold the source
-- clear into the existing status='relisted' UPDATE so it's one statement.
--
-- AFFECTED RESOLVERS (now correctly follow the live lot)
-- ------------------------------------------------------
--   * intake_lot_to_bin            (0103) — qr_token / lot_code / sticker_code
--   * resolve_lot_by_sticker       (0150) — bidder sticker scan, op-scoped
--   * resolve_lot_by_qr_token      (0103) — public /l/<token> + bidder /scan
--
-- SCOPE
-- -----
-- This fixes NEW relists GOING FORWARD only. The 25 EXISTING relist children
-- already have their sticker stranded on the 'relisted' source; that is a
-- separate one-time backfill (see the migration report — deferred / optional,
-- not included here to keep this change a pure function replacement).
--
-- Base: 0099_lot_number_race.sql (the highest-numbered CREATE OR REPLACE of
-- relist_lot_into_auction; 0097 is superseded — it only added the advisory
-- lock). Body reproduced faithfully below; the ONLY additions are (1) the two
-- new capture locals, (2) the source clear folded into the existing UPDATE,
-- and (3) the new-lot identity UPDATE. Signature + return type + lock + lot_code
-- mint + INSERT column list are all unchanged, so every caller
-- (auto_relist_unsold_lots in 0097/0146/0180, manual relist actions) is intact.
--
-- Plain statements only — NO BEGIN/COMMIT (the runner wraps each migration in a
-- transaction, dry-runs BEGIN/ROLLBACK, and self-marks _schema_migrations).
-- CREATE OR REPLACE preserves grants, but REVOKE/GRANT are re-asserted as 0099
-- did. CI-appliable on a fresh DB.
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
  -- so the source must release sticker_code (→ NULL) and qr_token (→ a FRESH
  -- uuid, since qr_token is NOT NULL) BEFORE the new lot can take them. Folded
  -- into the existing status='relisted' UPDATE that 0097/0099 already did.
  UPDATE lots
  SET status = 'relisted',
      sticker_code = NULL,
      qr_token = uuid_generate_v4(),
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
