-- ============================================================================
-- Migration 0129 — Finalize scheduled lots with zero bids at close_at
--
-- Problem (docs/audits/auction-build-and-bidder-deep-trace-2026-05-23.md,
-- HIGH severity issue #1):
--
--   The existing finalize_due_lots() (mig 0072) only scans status='live'.
--   A lot enters 'live' only via the first place_bid() call (mig 0111,
--   step 8: status = CASE WHEN status = 'scheduled' THEN 'live' ELSE status END).
--
--   Consequence: a lot that was scheduled but received ZERO bids will never
--   be flipped to 'live', so finalize_due_lots() never sees it even after
--   its close_at passes. advance_auction_lifecycle() (mig 0096) will not
--   close the parent auction because 'scheduled' is not a terminal state
--   (terminal = won | unsold | canceled | relisted). The auction hangs open
--   indefinitely unless an operator manually intervenes.
--
-- Fix approach — option (b) from the task spec:
--
--   A new SECURITY DEFINER function  finalize_scheduled_no_bid_lots()  handles
--   the narrow case: status='scheduled' AND close_at<=now() AND bid_count=0.
--   For each matching lot it flips status='unsold' and sets closed_at — the
--   exact same column set that finalize_lot() uses for zero-bid lots (see 0006).
--
--   finalize_due_lots() (also in this file, CREATE OR REPLACE) calls the new
--   function FIRST on each 5-second pg_cron tick, before its existing live-lot
--   loop. Both functions share the same advisory lock (7423940123), so no
--   separate cron schedule is needed.
--
-- Why bid_count=0 is the correct gate:
--
--   place_bid() is the ONLY writer of bids on a lot. Its step 8 atomically
--   increments bid_count AND flips status scheduled→live in the same UPDATE.
--   Because place_bid() holds pg_advisory_xact_lock(hashtext(lot_id)) for the
--   entire transaction (mig 0111 §A), no bid can exist on a scheduled lot
--   without that lot already being live. Therefore bid_count=0 on a scheduled
--   lot is a perfect proxy for "no bids ever placed". We guard the impossible
--   case (bid_count>0 AND status='scheduled') with a RAISE WARNING so any
--   future logic drift surfaces in Postgres logs.
--
-- Trigger safety:
--
--   • lots_check_auction_warehouse (mig 0101) — BEFORE UPDATE OF auction_id,
--     warehouse_id. Our UPDATE touches only (status, closed_at, updated_at);
--     the trigger will NOT fire.
--
--   • lots_status_history (mig 0098) — AFTER UPDATE OF status. WILL fire and
--     insert a clean scheduled→unsold row into lot_status_history. This is
--     the desired audit behaviour — no concern.
--
--   • bids_sync_lot_bid_count_ins/del (mig 0101) — fires on bids INSERT/DELETE
--     only. Not involved here.
--
-- Notifications:
--
--   finalize_lot() (mig 0006) does NOT emit a notification for the 'unsold'
--   branch (notification is only enqueued for 'won'). This function mirrors
--   that behaviour — no enqueue_notification() call for unsold lots.
--
-- Return value:
--   JSONB { "unsold": <int> } — count of lots advanced to unsold this tick.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- finalize_scheduled_no_bid_lots
--
-- Advances lots that are still 'scheduled' after close_at with zero bids
-- directly to 'unsold', unblocking advance_auction_lifecycle().
--
-- MUST be called from within finalize_due_lots() so the shared advisory lock
-- (7423940123) is already held. Do not schedule this as a standalone cron job.
-- ----------------------------------------------------------------------------
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
    SELECT id, bid_count
    FROM public.lots
    WHERE status = 'scheduled'
      AND close_at <= now()
      AND deleted_at IS NULL
    ORDER BY close_at
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  LOOP
    IF COALESCE(v_lot.bid_count, 0) = 0 THEN
      -- Normal path: no bids were ever placed. Flip to unsold.
      -- Mirror finalize_lot()'s unsold branch (mig 0006):
      --   UPDATE lots SET status='unsold', closed_at=now(), updated_at=now()
      -- The lots_status_history trigger (mig 0098) will capture scheduled→unsold
      -- in lot_status_history automatically.
      UPDATE public.lots
      SET
        status     = 'unsold',
        closed_at  = now(),
        updated_at = now()
      WHERE id = v_lot.id;

      v_unsold := v_unsold + 1;

    ELSE
      -- Impossible state: bid_count > 0 but status is still 'scheduled'.
      -- place_bid() always flips scheduled→live in the same atomic UPDATE that
      -- increments bid_count (mig 0111 §A serialises concurrent bids).
      -- If this fires, something bypassed place_bid() — surface it immediately.
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

-- ----------------------------------------------------------------------------
-- finalize_due_lots  (replaces mig 0072 version)
--
-- Unchanged semantics for the existing live-lot loop. The only addition is
-- the call to finalize_scheduled_no_bid_lots() at the top of the function
-- body, before the live-lot scan. The advisory lock covers both sub-operations.
--
-- Return value extended: adds "scheduled_unsold" key to the result object.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.finalize_due_lots(p_batch_size int DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lot_id          uuid;
  v_auction_id      uuid;
  v_result          finalize_lot_result;
  v_won_count       int := 0;
  v_total_count     int := 0;
  v_scheduled_result jsonb;
BEGIN
  -- Skip if another tick is already running. The next pg_cron firing
  -- (5s later) will pick up wherever this one would have started.
  IF NOT pg_try_advisory_xact_lock(7423940123) THEN
    RETURN jsonb_build_object('skipped', true);
  END IF;

  -- -------------------------------------------------------------------------
  -- Step 1: advance scheduled lots with zero bids past close_at → unsold.
  -- Must run FIRST so advance_auction_lifecycle() can close the parent
  -- auction on the very next 60s tick after the last lot clears.
  -- -------------------------------------------------------------------------
  SELECT public.finalize_scheduled_no_bid_lots(p_batch_size)
  INTO v_scheduled_result;

  -- -------------------------------------------------------------------------
  -- Step 2: existing live-lot finalization (UNCHANGED from mig 0072).
  -- -------------------------------------------------------------------------
  FOR v_lot_id IN
    SELECT id
    FROM public.lots
    WHERE status = 'live'
      AND close_at <= now()
    ORDER BY close_at
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  LOOP
    v_total_count := v_total_count + 1;

    SELECT * INTO v_result FROM public.finalize_lot(p_lot_id => v_lot_id);

    IF (v_result).ok AND (v_result).reason = 'won' THEN
      -- Get the auction id so we can debounce-enqueue the invoice build.
      SELECT auction_id INTO v_auction_id FROM public.lots WHERE id = v_lot_id;

      INSERT INTO public.build_invoice_jobs (auction_id, run_at)
      VALUES (v_auction_id, now() + interval '30 seconds')
      ON CONFLICT (auction_id) DO UPDATE
        SET run_at = GREATEST(public.build_invoice_jobs.run_at, EXCLUDED.run_at),
            attempt_count = 0,
            last_error = NULL;

      v_won_count := v_won_count + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'processed',          v_total_count,
    'won',                v_won_count,
    'scheduled_unsold',   (v_scheduled_result->>'unsold')::int
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.finalize_due_lots(int) FROM PUBLIC;
