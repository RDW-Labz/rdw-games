-- ============================================================================
-- Migration 0207 — Don't finalize scheduled lots before their auction starts
--
-- Bug (draft-auction recovery, observed 2026-06-17 on auction d329243a):
--
--   During a draft-auction repair, assign_lots_to_auction (mig 0060) stamps
--   close_at = ends_at + stagger*(lot_number-1) using the auction's CURRENT
--   (still-stale, in-the-past) ends_at at attach time. A lot attached in that
--   window is born with close_at <= now(). The 5-second cron
--   finalize_scheduled_no_bid_lots() (mig 0129) then flips it straight to
--   terminal 'unsold' BEFORE the auction window even opens — lot_status_history
--   shows scheduled -> unsold ~48 minutes before the auction's starts_at.
--   redistribute_close_times() (mig 0053) runs moments later but only rewrites
--   close_at, never status, so the lot is stuck terminal with a future
--   close_at: the storefront renders it "Closed" (heatFromCloseAt) and the
--   bidder app excludes it (status NOT IN scheduled/live). New lots attached
--   AFTER the window was fixed are unaffected, which is why "original" lots
--   looked dead while freshly-added lots stayed biddable.
--
-- Fix:
--
--   finalize_scheduled_no_bid_lots() must NOT finalize a scheduled lot whose
--   parent auction has not started yet (starts_at > now(), or NULL). A
--   scheduled lot in an auction that hasn't opened can never be a legitimate
--   zero-bid close. This mirrors the auction-started guard open_due_lots()
--   already applies (mig 0125). Once the auction starts — by which point
--   redistribute/editAuction has set correct close_at values — the lot
--   finalizes normally at its real close_at. No lot is left hanging: the
--   auction WILL start, then the existing path closes it.
--
--   Only the SELECT predicate changes vs mig 0129 (added: JOIN auctions +
--   `a.starts_at <= now()`, and FOR UPDATE OF l so we lock only lots).
--   Per-lot handling, the bid_count guard, the impossible-state WARNING, and
--   finalize_due_lots() (which calls this) are all UNCHANGED.
--
-- Trigger / lock safety: identical to mig 0129 — caller finalize_due_lots()
-- holds advisory lock 7423940123; UPDATE touches only (status, closed_at,
-- updated_at) so lots_check_auction_warehouse does not fire; lots_status_history
-- captures scheduled->unsold as before.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.finalize_scheduled_no_bid_lots(p_batch_size int DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lot       RECORD;
  v_unsold    int := 0;
BEGIN
  -- NOTE: caller (finalize_due_lots) already holds the advisory lock
  -- 7423940123 for this transaction. We must NOT re-acquire it here.

  FOR v_lot IN
    SELECT l.id, l.bid_count
    FROM public.lots l
    JOIN public.auctions a ON a.id = l.auction_id
    WHERE l.status = 'scheduled'
      AND l.close_at <= now()
      AND l.deleted_at IS NULL
      -- GUARD (mig 0207): never finalize a lot whose auction hasn't started.
      -- Closes the draft-recovery race where a lot is attached with a stale
      -- past close_at and would otherwise be killed before the window opens.
      AND a.starts_at <= now()
    ORDER BY l.close_at
    LIMIT p_batch_size
    FOR UPDATE OF l SKIP LOCKED
  LOOP
    IF COALESCE(v_lot.bid_count, 0) = 0 THEN
      -- Normal path: no bids were ever placed. Flip to unsold.
      -- Mirror finalize_lot()'s unsold branch (mig 0006). The
      -- lots_status_history trigger (mig 0098) captures scheduled->unsold.
      UPDATE public.lots
      SET
        status     = 'unsold',
        closed_at  = now(),
        updated_at = now()
      WHERE id = v_lot.id;

      v_unsold := v_unsold + 1;

    ELSE
      -- Impossible state: bid_count > 0 but status is still 'scheduled'.
      -- place_bid() always flips scheduled->live in the same atomic UPDATE
      -- that increments bid_count (mig 0111 §A). If this fires, something
      -- bypassed place_bid() — surface it immediately.
      RAISE WARNING
        'finalize_scheduled_no_bid_lots: lot % has status=scheduled but bid_count=%; '
        'expected 0. place_bid() should have flipped to live. Skipping — investigate.',
        v_lot.id, v_lot.bid_count;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('unsold', v_unsold);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.finalize_scheduled_no_bid_lots(int) FROM PUBLIC;
