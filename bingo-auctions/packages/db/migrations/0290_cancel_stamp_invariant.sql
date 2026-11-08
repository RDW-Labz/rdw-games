-- ============================================================================
-- Migration 0290 — fix the `canceled_at` overload that kept minting duplicates
--
-- Answers the operator question "those 44 lots, are they duplicates that need
-- gone?" — MOSTLY NO. Verified on prod 2026-07-27: there are 46 (not 44; two
-- more surfaced after 0288), and 43 of them are the SOLE listing for an item we
-- still physically own. Cancelling all 46 would have destroyed 43 real sellable
-- lots. Exactly 3 are true phantoms — see section 2.
--
-- ROOT CAUSE (proven, not theorized) --------------------------------------
--
-- `lots.canceled_at` is OVERLOADED. Two migrations disagree on its meaning:
--
--   • 0199 `cancel_auction()` writes `canceled_at = now()` as an AUDIT
--     BREADCRUMB — "this lot passed through a canceled auction" — while setting
--     `status = 'in_inventory'`. Its own header says the stamp is "preserved for
--     audit". The lot is good stock and returns to the available pool.
--
--   • 0275 `relist_lot_into_auction()` D1, 0276's unique index, 0288's assign
--     guard, and the builder's carryover filter ALL read `canceled_at IS NULL`
--     as a LIVENESS FLAG — "this child is dead, the parent may be relisted."
--
-- So the breadcrumb reads as a death certificate. The chain, confirmed by an
-- exact timestamp match on prod:
--
--   1. "Jackpot Auction" (4b54663a-…) cancelled 2026-07-15 13:50:44.593232+00.
--   2. `cancel_auction()` returned its 46 lots to inventory, stamping
--      `canceled_at` with that timestamp — byte-identical on all 46 lot rows.
--   3. Staff re-assigned those lots to a new auction. `assign_lots_to_auction`
--      set `status='scheduled'` but never cleared the stale stamp.
--   4. Result: 46 ACTIVE listings each carrying a cancel stamp — invisible to
--      every guard that keys on `canceled_at`.
--
-- That is why the duplicate bug "we fixed last week" was not fixed. 0275 shut
-- the front door; 0199 propped open a window. 9 of the 46 have a parent still
-- sitting at `in_inventory` — an accepted relist source — so D1 sees no active
-- child and ALLOWS another carryover, minting a second live lot for an item
-- that already has one.
--
-- THE INDEX WAS WRONG IN BOTH DIRECTIONS ----------------------------------
--
-- 0276's `lots_one_active_relist_child` is UNIQUE(relisted_from_lot_id) WHERE
-- canceled_at IS NULL AND deleted_at IS NULL. Keying on canceled_at makes it:
--   • too WEAK — a stale-stamped active child drops out of the index, so the
--     real duplicate it is supposed to prevent sails through; and
--   • too STRONG — a `won` or `unsold` sibling stays in the index forever, so a
--     refunded / never-collected / no-show item can never be legitimately
--     re-listed. 8 of the 46 are exactly this case.
-- Section 4 re-keys it on status, which is what "one ACTIVE listing per item"
-- actually means and what D1 / 0288 / the builder all intend.
--
-- Deliberately NOT touched:
--   • The 29 `in_inventory` lots carrying a stamp — 0199 working as designed.
--     They are not active, so no guard misreads them, and the breadcrumb is
--     real audit history.
--   • The 53 lots at `status='canceled'` with `canceled_at IS NULL` (pre-0199
--     0096 behaviour). Canceled by status, every guard agrees, and back-filling
--     a timestamp would be inventing audit history.
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Cancel the 3 TRUE phantoms — items that physically left the building.
--
-- These have a sibling listing that was won, PAID, and PICKED UP, with no
-- refund on the line. One physical item, one lineage: if a buyer paid and
-- collected it, we do not own it any more and must not be taking bids on it.
--
--   BIN-002568  sibling BIN-002248 collected 2026-07-22  (1 live bid, $1.00)
--   BIN-002581  sibling BIN-002239 collected 2026-07-22  (3 live bids, $3.00)
--   BIN-002628  sibling BIN-002244 collected 2026-07-21  (0 bids)
--
-- 4 live bids totalling $4.00 of current-bid exposure are voided. That is the
-- correct trade: the alternative is selling an item we cannot deliver, which
-- costs a refund plus a customer. Bid rows are left in place as audit trail —
-- `place_bid` refuses non-scheduled/live lots, so no new bids can land.
--
-- Scoped by the predicate, not by hard-coded ids, so this is self-verifying:
-- if the data has moved on, it simply matches fewer rows.
-- ---------------------------------------------------------------------------
UPDATE lots s
   SET status      = 'canceled',
       auction_id  = NULL,
       lot_number  = NULL,
       close_at    = NULL,
       canceled_at = now(),
       updated_at  = now()
 WHERE s.deleted_at IS NULL
   AND s.canceled_at IS NOT NULL
   AND s.status IN ('draft', 'scheduled', 'live')
   AND EXISTS (
     SELECT 1
       FROM lots sib
       JOIN invoice_lots il ON il.lot_id = sib.id
      WHERE sib.relisted_from_lot_id = s.relisted_from_lot_id
        AND sib.id <> s.id
        AND sib.deleted_at IS NULL
        AND sib.canceled_at IS NULL
        AND il.picked_up_at IS NOT NULL   -- buyer physically took it
        AND il.refunded_at  IS NULL       -- and it was never refunded/returned
   );

-- ---------------------------------------------------------------------------
-- 2. Re-key the one-active-child index onto status (see header).
--
-- Verified creatable: 0 parents currently have >1 child in draft/scheduled/live.
-- 'draft' is included because `relist_lot_into_auction` inserts its new child
-- as 'draft' — omitting it would let a second draft child slip in.
--
-- Plain (non-CONCURRENT) index build: 10,274 lots / 1,350 relist children, so
-- the exclusive lock is sub-second, and CONCURRENTLY cannot run in a
-- transaction — we want this atomic with the data repair below.
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS lots_one_active_relist_child;

CREATE UNIQUE INDEX lots_one_active_relist_child
  ON public.lots (relisted_from_lot_id)
  WHERE relisted_from_lot_id IS NOT NULL
    AND deleted_at IS NULL
    AND status IN ('draft', 'scheduled', 'live');

COMMENT ON INDEX public.lots_one_active_relist_child IS
  '0290 (was 0276): one ACTIVE listing per physical item. Keyed on status, not '
  'canceled_at — cancel_auction() stamps canceled_at as an audit breadcrumb on '
  'lots it returns to inventory, so canceled_at is not a liveness signal.';

-- ---------------------------------------------------------------------------
-- 3. Clear the stale stamp on the 43 remaining active lots.
--
-- Safe only after section 2: under the OLD canceled_at-keyed index these rows
-- would collide with a `won`/`relisted`/`unsold` sibling and abort the
-- migration on a unique violation (11 such collisions existed on prod).
-- ---------------------------------------------------------------------------
UPDATE lots
   SET canceled_at = NULL,
       canceled_by = NULL,
       updated_at  = now()
 WHERE deleted_at IS NULL
   AND canceled_at IS NOT NULL
   AND status IN ('draft', 'scheduled', 'live');

-- ---------------------------------------------------------------------------
-- 4. The invariant, enforced going forward.
--
-- An ACTIVE lot never carries a cancel stamp. This is what stops section 3
-- from being needed again, and it makes every existing canceled_at-keyed guard
-- correct as written — no edits to D1 (0285) or the assign guard (0288).
--
-- It cannot undo a real cancel: the only two routines that stamp canceled_at
-- are `admin_cancel_lot` (sets status='canceled') and `cancel_auction` (sets
-- status='in_inventory'). Neither is an active status, so neither is touched —
-- and 0199's audit breadcrumb still survives for as long as the lot sits in
-- inventory. It is cleared only when the lot becomes a listing again, at which
-- point it is no longer "a lot that passed through a canceled auction".
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.lots_clear_cancel_stamp_on_activate()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'public'
AS $function$
BEGIN
  IF NEW.status IN ('draft', 'scheduled', 'live') THEN
    NEW.canceled_at := NULL;
    NEW.canceled_by := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS lots_clear_cancel_stamp_on_activate ON public.lots;
CREATE TRIGGER lots_clear_cancel_stamp_on_activate
  BEFORE INSERT OR UPDATE OF status, canceled_at, canceled_by ON public.lots
  FOR EACH ROW EXECUTE FUNCTION public.lots_clear_cancel_stamp_on_activate();

-- ---------------------------------------------------------------------------
-- 5. Repair the 9 parents that section 3 just re-blocked, so they carry the
--    CORRECT tombstone status instead of merely being blocked by a guard.
--
-- `relist_lot_into_auction` leaves a carried-over source at status='relisted'
-- (0192 STEP 1 / 0275 D2). These were rolled back to 'in_inventory' by
-- `cancel_auction()` even though their carryover child survived, so they looked
-- like fresh available stock to anything walking inventory by status — not just
-- to the relist guard.
--
-- Scoped to parents that DO still have a surviving active child, so a
-- genuinely re-listable source (children all really gone) is left alone.
-- ---------------------------------------------------------------------------
UPDATE lots p
   SET status     = 'relisted',
       updated_at = now()
 WHERE p.deleted_at IS NULL
   AND p.status IN ('in_inventory', 'unsold')
   AND EXISTS (
     SELECT 1 FROM lots c
      WHERE c.relisted_from_lot_id = p.id
        AND c.deleted_at IS NULL
        AND c.status IN ('draft', 'scheduled', 'live')
   );

-- ---------------------------------------------------------------------------
-- 6. Detach tombstone parents still holding an auction slot.
--
-- 0275 D2 detaches a source on relist, but these predate it (or were
-- re-attached by the cancel/reassign churn). A tombstone parent still carrying
-- auction_id/lot_number/close_at is the publicly-visible ghost listing from
-- Jared's note — the same item appearing twice in one auction.
-- ---------------------------------------------------------------------------
UPDATE lots p
   SET auction_id = NULL,
       lot_number = NULL,
       close_at   = NULL,
       updated_at = now()
 WHERE p.deleted_at IS NULL
   AND p.auction_id IS NOT NULL
   AND p.status IN ('relisted', 'canceled')
   AND EXISTS (
     SELECT 1 FROM lots c
      WHERE c.relisted_from_lot_id = p.id
        AND c.deleted_at IS NULL
        AND c.status IN ('draft', 'scheduled', 'live')
   );

-- ---------------------------------------------------------------------------
-- 7. Extend duplicate_lot_audit() (0286) with the drift classes repaired above,
--    so a recurrence is VISIBLE instead of silent.
--
-- The 46 rows sat on prod for 12 days and no report showed them. The audit had
-- four checks and none covered "active lot carrying a cancel stamp" — the very
-- state that defeats the other four.
--
-- Also hardens check A, which filtered children on `canceled_at IS NULL` and so
-- was blind to a stale-stamped active child for the same reason D1 was.
--
-- Checks A–D are otherwise reproduced verbatim from 0286.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.duplicate_lot_audit()
RETURNS TABLE (
  kind      TEXT,
  key_value TEXT,
  n         INT,
  lot_codes TEXT[],
  lot_ids   UUID[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
-- Prefer columns over the OUT params (kind/key_value/n/…) on bare references.
#variable_conflict use_column
DECLARE
  v_caller UUID := auth.uid();
  v_op     UUID;
BEGIN
  IF v_caller IS NULL THEN RETURN; END IF;
  SELECT operator_id INTO v_op FROM operator_users WHERE user_id = v_caller LIMIT 1;
  IF v_op IS NULL THEN RETURN; END IF;

  RETURN QUERY
  WITH RECURSIVE
  active_walk AS (
    -- Every active (scheduled/live) lot, walked up to its lineage root.
    SELECT l.id AS active_id, l.id AS cur, l.relisted_from_lot_id AS parent_id
    FROM lots l
    WHERE l.operator_id = v_op
      AND l.deleted_at IS NULL
      AND l.status IN ('scheduled', 'live')
    UNION ALL
    SELECT aw.active_id, p.id, p.relisted_from_lot_id
    FROM active_walk aw JOIN lots p ON p.id = aw.parent_id
  ),
  active_roots AS (
    SELECT active_id, cur AS root_id FROM active_walk WHERE parent_id IS NULL
  )
  -- A) source with >1 active child
  SELECT
    'multi_active_child'::TEXT,
    s.lot_code,
    COUNT(*)::INT,
    array_agg(c.lot_code || ' [' || c.status::TEXT || ']' ORDER BY c.created_at),
    array_agg(c.id ORDER BY c.created_at)
  FROM lots c
  JOIN lots s ON s.id = c.relisted_from_lot_id
  WHERE c.operator_id = v_op
    -- 0290: status is authoritative for liveness; canceled_at may be a stale
    -- 0199 audit breadcrumb rather than a death certificate.
    AND (c.canceled_at IS NULL OR c.status IN ('draft', 'scheduled', 'live'))
    AND c.deleted_at IS NULL
  GROUP BY s.id, s.lot_code
  HAVING COUNT(*) > 1

  UNION ALL
  -- B) duplicate sticker_code
  SELECT
    'dup_sticker'::TEXT,
    l.sticker_code,
    COUNT(*)::INT,
    array_agg(l.lot_code || ' [' || l.status::TEXT || ']' ORDER BY l.created_at),
    array_agg(l.id ORDER BY l.created_at)
  FROM lots l
  WHERE l.operator_id = v_op
    AND l.deleted_at IS NULL
    AND l.sticker_code IS NOT NULL
  GROUP BY l.sticker_code
  HAVING COUNT(*) > 1

  UNION ALL
  -- C) duplicate qr_token
  SELECT
    'dup_qr'::TEXT,
    l.qr_token::TEXT,
    COUNT(*)::INT,
    array_agg(l.lot_code || ' [' || l.status::TEXT || ']' ORDER BY l.created_at),
    array_agg(l.id ORDER BY l.created_at)
  FROM lots l
  WHERE l.operator_id = v_op
    AND l.deleted_at IS NULL
    AND l.qr_token IS NOT NULL
  GROUP BY l.qr_token
  HAVING COUNT(*) > 1

  UNION ALL
  -- D) same lineage root with >1 active listing
  SELECT
    'same_root_active'::TEXT,
    root.lot_code,
    COUNT(*)::INT,
    array_agg(act.lot_code || ' [' || act.status::TEXT || ']' ORDER BY act.created_at),
    array_agg(act.id ORDER BY act.created_at)
  FROM active_roots ar
  JOIN lots act  ON act.id = ar.active_id
  JOIN lots root ON root.id = ar.root_id
  GROUP BY root.id, root.lot_code
  HAVING COUNT(*) > 1

  UNION ALL
  -- E) 0290: active lot carrying a cancel stamp. The section-4 trigger makes
  -- this unreachable, so any row here means the trigger was dropped or
  -- bypassed — and every canceled_at-keyed guard is blind again.
  SELECT
    'stale_cancel_stamp'::TEXT,
    to_char(l.canceled_at, 'YYYY-MM-DD HH24:MI:SS'),
    COUNT(*)::INT,
    array_agg(l.lot_code || ' [' || l.status::TEXT || ']' ORDER BY l.lot_code),
    array_agg(l.id ORDER BY l.lot_code)
  FROM lots l
  WHERE l.operator_id = v_op
    AND l.deleted_at IS NULL
    AND l.canceled_at IS NOT NULL
    AND l.status IN ('draft', 'scheduled', 'live')
  GROUP BY l.canceled_at

  UNION ALL
  -- F) 0290: active listing for an item a buyer already paid for AND collected.
  -- This is the phantom class section 1 cleaned: we are taking bids on stock we
  -- physically handed over. Highest-severity row this audit can emit.
  SELECT
    'sold_and_collected_still_live'::TEXT,
    sib.lot_code,
    COUNT(*)::INT,
    array_agg(s.lot_code || ' [' || s.status::TEXT || ']' ORDER BY s.lot_code),
    array_agg(s.id ORDER BY s.lot_code)
  FROM lots s
  JOIN lots sib ON sib.relisted_from_lot_id = s.relisted_from_lot_id
                AND sib.id <> s.id
                AND sib.deleted_at IS NULL
  JOIN invoice_lots il ON il.lot_id = sib.id
                       AND il.picked_up_at IS NOT NULL
                       AND il.refunded_at IS NULL
  WHERE s.operator_id = v_op
    AND s.deleted_at IS NULL
    AND s.status IN ('draft', 'scheduled', 'live')
  GROUP BY sib.id, sib.lot_code

  UNION ALL
  -- G) 0290: tombstone parent still holding an auction slot while its child is
  -- live — the "same item twice in one auction" ghost from Jared's note.
  SELECT
    'ghost_parent_on_auction'::TEXT,
    p.lot_code,
    COUNT(*)::INT,
    array_agg(c.lot_code || ' [' || c.status::TEXT || ']' ORDER BY c.created_at),
    array_agg(p.id ORDER BY c.created_at)
  FROM lots p
  JOIN lots c ON c.relisted_from_lot_id = p.id
  WHERE p.operator_id = v_op
    AND p.deleted_at IS NULL
    AND p.auction_id IS NOT NULL
    AND c.deleted_at IS NULL
    AND c.status IN ('draft', 'scheduled', 'live')
  GROUP BY p.id, p.lot_code;
END;
$$;

COMMENT ON FUNCTION public.duplicate_lot_audit() IS
  '0290: operator-scoped duplicate/ghost inventory audit. Seven checks — sources '
  'with >1 active child, duplicate sticker_code, duplicate qr_token, one lineage '
  'root with >1 active listing, active lots carrying a stale cancel stamp, '
  'active listings for items already paid for and collected, and tombstone '
  'parents still attached to an auction. Read-only.';

COMMIT;
