-- Rollback for 0421_refunds_by_refund_date.sql — standby only.
-- Puts refunds back in the period the invoice was PAID:
--   * operator_money_summary          → master's definition (mig 0287), verbatim
--   * operator_reports_period_summary → mig 0418's definition, verbatim
--   * operator_refund_ledger          → dropped (only the two functions above
--                                       call it; they are replaced first)
-- Functions only — no data to restore, no locks on lots/bids/invoices.
-- The operator-web labels ("Refunds (by refund date)") would then be wrong:
-- roll the operator-web deploy back with it.

BEGIN;

-- ── operator_money_summary, as in 0287 ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.operator_money_summary(
  p_from TIMESTAMPTZ DEFAULT NULL,
  p_to   TIMESTAMPTZ DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_op   UUID;
  result json;
BEGIN
  SELECT operator_id INTO v_op
  FROM public.operator_users WHERE user_id = auth.uid() LIMIT 1;
  IF v_op IS NULL THEN
    RAISE EXCEPTION 'not_operator_staff' USING ERRCODE = '42501';
  END IF;

  WITH collected AS (
    SELECT *
    FROM public.invoices i
    WHERE i.operator_id = v_op
      AND i.status::text IN ('paid', 'partially_refunded', 'refunded')
      AND (p_from IS NULL OR i.paid_at >= p_from)
      AND (p_to   IS NULL OR i.paid_at <  p_to)
  ),
  owed AS (
    SELECT *
    FROM public.invoices i
    WHERE i.operator_id = v_op
      AND i.paid_at IS NULL
      AND i.status::text NOT IN ('canceled', 'void', 'refunded')
  )
  SELECT json_build_object(
    -- What bidders were charged, broken into its parts.
    'invoices',              (SELECT count(*) FROM collected),
    'hammer_cents',          (SELECT coalesce(sum(subtotal_cents), 0)      FROM collected),
    'premium_cents',         (SELECT coalesce(sum(buyer_premium_cents), 0) FROM collected),
    'tax_cents',             (SELECT coalesce(sum(tax_cents), 0)           FROM collected),
    'gross_charged_cents',   (SELECT coalesce(sum(total_cents), 0)         FROM collected),
    -- Refunds actually returned.
    'refunded_cash_cents',   (SELECT coalesce(sum(refunded_cash_cents), 0)   FROM collected),
    'refunded_credit_cents', (SELECT coalesce(sum(refunded_credit_cents), 0) FROM collected),
    'refunded_tax_cents',    (SELECT coalesce(sum(refunded_tax_cents), 0)    FROM collected),
    -- Net of refunds. net_revenue excludes sales tax (owed to the state).
    'net_collected_cents', (
      SELECT coalesce(sum(total_cents)
             - sum(coalesce(refunded_cash_cents,0) + coalesce(refunded_credit_cents,0)), 0)
      FROM collected
    ),
    'net_tax_cents', (
      SELECT coalesce(sum(tax_cents) - sum(coalesce(refunded_tax_cents,0)), 0)
      FROM collected
    ),
    -- Square side: fees + what actually lands in the bank.
    'square_fee_cents',       (SELECT coalesce(sum(square_processing_fee_cents), 0) FROM collected),
    'square_fee_known_count', (SELECT count(square_processing_fee_cents)            FROM collected),
    'square_payment_count',   (SELECT count(square_payment_id)                      FROM collected),
    -- Cash / manual "mark paid" — real revenue that never touches Square, so
    -- it legitimately will NOT appear in a Square total.
    'offline_paid_count', (
      SELECT count(*) FROM collected WHERE square_payment_id IS NULL
    ),
    'offline_paid_cents', (
      SELECT coalesce(sum(total_cents), 0) FROM collected WHERE square_payment_id IS NULL
    ),
    'platform_fee_cents',  (SELECT coalesce(sum(application_fee_cents), 0) FROM collected),
    -- Still owed.
    'unpaid_count',        (SELECT count(*) FROM owed),
    'unpaid_cents',        (SELECT coalesce(sum(total_cents), 0) FROM owed),
    'by_status', (
      SELECT coalesce(json_agg(x ORDER BY x->>'status'), '[]'::json)
      FROM (
        SELECT json_build_object(
                 'status', status::text,
                 'invoices', count(*),
                 'gross_cents', coalesce(sum(total_cents), 0),
                 'refunded_cents', coalesce(sum(
                   coalesce(refunded_cash_cents,0) + coalesce(refunded_credit_cents,0)), 0)
               ) AS x
        FROM collected GROUP BY status::text
      ) q
    ),
    'first_paid_at', (SELECT min(paid_at) FROM collected),
    'last_paid_at',  (SELECT max(paid_at) FROM collected)
  ) INTO result;

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.operator_money_summary(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.operator_money_summary(TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;

COMMENT ON FUNCTION public.operator_money_summary(TIMESTAMPTZ, TIMESTAMPTZ) IS
  '0287: every component of the operator''s money over [p_from, p_to) by '
  'paid_at (NULL = all time): hammer, premium, tax, gross charged, refunds, '
  'net collected, Square fees + payment counts, offline/cash paid, platform '
  'fees, and unpaid. Built so platform figures can be reconciled line-by-line '
  'against a Square total.';

-- ── operator_reports_period_summary, as in 0418 ─────────────────────────────
CREATE OR REPLACE FUNCTION public.operator_reports_period_summary(
  p_from TIMESTAMPTZ DEFAULT NULL,
  p_to   TIMESTAMPTZ DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_op   UUID;
  result json;
BEGIN
  SELECT operator_id INTO v_op
  FROM public.operator_users WHERE user_id = auth.uid() LIMIT 1;
  IF v_op IS NULL THEN
    RAISE EXCEPTION 'not_operator_staff' USING ERRCODE = '42501';
  END IF;

  WITH collected AS (
    SELECT
      coalesce(i.subtotal_cents, 0)::bigint        AS hammer,
      coalesce(i.buyer_premium_cents, 0)::bigint   AS premium,
      coalesce(i.tax_cents, 0)::bigint             AS tax,
      coalesce(i.total_cents, 0)::bigint           AS total,
      (coalesce(i.refunded_cash_cents, 0)
        + coalesce(i.refunded_credit_cents, 0))::bigint AS refunded_face,
      coalesce(i.refunded_tax_cents, 0)::bigint    AS refunded_tax
    FROM public.invoices i
    WHERE i.operator_id = v_op
      AND i.status::text IN ('paid', 'partially_refunded', 'refunded')
      AND (p_from IS NULL OR i.paid_at >= p_from)
      AND (p_to   IS NULL OR i.paid_at <  p_to)
  ),
  -- Per-invoice split, identical to the JS it replaces (reports/page.tsx).
  per_row AS (
    SELECT
      c.*,
      CASE
        WHEN c.hammer + c.premium > 0 THEN
          greatest(0, round(
            c.hammer::numeric
            * ((c.hammer + c.premium) - greatest(0, c.refunded_face - c.refunded_tax))
            / (c.hammer + c.premium)
          ))::bigint
        ELSE c.hammer
      END                                                       AS eff_hammer
    FROM collected c
  ),
  agg AS (
    SELECT
      count(*)                                                  AS invoices,
      coalesce(sum(total), 0)                                   AS gross_charged,
      coalesce(sum(refunded_face), 0)                           AS refunded_face,
      coalesce(sum(tax), 0)                                     AS tax,
      coalesce(sum(refunded_tax), 0)                            AS refunded_tax,
      coalesce(sum(eff_hammer), 0)                              AS net_hammer
    FROM per_row
  ),
  fin AS (
    SELECT
      a.*,
      greatest(0, (a.gross_charged - a.refunded_face)
                  - (a.tax - a.refunded_tax))                   AS net_revenue
    FROM agg a
  )
  SELECT json_build_object(
    'invoices',             a.invoices,
    'gross_charged_cents',  a.gross_charged,
    'refunded_face_cents',  a.refunded_face,
    'net_collected_cents',  a.gross_charged - a.refunded_face,
    'net_tax_cents',        a.tax - a.refunded_tax,
    'net_revenue_cents',    a.net_revenue,
    'hammer_net_cents',     a.net_hammer,
    'premium_net_cents',    greatest(0, a.net_revenue - a.net_hammer)
  ) INTO result
  FROM fin a;

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.operator_reports_period_summary(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.operator_reports_period_summary(TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;

COMMENT ON FUNCTION public.operator_reports_period_summary(TIMESTAMPTZ, TIMESTAMPTZ) IS
  '0418: every money total on /reports over [p_from, p_to) by paid_at (NULL = '
  'all time), for the caller''s operator. Same definitions as '
  'operator_money_summary (gross charged, refunds, net collected, net tax, '
  'net revenue) plus the page''s per-invoice hammer/premium split net of '
  'refunds. Replaces a JS sum over the first 1,000 rows.';

DROP FUNCTION IF EXISTS public.operator_refund_ledger(UUID);

COMMIT;
