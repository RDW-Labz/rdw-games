-- 0296 — relot after a refund: stop D1 blocking on a cancel stamp
--
-- Field report 2026-07-29: "After refunding an item, we're attempting to relot
-- it, but the system returns an error stating that the lot code does not
-- exist... We were able to use this functionality previously."
--
-- The intended workflow is unchanged and is the one the Relot screen already
-- implements: RELOT THE EXISTING LOT. Do not create a brand-new lot for a
-- returned item — that is what produces the duplicate listings this codebase
-- has been chasing since 0275. relot.tsx flips a refunded 'won' lot to 'unsold'
-- and calls this RPC, which mints a fresh lot_code and records
-- relisted_from_lot_id lineage.
--
-- What was broken: D1 refused whenever the source had ANY child without a
-- cancel stamp. `canceled_at` is not liveness — 0290 established that for the
-- unique index and fixed it there, but D1 kept the old predicate. A child that
-- was won and then refunded has status 'won' and canceled_at NULL, so its
-- parent was permanently un-relistable with
--   relist_source_already_relisted: item already lives on lot <child>
-- even though the buyer had been refunded and the goods were back on the shelf.
--
-- Verified on prod 2026-07-29: 20+ parent lots sit in this state, e.g.
-- PNK4996612 -> BIN-004381 [won, refunded 07-28] and BRN4338806 -> BIN-003243
-- [won, refunded 07-27].
--
-- This migration reproduces 0285's function verbatim with ONLY the D1 predicate
-- changed. Everything else -- the status gate, the sticker/qr_token handover,
-- lot numbering, the tombstone flip -- is byte-identical to what is live.

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

  -- 0275 (D1), re-keyed by 0296: one physical item = at most ONE active lot.
  --
  -- 0285 asked "is there a child without a cancel stamp?". That is the same
  -- canceled_at-vs-status confusion 0290 fixed for the index and left here: a
  -- child that was WON and then REFUNDED carries no cancel stamp, so the parent
  -- stayed blocked forever with relist_source_already_relisted even though the
  -- item was physically back on the shelf. 20+ parents on prod are in exactly
  -- that state (2026-07-29), which is the "unable to relot refunded items"
  -- field report.
  --
  -- Ask the real question instead — is the item still SPOKEN FOR?
  --   • child is draft/scheduled/live  -> it already has a live listing. Block.
  --   • child is 'won' and NOT refunded -> a customer owns it. Block.
  --   • child is 'won' and REFUNDED     -> refund-and-restock; it came back to
  --     the store, so the parent may be relisted. Allow.
  --   • child canceled/unsold/relisted/in_inventory -> not spoken for. Allow,
  --     as before.
  --
  -- Strictly narrower than 0285: every child that blocked under the old
  -- predicate and is still genuinely spoken for still blocks.
  SELECT c.lot_code INTO v_active_child_code
    FROM lots c
   WHERE c.relisted_from_lot_id = p_lot_id
     AND c.deleted_at IS NULL
     AND (
       c.status IN ('draft', 'scheduled', 'live')
       OR (
         c.status = 'won'
         AND NOT EXISTS (
           SELECT 1 FROM invoice_lots il
            WHERE il.lot_id = c.id
              AND il.refunded_at IS NOT NULL
         )
       )
     )
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
  '0296: 0285 behaviour with the D1 active-child guard re-keyed off status '
  'instead of canceled_at. Refuses when a child is draft/scheduled/live, or is '
  'won and NOT refunded (a customer owns it). A won-then-REFUNDED child no '
  'longer blocks the parent -- that is refund-and-restock, and the item is back '
  'on the shelf. Still raises relist_source_already_relisted.';

COMMIT;
