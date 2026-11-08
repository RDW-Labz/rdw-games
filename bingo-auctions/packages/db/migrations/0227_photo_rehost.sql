-- 0227 — photo re-hosting state (own-storage image pipeline)
--
-- Owner, 2026-07-05: ~99.6% of storefront images are hosted on
-- infrastructure BinGo doesn't control — 585 lots of REAL intake photos on
-- the legacy platform's S3 bucket (lotting-images-prod/RustDustWanderlust),
-- 457 Amazon CDN hotlinks, 360 Wayfair CDN hotlinks. If any of those
-- accounts/URLs die, the catalog goes blank. The photo-rehost cron drain
-- (lib/cron/photo-rehost-drain.ts) downloads every external image into the
-- Supabase 'lot-photos' bucket and swaps the URL.
--
-- Watching the LOTS TABLE (not any import path) means every current and
-- future creation flow is covered automatically: manifest imports, BRN
-- sticker lotting, AI lotting, manual edits, relists.
--
--   photo_urls_original  the pre-rehost URLs, kept for provenance/fallback
--   photo_rehost_attempts  drain retry counter (gives up at 3)
--   photo_rehosted_at    set when every URL on the lot is internal
--
-- ops-health v3: 'jobs.photo_rehost_pending' so the console shows the
-- backlog draining.

BEGIN;

ALTER TABLE public.lots ADD COLUMN IF NOT EXISTS photo_urls_original text[];
ALTER TABLE public.lots ADD COLUMN IF NOT EXISTS photo_rehost_attempts int NOT NULL DEFAULT 0;
ALTER TABLE public.lots ADD COLUMN IF NOT EXISTS photo_rehosted_at timestamptz;

-- Narrow the drain's per-minute candidate scan.
CREATE INDEX IF NOT EXISTS lots_photo_rehost_pending_idx
  ON public.lots (photo_rehost_attempts)
  WHERE photo_rehosted_at IS NULL AND photo_urls IS NOT NULL;

-- ── ops-health v3: photo_rehost_pending under 'jobs' ────────────────────────
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
  IF NOT EXISTS (
    SELECT 1 FROM public.operator_users ou WHERE ou.user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'not_operator_staff' USING ERRCODE = '42501';
  END IF;

  SELECT json_build_object(
    'generated_at', now(),

    'signups', json_build_object(
      'total',     (SELECT count(*) FROM bidders WHERE deleted_at IS NULL),
      'last_24h',  (SELECT count(*) FROM bidders WHERE deleted_at IS NULL AND created_at > now() - interval '24 hours'),
      'last_7d',   (SELECT count(*) FROM bidders WHERE deleted_at IS NULL AND created_at > now() - interval '7 days'),
      'with_card', (SELECT count(*) FROM bidders WHERE deleted_at IS NULL AND default_payment_method_id IS NOT NULL)
    ),

    'bids', json_build_object(
      'total',            (SELECT count(*) FROM bids),
      'last_24h',         (SELECT count(*) FROM bids WHERE placed_at > now() - interval '24 hours'),
      'auto',             (SELECT count(*) FROM bids WHERE is_auto),
      'distinct_bidders', (SELECT count(DISTINCT bidder_id) FROM bids),
      'lots_with_bids',   (SELECT count(DISTINCT lot_id) FROM bids)
    ),

    'catalog', json_build_object(
      'active_auctions', (SELECT count(*) FROM auctions WHERE status::text IN ('scheduled','live')),
      'live_lots',       (SELECT count(*) FROM lots WHERE status::text = 'live'),
      'lots_ending_1h',  (SELECT count(*) FROM lots WHERE status::text = 'live' AND close_at IS NOT NULL AND close_at BETWEEN now() AND now() + interval '1 hour')
    ),

    'email', json_build_object(
      'queued',    (SELECT count(*) FROM notifications_outbox WHERE emailed_at IS NULL),
      'stuck_10m', (SELECT count(*) FROM notifications_outbox WHERE emailed_at IS NULL AND email_attempt_count < 3 AND created_at < now() - interval '10 minutes'),
      'failed',    (SELECT count(*) FROM notifications_outbox WHERE emailed_at IS NULL AND email_attempt_count >= 3),
      'sent_24h',  (SELECT count(*) FROM notifications_outbox WHERE emailed_at > now() - interval '24 hours' AND last_email_error IS NULL),
      'last_sent', (SELECT max(emailed_at) FROM notifications_outbox WHERE last_email_error IS NULL)
    ),

    'push', json_build_object(
      'queued',    (SELECT count(*) FROM notifications_outbox WHERE processed_at IS NULL),
      'stuck_10m', (SELECT count(*) FROM notifications_outbox WHERE processed_at IS NULL AND attempt_count < 3 AND created_at < now() - interval '10 minutes'),
      'last_sent', (SELECT max(processed_at) FROM notifications_outbox)
    ),

    'signup_failures_24h', (SELECT count(*) FROM signup_failures WHERE created_at > now() - interval '24 hours'),

    'jobs', json_build_object(
      'refunds_pending',      (SELECT count(*) FROM refund_jobs WHERE processed_at IS NULL),
      'image_enrich_pending', (SELECT count(*) FROM image_enrichment_jobs WHERE processed_at IS NULL),
      'autocharge_errored',   (SELECT count(*) FROM invoices WHERE last_auto_charge_error IS NOT NULL AND status::text <> 'paid'),
      -- v3 (0227): lots still carrying externally-hosted photos.
      'photo_rehost_pending', (SELECT count(*) FROM lots WHERE photo_rehosted_at IS NULL AND photo_rehost_attempts < 3 AND photo_urls IS NOT NULL AND array_length(photo_urls,1) >= 1)
    ),

    'money', json_build_object(
      'unpaid_count',  (SELECT count(*) FROM invoices WHERE paid_at IS NULL AND status::text NOT IN ('refunded','canceled','void')),
      'unpaid_cents',  (SELECT coalesce(sum(total_cents),0) FROM invoices WHERE paid_at IS NULL AND status::text NOT IN ('refunded','canceled','void')),
      'oldest_unpaid', (SELECT min(created_at) FROM invoices WHERE paid_at IS NULL AND status::text NOT IN ('refunded','canceled','void')),
      'paid_24h_cents',(SELECT coalesce(sum(total_cents),0) FROM invoices WHERE status::text = 'paid' AND paid_at > now() - interval '24 hours')
    ),

    'engine', json_build_object(
      'lots_overdue_finalize', (SELECT count(*) FROM lots WHERE status::text = 'live' AND close_at IS NOT NULL AND close_at < now() - interval '2 minutes')
    )
  ) INTO result;

  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.operator_ops_health() TO authenticated;

COMMIT;
