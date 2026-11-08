-- 0418: operator_reports_period_summary(from, to) — /reports totals in the DB
--
-- Bug (2026-10-14): /reports loaded the period's paid invoices with
-- .limit(1000) and summed them in JavaScript. A range with 1,677 invoices
-- showed net revenue $25,295.63 instead of $41,846.26 — the page silently
-- summed only the newest 1,000 rows. The "Prior 3 months" table had the same
-- shape (PostgREST's own row cap applies even without .limit()).
--
-- Fix: every money total on /reports now comes from this one function. The
-- invoice list on the page stays paginated and never drives a total.
--
-- Money definitions are operator_money_summary's (mig 0287) so /reports and
-- /reports/money agree to the cent for the same range:
--   gross_charged  = sum(total_cents)
--   refunded_face  = sum(refunded_cash_cents + refunded_credit_cents)
--   net_collected  = gross_charged − refunded_face        ("Total collected")
--   net_tax        = sum(tax_cents) − sum(refunded_tax_cents)
--   net_revenue    = greatest(0, net_collected − net_tax)  (Money page formula)
-- Same bucketing too: invoices in status paid / partially_refunded / refunded
-- with paid_at in [p_from, p_to). Refunds therefore land in the period the
-- invoice was PAID (as on the Money page), not the period they were issued.
-- The caller passes the bounds already converted from the warehouse wall
-- clock (America/Chicago), exactly as the Money page does.
--
-- The hammer / buyer's-premium split net of refunds: hammer is the page's
-- existing per-invoice proration (non-tax refund spread across hammer +
-- premium, rounded), moved here unchanged; premium = net_revenue − hammer, so
-- the cards always add up to the Money page's net revenue. On clean data this
-- equals the old per-row premium exactly (verified on 3,000 random invoices);
-- it differs only where refunded_tax_cents > tax_cents (5 of 10,905 paid
-- invoices in prod on 2026-10-14), where the old JS clamped tax per row and
-- the Money page does not.
--
-- Read-only: STABLE, no table changes, no locks beyond a plain SELECT's
-- ACCESS SHARE. SECURITY DEFINER + search_path pinned, operator resolved from
-- auth.uid() — the operator_money_summary pattern.

BEGIN;

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

COMMIT;
