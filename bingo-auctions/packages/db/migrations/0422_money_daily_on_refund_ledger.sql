-- 0422 — per-day money reads the one refund ledger (operator_refund_ledger)
--
-- Owner ask (Braden, 2026-10-14): one refund-date source for the whole
-- console. 0417 gave operator_money_daily its own split of refunds over
-- operator_audit_log rows (proportional to each row's amount). 0421 then added
-- operator_refund_ledger(op), which the Money page (operator_money_summary)
-- and /reports (operator_reports_period_summary) both read. Two splits of the
-- same refunds could put a cent — or, on the 3 invoices whose audit rows sum
-- above their accumulator (pre-0270 rows), whole dollars — on a different day
-- than the Money page does. Now operator_money_daily takes each refund's date
-- and amounts straight from the ledger, so over any range:
--   Σ days.refunds_cents = operator_money_summary face refunded
--                        = operator_reports_period_summary refunded_face_cents
-- and Σ days.tax_cents   = operator_money_summary net_tax_cents.
--
-- Why a new number and not an edit of 0417: migrations apply in number order
-- and 0417 < 0421, so 0417 cannot call the ledger.
--
-- Unchanged: signature (date, date, text), SECURITY DEFINER, grants, output
-- keys, invoice set, sales on the paid_at day, range checks. Changed: only the
-- refund side (date + face + tax per refund now = ledger rows).
-- operator_engagement_report and operator_ops_health (also touched by 0417)
-- do not date refunds — they sum gross charged by paid_at — so they stay as
-- 0417 left them.
--
-- The ledger is not granted to authenticated; this function is SECURITY
-- DEFINER (owner = migration role) and resolves the operator from auth.uid()
-- before calling it, exactly as the two 0421 report functions do.
--
-- Locks: CREATE OR REPLACE FUNCTION only. No table is altered, no index is
-- built, no row is written. Rollback (restores 0417's definition):
-- scripts/prod-rig/0422_ROLLBACK_money_daily_on_refund_ledger.sql

BEGIN;

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

  WITH charged AS (
    -- The Money page's invoice set (operator_money_summary), on the paid_at day.
    SELECT (i.paid_at AT TIME ZONE v_tz)::date             AS day,
           count(*)                                         AS invoices_paid,
           sum(coalesce(i.total_cents, 0))::bigint          AS gross_cents,
           sum(coalesce(i.tax_cents, 0))::bigint            AS tax_cents
    FROM public.invoices i
    WHERE i.operator_id = v_op
      AND i.status::text IN ('paid', 'partially_refunded', 'refunded')
      AND i.paid_at >= v_from AND i.paid_at < v_to
    GROUP BY 1
  ),
  refunds AS (
    -- 0422: the same refund rows the Money page and /reports read (0421).
    SELECT (r.refunded_at AT TIME ZONE v_tz)::date AS day,
           sum(r.face_cents)::bigint               AS face_cents,
           sum(r.tax_cents)::bigint                AS tax_cents
    FROM public.operator_refund_ledger(v_op) r
    WHERE r.refunded_at >= v_from AND r.refunded_at < v_to
    GROUP BY 1
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
  '0422: the console''s per-day money, operator-scoped, inclusive '
  '[p_from_day, p_to_day] in p_tz. Same invoice set as operator_money_summary '
  '(paid / partially_refunded / refunded). gross_charged (incl. tax) on the '
  'paid_at day; refunds (cash + credit face) and tax refunded on the refund '
  'date from operator_refund_ledger (0421) — the same rows the Money page and '
  '/reports read; net_collected = gross - refunds; tax = tax charged - tax '
  'refunded; net_revenue = net_collected - tax. Supersedes 0417''s own split.';

COMMIT;
