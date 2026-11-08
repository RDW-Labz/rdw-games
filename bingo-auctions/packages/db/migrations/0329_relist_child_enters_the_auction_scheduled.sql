-- 0329 — a relisted lot must enter its auction ready to sell, not as a draft.
--
-- Reported 2026-08-20 (Jourdan, with a photo of the lot page):
-- "can you have it look up that code sent and see why it hasn't opened bidding"
-- — TEA4951109, sitting in the LIVE "Beauty and the Bid" auction showing
-- "Bidding isn't available right now."
--
-- ── WHAT WAS WRONG ───────────────────────────────────────────────────────────
-- relist_lot_into_auction inserts the child lot with status 'draft'. The
-- ordinary path into an auction — assign_lots_to_auction — sets 'scheduled'.
-- Nothing promotes 'draft' to anything, so a relisted item is attached to the
-- auction, numbered, priced, photographed, visible on its lot page, and
-- unbiddable. Forever.
--
-- It hides well: the auction still shows a full lot count, and the lot page
-- renders normally right down to the countdown. The only tell is the one line
-- a bidder sees and staff do not.
--
-- 35 lots were in this state when it was found, across four auctions — 13 of
-- them in an auction closing the same afternoon. They have been repaired
-- (status set to match their auction, all zero-bid) alongside this migration.
--
-- ── THE FIX ──────────────────────────────────────────────────────────────────
-- Mint 'scheduled', exactly as assign_lots_to_auction does. The auction
-- lifecycle already promotes scheduled lots when the auction opens, which is
-- why every non-relisted lot works: this puts relist children on the same rails
-- instead of a status nothing advances.
--
-- 'scheduled' rather than 'live' deliberately. The function only accepts a
-- draft or scheduled target auction, so 'live' would be inventing a state the
-- target does not have; and if the auction opens later, the lifecycle promotes
-- this row with all its siblings. One path, one promotion.
--
-- Everything else is 0314's function verbatim.

BEGIN;

CREATE OR REPLACE FUNCTION public.relist_lot_into_auction(p_lot_id uuid, p_auction_id uuid)
RETURNS uuid
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
  -- 0314: stale lineage member currently wearing the box's label
  v_holder_id  UUID;
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

  -- 0314: the label may be worn by a STALE record of this same box — usually
  -- the previous relist child that went unsold. Reclaim it from inside the
  -- lineage tree only. Never from draft/scheduled/live, never from a 'won'
  -- row with an active claim, never across trees.
  IF v_src_sticker_code IS NULL THEN
    WITH RECURSIVE up AS (
      SELECT l.id, l.relisted_from_lot_id FROM lots l WHERE l.id = p_lot_id
      UNION
      SELECT l.id, l.relisted_from_lot_id
        FROM lots l JOIN up ON l.id = up.relisted_from_lot_id
    ), tree AS (
      SELECT u.id FROM up u WHERE u.relisted_from_lot_id IS NULL
      UNION
      SELECT l.id FROM lots l JOIN tree t ON l.relisted_from_lot_id = t.id
    )
    SELECT h.id, h.sticker_code
      INTO v_holder_id, v_src_sticker_code
      FROM lots h JOIN tree t ON t.id = h.id
     WHERE h.sticker_code IS NOT NULL
       AND h.deleted_at IS NULL
       AND h.id <> p_lot_id
       AND (
         h.status IN ('unsold', 'canceled', 'relisted', 'disposed')
         OR (
           h.status = 'won'
           AND EXISTS (SELECT 1 FROM invoice_lots il WHERE il.lot_id = h.id)
           AND NOT EXISTS (
             SELECT 1 FROM invoice_lots il
              WHERE il.lot_id = h.id
                AND il.refunded_at IS NULL
                AND il.forfeited_at IS NULL
           )
         )
       )
     ORDER BY h.created_at DESC
     LIMIT 1;

    IF v_holder_id IS NOT NULL THEN
      UPDATE lots
         SET sticker_code = NULL,
             updated_at   = now()
       WHERE id = v_holder_id;
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
    -- 0329: 'scheduled', not 'draft'. Nothing promotes a draft, so the old
    -- value left every relisted item attached to its auction and unbiddable.
    v_auction.ends_at, 'scheduled',
    v_src.id, COALESCE(v_src.relist_count, 0) + 1, now(),
    v_src.source, v_src.external_code,
    v_src.intake_at, v_src.intake_bin_id
  )
  RETURNING id INTO v_new_lot_id;

  -- 0192 STEP 1 + 0275 (D2): flip the source AND detach it from its auction.
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

  -- 0314: keep the pre-printed pool's claim pointer on the row that WEARS the
  -- sticker (clear_sticker_code releases scoped to claimed_by_lot_id).
  IF v_src_sticker_code IS NOT NULL THEN
    UPDATE lot_sticker_pool
       SET claimed_by_lot_id = v_new_lot_id
     WHERE sticker_code = v_src_sticker_code
       AND operator_id = v_op_id
       AND claimed_at IS NOT NULL
       AND claimed_by_lot_id IS DISTINCT FROM v_new_lot_id;
  END IF;

  RETURN v_new_lot_id;
END;
$function$;

COMMENT ON FUNCTION public.relist_lot_into_auction(uuid, uuid) IS
  '0329: the relist child is minted ''scheduled'', matching '
  'assign_lots_to_auction. It was ''draft'', which nothing promotes, so every '
  'relisted item sat in its auction unbiddable (35 found 2026-08-20).';

-- ---------------------------------------------------------------------------
-- Repair the rows already minted this way
-- ---------------------------------------------------------------------------
-- Applied to prod ahead of this file, on the afternoon it was found, because
-- 13 of the 35 were in an auction closing that evening. Written here so the
-- repair is reproducible and so a replay of migrations lands the same state.
--
-- Scoped to zero-bid relist children in a live or scheduled auction; the status
-- is set to match the auction rather than blanket-'live', so a lot in a
-- scheduled auction still waits for its opening.
UPDATE lots l
SET status = CASE WHEN a.status = 'live' THEN 'live'::lot_status
                  ELSE 'scheduled'::lot_status END,
    updated_at = now()
FROM auctions a
WHERE a.id = l.auction_id
  AND l.status = 'draft'
  AND l.deleted_at IS NULL
  AND l.bid_count = 0
  AND l.relisted_from_lot_id IS NOT NULL
  AND a.status IN ('live', 'scheduled');

COMMIT;
