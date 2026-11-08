-- 0285 — RECOVER the relist "one active lot per item" guard into the repo
--
-- ⚠️ REPO/PROD DRIFT (found 2026-07-24): migrations 0273, 0274, 0275, 0276 were
-- applied to BinGo prod (npwseclcxcatjhgjrtwe) but never committed to this repo
-- — the migration list jumps 0272 → 0277, yet 0277/0278 reference "0275's
-- active-child / detach guards". The live relist_lot_into_auction therefore
-- carries a guard (raising `relist_source_already_relisted`) that does NOT exist
-- in 0213, the last committed definition. A fresh rebuild from this repo would
-- SILENTLY DROP that guard and re-open duplicate relists.
--
-- This migration re-commits the CURRENTLY-DEPLOYED function body verbatim
-- (read via pg_get_functiondef on prod, 2026-07-24) so the repo matches reality
-- and a rebuild keeps the guard. It is CREATE OR REPLACE and byte-for-byte what
-- prod already runs, so re-applying it to prod is a safe no-op.
--
-- What the recovered guard does (vs 0213):
--   D1 — refuse to relist a source that already has an ACTIVE (canceled_at IS
--        NULL AND deleted_at IS NULL) child. One physical item = at most ONE
--        live lot. Error: `relist_source_already_relisted: item already lives
--        on lot <code>`. A source whose children were all canceled passes
--        (legitimate re-relist), which is why 'relisted' stays in the accepted
--        source-status list.
--   D2 — on relist, DETACH the source from its auction (auction_id, lot_number,
--        close_at → NULL) in addition to status='relisted', so the tombstone
--        parent stops appearing as a ghost listing / carryover candidate.
--
-- FOLLOW-UP (not done here — needs prod DDL history): 0273, 0274 and 0276 are
-- still missing from the repo. 0276 has a multi-step lot-restore (0277 cites its
-- "step-3"); 0273/0274 are unknown. Recover them the same way (dump from prod)
-- when their exact bodies are available. Tracked in the PR description.

BEGIN;

CREATE OR REPLACE FUNCTION public.relist_lot_into_auction(
  p_lot_id UUID,
  p_auction_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_src        lots%ROWTYPE;
  v_auction    auctions%ROWTYPE;
  v_new_code   TEXT;
  v_new_lot_id UUID;
  v_lot_number INT;
  v_op_id      UUID;
  v_op_code    TEXT;
  v_src_sticker_code TEXT;
  v_src_qr_token     UUID;
  -- 0275: existing active child, if any
  v_active_child_code TEXT;
BEGIN
  SELECT * INTO v_src FROM lots WHERE id = p_lot_id FOR UPDATE;
  IF v_src.id IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_src.status NOT IN ('unsold', 'in_inventory', 'relisted') THEN
    RAISE EXCEPTION 'relist_source_wrong_status: %', v_src.status
      USING ERRCODE = 'P0001';
  END IF;

  -- 0275 (D1): one physical item = at most ONE active lot. If this source
  -- already has a live (non-canceled) child, the item already has its listing —
  -- refuse, and tell the operator where it lives. A parent whose children were
  -- all canceled passes (that is the legitimate re-relist case, and the only
  -- reason 'relisted' remains in the accepted status list above).
  SELECT c.lot_code INTO v_active_child_code
    FROM lots c
   WHERE c.relisted_from_lot_id = p_lot_id
     AND c.canceled_at IS NULL
     AND c.deleted_at IS NULL
   LIMIT 1;
  IF v_active_child_code IS NOT NULL THEN
    RAISE EXCEPTION 'relist_source_already_relisted: item already lives on lot %',
      v_active_child_code USING ERRCODE = 'P0001';
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

  -- Stash the source's physical identity before we touch any row (0192).
  v_src_sticker_code := v_src.sticker_code;
  v_src_qr_token     := v_src.qr_token;

  -- 0213: legacy-coded source — derive the namespaced sticker for the new lot.
  IF v_src_sticker_code IS NULL AND v_src.lot_code ~ '^[A-Z]{2,8}[0-9]+$' THEN
    SELECT code INTO v_op_code FROM operators WHERE id = v_op_id;
    IF v_op_code IS NOT NULL THEN
      v_src_sticker_code := v_op_code || ':' || v_src.lot_code;
      IF EXISTS (
        SELECT 1 FROM lots
        WHERE sticker_code = v_src_sticker_code AND deleted_at IS NULL
      ) THEN
        v_src_sticker_code := NULL; -- already claimed elsewhere; don't derive
      END IF;
    END IF;
  END IF;

  SELECT next_lot_code(v_op_id) INTO v_new_code;
  IF v_new_code IS NULL THEN
    RAISE EXCEPTION 'relist_lot_code_mint_failed' USING ERRCODE = 'P0001';
  END IF;

  -- 0099: serialize lot_number assignment per target auction.
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

  -- 0192 STEP 1 + 0275 (D2): flip the source AND detach it from its auction.
  -- Pre-0275 the source kept auction_id/lot_number/close_at, leaving a publicly
  -- visible ghost listing (and the builder's carryover bucket re-offered it
  -- forever). The item now lives on v_new_lot_id; the parent is a tombstone.
  -- Bid-history columns (bid_count/current_bid_*/winner_bidder_id) are
  -- intentionally untouched — they are audit trail, and place_bid refuses
  -- non-scheduled/live lots so no new bids can land here.
  UPDATE lots
  SET status = 'relisted',
      auction_id = NULL,
      lot_number = NULL,
      close_at = NULL,
      sticker_code = NULL,
      qr_token = gen_random_uuid(),
      last_relisted_at = now(),
      updated_at = now()
  WHERE id = p_lot_id;

  -- 0192 STEP 2: move the source's old identity onto the new (live) lot.
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
$function$;

REVOKE ALL ON FUNCTION public.relist_lot_into_auction(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.relist_lot_into_auction(UUID, UUID) TO authenticated;

COMMENT ON FUNCTION public.relist_lot_into_auction(UUID, UUID) IS
  '0275 (recovered into repo by 0285): relist helper. Mints a new lot in the '
  'target auction, moves the source''s physical identity onto it, DETACHES the '
  'source from its auction, and REFUSES if the source already has an active '
  '(non-canceled, non-deleted) child (relist_source_already_relisted) — one '
  'physical item = one active lot. See 0097/0099/0192/0200/0213 for lineage.';

COMMIT;
