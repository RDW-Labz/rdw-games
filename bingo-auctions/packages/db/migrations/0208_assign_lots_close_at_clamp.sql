-- ============================================================================
-- Migration 0208 — Clamp assign_lots_to_auction close_at to the future
--
-- Bug (recovered-draft auction, observed 2026-06-18 on "Test Auction.16"):
--
--   When an inventory item is attached to a recovered draft auction whose
--   window is still STALE-PAST (ends_at/starts_at not yet re-set by the
--   reschedule), assign_lots_to_auction stamped
--     v_close_at := v_ends_at + stagger*(lot_number-1)
--   off that stale past ends_at — so the new lot was born with close_at <= now().
--   The 5-second finalize cron then flipped it scheduled -> unsold ~2s later
--   (BEFORE the real window). redistribute_close_times (run by the subsequent
--   schedule edit) rewrote close_at to a future value but never resets status,
--   leaving the lot in an impossible state: status=unsold (terminal) +
--   close_at in the FUTURE. That renders as auction "Upcoming" / lot card
--   counting down / lot detail "Bidding has ended" / and the bidder app hides
--   it (status filter scheduled|live). mig 0207's finalize guard did NOT catch
--   this case because starts_at was ALSO stale-past at attach time, so the
--   `a.starts_at <= now()` guard passed.
--
-- Fix (the root cause):
--
--   Clamp the attach-time close_at so a stale (past) ends_at can never produce
--   a close_at in the past:
--     v_close_at := GREATEST(v_ends_at, now()) + stagger*(lot_number-1)
--   A lot is therefore never born already-past-close, so the finalize cron
--   cannot prematurely kill it; the subsequent publish/redistribute then sets
--   the correct windowed close_at. For a normal auction (future ends_at) this
--   is a no-op — GREATEST returns v_ends_at unchanged.
--
--   This is the ONLY change vs the live function (signature unchanged); the
--   auth checks, status checks, warehouse check, sequencing, and RETURN TABLE
--   shape are byte-for-byte the current prod body.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.assign_lots_to_auction(p_auction_id uuid, p_lot_ids uuid[])
 RETURNS TABLE(lot_id uuid, lot_code text, lot_number integer, close_at timestamp with time zone)
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

  -- Next sequential lot_number for this auction. Explicit table-qualified
  -- to avoid the OUT-parameter shadowing that 0060 fixes.
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

    -- mig 0208: clamp to the future so a stale (past) ends_at on a recovered
    -- draft can never produce a past close_at — which the finalize cron would
    -- otherwise kill before the real window opens. Normal auctions (future
    -- ends_at) are unchanged: GREATEST returns v_ends_at.
    v_close_at := GREATEST(v_ends_at, now())
                  + (make_interval(secs => v_stagger * (v_next_number - 1)));

    UPDATE lots
       SET auction_id = p_auction_id,
           lot_number = v_next_number,
           status     = 'scheduled',
           close_at   = v_close_at
     WHERE id = v_lot.id;

    -- Assign to OUT parameters. With #variable_conflict use_column the
    -- bare names below would resolve to columns — but inside a RETURN
    -- NEXT statement they're unambiguous as OUT parameters because
    -- there's no surrounding query. Still, use the explicit form to
    -- make intent obvious.
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
