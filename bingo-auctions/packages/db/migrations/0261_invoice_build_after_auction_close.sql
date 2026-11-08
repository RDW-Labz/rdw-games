-- 0261 — build invoices only after the auction has FULLY closed.
--
-- INCIDENT (2026-07-13, launch week): customer Alexa Ruimy saw a won lot as
-- "UNPAID · PENDING" in the app; a platform sweep found 4 lots (grand-opening
-- ×3, Bid Bid BinGo ×1) that were WON but never attached to any invoice —
-- their winners were never charged.
--
-- ROOT CAUSE (verified against prod):
--   finalize_due_lots (0072) enqueued a per-auction build_invoice_job 30s after
--   EACH won lot. During a lull mid-auction that debounced job fired and
--   build_invoices_for_auction created a bidder's invoice from the lots won SO
--   FAR — a *partial* invoice. Eager bidders paid it within ~1 minute. Then
--   more of that bidder's lots finished closing; the next build re-ran, but
--   build_invoices_for_auction only rebuilds invoice_lots while the invoice is
--   'pending' (0233) and invoices are UNIQUE (auction_id, bidder_id) — so the
--   now-PAID invoice was frozen and the later lots were silently dropped
--   forever, with no sweeper to catch them. Confirmed: for all 4 orphans the
--   invoice was created BEFORE the lot closed and PAID before the final build.
--
-- FIX (this migration):
--   Only enqueue the invoice build once the auction has NO lots still 'live'
--   (i.e. fully closed). An invoice is therefore never partial, so there is
--   nothing incomplete for a bidder to pay early, and every winning lot is on
--   the invoice by the time it can be paid. Enqueue on ANY finalize outcome
--   (not just 'won') so an auction whose LAST lot is unsold still triggers the
--   build for its earlier wins. build_invoices_for_auction itself is unchanged.
--
--   Behavior change: invoices (and auto-charge-at-close) now appear a short
--   time after the auction fully closes rather than mid-auction. For BinGo's
--   staggered soft-close auctions that is a difference of a couple minutes and
--   matches the auto-charge-at-close model.
--
-- This does NOT repair the 4 pre-existing orphans (handled operationally).

BEGIN;

CREATE OR REPLACE FUNCTION public.finalize_due_lots(p_batch_size int DEFAULT 50)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_lot_id uuid;
  v_auction_id uuid;
  v_result finalize_lot_result;
  v_won_count int := 0;
  v_total_count int := 0;
BEGIN
  -- Skip if another tick is already running. The next pg_cron firing
  -- (5s later) will pick up wherever this one would have started.
  IF NOT pg_try_advisory_xact_lock(7423940123) THEN
    RETURN jsonb_build_object('skipped', true);
  END IF;

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

    SELECT auction_id INTO v_auction_id FROM public.lots WHERE id = v_lot_id;

    IF (v_result).ok AND (v_result).reason = 'won' THEN
      v_won_count := v_won_count + 1;
    END IF;

    -- Enqueue the (debounced) invoice build ONLY once this lot's auction has
    -- no lots still live — i.e. the auction has fully closed. Building
    -- mid-auction created partial invoices that a fast-paying bidder could pay
    -- before their later lots closed, permanently orphaning those lots
    -- (0261 incident). Gating to auction-close guarantees complete invoices.
    --
    -- Enqueue regardless of THIS lot's outcome ('won'/'unsold'/'sold') so an
    -- auction whose last lot is unsold still triggers the build for its earlier
    -- winning lots. build_invoices_for_auction is a no-op when there are no
    -- winners, so an all-unsold auction enqueues harmlessly.
    IF v_auction_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.lots
      WHERE auction_id = v_auction_id AND status = 'live'
    ) THEN
      INSERT INTO public.build_invoice_jobs (auction_id, run_at)
      VALUES (v_auction_id, now() + interval '30 seconds')
      ON CONFLICT (auction_id) DO UPDATE
        SET run_at = GREATEST(public.build_invoice_jobs.run_at, EXCLUDED.run_at),
            attempt_count = 0,
            last_error = NULL;
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'processed', v_total_count,
    'won', v_won_count
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.finalize_due_lots(int) FROM PUBLIC;

COMMIT;
