-- 0287 — money truth: auction gross from PAID invoice lines + full money summary
--
-- Owner report 2026-07-24: "the money on bingo dashboard and auction reports
-- isn't correct and it changes as days go by; in Square our sales are way more
-- substantial and the deposits."
--
-- ── Root cause of "changes as days go by" ────────────────────────────────────
-- operator_auction_performance (0225, replaced by 0240) derives BOTH `sold` and
-- `gross_cents` from the lot's CURRENT status:
--     count(*)           FILTER (WHERE l.status = 'won')
--     sum(current_bid_cents) FILTER (WHERE l.status = 'won')
-- But a lot that sold AND WAS PAID FOR gets flipped OUT of 'won' by ordinary
-- post-sale operations:
--     • pickup no-show  → auto_mark_pickup_no_show (0155:146) sets 'unsold'
--     • forfeit         → 0166 (operator KEEPS the money)
--     • carryover/relot → relist_lot_into_auction sets 'relisted'
-- So a CLOSED auction's revenue silently shrinks days later.
--
-- Measured against prod 2026-07-24, the status-driven gross is wrong THREE ways
-- at once (old $26,588.73 vs actually-collected $24,096.58 — net OVERSTATED by
-- $2,492.15, while also drifting):
--   (a) OVERSTATES: refunds are never deducted. A refund leaves the lot in
--       'won' (0245 deliberately keeps refunded lots out of the 'unsold'
--       requeue), so $2,731.40 of returned money still counted as revenue.
--   (b) OVERSTATES: lots that closed 'won' but were NEVER PAID (payment_failed
--       _grace / _relisted invoices) counted as revenue on hammer alone.
--   (c) UNDERSTATES + DRIFTS: paid lots flipped out of 'won' by no-show /
--       forfeit / carryover silently leave gross — 67 such lots, and the
--       number grows every day.
--
-- ── Fix (owner decision 2026-07-24) ──────────────────────────────────────────
-- Money now comes from what was actually COLLECTED, not from lot status:
--   gross_cents    = Σ invoice_lots.winning_bid_cents on paid, NON-refunded lines
--   refunded_cents = Σ invoice_lots.winning_bid_cents on paid, REFUNDED lines
--   sold           = lots with a paid, non-refunded line
-- A refund is the ONLY thing that reduces a closed auction's gross — which is
-- correct, because a refund is the only thing that actually returns money.
-- invoice_lots.winning_bid_cents is the immutable hammer captured at sale, so
-- these figures stop moving once the auction settles and its refunds land.
-- This simultaneously fixes (a) refunds are now deducted, (b) unpaid winners no
-- longer count, and (c) paid no-shows stay counted.
--
-- The lot-status movement stays VISIBLE rather than silently eating revenue:
--   returned_lots  = paid lots whose item came back (status no longer 'won')
--   refunded_lots  = paid lots whose invoice line was refunded
-- and `unsold` now means "never sold" (no paid line) so it can't double-count a
-- no-showed lot that IS in the sold/gross figures.
--
-- Scope note: this function is deliberately left operator-UNSCOPED, exactly as
-- 0225/0240 had it (single-operator platform, staff-gated). Only the money math
-- changes here — which auctions appear is untouched.
--
-- Also adds:
--   • invoices.square_processing_fee_cents / square_net_cents — so Square
--     DEPOSITS become reconcilable from the platform (we stored no fee data at
--     all, which is why deposits could never be matched). Populated by the
--     webhook + a square-sync backfill sweep.
--   • operator_money_summary(from, to) — one call returning every component of
--     the money: hammer, premium, tax, gross charged, refunds, net collected,
--     platform fees, Square fees, net deposit, plus unpaid + offline counts.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. Square fee columns (deposit reconciliation)
-- ---------------------------------------------------------------------------
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS square_processing_fee_cents BIGINT;

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS square_net_cents BIGINT;

COMMENT ON COLUMN public.invoices.square_processing_fee_cents IS
  '0287: Square processing fee for this payment, in cents, as reported by '
  'Square (payment.processing_fee[].amount_money). NULL = not yet known — the '
  'fee is only finalized when the payment settles, so the square-sync sweep '
  'backfills it. Needed to reconcile platform revenue against Square DEPOSITS, '
  'which are net of fees.';

COMMENT ON COLUMN public.invoices.square_net_cents IS
  '0287: amount Square actually deposits for this payment (captured amount '
  'minus processing fee), in cents. NULL until the fee is known.';

-- Partial index drives the backfill sweep (paid invoices still missing a fee).
CREATE INDEX IF NOT EXISTS invoices_square_fee_backfill_idx
  ON public.invoices (paid_at)
  WHERE square_payment_id IS NOT NULL AND square_processing_fee_cents IS NULL;

-- ---------------------------------------------------------------------------
-- 2. operator_auction_performance — money from paid invoice lines
-- ---------------------------------------------------------------------------
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
        -- 0287: sold / gross / msrp now come from PAID invoice lines, so a
        -- no-show or carryover no longer erases a closed auction's revenue.
        'sold', s.sold,
        'unsold', s.unsold,
        'still_open', s.still_open,
        'gross_cents', s.gross_cents,
        -- 0287 (new): the post-sale movement, surfaced instead of hidden.
        'returned_lots', s.returned_lots,
        'refunded_lots', s.refunded_lots,
        'refunded_cents', s.refunded_cents,
        'open_hammer_cents', s.open_hammer_cents,
        'open_bid_lots', s.open_bid_lots,
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
        count(*) FILTER (WHERE lf.deleted_at IS NULL)                  AS lots_total,
        -- Sold = the item was paid for. Immune to later status changes.
        count(*) FILTER (WHERE lf.has_paid)                            AS sold,
        -- Never sold: no paid line at all. Excludes no-showed lots so they
        -- can't be counted as unsold AND in gross at the same time.
        count(*) FILTER (
          WHERE lf.status IN ('unsold', 'relisted') AND NOT lf.has_paid
        )                                                              AS unsold,
        count(*) FILTER (WHERE lf.status IN ('live', 'scheduled'))      AS still_open,
        -- Paid, then came back (no-show / forfeit / carried over).
        count(*) FILTER (WHERE lf.has_paid AND lf.status <> 'won')      AS returned_lots,
        count(*) FILTER (WHERE lf.has_refunded)                        AS refunded_lots,
        coalesce(sum(lf.paid_hammer), 0)                               AS gross_cents,
        coalesce(sum(lf.refunded_hammer), 0)                           AS refunded_cents,
        -- 0240: running hammer on open lots with at least one bid (unchanged).
        coalesce(sum(lf.current_bid_cents) FILTER (
          WHERE lf.status IN ('live', 'scheduled') AND lf.bid_count > 0
        ), 0)                                                          AS open_hammer_cents,
        count(*) FILTER (
          WHERE lf.status IN ('live', 'scheduled') AND lf.bid_count > 0
        )                                                              AS open_bid_lots,
        coalesce(sum(lf.bid_count), 0)                                 AS bids,
        coalesce(sum(lf.msrp_cents) FILTER (WHERE lf.has_paid), 0)     AS msrp_sold_cents
      FROM (
        SELECT
          l.status::text        AS status,
          l.deleted_at,
          l.msrp_cents,
          l.bid_count,
          l.current_bid_cents,
          coalesce(pf.paid_hammer, 0)     AS paid_hammer,
          coalesce(pf.refunded_hammer, 0) AS refunded_hammer,
          coalesce(pf.paid_lines, 0)     > 0 AS has_paid,
          coalesce(pf.refunded_lines, 0) > 0 AS has_refunded
        FROM public.lots l
        LEFT JOIN LATERAL (
          -- Per-lot paid facts. Pre-aggregated so a lot can never be
          -- double-counted by the outer sums.
          SELECT
            sum(il.winning_bid_cents) FILTER (WHERE il.refunded_at IS NULL)     AS paid_hammer,
            sum(il.winning_bid_cents) FILTER (WHERE il.refunded_at IS NOT NULL) AS refunded_hammer,
            count(*) FILTER (WHERE il.refunded_at IS NULL)                      AS paid_lines,
            count(*) FILTER (WHERE il.refunded_at IS NOT NULL)                  AS refunded_lines
          FROM public.invoice_lots il
          JOIN public.invoices i ON i.id = il.invoice_id
          WHERE il.lot_id = l.id
            AND i.status::text IN ('paid', 'partially_refunded', 'refunded')
        ) pf ON true
        WHERE l.auction_id = a.id
      ) lf
    ) s ON true
    ORDER BY coalesce(a.ends_at, a.starts_at) DESC
    LIMIT 30
  ) t;

  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.operator_auction_performance() TO authenticated;

COMMENT ON FUNCTION public.operator_auction_performance() IS
  '0287: last 30 auctions. sold/gross/msrp derive from PAID invoice_lots (net '
  'of refunded lines), NOT from lots.status=''won'' — so a no-show, forfeit or '
  'carryover no longer shrinks a closed auction''s revenue after the fact. '
  'returned_lots / refunded_lots / refunded_cents expose that movement. '
  'unsold = never sold (no paid line). Supersedes 0225 + 0240.';

-- ---------------------------------------------------------------------------
-- 3. operator_money_summary(from, to) — every component of the money
-- ---------------------------------------------------------------------------
-- Operator-scoped (unlike the perf fn above, this is pure money for the
-- caller's own books). NULL bounds = all time. Bucketed on paid_at.
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

COMMIT;
