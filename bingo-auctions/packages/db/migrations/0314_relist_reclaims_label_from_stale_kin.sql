-- 0314 — the label follows the live lot: relist reclaims it from stale kin
--
-- Owner decision 2026-08-07: the printed label (BRN/TEA/PNK/… on the box) is
-- how the team and customers track an item. Whatever lot is live and in
-- inventory should WEAR that label — one box, one code, reused across relists.
--
-- What blocked that: 0213's derive step refuses whenever the label "is already
-- claimed elsewhere" — and the claimer is almost always a STALE record of the
-- SAME box: the previous relist child that went unsold, was canceled, or was
-- won-then-refunded. Reproduced on prod the same day this shipped:
-- TEA4951993 (root, relisted) → BIN-006802 (unsold, wears BIN:TEA4951993)
--                             → BIN-007904 (won today, sticker NULL — the
--                               derive bailed because the unsold twin holds
--                               the label). The customer's pickup pass said
--                               BIN-007904; the box said TEA4951993.
--
-- Fix, two parts:
--
--   1. FUNCTION: when the source carries no sticker and none can be derived
--      unclaimed, look for the label INSIDE THIS ITEM'S LINEAGE TREE. If a
--      lineage member wears one and its claim is stale — unsold / canceled /
--      relisted / disposed, or won with every invoice claim refunded or
--      forfeited — strip it there and hand it to the new lot. Scoped strictly
--      to the lineage: a claim by any row OUTSIDE the tree is a different
--      physical box (or corruption) and is never touched. The D1 guard already
--      ensures no child of the source is actively listed at relist time, so
--      within the tree "wearing the label" and "actively spoken for" can only
--      coincide on rows this predicate refuses anyway.
--
--   2. BACKFILL: apply the same rule once to existing trees. For each lineage,
--      the item's CURRENT record is its newest alive member (draft/scheduled/
--      live/pending_intake/in_inventory/unsold, or won with an un-refunded,
--      un-forfeited invoice claim). If the current record wears nothing and a
--      STALE member wears the label, move it. Dry-run on prod 2026-08-08:
--      exactly 14 moves, every one from canceled/won-refunded → the current
--      scheduled/live/won/unsold row; zero ambiguous trees touched (a tree
--      whose newest alive member already wears the label produces no row).
--
-- Display was already right (0304-era lotDisplayCode walks the lineage); what
-- this changes is OWNERSHIP: sticker scans now hit the current lot directly
-- instead of leaning on ranking, and sticker_code search matches the row that
-- is actually for sale.
--
-- Function body is 0296's verbatim except the new reclaim block (marked 0314)
-- and its two declarations.

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

  -- 0314: the label may be WORN BY A STALE RECORD OF THIS SAME BOX — usually
  -- the previous relist child that went unsold (that is what made 0213's
  -- claimed-elsewhere check bail). The box is one physical item; its label
  -- belongs on the lot that is about to be live. Find the newest wearer
  -- inside this item's lineage tree whose claim is stale and reclaim it.
  --
  -- Never reclaims across trees (that would be a different box), never from a
  -- lot that is draft/scheduled/live, and never from a 'won' row that still
  -- has an un-refunded, un-forfeited invoice claim (a customer is owed that
  -- box). 'won' with no invoice rows at all is treated as spoken for, not
  -- stale — invoicing can lag the close.
  IF v_src_sticker_code IS NULL THEN
    WITH RECURSIVE up AS (
      -- Climb from the source to its root. UNION (not ALL) so a lineage cycle
      -- in bad data terminates instead of looping.
      SELECT l.id, l.relisted_from_lot_id FROM lots l WHERE l.id = p_lot_id
      UNION
      SELECT l.id, l.relisted_from_lot_id
        FROM lots l JOIN up ON l.id = up.relisted_from_lot_id
    ), tree AS (
      -- Everyone descended from the root: the box's full history.
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
      -- Strip the stale wearer FIRST so the unique index accepts the handover
      -- to the new lot in STEP 2 below.
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

  -- 0314: keep the pre-printed pool's claim pointer on the row that WEARS the
  -- sticker. claimed_at was already right (the label is genuinely in use), but
  -- claimed_by_lot_id kept pointing at whichever ancestor first bound it — and
  -- clear_sticker_code (0300) releases the pool ONLY where claimed_by_lot_id
  -- matches the clearing lot, so a handed-over sticker could never be released
  -- from its current wearer. Applies to the plain 0192 handover and the
  -- reclaim path alike; no-op for labels that were never pool-printed.
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

REVOKE ALL ON FUNCTION public.relist_lot_into_auction(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.relist_lot_into_auction(UUID, UUID) TO authenticated;

COMMENT ON FUNCTION public.relist_lot_into_auction(UUID, UUID) IS
  '0314: 0296 behaviour plus label reclaim — when the source carries no '
  'sticker and none derives unclaimed, the label is reclaimed from the newest '
  'STALE wearer inside the same lineage tree (unsold/canceled/relisted/'
  'disposed, or won with every invoice claim refunded or forfeited) so the '
  'physical box''s code follows the lot that is actually for sale.';

-- ---------------------------------------------------------------------------
-- One-time backfill: apply the same rule to existing trees.
--
-- current  = newest ALIVE member of each lineage tree (the row that IS the box
--            today). unsold counts as alive here: with no newer sibling it is
--            the shelf record awaiting relist.
-- holder   = newest STALE wearer in the tree (same predicate as the function).
-- move     = only when the current record wears nothing and holder ≠ current.
--
-- Materialized first so the strip and the handover act on the identical set;
-- strip runs before handover to satisfy lots_sticker_code_unique_idx.
-- Idempotent: after the move the tree yields no further row.
-- ---------------------------------------------------------------------------

CREATE TEMP TABLE _label_moves ON COMMIT DROP AS
WITH RECURSIVE anc AS (
  SELECT id AS lot_id, id AS cur, relisted_from_lot_id AS parent, ARRAY[id] AS path
  FROM lots WHERE deleted_at IS NULL
  UNION ALL
  SELECT a.lot_id, l.id, l.relisted_from_lot_id, a.path || l.id
  FROM anc a JOIN lots l ON l.id = a.parent
  WHERE NOT l.id = ANY(a.path)
),
rooted AS (SELECT lot_id, cur AS root_id FROM anc WHERE parent IS NULL),
members AS (
  SELECT r.root_id, l.id, l.sticker_code, l.status, l.created_at,
    (l.status IN ('draft','scheduled','live','pending_intake','in_inventory','unsold')
     OR (l.status = 'won' AND EXISTS (
          SELECT 1 FROM invoice_lots il
           WHERE il.lot_id = l.id
             AND il.refunded_at IS NULL AND il.forfeited_at IS NULL))) AS alive
  FROM rooted r JOIN lots l ON l.id = r.lot_id
),
cur AS (
  SELECT DISTINCT ON (root_id) root_id, id
  FROM members WHERE alive ORDER BY root_id, created_at DESC
),
holder AS (
  SELECT DISTINCT ON (m.root_id) m.root_id, m.id, m.sticker_code
  FROM members m
  WHERE m.sticker_code IS NOT NULL
    AND (m.status IN ('unsold','canceled','relisted','disposed')
         OR (m.status = 'won'
             AND EXISTS (SELECT 1 FROM invoice_lots il WHERE il.lot_id = m.id)
             AND NOT EXISTS (
               SELECT 1 FROM invoice_lots il
                WHERE il.lot_id = m.id
                  AND il.refunded_at IS NULL AND il.forfeited_at IS NULL)))
  ORDER BY m.root_id, m.created_at DESC
)
SELECT h.id AS holder_id, c.id AS current_id, h.sticker_code AS label
FROM cur c
JOIN holder h ON h.root_id = c.root_id AND h.id <> c.id
JOIN lots cl ON cl.id = c.id AND cl.sticker_code IS NULL;

UPDATE lots h
   SET sticker_code = NULL, updated_at = now()
  FROM _label_moves m
 WHERE h.id = m.holder_id;

UPDATE lots c
   SET sticker_code = m.label, updated_at = now()
  FROM _label_moves m
 WHERE c.id = m.current_id;

-- Repoint any pool claim for a moved label at its new wearer (see the
-- function's 0314 block for why 0300 needs this).
UPDATE lot_sticker_pool p
   SET claimed_by_lot_id = m.current_id
  FROM _label_moves m
 WHERE p.sticker_code = m.label
   AND p.claimed_at IS NOT NULL;

COMMIT;
