-- 0225 — reporting expansion: auction performance + engagement funnel/trend
--
-- Owner, 2026-07-05: "look at all of the reporting and expand it". Three
-- additions, all operator-staff-gated SECURITY DEFINER (pattern from 0222/
-- 0224 — BinGo is single-operator, platform-wide counts ARE the operator's):
--
--   1. operator_auction_performance() — per-auction sell-through, gross,
--      bids, unique bidders, MSRP recovery. The auctioneer's core report
--      ("how did last night do?"); nothing answered it before.
--   2. operator_engagement_report(p_tz, p_days) — bidder funnel
--      (registered → card → bid → won → paid) + per-day trend (signups,
--      bids, paid GMV) bucketed in the operator's wall-clock zone.
--   3. operator_ops_health() v2 — adds a 'money' group: unpaid invoice
--      count / value / oldest age. (Full CREATE OR REPLACE; idempotent.)
--
-- Enum comparisons use status::text so a literal that doesn't exist in an
-- enum can never error the whole report.

BEGIN;

-- ── 1. Per-auction performance ───────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.operator_auction_performance()
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

  SELECT coalesce(json_agg(t.obj ORDER BY t.ord), '[]'::json) INTO result
  FROM (
    SELECT
      row_number() OVER (ORDER BY coalesce(a.ends_at, a.starts_at) DESC) AS ord,
      json_build_object(
        'id', a.id,
        'title', a.title,
        'status', a.status::text,
        'starts_at', a.starts_at,
        'ends_at', a.ends_at,
        'lots_total', s.lots_total,
        'sold', s.sold,
        -- 'relisted' counts as unsold for the SOURCE auction: it didn't
        -- sell there and was pushed to a later auction.
        'unsold', s.unsold,
        'still_open', s.still_open,
        'gross_cents', s.gross_cents,
        'bids', s.bids,
        'unique_bidders', (
          SELECT count(DISTINCT b.bidder_id)
          FROM public.bids b
          JOIN public.lots lb ON lb.id = b.lot_id
          WHERE lb.auction_id = a.id
        ),
        'msrp_sold_cents', s.msrp_sold_cents
      ) AS obj
    FROM public.auctions a
    JOIN LATERAL (
      SELECT
        count(*) FILTER (WHERE l.deleted_at IS NULL)                              AS lots_total,
        count(*) FILTER (WHERE l.status::text = 'won')                            AS sold,
        count(*) FILTER (WHERE l.status::text IN ('unsold', 'relisted'))          AS unsold,
        count(*) FILTER (WHERE l.status::text IN ('live', 'scheduled'))           AS still_open,
        coalesce(sum(l.current_bid_cents) FILTER (WHERE l.status::text = 'won'), 0) AS gross_cents,
        coalesce(sum(l.bid_count), 0)                                             AS bids,
        coalesce(sum(l.msrp_cents) FILTER (WHERE l.status::text = 'won'), 0)      AS msrp_sold_cents
      FROM public.lots l
      WHERE l.auction_id = a.id
    ) s ON true
    ORDER BY coalesce(a.ends_at, a.starts_at) DESC
    LIMIT 30
  ) t;

  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.operator_auction_performance() TO authenticated;

-- ── 2. Engagement: funnel + daily trend ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.operator_engagement_report(
  p_tz   text DEFAULT 'America/Chicago',
  p_days int  DEFAULT 14
)
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
    'funnel', json_build_object(
      'registered', (SELECT count(*) FROM public.bidders WHERE deleted_at IS NULL),
      'with_card',  (SELECT count(*) FROM public.bidders WHERE deleted_at IS NULL AND default_payment_method_id IS NOT NULL),
      'bid',        (SELECT count(DISTINCT bidder_id) FROM public.bids),
      'won',        (SELECT count(DISTINCT winner_bidder_id) FROM public.lots WHERE winner_bidder_id IS NOT NULL AND status::text = 'won'),
      'paid',       (SELECT count(DISTINCT bidder_id) FROM public.invoices WHERE status::text = 'paid')
    ),
    'daily', (
      SELECT coalesce(json_agg(json_build_object(
        'day', d.day,
        'signups', (SELECT count(*) FROM public.bidders b
                    WHERE b.deleted_at IS NULL AND (b.created_at AT TIME ZONE p_tz)::date = d.day),
        'bids', (SELECT count(*) FROM public.bids bd
                 WHERE (bd.placed_at AT TIME ZONE p_tz)::date = d.day),
        'gmv_cents', (SELECT coalesce(sum(i.total_cents), 0) FROM public.invoices i
                      WHERE i.status::text = 'paid' AND (i.paid_at AT TIME ZONE p_tz)::date = d.day)
      ) ORDER BY d.day), '[]'::json)
      FROM (
        SELECT ((now() AT TIME ZONE p_tz)::date - offs) AS day
        FROM generate_series(0, greatest(p_days, 1) - 1) AS offs
      ) d
    )
  ) INTO result;

  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.operator_engagement_report(text, int) TO authenticated;

-- ── 3. ops-health v2: + money group ─────────────────────────────────────────
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
      'autocharge_errored',   (SELECT count(*) FROM invoices WHERE last_auto_charge_error IS NOT NULL AND status::text <> 'paid')
    ),

    -- v2 (0225): who owes money. Unpaid = never paid, not refunded/canceled.
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
