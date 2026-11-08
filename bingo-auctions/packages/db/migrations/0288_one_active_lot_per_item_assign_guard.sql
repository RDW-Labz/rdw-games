-- 0288 — close the duplicate-listing hole in the ASSIGN path
--
-- Incident 2026-07-25: the new /reports/duplicates audit (0286) found SIX items
-- listed twice in active auctions — three with live bids on both copies. The
-- owner's reaction was "I thought we had fixed this last week." We had, but only
-- halfway, and this migration explains + fixes the other half.
--
-- ── What 0275 actually fixed ────────────────────────────────────────────────
-- relist_lot_into_auction refuses to relist a source that already has an active
-- child, and detaches the source when it does relist. That closes the
-- relist->relist duplicate. It is genuinely working: prod has ZERO sources with
-- more than one active child.
--
-- ── The half that was still open ───────────────────────────────────────────
-- assign_lots_to_auction (0060 → 0208) validates exactly three things per lot:
--     auction_id IS NULL
--     status = 'in_inventory'
--     warehouse matches the auction
-- It has NO notion of lineage, so it cannot see that the item is already listed
-- somewhere else. That gives a duplicate path with no relist involved:
--     1. Lot A is relisted -> child B created; A becomes 'relisted' + detached.
--     2. Staff pull A back to stock (pullLotToInventory allows
--        'unsold'/'relisted' -> 'in_inventory'; it only blocks on bids).
--        Migration 0277's ghost-detach did the same thing in bulk for ~74 lots.
--     3. A now appears in the auction builder's "Available" bucket and assigns
--        cleanly -> A and B are both live. Same physical item, two listings,
--        two winners, one box.
-- Verified against prod: every one of the six duplicate pairs is this shape
-- (a retired ancestor re-assigned alongside its still-active descendant, or two
-- siblings from pre-0275 relists), not a double-relist.
--
-- ── The invariant, enforced once ───────────────────────────────────────────
-- "One physical item = at most one lot a bidder can currently buy."
-- Items are identified by LINEAGE (relisted_from_lot_id chains), because every
-- carryover mints a brand-new lot_code for the same box. So the guard resolves
-- the lot's lineage root, walks the whole tree, and refuses if any OTHER member
-- is 'scheduled' or 'live'.
--
-- Only 'scheduled'/'live' block: those are the states where a bidder can place
-- money on it. A long-since-'won' ancestor that was refunded and restocked must
-- still be re-listable, and 'unsold'/'relisted'/'canceled'/'disposed' ancestors
-- are inert by definition.
--
-- Two small helpers are added rather than inlining a recursive CTE per lot, so
-- the cost is one upward walk + one downward walk per assigned lot instead of a
-- scan over every active lot.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. lot_lineage_root — walk UP relisted_from_lot_id to the original lot
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lot_lineage_root(p_lot_id UUID)
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH RECURSIVE up AS (
    SELECT l.id, l.relisted_from_lot_id
    FROM lots l WHERE l.id = p_lot_id
    UNION ALL
    SELECT p.id, p.relisted_from_lot_id
    FROM up JOIN lots p ON p.id = up.relisted_from_lot_id
  )
  SELECT id FROM up WHERE relisted_from_lot_id IS NULL LIMIT 1;
$$;

COMMENT ON FUNCTION public.lot_lineage_root(UUID) IS
  '0288: the original (root) lot of a relist chain — walks relisted_from_lot_id '
  'upward. Every carryover mints a new lot_code for the SAME physical item, so '
  'the root is how we identify "the item" rather than "the listing".';

-- ---------------------------------------------------------------------------
-- 2. lot_lineage_members — the whole tree (root + all descendants)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lot_lineage_members(p_root_id UUID)
RETURNS TABLE (lot_id UUID)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH RECURSIVE down AS (
    SELECT l.id FROM lots l WHERE l.id = p_root_id
    UNION ALL
    SELECT c.id FROM lots c JOIN down ON c.relisted_from_lot_id = down.id
  )
  SELECT id FROM down;
$$;

COMMENT ON FUNCTION public.lot_lineage_members(UUID) IS
  '0288: every lot descended from a lineage root (inclusive) — all listings '
  'that have ever represented one physical item.';

-- ---------------------------------------------------------------------------
-- 3. assign_lots_to_auction — same as 0208 plus the one-active-lot guard
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.assign_lots_to_auction(
  p_auction_id UUID,
  p_lot_ids UUID[]
)
RETURNS TABLE(lot_id UUID, lot_code TEXT, lot_number INTEGER, close_at TIMESTAMPTZ)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE
  v_caller       UUID := auth.uid();
  v_operator_id  UUID;
  v_role         operator_user_role;
  v_auction      RECORD;
  v_stagger      INTEGER;
  v_ends_at      TIMESTAMPTZ;
  v_next_number  INTEGER;
  v_lot          RECORD;
  v_close_at     TIMESTAMPTZ;
  -- 0288: conflicting active listing for the same physical item, if any.
  v_dup_code     TEXT;
BEGIN
  IF v_caller IS NULL THEN
    RAISE EXCEPTION 'not_authenticated' USING ERRCODE = '28000';
  END IF;

  SELECT operator_id, role INTO v_operator_id, v_role
  FROM operator_users WHERE user_id = v_caller LIMIT 1;
  IF v_operator_id IS NULL THEN
    RAISE EXCEPTION 'not_staff' USING ERRCODE = '42501';
  END IF;
  IF v_role NOT IN ('admin', 'manager') THEN
    RAISE EXCEPTION 'admin_or_manager_required' USING ERRCODE = '42501';
  END IF;

  -- Auction must belong to the operator and accept new lots.
  SELECT a.id, a.ends_at, a.warehouse_id, a.status, a.close_stagger_seconds
    INTO v_auction
  FROM auctions a
  WHERE a.id = p_auction_id AND a.operator_id = v_operator_id
  FOR UPDATE;

  IF v_auction.id IS NULL THEN
    RAISE EXCEPTION 'auction_not_found' USING ERRCODE = '02000';
  END IF;
  IF v_auction.status NOT IN ('draft', 'scheduled') THEN
    RAISE EXCEPTION 'auction_not_editable_status:%', v_auction.status
      USING ERRCODE = '42501';
  END IF;

  v_stagger := COALESCE(v_auction.close_stagger_seconds, 0);
  v_ends_at := v_auction.ends_at;

  SELECT COALESCE(MAX(l.lot_number), 0) + 1 INTO v_next_number
  FROM lots l WHERE l.auction_id = p_auction_id;

  FOR v_lot IN
    SELECT l.id, l.lot_code, l.status, l.warehouse_id, l.auction_id
    FROM lots l
    WHERE l.id = ANY(p_lot_ids)
      AND l.operator_id = v_operator_id
    ORDER BY l.id
    FOR UPDATE
  LOOP
    IF v_lot.auction_id IS NOT NULL THEN
      RAISE EXCEPTION 'lot_already_in_auction:%', v_lot.lot_code
        USING ERRCODE = '42501';
    END IF;
    IF v_lot.status <> 'in_inventory' THEN
      RAISE EXCEPTION 'lot_not_in_inventory:%:%', v_lot.lot_code, v_lot.status
        USING ERRCODE = '42501';
    END IF;
    IF v_auction.warehouse_id IS NOT NULL
       AND v_lot.warehouse_id <> v_auction.warehouse_id THEN
      RAISE EXCEPTION 'lot_wrong_warehouse:%', v_lot.lot_code
        USING ERRCODE = '42501';
    END IF;

    -- 0288: ONE PHYSICAL ITEM = ONE BUYABLE LOT. The three checks above are all
    -- about THIS row; none of them can see that the same box is already on sale
    -- under a different lot_code further along its relist chain. Resolve the
    -- lineage root, walk the whole tree, and refuse if a sibling/ancestor/
    -- descendant is currently scheduled or live.
    SELECT other.lot_code INTO v_dup_code
      FROM lots other
     WHERE other.id IN (
             SELECT m.lot_id FROM lot_lineage_members(lot_lineage_root(v_lot.id)) m
           )
       AND other.id <> v_lot.id
       AND other.deleted_at IS NULL
       AND other.canceled_at IS NULL
       AND other.status::text IN ('scheduled', 'live')
     LIMIT 1;
    IF v_dup_code IS NOT NULL THEN
      RAISE EXCEPTION 'lot_item_already_listed:%:%', v_lot.lot_code, v_dup_code
        USING ERRCODE = 'P0001';
    END IF;

    -- mig 0208: clamp to the future so a stale (past) ends_at on a recovered
    -- draft can never produce a past close_at.
    v_close_at := GREATEST(v_ends_at, now())
                  + (make_interval(secs => v_stagger * (v_next_number - 1)));

    UPDATE lots
       SET auction_id = p_auction_id,
           lot_number = v_next_number,
           status     = 'scheduled',
           close_at   = v_close_at
     WHERE id = v_lot.id;

    lot_id     := v_lot.id;
    lot_code   := v_lot.lot_code;
    lot_number := v_next_number;
    close_at   := v_close_at;
    RETURN NEXT;

    v_next_number := v_next_number + 1;
  END LOOP;

  RETURN;
END;
$function$;

REVOKE ALL ON FUNCTION public.assign_lots_to_auction(UUID, UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assign_lots_to_auction(UUID, UUID[]) TO authenticated;

COMMENT ON FUNCTION public.assign_lots_to_auction(UUID, UUID[]) IS
  '0288: 0208 behaviour plus the one-active-lot-per-physical-item guard. Raises '
  'lot_item_already_listed:<lot>:<other> when another member of the lot''s '
  'relist lineage is already scheduled/live — the duplicate path that 0275''s '
  'relist-side guard could not see (retired ancestor pulled back to stock and '
  're-assigned).';

COMMIT;
