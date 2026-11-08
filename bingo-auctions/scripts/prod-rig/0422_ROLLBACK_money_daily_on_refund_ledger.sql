-- ROLLBACK for 0422_money_daily_on_refund_ledger.sql — written, never run.
--
-- Restores operator_money_daily verbatim as 0417 defined it (its own
-- proportional split of refunds over operator_audit_log rows). Signature,
-- grants and output keys are identical, so the console needs no rollback.
-- To go back further (drop the function, restore the status='paid' rule),
-- run scripts/prod-rig/0417_ROLLBACK_money_daily_revenue.sql after this.
-- Locks: CREATE OR REPLACE FUNCTION only; no table locks.

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

COMMIT;
