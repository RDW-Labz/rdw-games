-- SQL replacements for the BullMQ workers that did pure-database work.
--
-- Three workers move into Postgres entirely:
--   1. closeLot          -> finalize_due_lots()
--   2. buildInvoices     -> build_invoices_for_auction() + drain_build_invoice_jobs()
--   3. settlements step1 -> mark_settlements_releasable() (the held -> releasable flip)
--
-- The TypeScript closeLot worker used to enqueue both the 'won' notification
-- and the build-invoices job. finalize_lot() already handles the 'won'
-- notification itself (see 0006), so finalize_due_lots only needs to upsert
-- the build-invoice job on 'won' results.
--
-- closing-soon, saved-searches, notifications-drain, settlements-release,
-- email-drain, sms-drain, and product-cache-warm-drain run as Cloudflare
-- Worker /api/cron/* routes -- they call external APIs (Expo, Stripe, Resend,
-- Twilio, eBay) and need fetch + secrets, which Postgres functions can't do.

-- ----------------------------------------------------------------------------
-- build_invoices_for_auction
--
-- Port of packages/auction-engine/src/buildInvoices.ts. Groups won lots by
-- bidder, computes subtotal/premium/total/application_fee, upserts an
-- invoice per (auction, bidder), and replaces invoice_lots rows.
--
-- Idempotent via UNIQUE (auction_id, bidder_id) on invoices. Existing
-- invoices update their totals ONLY if status='pending' -- once an invoice
-- is paid we never recompute it (a manual lot cancel after payment is a
-- refund flow, not a recompute).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.build_invoices_for_auction(p_auction_id uuid)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_auction record;
  v_operator record;
  v_bidder record;
  v_invoice_id uuid;
  v_buyer_premium int;
  v_total int;
  v_app_fee int;
  v_count int := 0;
BEGIN
  SELECT id, buyer_premium_bps, operator_id
  INTO v_auction
  FROM public.auctions
  WHERE id = p_auction_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'auction_not_found: %', p_auction_id;
  END IF;

  SELECT id, application_fee_bps
  INTO v_operator
  FROM public.operators
  WHERE id = v_auction.operator_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'operator_not_found: %', v_auction.operator_id;
  END IF;

  FOR v_bidder IN
    SELECT winner_bidder_id,
           SUM(current_bid_cents)::int AS subtotal
    FROM public.lots
    WHERE auction_id = p_auction_id
      AND status = 'won'
      AND winner_bidder_id IS NOT NULL
    GROUP BY winner_bidder_id
  LOOP
    v_buyer_premium := ROUND(v_bidder.subtotal::numeric * v_auction.buyer_premium_bps / 10000.0)::int;
    v_total := v_bidder.subtotal + v_buyer_premium;
    v_app_fee := ROUND((v_bidder.subtotal + v_buyer_premium)::numeric * v_operator.application_fee_bps / 10000.0)::int;

    INSERT INTO public.invoices (
      operator_id, auction_id, bidder_id, status,
      subtotal_cents, buyer_premium_cents, total_cents, application_fee_cents
    ) VALUES (
      v_auction.operator_id, p_auction_id, v_bidder.winner_bidder_id, 'pending',
      v_bidder.subtotal, v_buyer_premium, v_total, v_app_fee
    )
    ON CONFLICT (auction_id, bidder_id) DO UPDATE
      SET subtotal_cents = EXCLUDED.subtotal_cents,
          buyer_premium_cents = EXCLUDED.buyer_premium_cents,
          total_cents = EXCLUDED.total_cents,
          application_fee_cents = EXCLUDED.application_fee_cents
      WHERE public.invoices.status = 'pending'
    RETURNING id INTO v_invoice_id;

    -- If the upsert was a no-op (status != 'pending'), the RETURNING is NULL.
    -- Re-fetch so we can still rebuild invoice_lots for any pending invoice
    -- that just got refreshed.
    IF v_invoice_id IS NULL THEN
      SELECT id INTO v_invoice_id
      FROM public.invoices
      WHERE auction_id = p_auction_id AND bidder_id = v_bidder.winner_bidder_id;
    END IF;

    -- Only rebuild invoice_lots for a pending invoice. Paid/refunded
    -- invoices keep their historical line items.
    IF EXISTS (
      SELECT 1 FROM public.invoices
      WHERE id = v_invoice_id AND status = 'pending'
    ) THEN
      DELETE FROM public.invoice_lots WHERE invoice_id = v_invoice_id;
      INSERT INTO public.invoice_lots (invoice_id, lot_id, winning_bid_cents)
      SELECT v_invoice_id, l.id, l.current_bid_cents
      FROM public.lots l
      WHERE l.auction_id = p_auction_id
        AND l.status = 'won'
        AND l.winner_bidder_id = v_bidder.winner_bidder_id;
    END IF;

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.build_invoices_for_auction(uuid) FROM PUBLIC;

-- ----------------------------------------------------------------------------
-- finalize_due_lots
--
-- Scans for lots whose close_at has passed and calls finalize_lot on each.
-- Replaces the BullMQ-scheduled close-lot job entirely -- the "schedule per
-- lot at close_at" pattern is unnecessary when we can just scan WHERE
-- close_at <= now() every 5 seconds.
--
-- finalize_lot is idempotent and already handles:
--   - already-closed lots (no-op)
--   - soft-close extensions (returns reason='reschedule')
--   - 'won' notification enqueue
--
-- This wrapper only needs to upsert the per-auction build_invoice_jobs
-- entry on a 'won' result so the invoice drainer picks it up.
--
-- Advisory lock (pg_try_advisory_xact_lock) prevents overlapping ticks
-- from racing. SKIP LOCKED inside the scan handles within-batch concurrency
-- with other writers (e.g. place_bid doing soft-close extension).
-- ----------------------------------------------------------------------------
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
    'processed', v_total_count,
    'won', v_won_count
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.finalize_due_lots(int) FROM PUBLIC;

-- ----------------------------------------------------------------------------
-- drain_build_invoice_jobs
--
-- Reads the build_invoice_jobs table for entries whose run_at has passed
-- (debounce window expired) and invokes build_invoices_for_auction for each.
-- On success deletes the row; on failure bumps attempt_count + last_error.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.drain_build_invoice_jobs(p_batch_size int DEFAULT 20)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_job record;
  v_count int := 0;
BEGIN
  IF NOT pg_try_advisory_xact_lock(7423940124) THEN
    RETURN -1;
  END IF;

  FOR v_job IN
    SELECT auction_id
    FROM public.build_invoice_jobs
    WHERE run_at <= now()
      AND attempt_count < 5
    ORDER BY run_at
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  LOOP
    BEGIN
      PERFORM public.build_invoices_for_auction(v_job.auction_id);
      DELETE FROM public.build_invoice_jobs WHERE auction_id = v_job.auction_id;
      v_count := v_count + 1;
    EXCEPTION WHEN OTHERS THEN
      UPDATE public.build_invoice_jobs
      SET attempt_count = attempt_count + 1,
          last_attempt_at = now(),
          last_error = left(SQLERRM, 500)
      WHERE auction_id = v_job.auction_id;
    END;
  END LOOP;

  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.drain_build_invoice_jobs(int) FROM PUBLIC;

-- ----------------------------------------------------------------------------
-- mark_settlements_releasable
--
-- Port of step 1 of packages/auction-engine/src/settlements.ts tick().
-- Pure-SQL state flip with no external calls -- just the held -> releasable
-- transition based on release_at <= now(). The actual Stripe transfer
-- happens in /api/cron/settlements-release in operator-web (Cloudflare).
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.mark_settlements_releasable()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count int;
BEGIN
  UPDATE public.operator_settlements
  SET status = 'releasable'
  WHERE status = 'held'
    AND release_at <= now();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.mark_settlements_releasable() FROM PUBLIC;
