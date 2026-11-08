-- 0374 — get_recent_wins: skip test / demo auctions, and make it work at all.
--
-- ── WHAT WAS WRONG (prod, 2026-09-28) ────────────────────────────────────────
-- 1. It errors on every call that has any win to return:
--      42804 structure of query does not match function result type —
--      Returned type numeric does not match expected type bigint in column 4
--    savings_cents is SUM(bigint) - SUM(int), which is numeric. The bidder
--    app's RecentWinsRail hides itself on error, so the rail has been blank.
-- 2. invoice_agg joined every lot row of an invoice to every ranked row of the
--    same invoice: an invoice with n lots reported n*n lots and n times its
--    savings.
-- 3. No auction filter. Unlisted staff test auctions (0242) and the demo
--    operator's App Review auction would show as customer social proof the
--    moment (1) is fixed. The website's RecentWins already drops both
--    (loadRecentWins); this is the same rule for the app.
--
-- ── WHAT THIS DOES ───────────────────────────────────────────────────────────
-- Same signature, return type, SECURITY DEFINER and search_path, so the
-- existing grants (anon, authenticated, service_role) stay as they are.
-- Eligible invoices must belong to an auction that is not unlisted and whose
-- operator is not is_demo. Totals are summed once per invoice, the
-- representative lot is picked separately, and savings is cast to bigint.
-- Privacy contract unchanged: no bidder_id, no financial columns beyond
-- savings.

CREATE OR REPLACE FUNCTION public.get_recent_wins(p_days integer DEFAULT 7, p_limit integer DEFAULT 10)
 RETURNS TABLE(invoice_id uuid, representative_title text, representative_photo_url text, savings_cents bigint, lot_count integer, paid_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  -- Clamp params so a caller cannot trigger a runaway query.
  p_days  := LEAST(GREATEST(p_days,  1), 90);
  p_limit := LEAST(GREATEST(p_limit, 1), 50);

  RETURN QUERY
  WITH
  -- Paid invoices in the window, from listed auctions of real operators only.
  eligible_invoices AS (
    SELECT i.id AS e_invoice_id, i.paid_at AS e_paid_at
    FROM public.invoices i
    JOIN public.auctions  a ON a.id = i.auction_id
    JOIN public.operators o ON o.id = a.operator_id
    WHERE i.status = 'paid'
      AND i.paid_at > now() - (p_days || ' days')::INTERVAL
      AND a.unlisted IS NOT TRUE
      AND o.is_demo IS NOT TRUE
  ),
  -- One row per lot on those invoices. bidder ids are never touched.
  lot_data AS (
    SELECT
      il.invoice_id                                    AS d_invoice_id,
      l.title                                          AS d_title,
      l.photo_urls[1]                                  AS d_photo,
      COALESCE(l.msrp_cents, 0)::bigint                AS d_msrp,
      il.winning_bid_cents::bigint                     AS d_bid,
      COALESCE(l.msrp_cents, 0)::bigint - il.winning_bid_cents::bigint AS d_savings
    FROM eligible_invoices ei
    JOIN public.invoice_lots il ON il.invoice_id = ei.e_invoice_id
    JOIN public.lots          l  ON l.id = il.lot_id
  ),
  -- Totals, once per invoice.
  totals AS (
    SELECT d_invoice_id AS t_invoice_id,
           SUM(d_msrp)::bigint - SUM(d_bid)::bigint AS t_savings,
           COUNT(*)::integer AS t_lot_count
    FROM lot_data
    GROUP BY d_invoice_id
  ),
  -- Representative lot: positive savings with a title first, then highest
  -- MSRP (the web component's heuristic). DISTINCT ON picks exactly one.
  rep AS (
    SELECT DISTINCT ON (d_invoice_id)
           d_invoice_id AS r_invoice_id, d_title AS r_title, d_photo AS r_photo
    FROM lot_data
    ORDER BY d_invoice_id,
             CASE WHEN d_savings > 0 AND d_title IS NOT NULL THEN 0 ELSE 1 END,
             d_msrp DESC
  )
  SELECT ei.e_invoice_id, r.r_title, r.r_photo, t.t_savings, t.t_lot_count, ei.e_paid_at
  FROM eligible_invoices ei
  JOIN totals t ON t.t_invoice_id = ei.e_invoice_id
  JOIN rep    r ON r.r_invoice_id = ei.e_invoice_id
  WHERE t.t_savings > 0
    AND r.r_title IS NOT NULL
  ORDER BY ei.e_paid_at DESC
  LIMIT p_limit;
END;
$function$;
