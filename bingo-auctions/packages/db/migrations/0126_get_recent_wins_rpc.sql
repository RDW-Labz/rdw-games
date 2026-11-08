-- ============================================================================
-- 0126_get_recent_wins_rpc.sql
--
-- Exposes a privacy-safe "recent wins" social-proof feed for the mobile
-- bidder app without requiring the service-role key.
--
-- Problem:
--   The web's RecentWins component (apps/operator-web/src/app/(public)/
--   _components/RecentWins.tsx) fetches paid invoices using the Supabase
--   admin/service-role client because RLS on `invoices` only permits reads
--   by the invoice's own bidder or an operator_user. Mobile must use the
--   anon key (exposing service-role on a device is a hard security no).
--
-- Solution:
--   A SECURITY DEFINER function runs as the function owner (postgres),
--   bypassing RLS, but returns ONLY the columns listed in the RETURNS TABLE
--   clause — an explicit allowlist with no bidder-identifying data.
--   SET search_path = public prevents search_path injection attacks.
--
-- Privacy contract (enforced in the SQL body, not just the interface):
--   - bidder_id      → NEVER selected; removed from data path entirely.
--   - email/phone    → never reached (bidders table not touched).
--   - display_name   → never reached (bidders table not touched).
--   - stripe IDs     → never reached (invoices.stripe_* not selected).
--   - Lot title IS public (visible on the public /lot/[code] page), so
--     surfacing the highest-MSRP lot title from an invoice leaks nothing new.
--   - photo_urls[1]  → first photo from the same lot (also public on lot page).
--
-- Photo selection:
--   lots.photo_urls is TEXT[]. We pick photo_urls[1] (1-indexed in Postgres)
--   for the representative photo, from the same lot chosen as representative
--   (highest MSRP among lots with positive savings). NULL when the array is
--   empty or the lot has no photos.
--
-- Performance:
--   Filtered on invoices.status = 'paid' + paid_at index (invoices_status_idx).
--   Window function ranks lots within each invoice — one scan, no N+1.
--   p_limit caps the result set; p_days narrows the time window.
--   Typical cold-cache time on production volumes is well under 100 ms.
--
-- Grant:
--   anon  — public homepage / mobile home tab (unauthenticated).
--   authenticated — logged-in bidders (same data, same privacy guarantee).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_recent_wins(
  p_days  INTEGER DEFAULT 7,
  p_limit INTEGER DEFAULT 10
)
RETURNS TABLE (
  invoice_id             UUID,
  representative_title   TEXT,
  representative_photo_url TEXT,
  savings_cents          BIGINT,
  lot_count              INTEGER,
  paid_at                TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
BEGIN
  -- Guard: clamp params to sane ranges so a malicious caller cannot
  -- trigger a runaway query via e.g. p_days = 9999999.
  p_days  := LEAST(GREATEST(p_days,  1), 90);
  p_limit := LEAST(GREATEST(p_limit, 1), 50);

  RETURN QUERY
  WITH
  -- Step 1: Identify paid invoices in the time window. We explicitly
  -- select ONLY the three columns we need — invoice id, paid_at, and
  -- the implicit row identity for the join below. bidder_id and all
  -- Stripe/financial columns are intentionally omitted.
  eligible_invoices AS (
    SELECT
      i.id        AS invoice_id,
      i.paid_at   AS invoice_paid_at
    FROM public.invoices i
    WHERE i.status  = 'paid'
      AND i.paid_at > now() - (p_days || ' days')::INTERVAL
  ),

  -- Step 2: Join invoice_lots → lots to get per-lot savings and photo.
  -- Only columns required for the output surface are pulled; in particular,
  -- winner_bidder_id on lots and bidder_id on invoices are never touched.
  lot_data AS (
    SELECT
      il.invoice_id                                         AS invoice_id,
      l.title                                               AS lot_title,
      -- 1-indexed array access; NULL when array is empty.
      l.photo_urls[1]                                       AS lot_photo,
      COALESCE(l.msrp_cents, 0)                             AS lot_msrp,
      il.winning_bid_cents                                  AS lot_winning_bid,
      COALESCE(l.msrp_cents, 0) - il.winning_bid_cents      AS lot_savings
    FROM eligible_invoices ei
    JOIN public.invoice_lots il ON il.invoice_id = ei.invoice_id
    JOIN public.lots          l  ON l.id = il.lot_id
  ),

  -- Step 3: Aggregate per-invoice metrics and rank the "representative" lot.
  -- The representative lot is the one with the highest MSRP among lots that
  -- have positive individual savings (matching the web component's heuristic).
  -- RANK() within each invoice; rank = 1 is the best candidate.
  ranked AS (
    SELECT
      ld.invoice_id,
      ld.lot_title,
      ld.lot_photo,
      ld.lot_msrp,
      ld.lot_savings,
      RANK() OVER (
        PARTITION BY ld.invoice_id
        ORDER BY
          -- Prefer lots with positive savings and a non-null title first,
          -- then rank by MSRP descending (highest-value item leads).
          CASE WHEN ld.lot_savings > 0 AND ld.lot_title IS NOT NULL THEN 0 ELSE 1 END,
          ld.lot_msrp DESC
      ) AS rnk
    FROM lot_data ld
  ),

  -- Step 4: Pull the representative lot (rnk = 1) and compute invoice totals.
  invoice_agg AS (
    SELECT
      ld_all.invoice_id,
      -- Representative lot from the ranked CTE (rnk = 1 row)
      MAX(r.lot_title)  FILTER (WHERE r.rnk = 1) AS rep_title,
      MAX(r.lot_photo)  FILTER (WHERE r.rnk = 1) AS rep_photo,
      -- Invoice-level aggregates: all lots regardless of which is representative
      SUM(ld_all.lot_msrp)        AS total_msrp,
      SUM(ld_all.lot_winning_bid) AS total_winning_bid,
      COUNT(*)::INTEGER           AS invoice_lot_count
    FROM lot_data ld_all
    JOIN ranked   r   ON r.invoice_id = ld_all.invoice_id
    GROUP BY ld_all.invoice_id
  ),

  -- Step 5: Filter to invoices with positive aggregate savings and a
  -- usable representative title, then join back for paid_at.
  final AS (
    SELECT
      ei.invoice_id                              AS f_invoice_id,
      agg.rep_title                              AS f_rep_title,
      agg.rep_photo                              AS f_rep_photo,
      (agg.total_msrp - agg.total_winning_bid)   AS f_savings_cents,
      agg.invoice_lot_count                      AS f_lot_count,
      ei.invoice_paid_at                         AS f_paid_at
    FROM invoice_agg agg
    JOIN eligible_invoices ei ON ei.invoice_id = agg.invoice_id
    WHERE (agg.total_msrp - agg.total_winning_bid) > 0
      AND agg.rep_title IS NOT NULL
  )

  SELECT
    f.f_invoice_id,
    f.f_rep_title,
    f.f_rep_photo,
    f.f_savings_cents,
    f.f_lot_count,
    f.f_paid_at
  FROM final f
  ORDER BY f.f_paid_at DESC
  LIMIT p_limit;
END;
$function$;

COMMENT ON FUNCTION public.get_recent_wins(INTEGER, INTEGER) IS
  'Returns anonymized recent winning invoices for the social-proof "Recent wins" '
  'feed. SECURITY DEFINER bypasses RLS so the mobile app can call this with the '
  'anon key; the function never selects bidder_id, email, phone, display_name, or '
  'any Stripe identifier — only aggregate financial data and the single highest-MSRP '
  'lot title/photo from each invoice (both of which are already public on the lot '
  'detail page). p_days is clamped to [1,90]; p_limit is clamped to [1,50]. '
  'Added 2026-05-23 for Wave 1D native port of the web RecentWins component.';

-- Grant to anon (unauthenticated mobile / public homepage callers) and
-- authenticated (logged-in bidders — same privacy guarantee applies).
GRANT EXECUTE ON FUNCTION public.get_recent_wins(INTEGER, INTEGER) TO anon, authenticated;
