-- 0224 — operator_ops_health(): single-call operations-health snapshot RPC
--
-- Owner, 2026-07-05: "should we work on a reporting audit sop i can see all
-- things needed" → a live Operations Health page in the console (scope:
-- operations health, not P&L — the monthly /reports page already covers
-- business finance). This RPC returns every operational signal in one JSON
-- object so the page is a single round-trip.
--
-- SECURITY DEFINER + operator-staff gate (mirrors bidder_signup_stats, 0222):
-- the counts span platform tables (notifications_outbox, refund_jobs,
-- image_enrichment_jobs) that operator RLS would otherwise hide. BinGo is
-- single-operator, so platform-wide counts ARE the operator's counts. Returns
-- counts + timestamps only — no PII.
--
-- Idempotent: CREATE OR REPLACE + GRANT.

BEGIN;

CREATE OR REPLACE FUNCTION public.operator_ops_health()
RETURNS json
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  result json;
BEGIN
  -- Operator staff only.
  IF NOT EXISTS (
    SELECT 1 FROM public.operator_users ou WHERE ou.user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'not_operator_staff' USING ERRCODE = '42501';
  END IF;

  SELECT json_build_object(
    'generated_at', now(),

    -- Who is signing up.
    'signups', json_build_object(
      'total',     (SELECT count(*) FROM bidders WHERE deleted_at IS NULL),
      'last_24h',  (SELECT count(*) FROM bidders WHERE deleted_at IS NULL AND created_at > now() - interval '24 hours'),
      'last_7d',   (SELECT count(*) FROM bidders WHERE deleted_at IS NULL AND created_at > now() - interval '7 days'),
      'with_card', (SELECT count(*) FROM bidders WHERE deleted_at IS NULL AND default_payment_method_id IS NOT NULL)
    ),

    -- Whether they are bidding.
    'bids', json_build_object(
      'total',            (SELECT count(*) FROM bids),
      'last_24h',         (SELECT count(*) FROM bids WHERE placed_at > now() - interval '24 hours'),
      'auto',             (SELECT count(*) FROM bids WHERE is_auto),
      'distinct_bidders', (SELECT count(DISTINCT bidder_id) FROM bids),
      'lots_with_bids',   (SELECT count(DISTINCT lot_id) FROM bids)
    ),

    -- What is on the block right now.
    'catalog', json_build_object(
      'active_auctions', (SELECT count(*) FROM auctions WHERE status IN ('scheduled','live')),
      'live_lots',       (SELECT count(*) FROM lots WHERE status = 'live'),
      'lots_ending_1h',  (SELECT count(*) FROM lots WHERE status = 'live' AND close_at IS NOT NULL AND close_at BETWEEN now() AND now() + interval '1 hour')
    ),

    -- Email pipeline (Resend via the outbox drain).
    'email', json_build_object(
      'queued',    (SELECT count(*) FROM notifications_outbox WHERE emailed_at IS NULL),
      'stuck_10m', (SELECT count(*) FROM notifications_outbox WHERE emailed_at IS NULL AND email_attempt_count < 3 AND created_at < now() - interval '10 minutes'),
      'failed',    (SELECT count(*) FROM notifications_outbox WHERE emailed_at IS NULL AND email_attempt_count >= 3),
      'sent_24h',  (SELECT count(*) FROM notifications_outbox WHERE emailed_at > now() - interval '24 hours' AND last_email_error IS NULL),
      'last_sent', (SELECT max(emailed_at) FROM notifications_outbox WHERE last_email_error IS NULL)
    ),

    -- Push pipeline (Expo via the notifications drain).
    'push', json_build_object(
      'queued',    (SELECT count(*) FROM notifications_outbox WHERE processed_at IS NULL),
      'stuck_10m', (SELECT count(*) FROM notifications_outbox WHERE processed_at IS NULL AND attempt_count < 3 AND created_at < now() - interval '10 minutes'),
      'last_sent', (SELECT max(processed_at) FROM notifications_outbox)
    ),

    -- Bidders who tried to sign up and bounced (mig 0223).
    'signup_failures_24h', (SELECT count(*) FROM signup_failures WHERE created_at > now() - interval '24 hours'),

    -- Background job queues.
    'jobs', json_build_object(
      'refunds_pending',      (SELECT count(*) FROM refund_jobs WHERE processed_at IS NULL),
      'image_enrich_pending', (SELECT count(*) FROM image_enrichment_jobs WHERE processed_at IS NULL),
      'autocharge_errored',   (SELECT count(*) FROM invoices WHERE last_auto_charge_error IS NOT NULL AND status <> 'paid')
    ),

    -- Engine liveness: a lot past its close time and still 'live' after a
    -- 2-minute grace means finalize_due_lots is not running.
    'engine', json_build_object(
      'lots_overdue_finalize', (SELECT count(*) FROM lots WHERE status = 'live' AND close_at IS NOT NULL AND close_at < now() - interval '2 minutes')
    )
  ) INTO result;

  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.operator_ops_health() TO authenticated;

COMMIT;
