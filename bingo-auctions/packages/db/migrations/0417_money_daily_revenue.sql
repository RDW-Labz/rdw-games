-- 0417 — one revenue calculation for the whole console (operator_money_daily)
--
-- Read-only analysis 2026-10-14: Reports → Health "Revenue" (engagement
-- report gmv_cents, 0225) and Ops "Revenue today" both summed
-- invoices.total_cents WHERE status = 'paid'. Any partial refund moves an
-- invoice to 'partially_refunded', so the WHOLE invoice — not the refunded
-- part — dropped out of revenue. Prod, Sept 30–Oct 12 (Chicago days):
--     status = 'paid' only          $37,641.50
--     actually charged (paid_at)    $52,327.69
--     Money page net revenue        $41,846.26
-- The Money page (operator_money_summary, 0287) was the only correct
-- calculation. This migration gives every other revenue figure the same
-- rules, per Chicago day, and removes the status = 'paid' revenue rule.
--
-- ── operator_money_daily(from_day, to_day, tz) ──────────────────────────────
-- Same invoice set as operator_money_summary: the caller's operator, status
-- paid / partially_refunded / refunded. Per calendar day in p_tz:
--   gross_charged_cents  Σ total_cents (incl. tax) on the paid_at day
--   refunds_cents        face refunded (cash + store credit) on the day the
--                        refund was ISSUED
--   net_collected_cents  gross_charged − refunds
--   tax_cents            tax charged that day − tax refunded that day
--   net_revenue_cents    net_collected − tax  (bids + premium − refunds,
--                        excl. sales tax)
-- Over a range, gross and tax charged equal operator_money_summary's figures
-- exactly. Refunds differ by design: the Money page's ladder counts a refund
-- against the sale it reverses (paid_at cohort); per-day figures count it on
-- the day the money went back, so a closed day never changes afterwards and a
-- day with more refunds than sales reads negative (true).
--
-- Refund dates. invoices carries only CUMULATIVE refund amounts
-- (refunded_cash/credit/tax_cents, 0270) and refunded_at = FIRST refund
-- (prod: 128 invoices were refunded across more than one day; 92 refunded
-- invoices have no refunded_at at all). Both refund routes write one
-- operator_audit_log row per refund ('invoice.refund': cash_cents +
-- credit_cents; 'invoice.refund_item': amount_cents per item). Prod
-- 2026-10-14: all 2,015 refunded invoices have audit rows, 2,012 match the
-- invoice accumulator to the cent, 3 differ by $35.26 in total. So:
--   * each audit row is a refund event, dated by its created_at;
--   * the invoice accumulators stay the source of truth for AMOUNTS — they are
--     spread over that invoice's events in proportion to each event's face
--     (cumulative integer split, so the parts always sum to the accumulator
--     exactly); refunded tax is spread the same way;
--   * an invoice with refunded money but no usable audit row gets one event
--     at coalesce(refunded_at, paid_at).
--
-- ── Also ────────────────────────────────────────────────────────────────────
--   * operator_engagement_report: daily gmv_cents = gross charged (same set
--     as above, by paid_at) instead of status = 'paid'; funnel.paid counts
--     bidders with any paid / partially refunded / refunded invoice. Kept
--     operator-unscoped exactly as 0225 had it. The Health page now reads
--     its money columns from operator_money_daily; gmv_cents stays for
--     compatibility.
--   * operator_ops_health: money.paid_24h_cents = gross charged in the last
--     24 h over the same set (was status = 'paid'). Body otherwise identical
--     to 0227 (prod source verified identical to the repo 2026-10-14).
--
-- Locks: CREATE OR REPLACE FUNCTION only. No table is altered, no index is
-- built, no row is written. Rollback: scripts/prod-rig/0417_ROLLBACK_money_daily_revenue.sql

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. operator_money_daily
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.operator_money_daily(
  p_from_day DATE,
  p_to_day   DATE,
  p_tz       TEXT DEFAULT 'America/Chicago'
)
RETURNS json
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_op   UUID;
  v_tz   TEXT := coalesce(nullif(p_tz, ''), 'America/Chicago');
  v_from TIMESTAMPTZ;
  v_to   TIMESTAMPTZ;
  result json;
BEGIN
  SELECT operator_id INTO v_op
  FROM public.operator_users WHERE user_id = auth.uid() LIMIT 1;
  IF v_op IS NULL THEN
    RAISE EXCEPTION 'not_operator_staff' USING ERRCODE = '42501';
  END IF;

  IF p_from_day IS NULL OR p_to_day IS NULL OR p_to_day < p_from_day THEN
    RAISE EXCEPTION 'invalid_range' USING ERRCODE = '22023';
  END IF;
  IF p_to_day - p_from_day > 731 THEN
    RAISE EXCEPTION 'range_too_long' USING ERRCODE = '22023';
  END IF;
  -- Validates the zone (raises on an unknown name) and fixes the bounds.
  v_from := p_from_day::timestamp AT TIME ZONE v_tz;
  v_to   := (p_to_day + 1)::timestamp AT TIME ZONE v_tz;

  WITH inv AS (
    -- The Money page's invoice set (operator_money_summary, 0287).
    SELECT i.id, i.paid_at, i.refunded_at,
           coalesce(i.total_cents, 0)::bigint AS total_cents,
           coalesce(i.tax_cents, 0)::bigint   AS tax_cents,
           (coalesce(i.refunded_cash_cents, 0)
            + coalesce(i.refunded_credit_cents, 0))::bigint AS refund_face,
           coalesce(i.refunded_tax_cents, 0)::bigint        AS refund_tax
    FROM public.invoices i
    WHERE i.operator_id = v_op
      AND i.status::text IN ('paid', 'partially_refunded', 'refunded')
  ),
  charged AS (
    SELECT (inv.paid_at AT TIME ZONE v_tz)::date AS day,
           count(*)                       AS invoices_paid,
           sum(inv.total_cents)::bigint   AS gross_cents,
           sum(inv.tax_cents)::bigint     AS tax_cents
    FROM inv
    WHERE inv.paid_at >= v_from AND inv.paid_at < v_to
    GROUP BY 1
  ),
  refunded AS (
    SELECT * FROM inv WHERE inv.refund_face <> 0 OR inv.refund_tax <> 0
  ),
  audit_ev AS (
    -- One row per refund the routes issued. Amount parsing is defensive: a
    -- malformed value weighs 0 rather than failing the report.
    SELECT a.target_id AS invoice_id, a.created_at AS at, a.id AS seq,
           CASE WHEN a.action_type = 'invoice.refund' THEN
                  (CASE WHEN (a.after_state->>'cash_cents') ~ '^[0-9]{1,15}$'
                        THEN (a.after_state->>'cash_cents')::bigint ELSE 0 END)
                + (CASE WHEN (a.after_state->>'credit_cents') ~ '^[0-9]{1,15}$'
                        THEN (a.after_state->>'credit_cents')::bigint ELSE 0 END)
                ELSE
                  (CASE WHEN (a.after_state->>'amount_cents') ~ '^[0-9]{1,15}$'
                        THEN (a.after_state->>'amount_cents')::bigint ELSE 0 END)
           END AS weight
    FROM public.operator_audit_log a
    JOIN refunded r ON r.id = a.target_id
    WHERE a.operator_id = v_op
      AND a.action_type IN ('invoice.refund', 'invoice.refund_item')
  ),
  ev AS (
    SELECT e.invoice_id, e.at, e.seq, e.weight
    FROM audit_ev e
    WHERE e.weight > 0
    UNION ALL
    -- No usable audit row: one event at the recorded refund date.
    SELECT r.id, coalesce(r.refunded_at, r.paid_at), 0::bigint, 1::bigint
    FROM refunded r
    WHERE NOT EXISTS (
      SELECT 1 FROM audit_ev e WHERE e.invoice_id = r.id AND e.weight > 0
    )
  ),
  ev_cum AS (
    SELECT ev.invoice_id, ev.at,
           (sum(ev.weight) OVER w)::bigint                            AS cum,
           (sum(ev.weight) OVER w)::bigint - ev.weight                AS prev,
           (sum(ev.weight) OVER (PARTITION BY ev.invoice_id))::bigint AS total
    FROM ev
    WINDOW w AS (PARTITION BY ev.invoice_id ORDER BY ev.at, ev.seq
                 ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
  ),
  refund_parts AS (
    -- Cumulative integer split: each invoice's parts sum to its accumulator.
    SELECT (c.at AT TIME ZONE v_tz)::date AS day,
           (r.refund_face * c.cum) / c.total - (r.refund_face * c.prev) / c.total AS face,
           (r.refund_tax  * c.cum) / c.total - (r.refund_tax  * c.prev) / c.total AS tax
    FROM ev_cum c
    JOIN refunded r ON r.id = c.invoice_id
    WHERE c.at >= v_from AND c.at < v_to
  ),
  refunds AS (
    SELECT day, sum(face)::bigint AS face_cents, sum(tax)::bigint AS tax_cents
    FROM refund_parts GROUP BY day
  ),
  days AS (
    SELECT d::date AS day,
           coalesce(ch.invoices_paid, 0)                            AS invoices_paid,
           coalesce(ch.gross_cents, 0)                              AS gross_charged_cents,
           coalesce(rf.face_cents, 0)                               AS refunds_cents,
           coalesce(ch.gross_cents, 0) - coalesce(rf.face_cents, 0) AS net_collected_cents,
           coalesce(ch.tax_cents, 0)   - coalesce(rf.tax_cents, 0)  AS tax_cents
    FROM generate_series(p_from_day, p_to_day, interval '1 day') AS d
    LEFT JOIN charged ch ON ch.day = d::date
    LEFT JOIN refunds rf ON rf.day = d::date
  )
  SELECT json_build_object(
    'tz',       v_tz,
    'from_day', p_from_day,
    'to_day',   p_to_day,
    'days', (
      SELECT coalesce(json_agg(json_build_object(
               'day',                 days.day,
               'invoices_paid',       days.invoices_paid,
               'gross_charged_cents', days.gross_charged_cents,
               'refunds_cents',       days.refunds_cents,
               'net_collected_cents', days.net_collected_cents,
               'tax_cents',           days.tax_cents,
               'net_revenue_cents',   days.net_collected_cents - days.tax_cents
             ) ORDER BY days.day), '[]'::json)
      FROM days
    ),
    'totals', (
      SELECT json_build_object(
               'invoices_paid',       coalesce(sum(invoices_paid), 0)::bigint,
               'gross_charged_cents', coalesce(sum(gross_charged_cents), 0)::bigint,
               'refunds_cents',       coalesce(sum(refunds_cents), 0)::bigint,
               'net_collected_cents', coalesce(sum(net_collected_cents), 0)::bigint,
               'tax_cents',           coalesce(sum(tax_cents), 0)::bigint,
               'net_revenue_cents',   coalesce(sum(net_collected_cents - tax_cents), 0)::bigint
             )
      FROM days
    )
  ) INTO result;

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.operator_money_daily(DATE, DATE, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.operator_money_daily(DATE, DATE, TEXT) TO authenticated;

COMMENT ON FUNCTION public.operator_money_daily(DATE, DATE, TEXT) IS
  '0417: the console''s per-day money, operator-scoped, inclusive '
  '[p_from_day, p_to_day] in p_tz. Same invoice set as operator_money_summary '
  '(paid / partially_refunded / refunded). gross_charged (incl. tax) on the '
  'paid_at day; refunds (cash + credit face) on the day issued, dated from '
  'operator_audit_log refund rows and sized from the invoice accumulators; '
  'net_collected = gross - refunds; tax = tax charged - tax refunded; '
  'net_revenue = net_collected - tax. Replaces every status=''paid'' revenue sum.';

-- ---------------------------------------------------------------------------
-- 2. operator_engagement_report — gmv_cents no longer drops refunded invoices
-- ---------------------------------------------------------------------------
-- Body = 0225 with two money lines changed (marked 0417).
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
      -- 0417: a later refund doesn't mean the bidder never paid.
      'paid',       (SELECT count(DISTINCT bidder_id) FROM public.invoices
                     WHERE status::text IN ('paid', 'partially_refunded', 'refunded'))
    ),
    'daily', (
      SELECT coalesce(json_agg(json_build_object(
        'day', d.day,
        'signups', (SELECT count(*) FROM public.bidders b
                    WHERE b.deleted_at IS NULL AND (b.created_at AT TIME ZONE p_tz)::date = d.day),
        'bids', (SELECT count(*) FROM public.bids bd
                 WHERE (bd.placed_at AT TIME ZONE p_tz)::date = d.day),
        -- 0417: gross charged (incl. tax) by paid_at over the Money page's
        -- invoice set. Was status = 'paid', which dropped every invoice with
        -- a partial refund. Net figures: operator_money_daily.
        'gmv_cents', (SELECT coalesce(sum(i.total_cents), 0) FROM public.invoices i
                      WHERE i.status::text IN ('paid', 'partially_refunded', 'refunded')
                        AND (i.paid_at AT TIME ZONE p_tz)::date = d.day)
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

REVOKE EXECUTE ON FUNCTION public.operator_engagement_report(text, int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.operator_engagement_report(text, int) TO authenticated;

-- ---------------------------------------------------------------------------
-- 3. operator_ops_health — paid_24h_cents no longer drops refunded invoices
-- ---------------------------------------------------------------------------
-- Body = 0227 with the one paid_24h_cents line changed (marked 0417).
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
      -- 0417: gross charged (incl. tax) in the last 24 h over the Money page's
      -- invoice set. Was status = 'paid', which dropped partially refunded invoices.
      'paid_24h_cents',(SELECT coalesce(sum(total_cents),0) FROM invoices WHERE status::text IN ('paid','partially_refunded','refunded') AND paid_at > now() - interval '24 hours')
    ),

    'engine', json_build_object(
      'lots_overdue_finalize', (SELECT count(*) FROM lots WHERE status::text = 'live' AND close_at IS NOT NULL AND close_at < now() - interval '2 minutes')
    )
  ) INTO result;

  RETURN result;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.operator_ops_health() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.operator_ops_health() TO authenticated;

COMMIT;
