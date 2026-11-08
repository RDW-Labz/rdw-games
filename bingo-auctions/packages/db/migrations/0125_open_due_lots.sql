-- ============================================================================
-- 0125_open_due_lots.sql
--
-- Launch-blocker bug discovered 2026-05-23: the auction engine has a missing
-- transition. `advance_auction_lifecycle` promotes auctions scheduled → live
-- ONLY when a child lot is ALREADY live, but NO function existed to promote
-- lots scheduled → live when their parent auction's starts_at arrives.
-- Result: every scheduled auction sat in `scheduled` forever until an
-- operator manually flipped lots via raw SQL.
--
-- Confirmed by reading all 6 active pg_cron jobs — finalize_due_lots,
-- drain_build_invoice_jobs, mark_settlements_releasable, advance_auction_lifecycle,
-- auto_relist_unsold_lots, and the housekeeping cleanup. None promote lots.
--
-- Fix:
--   1. New SECURITY DEFINER function `open_due_lots()` promotes
--      lots from 'scheduled' → 'live' when:
--        - parent auction is 'scheduled' OR 'live'
--        - parent auction.starts_at <= now()
--        - lot.close_at > now()  (defense — a misconfigured row with
--          close_at already passed should skip straight to finalize)
--   2. Same pg_try_advisory_xact_lock pattern as finalize_due_lots to
--      avoid concurrent ticks stepping on each other.
--   3. New pg_cron job to call it every 5 seconds, mirroring the
--      finalize_due_lots cadence so a scheduled→live→bid→won lifecycle
--      can complete within one tick window.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.open_due_lots(p_batch_size integer DEFAULT 100)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_opened_count int := 0;
BEGIN
  -- Skip if another tick is already running. The next pg_cron firing
  -- will pick up wherever this one would have started.
  IF NOT pg_try_advisory_xact_lock(7423940124) THEN
    RETURN jsonb_build_object('skipped', true);
  END IF;

  -- Promote eligible lots from 'scheduled' to 'live':
  --   - parent auction has started (starts_at <= now())
  --   - parent auction itself is still pre-close (scheduled or live)
  --   - lot's own close_at is in the future
  --   - (the cancel/relist flow flips to canceled/relisted directly, so
  --     filtering on status='scheduled' is sufficient — we don't risk
  --     re-opening a closed lot)
  WITH eligible AS (
    SELECT l.id
    FROM public.lots l
    JOIN public.auctions a ON a.id = l.auction_id
    WHERE l.status = 'scheduled'
      AND l.close_at > now()
      AND a.status IN ('scheduled', 'live')
      AND a.starts_at <= now()
    ORDER BY a.starts_at, l.lot_number NULLS LAST, l.id
    LIMIT p_batch_size
    FOR UPDATE OF l SKIP LOCKED
  ),
  promoted AS (
    UPDATE public.lots l
       SET status = 'live',
           updated_at = now()
      FROM eligible e
     WHERE l.id = e.id
    RETURNING l.id
  )
  SELECT count(*) INTO v_opened_count FROM promoted;

  RETURN jsonb_build_object(
    'opened', v_opened_count,
    'at', now()
  );
END;
$function$;

COMMENT ON FUNCTION public.open_due_lots(integer) IS
  'Promotes lots from scheduled to live once parent auction starts_at arrives. '
  'Companion to finalize_due_lots (close) and advance_auction_lifecycle (auction-level). '
  'Added 2026-05-23 — prior engine had no path from scheduled to live; auctions sat '
  'in scheduled forever after starts_at hit. See migration 0125 header for full RCA.';

-- ============================================================================
-- pg_cron registration
--
-- Schedule: every 5 seconds — matches finalize_due_lots cadence so the open
-- → close → finalize chain can complete within a single tick window for
-- short-window demo auctions.
-- ============================================================================

DO $$
BEGIN
  -- Idempotent register. cron.schedule errors if the same name already
  -- exists, so we unschedule any prior version first.
  PERFORM cron.unschedule('open_due_lots') WHERE EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'open_due_lots'
  );
  PERFORM cron.schedule(
    'open_due_lots',
    '5 seconds',
    'SELECT public.open_due_lots()'
  );
END $$;

-- ============================================================================
-- One-shot catch-up: immediately promote any lots whose auction starts_at
-- has already passed. This is the migration's recovery step for any auctions
-- that have been sitting in scheduled limbo on prod since launch.
-- ============================================================================

SELECT public.open_due_lots();

-- After lots are live, give advance_auction_lifecycle a nudge so auction-level
-- status catches up in the same migration. Belt-and-suspenders — the cron will
-- catch it anyway within 60 seconds.
SELECT public.advance_auction_lifecycle();
