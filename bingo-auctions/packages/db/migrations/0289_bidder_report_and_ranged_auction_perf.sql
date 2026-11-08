-- 0289 — bidder/retention reporting + date-ranged auction performance
--
-- Owner ask 2026-07-25: "better date filters custom ranges on all reporting
-- tabs, better bidder reporting like distinct weekly bidders and retention
-- stuff... lets think how to increase bidders and money."
--
-- ── Why this shape (measured, not guessed) ─────────────────────────────────
-- Prod funnel at the time of writing: 622 registered bidders, 355 ever bid
-- (57%), 259 ever bought (73% of bidders), and of those buyers 206 are REPEAT
-- (80%) averaging 7.32 invoices and $166.57 lifetime spend.
--
-- So retention is already strong; the leak is ACTIVATION — 267 registered
-- bidders (43%) have never placed a single bid. An already-registered
-- never-bidder is worth ~$121 (73% x $166.57) at zero acquisition cost, vs
-- ~$70 for a fresh signup (42% x $166.57). That is why this migration ships
-- SEGMENTS, not just charts: the never-bid list is the actionable asset, and a
-- metric you cannot act on is trivia.
--
-- Two functions:
--   operator_bidder_report(from, to, tz)  — weekly distinct bidders (new vs
--       returning), funnel, repeat rate, LTV, segment SIZES. Staff-gated.
--   operator_bidder_segment(segment, limit) — the actual PEOPLE in a segment
--       with contact details, for campaign targeting. ADMIN/MANAGER only,
--       because `bidders` holds PII that operator staff have no RLS read on
--       (see the reports page note about the invoices->bidders embed).
--
-- Plus operator_auction_performance gains optional [from,to) bounds on
-- ends_at so the Auction Performance tab honours the same date filter as every
-- other report tab. The old 0-arg signature is DROPped and recreated with
-- DEFAULT NULL params so existing no-arg callers keep working unchanged —
-- CREATE OR REPLACE cannot add parameters, and leaving both would fork the
-- body across two overloads.
--
-- Scope note: `bidders` is platform-wide (single-operator build), so the
-- registered count is global. Bid/purchase activity IS operator-scoped via
-- lots.operator_id / invoices.operator_id.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. operator_bidder_report — the numbers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.operator_bidder_report(
  p_from TIMESTAMPTZ DEFAULT NULL,
  p_to   TIMESTAMPTZ DEFAULT NULL,
  p_tz   TEXT DEFAULT 'America/Chicago'
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
  FROM operator_users WHERE user_id = auth.uid() LIMIT 1;
  IF v_op IS NULL THEN
    RAISE EXCEPTION 'not_operator_staff' USING ERRCODE = '42501';
  END IF;

  WITH
  -- Every bid on this operator's lots, with the bidder's first-ever bid so a
  -- week can be split into new vs returning.
  bid_events AS (
    SELECT b.bidder_id,
           b.placed_at,
           min(b.placed_at) OVER (PARTITION BY b.bidder_id) AS first_bid_at
    FROM bids b
    JOIN lots l ON l.id = b.lot_id
    WHERE l.operator_id = v_op
  ),
  -- Money actually collected, per bidder.
  buys AS (
    SELECT i.bidder_id, i.paid_at,
           GREATEST(0, i.total_cents
             - COALESCE(i.refunded_cash_cents,0) - COALESCE(i.refunded_credit_cents,0)) AS net_cents
    FROM invoices i
    WHERE i.operator_id = v_op
      AND i.status::text IN ('paid','partially_refunded','refunded')
      AND i.paid_at IS NOT NULL
  ),
  buyer_totals AS (
    SELECT bidder_id, count(*) AS invoices, sum(net_cents) AS net_cents
    FROM buys GROUP BY bidder_id
  ),
  -- Weekly activity, bucketed in the operator's wall clock.
  weeks AS (
    SELECT date_trunc('week', (be.placed_at AT TIME ZONE p_tz))::date AS wk,
           count(DISTINCT be.bidder_id)                                        AS bidders,
           count(DISTINCT be.bidder_id) FILTER (
             WHERE date_trunc('week', (be.first_bid_at AT TIME ZONE p_tz))
                 = date_trunc('week', (be.placed_at   AT TIME ZONE p_tz))
           )                                                                   AS new_bidders,
           count(*)                                                            AS bids
    FROM bid_events be
    WHERE (p_from IS NULL OR be.placed_at >= p_from)
      AND (p_to   IS NULL OR be.placed_at <  p_to)
    GROUP BY 1
  ),
  week_buyers AS (
    SELECT date_trunc('week', (bu.paid_at AT TIME ZONE p_tz))::date AS wk,
           count(DISTINCT bu.bidder_id) AS buyers,
           sum(bu.net_cents)            AS net_cents
    FROM buys bu
    WHERE (p_from IS NULL OR bu.paid_at >= p_from)
      AND (p_to   IS NULL OR bu.paid_at <  p_to)
    GROUP BY 1
  )
  SELECT json_build_object(
    -- Acquisition funnel (all-time; the range applies to the weekly series and
    -- period figures below, but the funnel is a lifetime view by nature).
    'registered',        (SELECT count(*) FROM bidders WHERE deleted_at IS NULL),
    'ever_bid',          (SELECT count(DISTINCT bidder_id) FROM bid_events),
    'ever_bought',       (SELECT count(*) FROM buyer_totals),
    'repeat_buyers',     (SELECT count(*) FROM buyer_totals WHERE invoices > 1),
    'one_and_done',      (SELECT count(*) FROM buyer_totals WHERE invoices = 1),
    'avg_invoices_per_buyer', (SELECT round(avg(invoices), 2) FROM buyer_totals),
    'avg_lifetime_cents',     (SELECT round(avg(net_cents)) FROM buyer_totals),
    -- Segment sizes. These are the campaign-able lists; membership comes from
    -- operator_bidder_segment().
    'seg_never_bid', (
      SELECT count(*) FROM bidders b
      WHERE b.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM bid_events e WHERE e.bidder_id = b.id)
    ),
    'seg_one_and_done', (SELECT count(*) FROM buyer_totals WHERE invoices = 1),
    'seg_lapsed_14d', (
      SELECT count(*) FROM buyer_totals bt
      WHERE NOT EXISTS (
        SELECT 1 FROM bid_events e
        WHERE e.bidder_id = bt.bidder_id AND e.placed_at > now() - interval '14 days'
      )
    ),
    -- Period activity (honours [from,to)).
    'period_active_bidders', (
      SELECT count(DISTINCT bidder_id) FROM bid_events
      WHERE (p_from IS NULL OR placed_at >= p_from) AND (p_to IS NULL OR placed_at < p_to)
    ),
    'period_buyers', (
      SELECT count(DISTINCT bidder_id) FROM buys
      WHERE (p_from IS NULL OR paid_at >= p_from) AND (p_to IS NULL OR paid_at < p_to)
    ),
    'period_net_cents', (
      SELECT COALESCE(sum(net_cents), 0) FROM buys
      WHERE (p_from IS NULL OR paid_at >= p_from) AND (p_to IS NULL OR paid_at < p_to)
    ),
    'period_new_signups', (
      SELECT count(*) FROM bidders
      WHERE deleted_at IS NULL
        AND (p_from IS NULL OR created_at >= p_from)
        AND (p_to   IS NULL OR created_at <  p_to)
    ),
    -- Weekly series: distinct bidders split new vs returning, plus buyers and
    -- money for the same week. FULL JOIN so a week with buyers but no new bids
    -- (or vice versa) still appears.
    'weekly', (
      SELECT COALESCE(json_agg(json_build_object(
               'week', COALESCE(w.wk, wb.wk),
               'bidders', COALESCE(w.bidders, 0),
               'new_bidders', COALESCE(w.new_bidders, 0),
               'returning_bidders', GREATEST(0, COALESCE(w.bidders,0) - COALESCE(w.new_bidders,0)),
               'bids', COALESCE(w.bids, 0),
               'buyers', COALESCE(wb.buyers, 0),
               'net_cents', COALESCE(wb.net_cents, 0)
             ) ORDER BY COALESCE(w.wk, wb.wk)), '[]'::json)
      FROM weeks w
      FULL JOIN week_buyers wb ON wb.wk = w.wk
    )
  ) INTO result;

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.operator_bidder_report(TIMESTAMPTZ, TIMESTAMPTZ, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.operator_bidder_report(TIMESTAMPTZ, TIMESTAMPTZ, TEXT) TO authenticated;

COMMENT ON FUNCTION public.operator_bidder_report(TIMESTAMPTZ, TIMESTAMPTZ, TEXT) IS
  '0289: bidder acquisition + retention metrics. Weekly distinct bidders split '
  'new vs returning, lifetime funnel (registered -> bid -> bought -> repeat), '
  'repeat rate, LTV, and segment sizes. Weekly buckets use p_tz wall clock. '
  'Operator-scoped on activity; `registered` is platform-wide (single-operator).';

-- ---------------------------------------------------------------------------
-- 2. operator_bidder_segment — the people, for campaigns (PII: admin/manager)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.operator_bidder_segment(
  p_segment TEXT,
  p_limit   INT DEFAULT 500
)
RETURNS TABLE (
  bidder_id     UUID,
  display_name  TEXT,
  email         TEXT,
  phone         TEXT,
  bidder_number INT,
  signed_up_at  TIMESTAMPTZ,
  bids          BIGINT,
  invoices      BIGINT,
  net_spend_cents BIGINT,
  last_bid_at   TIMESTAMPTZ,
  last_paid_at  TIMESTAMPTZ
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_op    UUID;
  v_role  operator_user_role;
  v_limit INT := LEAST(GREATEST(COALESCE(p_limit, 500), 1), 5000);
BEGIN
  SELECT operator_id, role INTO v_op, v_role
  FROM operator_users WHERE user_id = auth.uid() LIMIT 1;
  IF v_op IS NULL THEN
    RAISE EXCEPTION 'not_operator_staff' USING ERRCODE = '42501';
  END IF;
  -- Returns names, emails and phone numbers. Gate it above picker/checkout
  -- staff, who have no RLS read on `bidders` at all.
  IF v_role NOT IN ('admin', 'manager') THEN
    RAISE EXCEPTION 'admin_or_manager_required' USING ERRCODE = '42501';
  END IF;
  IF p_segment NOT IN ('never_bid', 'one_and_done', 'lapsed', 'top_spenders', 'all_buyers') THEN
    RAISE EXCEPTION 'unknown_segment:%', p_segment USING ERRCODE = 'P0001';
  END IF;

  RETURN QUERY
  WITH act AS (
    SELECT b.bidder_id, count(*) AS bids, max(b.placed_at) AS last_bid_at
    FROM bids b JOIN lots l ON l.id = b.lot_id
    WHERE l.operator_id = v_op
    GROUP BY b.bidder_id
  ),
  buy AS (
    SELECT i.bidder_id, count(*) AS invoices, max(i.paid_at) AS last_paid_at,
           sum(GREATEST(0, i.total_cents
               - COALESCE(i.refunded_cash_cents,0) - COALESCE(i.refunded_credit_cents,0))) AS net_cents
    FROM invoices i
    WHERE i.operator_id = v_op
      AND i.status::text IN ('paid','partially_refunded','refunded')
      AND i.paid_at IS NOT NULL
    GROUP BY i.bidder_id
  ),
  base AS (
    SELECT bd.id, bd.display_name, bd.email, bd.phone, bd.bidder_number, bd.created_at,
           COALESCE(a.bids, 0) AS bids, a.last_bid_at,
           COALESCE(v.invoices, 0) AS invoices, v.last_paid_at,
           COALESCE(v.net_cents, 0) AS net_cents
    FROM bidders bd
    LEFT JOIN act a ON a.bidder_id = bd.id
    LEFT JOIN buy v ON v.bidder_id = bd.id
    WHERE bd.deleted_at IS NULL
  )
  SELECT s.id, s.display_name, s.email, s.phone, s.bidder_number, s.created_at,
         s.bids, s.invoices, s.net_cents, s.last_bid_at, s.last_paid_at
  FROM base s
  WHERE CASE p_segment
          -- Registered and never bid: the biggest activation pool.
          WHEN 'never_bid'    THEN s.bids = 0
          -- Bought exactly once: high-value win-back given the 80% repeat rate.
          WHEN 'one_and_done' THEN s.invoices = 1
          -- Has bought before but has gone quiet for 14+ days.
          WHEN 'lapsed'       THEN s.invoices > 0
                                   AND (s.last_bid_at IS NULL
                                        OR s.last_bid_at < now() - interval '14 days')
          WHEN 'top_spenders' THEN s.net_cents > 0
          ELSE s.invoices > 0
        END
  ORDER BY
    CASE WHEN p_segment = 'top_spenders' THEN s.net_cents ELSE 0 END DESC,
    CASE WHEN p_segment = 'never_bid'    THEN s.created_at END DESC NULLS LAST,
    s.net_cents DESC, s.created_at DESC
  LIMIT v_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.operator_bidder_segment(TEXT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.operator_bidder_segment(TEXT, INT) TO authenticated;

COMMENT ON FUNCTION public.operator_bidder_segment(TEXT, INT) IS
  '0289: members of a campaign segment (never_bid | one_and_done | lapsed | '
  'top_spenders | all_buyers) with contact details for targeting. '
  'ADMIN/MANAGER only — returns bidder PII that operator staff cannot read '
  'through RLS.';

-- ---------------------------------------------------------------------------
-- 3. operator_auction_performance — accept the same [from,to) date filter
-- ---------------------------------------------------------------------------
-- Body identical to 0287 (money from paid invoice lines); only the auction
-- selection gains the optional bounds + a wider cap when a range is supplied.
-- DROP first: CREATE OR REPLACE cannot add parameters, and keeping both the
-- 0-arg and 3-arg forms would fork the body.
DROP FUNCTION IF EXISTS public.operator_auction_performance();

CREATE OR REPLACE FUNCTION public.operator_auction_performance(
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
  result json;
  v_limit INT := CASE WHEN p_from IS NULL AND p_to IS NULL THEN 30 ELSE 500 END;
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
        'unsold', s.unsold,
        'still_open', s.still_open,
        'gross_cents', s.gross_cents,
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
        count(*) FILTER (WHERE lf.has_paid)                            AS sold,
        count(*) FILTER (
          WHERE lf.status IN ('unsold', 'relisted') AND NOT lf.has_paid
        )                                                              AS unsold,
        count(*) FILTER (WHERE lf.status IN ('live', 'scheduled'))      AS still_open,
        count(*) FILTER (WHERE lf.has_paid AND lf.status <> 'won')      AS returned_lots,
        count(*) FILTER (WHERE lf.has_refunded)                        AS refunded_lots,
        coalesce(sum(lf.paid_hammer), 0)                               AS gross_cents,
        coalesce(sum(lf.refunded_hammer), 0)                           AS refunded_cents,
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
    -- 0289: optional date bounds on the auction's close. Anchored on ends_at
    -- (falling back to starts_at) so an auction lands in the period it ran in.
    WHERE (p_from IS NULL OR coalesce(a.ends_at, a.starts_at) >= p_from)
      AND (p_to   IS NULL OR coalesce(a.ends_at, a.starts_at) <  p_to)
    ORDER BY coalesce(a.ends_at, a.starts_at) DESC
    LIMIT v_limit
  ) t;

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.operator_auction_performance(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.operator_auction_performance(TIMESTAMPTZ, TIMESTAMPTZ) TO authenticated;

COMMENT ON FUNCTION public.operator_auction_performance(TIMESTAMPTZ, TIMESTAMPTZ) IS
  '0289: 0287 money semantics (gross from paid invoice_lots, net of refunds) '
  'plus optional [p_from, p_to) bounds on the auction close so this tab honours '
  'the shared report date filter. No range = last 30 auctions; ranged = up to '
  '500. Supersedes the 0-arg form, which was dropped.';

COMMIT;
