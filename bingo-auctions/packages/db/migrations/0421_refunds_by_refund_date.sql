-- 0421 — refunds counted on the day they were REFUNDED, not the day paid
--
-- Owner ask (Braden, 2026-10-14): on the Money page (operator_money_summary,
-- mig 0287) and /reports (operator_reports_period_summary, mig 0418) a refund
-- was subtracted in the period the invoice was PAID. An invoice paid in
-- September and refunded in October rewrote September's numbers in October,
-- and October never showed the money going back. Now:
--   * sales (gross charged, hammer, premium, tax, invoice count) stay on the
--     invoice's paid_at, as before;
--   * every refund figure (cash, store credit, tax refunded, and the hammer
--     share of the refund on /reports) lands on the refund's own timestamp.
-- Both functions keep their signatures and their output keys. Both read the
-- same refund ledger (operator_refund_ledger below), so the two pages still
-- agree to the cent for any range. All-time totals are unchanged.
--
-- ── Where a refund's date comes from ─────────────────────────────────────────
-- invoices.refunded_at is ONE timestamp per invoice (the first refund), and
-- invoice_lots.refunded_at has a time but no amount. The only per-refund
-- amount + timestamp record is operator_audit_log, written by both refund
-- routes after the money moves:
--   'invoice.refund'      (whole/amount refund)  after_state.cash_cents + credit_cents
--   'invoice.refund_item' (one row per lot)      after_state.amount_cents (face)
-- refund_jobs is the dead Stripe-era queue (no writer since the Square move).
-- Prod check 2026-10-14: 2,015 invoices carry a refund; ALL 2,015 have audit
-- rows, 2,012 sum to the invoice's refunded face exactly. The other 3 also
-- have refund rows from before mig 0270 started the accumulators (July 8-15)
-- — the audit sum is higher than what the invoice counts. 133 invoices have
-- audit rows from before 0270 and a refunded face of 0.
--
-- ── How the ledger splits an invoice's refunds over time ─────────────────────
-- The invoice accumulators (refunded_cash/credit/tax_cents, mig 0270) stay the
-- source of truth for HOW MUCH; the audit rows only say WHEN.
--   1. Face: walk the invoice's audit rows newest first and give each one its
--      amount until the invoice's refunded face is used up. So pre-0270 rows
--      the accumulators never counted get 0 (and invoices with face 0 get
--      nothing), and on clean invoices every refund gets exactly its amount.
--   2. Any face no audit row covers (an audit insert that failed) goes to the
--      invoice's latest known refund moment: greatest(last audit row,
--      invoices.refunded_at), else paid_at.
--   3. Cash, tax, and the hammer reduction are spread over those pieces in
--      proportion to face, with cumulative rounding so each invoice's pieces
--      add up to its stored totals to the cent. Credit = face − cash.
-- The hammer reduction is exactly the per-invoice proration 0418 used
-- (hammer − round(hammer × (hammer+premium − non-tax refund)/(hammer+premium))),
-- so /reports' all-time hammer is unchanged too.
--
-- Consequence worth knowing: a period can now show a refund for an invoice
-- that was paid in an earlier period, so a quiet day with big refunds shows
-- NEGATIVE net collected / net revenue. That is the point — it is when the
-- money left. So /reports' net_revenue and premium_net are no longer clamped
-- at 0 (0418 clamped the aggregate, which could only bind on such a period),
-- and premium_net = net_revenue − hammer_net always. The Money page drops its
-- matching Math.max(0, …) in the same change.
--
-- Read-only: functions only. No table changes, no locks beyond a plain
-- SELECT's ACCESS SHARE when the functions run.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. operator_refund_ledger(operator) — one row per refund, with its date
-- ---------------------------------------------------------------------------
-- INTERNAL: takes an operator id, so it is NOT executable by anon or
-- authenticated (it would let one operator read another's refunds). Called
-- only from the two SECURITY DEFINER report functions below, which resolve the
-- operator from auth.uid().
CREATE OR REPLACE FUNCTION public.operator_refund_ledger(p_operator_id UUID)
RETURNS TABLE (
  invoice_id     UUID,
  invoice_status TEXT,
  refunded_at    TIMESTAMPTZ,
  face_cents     BIGINT,
  cash_cents     BIGINT,
  credit_cents   BIGINT,
  tax_cents      BIGINT,
  hammer_cents   BIGINT
)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  WITH inv AS (
    SELECT
      i.id,
      i.status::text                                   AS status,
      i.paid_at,
      i.refunded_at                                    AS first_refunded_at,
      (coalesce(i.refunded_cash_cents, 0)
        + coalesce(i.refunded_credit_cents, 0))::bigint AS face,
      coalesce(i.refunded_cash_cents, 0)::bigint       AS cash,
      coalesce(i.refunded_tax_cents, 0)::bigint        AS rtax,
      -- 0418's per-invoice hammer proration, as the amount it REMOVES.
      coalesce(i.subtotal_cents, 0)::bigint - CASE
        WHEN coalesce(i.subtotal_cents, 0) + coalesce(i.buyer_premium_cents, 0) > 0 THEN
          greatest(0, round(
            coalesce(i.subtotal_cents, 0)::numeric
            * ((coalesce(i.subtotal_cents, 0) + coalesce(i.buyer_premium_cents, 0))
               - greatest(0, (coalesce(i.refunded_cash_cents, 0)
                              + coalesce(i.refunded_credit_cents, 0))
                             - coalesce(i.refunded_tax_cents, 0)))
            / (coalesce(i.subtotal_cents, 0) + coalesce(i.buyer_premium_cents, 0))
          ))::bigint
        ELSE coalesce(i.subtotal_cents, 0)::bigint
      END                                              AS hammer_cut
    FROM public.invoices i
    WHERE i.operator_id = p_operator_id
      AND i.status::text IN ('paid', 'partially_refunded', 'refunded')
      AND coalesce(i.refunded_cash_cents, 0) + coalesce(i.refunded_credit_cents, 0) > 0
  ),
  ev AS (
    SELECT
      l.target_id   AS invoice_id,
      l.id          AS seq,
      l.created_at  AS at,
      greatest(0, CASE
        WHEN l.action_type = 'invoice.refund' THEN
          coalesce((l.after_state->>'cash_cents')::bigint, 0)
          + coalesce((l.after_state->>'credit_cents')::bigint, 0)
        ELSE coalesce((l.after_state->>'amount_cents')::bigint, 0)
      END)          AS amt
    FROM public.operator_audit_log l
    JOIN inv ON inv.id = l.target_id
    WHERE l.action_type IN ('invoice.refund', 'invoice.refund_item')
  ),
  -- Newest first: each audit row takes its amount until the face is used up.
  filled AS (
    SELECT
      ev.invoice_id, ev.seq, ev.at,
      least(ev.amt, greatest(0, inv.face - coalesce(sum(ev.amt) OVER (
        PARTITION BY ev.invoice_id ORDER BY ev.at DESC, ev.seq DESC
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)))  AS part
    FROM ev JOIN inv ON inv.id = ev.invoice_id
  ),
  pieces AS (
    SELECT invoice_id, seq, at, part FROM filled WHERE part > 0
    UNION ALL
    -- Face no audit row covers: the latest known refund moment.
    SELECT
      inv.id,
      9223372036854775807::bigint,
      coalesce(greatest(f.last_at, inv.first_refunded_at), inv.paid_at),
      inv.face - coalesce(f.covered, 0)
    FROM inv
    LEFT JOIN (
      SELECT invoice_id, sum(part) AS covered, max(at) AS last_at
      FROM filled GROUP BY invoice_id
    ) f ON f.invoice_id = inv.id
    WHERE inv.face - coalesce(f.covered, 0) > 0
  ),
  cum AS (
    SELECT
      p.invoice_id, p.at, p.part, inv.status, inv.face, inv.cash, inv.rtax, inv.hammer_cut,
      sum(p.part) OVER (PARTITION BY p.invoice_id ORDER BY p.at, p.seq
                        ROWS UNBOUNDED PRECEDING)               AS upto
    FROM pieces p JOIN inv ON inv.id = p.invoice_id
  ),
  alloc AS (
    SELECT
      c.invoice_id, c.status, c.at, c.part,
      (round(c.cash::numeric * c.upto / c.face)
        - round(c.cash::numeric * (c.upto - c.part) / c.face))::bigint       AS cash_part,
      (round(c.rtax::numeric * c.upto / c.face)
        - round(c.rtax::numeric * (c.upto - c.part) / c.face))::bigint       AS tax_part,
      (round(c.hammer_cut::numeric * c.upto / c.face)
        - round(c.hammer_cut::numeric * (c.upto - c.part) / c.face))::bigint AS hammer_part
    FROM cum c
  )
  SELECT invoice_id, status, at, part, cash_part, part - cash_part, tax_part, hammer_part
  FROM alloc;
$$;

REVOKE ALL ON FUNCTION public.operator_refund_ledger(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.operator_refund_ledger(UUID) FROM anon, authenticated;

COMMENT ON FUNCTION public.operator_refund_ledger(UUID) IS
  '0421: INTERNAL (not granted to anon/authenticated). One row per refund for '
  'the operator: when (operator_audit_log invoice.refund / invoice.refund_item '
  'created_at) and how much (the invoice''s refunded_* accumulators, mig 0270, '
  'spread over its refunds). Each invoice''s rows sum to its stored totals. '
  'Read by operator_money_summary and operator_reports_period_summary so both '
  'pages count refunds on the refund date.';

-- ---------------------------------------------------------------------------
-- 2. operator_money_summary — 0287's body, refunds by refund date
-- ---------------------------------------------------------------------------
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
  -- 0421: refunds issued in the window, whenever the invoice was paid.
  refunds AS (
    SELECT *
    FROM public.operator_refund_ledger(v_op) r
    WHERE (p_from IS NULL OR r.refunded_at >= p_from)
      AND (p_to   IS NULL OR r.refunded_at <  p_to)
  ),
  owed AS (
    SELECT *
    FROM public.invoices i
    WHERE i.operator_id = v_op
      AND i.paid_at IS NULL
      AND i.status::text NOT IN ('canceled', 'void', 'refunded')
  )
  SELECT json_build_object(
    -- What bidders were charged, broken into its parts (by paid_at).
    'invoices',              (SELECT count(*) FROM collected),
    'hammer_cents',          (SELECT coalesce(sum(subtotal_cents), 0)      FROM collected),
    'premium_cents',         (SELECT coalesce(sum(buyer_premium_cents), 0) FROM collected),
    'tax_cents',             (SELECT coalesce(sum(tax_cents), 0)           FROM collected),
    'gross_charged_cents',   (SELECT coalesce(sum(total_cents), 0)         FROM collected),
    -- Refunds actually returned IN THE WINDOW (by refund date).
    'refunded_cash_cents',   (SELECT coalesce(sum(cash_cents), 0)   FROM refunds),
    'refunded_credit_cents', (SELECT coalesce(sum(credit_cents), 0) FROM refunds),
    'refunded_tax_cents',    (SELECT coalesce(sum(tax_cents), 0)    FROM refunds),
    -- Net of refunds. net_revenue excludes sales tax (owed to the state).
    'net_collected_cents', (
      (SELECT coalesce(sum(total_cents), 0) FROM collected)
      - (SELECT coalesce(sum(face_cents), 0) FROM refunds)
    ),
    'net_tax_cents', (
      (SELECT coalesce(sum(tax_cents), 0) FROM collected)
      - (SELECT coalesce(sum(tax_cents), 0) FROM refunds)
    ),
    -- Square side: fees + what actually lands in the bank.
    'square_fee_cents',       (SELECT coalesce(sum(square_processing_fee_cents), 0) FROM collected),
    'square_fee_known_count', (SELECT count(square_processing_fee_cents)            FROM collected),
    'square_payment_count',   (SELECT count(square_payment_id)                      FROM collected),
    -- Cash / manual "mark paid" — real revenue that never touches Square.
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
    -- Invoices paid in the window by status, plus refunds issued in the
    -- window grouped by the refunded invoice's current status.
    'by_status', (
      SELECT coalesce(json_agg(x ORDER BY x->>'status'), '[]'::json)
      FROM (
        SELECT json_build_object(
                 'status', s.status,
                 'invoices', coalesce(g.invoices, 0),
                 'gross_cents', coalesce(g.gross_cents, 0),
                 'refunded_cents', coalesce(rf.refunded_cents, 0)
               ) AS x
        FROM (
          SELECT status::text AS status FROM collected
          UNION
          SELECT invoice_status FROM refunds
        ) s
        LEFT JOIN (
          SELECT status::text AS status, count(*) AS invoices,
                 sum(total_cents) AS gross_cents
          FROM collected GROUP BY status::text
        ) g ON g.status = s.status
        LEFT JOIN (
          SELECT invoice_status AS status, sum(face_cents) AS refunded_cents
          FROM refunds GROUP BY invoice_status
        ) rf ON rf.status = s.status
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
  '0421: every component of the operator''s money over [p_from, p_to) '
  '(NULL = all time). Sales (hammer, premium, tax, gross charged, Square fees, '
  'offline, platform fees) by paid_at; refunds (cash, credit, tax refunded) by '
  'the refund''s own date via operator_refund_ledger; net = sales − refunds. '
  'Supersedes 0287.';

-- ---------------------------------------------------------------------------
-- 3. operator_reports_period_summary — 0418's body, refunds by refund date
-- ---------------------------------------------------------------------------
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

  WITH sales AS (
    SELECT
      count(*)                                    AS invoices,
      coalesce(sum(i.total_cents), 0)::bigint     AS gross_charged,
      coalesce(sum(i.tax_cents), 0)::bigint       AS tax,
      coalesce(sum(i.subtotal_cents), 0)::bigint  AS hammer
    FROM public.invoices i
    WHERE i.operator_id = v_op
      AND i.status::text IN ('paid', 'partially_refunded', 'refunded')
      AND (p_from IS NULL OR i.paid_at >= p_from)
      AND (p_to   IS NULL OR i.paid_at <  p_to)
  ),
  -- 0421: refunds issued in the window, whenever the invoice was paid.
  refunds AS (
    SELECT
      coalesce(sum(r.face_cents), 0)::bigint      AS refunded_face,
      coalesce(sum(r.tax_cents), 0)::bigint       AS refunded_tax,
      coalesce(sum(r.hammer_cents), 0)::bigint    AS hammer_cut
    FROM public.operator_refund_ledger(v_op) r
    WHERE (p_from IS NULL OR r.refunded_at >= p_from)
      AND (p_to   IS NULL OR r.refunded_at <  p_to)
  ),
  fin AS (
    SELECT
      s.invoices, s.gross_charged, s.tax, r.refunded_face, r.refunded_tax,
      s.hammer - r.hammer_cut                                      AS net_hammer,
      -- Not clamped at 0 any more: a period whose refunds outweigh its sales
      -- really did lose money (0418 clamped; only reachable now).
      (s.gross_charged - r.refunded_face) - (s.tax - r.refunded_tax) AS net_revenue
    FROM sales s CROSS JOIN refunds r
  )
  SELECT json_build_object(
    'invoices',             a.invoices,
    'gross_charged_cents',  a.gross_charged,
    'refunded_face_cents',  a.refunded_face,
    'net_collected_cents',  a.gross_charged - a.refunded_face,
    'net_tax_cents',        a.tax - a.refunded_tax,
    'net_revenue_cents',    a.net_revenue,
    'hammer_net_cents',     a.net_hammer,
    'premium_net_cents',    a.net_revenue - a.net_hammer
  ) INTO result
  FROM fin a;

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.operator_reports_period_summary(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.operator_reports_period_summary(TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;

COMMENT ON FUNCTION public.operator_reports_period_summary(TIMESTAMPTZ, TIMESTAMPTZ) IS
  '0421: every money total on /reports over [p_from, p_to) (NULL = all time), '
  'for the caller''s operator. Sales by paid_at, refunds by the refund''s own '
  'date (operator_refund_ledger) — same definitions and same ledger as '
  'operator_money_summary. hammer_net = hammer sold − hammer share of refunds '
  'issued; premium_net = net revenue − hammer_net. Supersedes 0418.';

COMMIT;
