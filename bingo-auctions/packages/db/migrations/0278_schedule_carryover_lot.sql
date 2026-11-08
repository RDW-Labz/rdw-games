-- 0278 — schedule_relisted_lot: builder-carryover lots go LIVE, not draft
--
-- Operator decision 2026-07-17: keep relisting unsold/unpicked-up inventory via
-- the auction builder's "Carry over" flow, but make those lots actually join
-- the auction as live lots instead of lingering as draft "ghosts" past the lot
-- count (which is what 0277 just cleaned up).
--
-- Why they ghosted: the builder carryover routes through
-- relist_lot_into_auction (0213 / guarded by 0275), which mints the new lot as
-- status='draft' with close_at = auction.ends_at. Draft lots are NOT promoted
-- when the auction publishes, so a carried-over lot never went live — it just
-- occupied a lot_number + close slot. The "available" assign path
-- (assign_lots_to_auction, 0208) instead lands lots as 'scheduled' with a
-- clamped, staggered close_at.
--
-- This RPC gives a carryover lot the SAME promotion the assign path gives, WITHOUT
-- recreating relist_lot_into_auction (so 0275's active-child / detach guards stay
-- intact). The builder calls it immediately after relisting each lot. Single-lot
-- relot (relot.tsx / worklist) does NOT call it, so its intentional
-- draft -> edit-photos -> publish flow is unchanged.
--
-- Promotion: draft relist-child in an editable (draft/scheduled) auction ->
--   status   = 'scheduled'
--   close_at = GREATEST(ends_at, now()) + stagger*(lot_number-1)
-- The GREATEST clamp is the 0208 fix: a stale/past ends_at can never yield a
-- past close_at that the finalize cron would kill before the window opens.
--
-- Safe + idempotent: no-ops unless the lot is a draft relist-child, in an
-- editable auction, owned by the caller's operator (admin/manager). A live/
-- closed auction is left alone (never inject a new lot into a running sale).

BEGIN;

CREATE OR REPLACE FUNCTION public.schedule_relisted_lot(p_lot_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller  UUID := auth.uid();
  v_op      UUID;
  v_role    operator_user_role;
  v_lot     lots%ROWTYPE;
  v_auction RECORD;
  v_stagger INT;
  v_close   TIMESTAMPTZ;
BEGIN
  IF v_caller IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_authenticated');
  END IF;

  SELECT operator_id, role INTO v_op, v_role
  FROM operator_users WHERE user_id = v_caller LIMIT 1;
  IF v_op IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'not_staff');
  END IF;
  IF v_role NOT IN ('admin', 'manager') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'admin_or_manager_required');
  END IF;

  SELECT * INTO v_lot FROM lots WHERE id = p_lot_id FOR UPDATE;
  IF v_lot.id IS NULL OR v_lot.operator_id IS DISTINCT FROM v_op THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'lot_not_found');
  END IF;

  -- Only promote a carryover draft that is actually sitting in an auction with a
  -- lot number. Anything else (already scheduled/live, not in an auction, no
  -- number) is deliberately left untouched — makes the call idempotent.
  IF v_lot.status <> 'draft' OR v_lot.auction_id IS NULL OR v_lot.lot_number IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'noop', true, 'status', v_lot.status);
  END IF;

  SELECT a.ends_at, a.close_stagger_seconds, a.status, a.operator_id
    INTO v_auction
  FROM auctions a WHERE a.id = v_lot.auction_id;
  IF v_auction.operator_id IS DISTINCT FROM v_op THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'cross_tenant');
  END IF;
  IF v_auction.status NOT IN ('draft', 'scheduled') THEN
    -- Auction already live/closed — do not inject a new lot into a running sale.
    RETURN jsonb_build_object('ok', true, 'noop', true, 'reason', 'auction_not_editable');
  END IF;

  v_stagger := COALESCE(v_auction.close_stagger_seconds, 0);
  v_close := GREATEST(v_auction.ends_at, now())
             + make_interval(secs => v_stagger * (v_lot.lot_number - 1));

  UPDATE lots
     SET status     = 'scheduled'::lot_status,
         close_at   = v_close,
         updated_at = now()
   WHERE id = p_lot_id;

  RETURN jsonb_build_object('ok', true, 'status', 'scheduled', 'close_at', v_close);
END;
$$;

REVOKE ALL ON FUNCTION public.schedule_relisted_lot(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.schedule_relisted_lot(UUID) TO authenticated;

COMMENT ON FUNCTION public.schedule_relisted_lot(UUID) IS
  '0278: promote a builder-carryover draft relist-child to scheduled with the '
  '0208-clamped staggered close_at, so carried-over lots go live with the auction '
  'instead of lingering as draft ghosts. Called by addInventoryToAuction right '
  'after relist_lot_into_auction; single-lot relot does not call it.';

COMMIT;
