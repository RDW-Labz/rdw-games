-- ============================================================================
-- Migration 0155 — Auto-mark missed pickups as no_show + route lots to relist
--
-- Today, an operator must MANUALLY flip a pickup to `no_show` from the
-- operator-web /pickups page. There is no automation for past-deadline
-- pickups, so missed pickups linger as `status='pending'` or `'scheduled'`
-- forever — bidders' invoices aren't auto-relisted, lots stay frozen in
-- `won`, and the operator has to babysit the dashboard.
--
-- This migration adds:
--   1. auto_mark_pickup_no_show()  — SECURITY DEFINER function that flips
--      past-deadline pickups to `no_show` (per-operator grace) AND routes
--      their lots back into the auto-relist pool by setting lots.status
--      from 'won' to 'unsold'.
--   2. cron.schedule('auto-mark-pickup-no-show', '*/30 * * * *', …) — pg_cron
--      registration, every 30 minutes. Mirrors the idempotency pattern of
--      mig 0097 (auto_relist_unsold_lots).
--
-- ── Deadline definition ────────────────────────────────────────────────────
-- A pickup's effective deadline is:
--   COALESCE(pickups.scheduled_at, auctions.pickup_ends_at)
--     + (operators.pickup_grace_extension_hours * INTERVAL '1 hour')
--
-- - pickups.scheduled_at (nullable, mig 0001) is the individually-booked
--   pickup time, when one exists.
-- - auctions.pickup_ends_at (NOT NULL, mig 0001) is the auction-wide pickup
--   window close, used as the fallback.
-- - operators.pickup_grace_extension_hours (mig 0144, default 0, range 0-168)
--   gives each operator a configurable buffer beyond the standard window
--   before a missed pickup transitions to no_show. Defaults to 0 = no
--   extension. High-touch / VIP markets can extend.
--
-- We use COALESCE on the grace value too, so any operator created before
-- mig 0144 (defensive — should be impossible since 0144 sets a NOT NULL
-- default of 0) still gets a sane 24h fallback.
--
-- ── Lot routing (the bug fix) ──────────────────────────────────────────────
-- Same function also routes lots from no-show'd pickups back into the
-- auto-relist pool. The 0097/0146 auto_relist_unsold_lots() cron requires
-- `status='unsold'`. We update lots from `status='won'` (set when the
-- bidder won the auction) to `status='unsold'` so they re-enter the pool
-- on the next tick of auto-relist-unsold (10-minute cadence).
--
-- This is the DB-side complement of the bug fix in
-- apps/operator-web/src/app/(operator)/pickups/actions.ts — the manual
-- "Mark no-show" button used to set lots.status='relisted', which is a
-- valid enum value but is NOT picked up by the auto-relist cron. Both
-- code paths now agree on 'unsold'.
--
-- ── Idempotency ────────────────────────────────────────────────────────────
-- - CREATE OR REPLACE FUNCTION   — safe to re-run
-- - Function selects only pickups whose status is still pending/scheduled
--   AND whose deadline is past, so re-running on the same tick is a no-op
-- - cron.schedule is wrapped in a DO-block that unschedules first if the
--   job already exists, mirroring mig 0097 exactly
-- - Lot status update is gated on `status = 'won'` so a lot that's been
--   manually progressed elsewhere is not clobbered
-- - Advisory xact lock prevents overlapping cron ticks from double-flipping
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. auto_mark_pickup_no_show() — pg_cron entry point
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION auto_mark_pickup_no_show()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_pickup_count INT := 0;
  v_lot_count    INT := 0;
BEGIN
  -- Advisory lock so overlapping cron ticks (30-min cadence shouldn't
  -- overlap, but defensive) don't double-process the same pickup. Same
  -- pattern as mig 0097's auto_relist_unsold_lots advisory lock, with
  -- a different magic number.
  IF NOT pg_try_advisory_xact_lock(7423940155) THEN
    RETURN jsonb_build_object('skipped', 'lock_held');
  END IF;

  -- Step 1: flip past-deadline pickups to no_show.
  --
  -- A pickup is past-deadline when:
  --   COALESCE(p.scheduled_at, a.pickup_ends_at)
  --     + (operators.pickup_grace_extension_hours * INTERVAL '1 hour') < now()
  --
  -- We join through invoices to get the auction's pickup_ends_at fallback,
  -- and through operators (via invoices.operator_id) for the per-operator
  -- grace. The CTE captures every pickup we're about to flip so we can
  -- also route its lots in step 2 within the same transaction.
  WITH due AS (
    SELECT
      p.id           AS pickup_id,
      p.invoice_id   AS invoice_id
    FROM pickups p
    JOIN invoices  i ON i.id = p.invoice_id
    JOIN auctions  a ON a.id = i.auction_id
    JOIN operators o ON o.id = i.operator_id
    WHERE p.status IN ('pending', 'scheduled')
      AND (
        COALESCE(p.scheduled_at, a.pickup_ends_at)
          + (COALESCE(o.pickup_grace_extension_hours, 24) * INTERVAL '1 hour')
      ) < now()
  ),
  flipped AS (
    UPDATE pickups
       SET status     = 'no_show',
           updated_at = now()
     WHERE id IN (SELECT pickup_id FROM due)
    RETURNING id, invoice_id
  )
  SELECT COUNT(*) INTO v_pickup_count FROM flipped;

  -- Step 2: route those pickups' lots back into the auto-relist pool.
  --
  -- The auto-relist cron (mig 0097/0146) picks up lots with status='unsold'.
  -- A "won" lot whose pickup was no-show'd should re-enter the pool so the
  -- bidder loses the win and the lot gets another auction.
  --
  -- We re-query against pickups.status='no_show' (rather than reusing the
  -- CTE result) because pickups that were already no_show from a prior
  -- tick might still have lots stuck in 'won' if the operator marked the
  -- pickup pre-this-migration. Re-routing those is part of the catch-up.
  --
  -- Gated on lots.status='won' so we don't clobber lots that have been
  -- manually progressed (e.g. already disposed, already relisted).
  WITH no_show_invoices AS (
    SELECT DISTINCT invoice_id
    FROM pickups
    WHERE status = 'no_show'
  ),
  no_show_lot_ids AS (
    SELECT il.lot_id
    FROM invoice_lots il
    JOIN no_show_invoices nsi ON nsi.invoice_id = il.invoice_id
  ),
  routed AS (
    UPDATE lots
       SET status     = 'unsold',
           updated_at = now()
     WHERE id IN (SELECT lot_id FROM no_show_lot_ids)
       AND status = 'won'
    RETURNING id
  )
  SELECT COUNT(*) INTO v_lot_count FROM routed;

  RETURN jsonb_build_object(
    'pickups_flipped', v_pickup_count,
    'lots_routed_to_unsold', v_lot_count,
    'at', now()
  );
END;
$$;

REVOKE ALL ON FUNCTION auto_mark_pickup_no_show() FROM PUBLIC;

COMMENT ON FUNCTION auto_mark_pickup_no_show() IS
  'Mig 0155: pg_cron entry point that flips past-deadline pickups '
  '(status pending|scheduled) to no_show and routes their lots from '
  'status=won to status=unsold so they re-enter the auto-relist pool '
  '(picked up by auto_relist_unsold_lots from mig 0097/0146). Deadline = '
  'COALESCE(pickups.scheduled_at, auctions.pickup_ends_at) + '
  'operators.pickup_grace_extension_hours hours. Returns counts of '
  'pickups flipped and lots routed.';

-- ---------------------------------------------------------------------------
-- 2. Schedule the job on pg_cron
-- ---------------------------------------------------------------------------
-- Every 30 minutes. Cheap (filtered scan with predicate index on
-- pickups.status from mig 0001), and 30-min cadence means a deadline
-- crossed at 14:00 is reflected by 14:30 at the latest — fast enough
-- that operators see the right state on a refresh, slow enough not to
-- thrash. Mirrors mig 0097's DO-block idempotency: unschedule if exists,
-- then re-schedule.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM cron.job WHERE jobname = 'auto-mark-pickup-no-show'
  ) THEN
    PERFORM cron.unschedule('auto-mark-pickup-no-show');
  END IF;
  PERFORM cron.schedule(
    'auto-mark-pickup-no-show',
    '*/30 * * * *',  -- every 30 minutes
    $cron$SELECT public.auto_mark_pickup_no_show()$cron$
  );
END $$;

COMMIT;
