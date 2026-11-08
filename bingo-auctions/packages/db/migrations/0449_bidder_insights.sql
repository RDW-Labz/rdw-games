-- 0449 — Bidder insights: ZIP heat table, activity segments, weekly cohorts.
--
-- Three read-only reporting RPCs behind the console's new "Bidder insights"
-- report (under /reports, admin/manager only — same role gate as 0434's
-- operator_bidder_location_summary). No table changes; no writes anywhere.
--
-- WHAT
--   1. operator_bidder_zip_heat(p_from, p_to, p_zip_prefix)
--      Per-ZIP: registered (lifetime), active in the last 30 days (fixed
--      rolling window, independent of p_from/p_to — same "active" meaning as
--      segment #2), winners and paid revenue IN [p_from, p_to), and that
--      ZIP's share of the returned total revenue (basis points, 0-10000).
--      ZIP groups under 3 registered bidders roll into 'Other (fewer than 3)'
--      (mirrors 0434/0438); a bidder with no ZIP is 'Unknown'. The roll-up is
--      computed over ALL non-deleted bidders first, same as 0434, so the
--      p_zip_prefix filter can't change which ZIPs count toward the <3 test.
--      City/state (GeoNames, mig 0438) are intentionally NOT joined here:
--      0438 is still a draft PR (not applied), so this function has zero
--      dependency on zip_reference existing. Once 0438 lands, the by-place
--      report (operator_bidder_location_summary_by_place) already has
--      city/state — a follow-up can fold that in here. Until then the
--      console shows ZIP only with a "city names appear once the ZIP list is
--      loaded" note, same wording 0438's own report uses.
--
--   2. operator_bidder_segments() / operator_bidder_segments_by_zip()
--      Activity segments, mutually exclusive, evaluated as of NOW():
--        new        — created_at within the last 30 days (acquisition
--                      cohort; takes priority over the bid-recency buckets
--                      below, so a brand-new signup who already placed a bid
--                      is still counted as "new" rather than "active" — the
--                      acquisition funnel on /reports/bidders already answers
--                      "did they activate", this answers "are new people
--                      arriving")
--        active      — not new; last bid within the last 30 days
--        lapsed      — not new; last bid 31-90 days ago
--        dormant     — not new; last bid more than 90 days ago
--        never_bid   — not new; no bid, ever
--      _by_zip applies the SAME <3 roll-up as the heat table (a ZIP's total
--      registered count decides Other/Unknown, not its count within one
--      segment), so a segment slice can't leak a small ZIP's identity.
--      _segments() (no ZIP breakdown) has no suppression need — five
--      platform-wide totals.
--
--   3. operator_bidder_cohorts(p_weeks, p_tz)
--      Weekly signup cohorts, last p_weeks (default 12, clamped 1-52). Each
--      row is one (cohort week, weeks since signup) cell: cohort_size, the
--      % of that cohort who placed >= 1 bid in that calendar week, and the %
--      who had >= 1 paid invoice in that calendar week. Weeks bucket in
--      p_tz wall-clock (date_trunc('week', ... AT TIME ZONE p_tz), Monday
--      start — same convention as operator_bidder_report, mig 0289). A
--      cohort week with fewer than 3 signups is dropped entirely (no row at
--      any offset) — small-group suppression applied to the whole cohort,
--      not just thin cells. Only offsets that have actually elapsed are
--      returned (no row for a week that hasn't happened yet).
--
-- PRIVACY: every function returns aggregates only — no bidder id, name,
-- email or phone in any result column. SECURITY DEFINER, STABLE, scoped to
-- current_operator_id(); admin/manager only (42501), mirroring 0434/0438.
-- Revoked from PUBLIC and anon; granted to authenticated only.
--
-- LOCKS: none — three new functions, no table/column changes. Additive;
-- safe any hour (Rule 9).
--
-- COST: bids ~210k rows, bidders a few thousand. Every query here is a
-- single pass over bids/invoices filtered by an index-friendly timestamp
-- range (placed_at / paid_at / created_at), joined to bidders by id/bidder_id
-- — no per-row correlated subquery over bids. See EXPLAIN notes at the
-- bottom of this file (rig proof, not applied here).
--
-- Rollback: scripts/prod-rig/0449_ROLLBACK_bidder_insights.sql (drops the
-- three functions; nothing else to undo — no columns, no tables).

SET lock_timeout = '3s';

BEGIN;

-- ── 1. operator_bidder_zip_heat ─────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.operator_bidder_zip_heat(
  p_from       timestamptz DEFAULT NULL,
  p_to         timestamptz DEFAULT NULL,
  p_zip_prefix text        DEFAULT NULL
)
RETURNS TABLE(
  postal_code         text,
  registered          bigint,
  active_bidders_30d  bigint,
  winners             bigint,
  paid_revenue_cents  bigint,
  share_bps           bigint
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE
  v_op     uuid := current_operator_id();
  v_prefix text := nullif(btrim(coalesce(p_zip_prefix, '')), '');
BEGIN
  IF v_op IS NULL
     OR current_operator_role() IS NULL
     OR current_operator_role()::text NOT IN ('admin', 'manager') THEN
    RAISE EXCEPTION 'bidder_insights_forbidden' USING ERRCODE = '42501';
  END IF;

  IF v_prefix IS NOT NULL AND v_prefix !~ '^[0-9]{1,5}$' THEN
    RAISE EXCEPTION 'invalid_zip_prefix' USING ERRCODE = '22023';
  END IF;

  RETURN QUERY
  WITH
  -- Roll-up first, over ALL non-deleted bidders, same rule as 0434/0438.
  zip_sizes AS (
    SELECT b.postal_code AS zip, count(*) AS n
      FROM bidders b
     WHERE b.deleted_at IS NULL AND b.postal_code IS NOT NULL
     GROUP BY b.postal_code
  ),
  bz AS (
    SELECT b.id AS bidder_id,
           CASE WHEN b.postal_code IS NULL        THEN 'Unknown'
                WHEN coalesce(zs.n, 0) < 3         THEN 'Other (fewer than 3)'
                ELSE b.postal_code END             AS zip_group
      FROM bidders b
      LEFT JOIN zip_sizes zs ON zs.zip = b.postal_code
     WHERE b.deleted_at IS NULL
       AND (
         v_prefix IS NULL
         OR (b.postal_code IS NOT NULL AND coalesce(zs.n, 0) >= 3 AND b.postal_code LIKE v_prefix || '%')
       )
  ),
  active_30d AS (
    SELECT DISTINCT bd.bidder_id
      FROM bids bd
      JOIN lots l ON l.id = bd.lot_id
     WHERE l.operator_id = v_op
       AND bd.placed_at >= now() - interval '30 days'
  ),
  paid_inv AS (
    SELECT i.id, i.bidder_id,
           CASE WHEN i.status::text = 'refunded' THEN 0::bigint
                ELSE (i.subtotal_cents + i.buyer_premium_cents - coalesce((
                  SELECT sum(il.winning_bid_cents
                             + CASE WHEN i.subtotal_cents > 0
                                    THEN round(i.buyer_premium_cents::numeric * il.winning_bid_cents
                                               / i.subtotal_cents)::bigint
                                    ELSE 0 END)
                    FROM invoice_lots il
                   WHERE il.invoice_id = i.id
                     AND il.refunded_at IS NOT NULL), 0))::bigint
           END AS net
      FROM invoices i
     WHERE i.operator_id = v_op
       AND i.paid_at IS NOT NULL
       AND i.status::text IN ('paid', 'partially_refunded', 'refunded')
       AND (p_from IS NULL OR i.paid_at >= p_from)
       AND (p_to   IS NULL OR i.paid_at <  p_to)
  ),
  per_zip AS (
    SELECT bz.zip_group,
           count(DISTINCT bz.bidder_id)                                       AS registered,
           count(DISTINCT a30.bidder_id)                                      AS active_bidders_30d,
           count(DISTINCT pi.bidder_id)                                       AS winners,
           coalesce(sum(pi.net), 0)::bigint                                   AS paid_revenue_cents
      FROM bz
      LEFT JOIN active_30d a30 ON a30.bidder_id = bz.bidder_id
      LEFT JOIN paid_inv   pi  ON pi.bidder_id  = bz.bidder_id
     GROUP BY bz.zip_group
  ),
  totals AS (
    SELECT coalesce(sum(paid_revenue_cents), 0)::bigint AS total_revenue FROM per_zip
  )
  SELECT pz.zip_group::text,
         pz.registered::bigint,
         pz.active_bidders_30d::bigint,
         pz.winners::bigint,
         pz.paid_revenue_cents::bigint,
         CASE WHEN t.total_revenue > 0
              THEN round(pz.paid_revenue_cents::numeric * 10000 / t.total_revenue)::bigint
              ELSE NULL END AS share_bps
    FROM per_zip pz
    CROSS JOIN totals t
   ORDER BY CASE pz.zip_group WHEN 'Other (fewer than 3)' THEN 1 WHEN 'Unknown' THEN 2 ELSE 0 END,
            pz.zip_group;
END;
$function$;

COMMENT ON FUNCTION public.operator_bidder_zip_heat(timestamptz, timestamptz, text) IS
  '0449: per-ZIP bidder/revenue heat map. registered is lifetime; '
  'active_bidders_30d is a fixed rolling 30-day window; winners/paid_revenue '
  'honour [p_from, p_to). ZIP roll-up (<3 registered -> Other) computed '
  'before any filter, same rule as 0434/0438. No city/state (0438 not yet '
  'applied) — ZIP only. Admin/manager of current_operator_id() only (42501).';

REVOKE ALL ON FUNCTION public.operator_bidder_zip_heat(timestamptz, timestamptz, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.operator_bidder_zip_heat(timestamptz, timestamptz, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.operator_bidder_zip_heat(timestamptz, timestamptz, text) TO authenticated;

-- ── 2. operator_bidder_segments / operator_bidder_segments_by_zip ──────────

CREATE OR REPLACE FUNCTION public.operator_bidder_segments()
RETURNS TABLE(segment text, bidders bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE
  v_op uuid := current_operator_id();
BEGIN
  IF v_op IS NULL
     OR current_operator_role() IS NULL
     OR current_operator_role()::text NOT IN ('admin', 'manager') THEN
    RAISE EXCEPTION 'bidder_insights_forbidden' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH last_bid AS (
    SELECT bd.bidder_id, max(bd.placed_at) AS last_bid_at
      FROM bids bd
      JOIN lots l ON l.id = bd.lot_id
     WHERE l.operator_id = v_op
     GROUP BY bd.bidder_id
  ),
  classified AS (
    SELECT
      CASE
        WHEN b.created_at >= now() - interval '30 days'  THEN 'new'
        WHEN lb.last_bid_at IS NULL                       THEN 'never_bid'
        WHEN lb.last_bid_at >= now() - interval '30 days' THEN 'active'
        WHEN lb.last_bid_at >= now() - interval '90 days' THEN 'lapsed'
        ELSE 'dormant'
      END AS segment
    FROM bidders b
    LEFT JOIN last_bid lb ON lb.bidder_id = b.id
    WHERE b.deleted_at IS NULL
  ),
  order_list(segment, ord) AS (
    VALUES ('new', 1), ('active', 2), ('lapsed', 3), ('dormant', 4), ('never_bid', 5)
  )
  SELECT ol.segment::text, coalesce(count(c.segment), 0)::bigint
    FROM order_list ol
    LEFT JOIN classified c ON c.segment = ol.segment
   GROUP BY ol.segment, ol.ord
   ORDER BY ol.ord;
END;
$function$;

COMMENT ON FUNCTION public.operator_bidder_segments() IS
  '0449: platform-wide counts for the 5 activity segments (new / active / '
  'lapsed / dormant / never_bid), mutually exclusive, evaluated as of now(). '
  'Admin/manager of current_operator_id() only (42501). Always 5 rows.';

REVOKE ALL ON FUNCTION public.operator_bidder_segments() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.operator_bidder_segments() FROM anon;
GRANT EXECUTE ON FUNCTION public.operator_bidder_segments() TO authenticated;

CREATE OR REPLACE FUNCTION public.operator_bidder_segments_by_zip()
RETURNS TABLE(postal_code text, segment text, bidders bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE
  v_op uuid := current_operator_id();
BEGIN
  IF v_op IS NULL
     OR current_operator_role() IS NULL
     OR current_operator_role()::text NOT IN ('admin', 'manager') THEN
    RAISE EXCEPTION 'bidder_insights_forbidden' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH zip_sizes AS (
    SELECT b.postal_code AS zip, count(*) AS n
      FROM bidders b
     WHERE b.deleted_at IS NULL AND b.postal_code IS NOT NULL
     GROUP BY b.postal_code
  ),
  bz AS (
    SELECT b.id AS bidder_id, b.created_at,
           CASE WHEN b.postal_code IS NULL        THEN 'Unknown'
                WHEN coalesce(zs.n, 0) < 3         THEN 'Other (fewer than 3)'
                ELSE b.postal_code END             AS zip_group
      FROM bidders b
      LEFT JOIN zip_sizes zs ON zs.zip = b.postal_code
     WHERE b.deleted_at IS NULL
  ),
  last_bid AS (
    SELECT bd.bidder_id, max(bd.placed_at) AS last_bid_at
      FROM bids bd
      JOIN lots l ON l.id = bd.lot_id
     WHERE l.operator_id = v_op
     GROUP BY bd.bidder_id
  ),
  classified AS (
    SELECT bz.zip_group,
      CASE
        WHEN bz.created_at >= now() - interval '30 days' THEN 'new'
        WHEN lb.last_bid_at IS NULL                       THEN 'never_bid'
        WHEN lb.last_bid_at >= now() - interval '30 days' THEN 'active'
        WHEN lb.last_bid_at >= now() - interval '90 days' THEN 'lapsed'
        ELSE 'dormant'
      END AS segment
    FROM bz
    LEFT JOIN last_bid lb ON lb.bidder_id = bz.bidder_id
  ),
  order_list(segment, ord) AS (
    VALUES ('new', 1), ('active', 2), ('lapsed', 3), ('dormant', 4), ('never_bid', 5)
  ),
  zips AS (SELECT DISTINCT zip_group FROM classified)
  SELECT z.zip_group::text, ol.segment::text, coalesce(count(c.segment), 0)::bigint
    FROM zips z
    CROSS JOIN order_list ol
    LEFT JOIN classified c ON c.zip_group = z.zip_group AND c.segment = ol.segment
   GROUP BY z.zip_group, ol.segment, ol.ord
   ORDER BY CASE z.zip_group WHEN 'Other (fewer than 3)' THEN 1 WHEN 'Unknown' THEN 2 ELSE 0 END,
            z.zip_group, ol.ord;
END;
$function$;

COMMENT ON FUNCTION public.operator_bidder_segments_by_zip() IS
  '0449: segment counts per ZIP group, same <3-registered roll-up as '
  'operator_bidder_zip_heat (a ZIP''s TOTAL registered count decides Other/ '
  'Unknown, not its count within one segment). Admin/manager only (42501).';

REVOKE ALL ON FUNCTION public.operator_bidder_segments_by_zip() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.operator_bidder_segments_by_zip() FROM anon;
GRANT EXECUTE ON FUNCTION public.operator_bidder_segments_by_zip() TO authenticated;

-- ── 3. operator_bidder_cohorts ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.operator_bidder_cohorts(
  p_weeks int  DEFAULT 12,
  p_tz    text DEFAULT 'America/Chicago'
)
RETURNS TABLE(
  cohort_week  date,
  weeks_since  int,
  cohort_size  bigint,
  bid_pct      numeric,
  win_pct      numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
#variable_conflict use_column
DECLARE
  v_op    uuid := current_operator_id();
  v_weeks int  := least(greatest(coalesce(p_weeks, 12), 1), 52);
  v_tz    text := coalesce(nullif(btrim(p_tz), ''), 'America/Chicago');
BEGIN
  IF v_op IS NULL
     OR current_operator_role() IS NULL
     OR current_operator_role()::text NOT IN ('admin', 'manager') THEN
    RAISE EXCEPTION 'bidder_insights_forbidden' USING ERRCODE = '42501';
  END IF;

  -- Validate the zone name so a bad p_tz fails clean (22023) rather than
  -- erroring deep inside the query with an opaque Postgres message.
  BEGIN
    PERFORM now() AT TIME ZONE v_tz;
  EXCEPTION WHEN invalid_parameter_value OR others THEN
    RAISE EXCEPTION 'invalid_timezone' USING ERRCODE = '22023';
  END;

  RETURN QUERY
  WITH cohorts AS (
    SELECT b.id AS bidder_id,
           date_trunc('week', (b.created_at AT TIME ZONE v_tz))::date AS cohort_week
      FROM bidders b
     WHERE b.deleted_at IS NULL
  ),
  recent_cohorts AS (
    SELECT cohort_week, count(*) AS cohort_size
      FROM cohorts
     GROUP BY cohort_week
    HAVING count(*) >= 3
     ORDER BY cohort_week DESC
     LIMIT v_weeks
  ),
  bid_events AS (
    SELECT bd.bidder_id, bd.placed_at
      FROM bids bd
      JOIN lots l ON l.id = bd.lot_id
     WHERE l.operator_id = v_op
  ),
  pay_events AS (
    SELECT i.bidder_id, i.paid_at
      FROM invoices i
     WHERE i.operator_id = v_op
       AND i.paid_at IS NOT NULL
       AND i.status::text IN ('paid', 'partially_refunded', 'refunded')
  ),
  members AS (
    SELECT c.bidder_id, c.cohort_week
      FROM cohorts c
      JOIN recent_cohorts rc ON rc.cohort_week = c.cohort_week
  ),
  cur_week AS (
    SELECT date_trunc('week', (now() AT TIME ZONE v_tz))::date AS wk
  ),
  offsets AS (
    SELECT rc.cohort_week, gs.n AS weeks_since, rc.cohort_size
      FROM recent_cohorts rc
      CROSS JOIN generate_series(0, v_weeks - 1) AS gs(n)
      CROSS JOIN cur_week
     WHERE rc.cohort_week + (gs.n * 7) <= cur_week.wk
  ),
  bidded AS (
    SELECT m.cohort_week,
           ((date_trunc('week', (be.placed_at AT TIME ZONE v_tz))::date - m.cohort_week) / 7)::int AS weeks_since,
           count(DISTINCT be.bidder_id) AS n
      FROM members m
      JOIN bid_events be ON be.bidder_id = m.bidder_id
     GROUP BY 1, 2
  ),
  paid AS (
    SELECT m.cohort_week,
           ((date_trunc('week', (pe.paid_at AT TIME ZONE v_tz))::date - m.cohort_week) / 7)::int AS weeks_since,
           count(DISTINCT pe.bidder_id) AS n
      FROM members m
      JOIN pay_events pe ON pe.bidder_id = m.bidder_id
     GROUP BY 1, 2
  )
  SELECT o.cohort_week,
         o.weeks_since,
         o.cohort_size,
         round(100.0 * coalesce(bd.n, 0) / o.cohort_size, 1) AS bid_pct,
         round(100.0 * coalesce(pd.n, 0) / o.cohort_size, 1) AS win_pct
    FROM offsets o
    LEFT JOIN bidded bd ON bd.cohort_week = o.cohort_week AND bd.weeks_since = o.weeks_since
    LEFT JOIN paid   pd ON pd.cohort_week = o.cohort_week AND pd.weeks_since = o.weeks_since
   ORDER BY o.cohort_week, o.weeks_since;
END;
$function$;

COMMENT ON FUNCTION public.operator_bidder_cohorts(int, text) IS
  '0449: weekly signup cohorts (last p_weeks, default 12, clamped 1-52). '
  'One row per (cohort week, weeks since signup): cohort_size, % who bid '
  'that calendar week, % who had a paid invoice that week. Weeks bucket in '
  'p_tz wall clock, Monday start (same convention as operator_bidder_report, '
  'mig 0289). A cohort under 3 signups is dropped entirely. Admin/manager '
  'of current_operator_id() only (42501).';

REVOKE ALL ON FUNCTION public.operator_bidder_cohorts(int, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.operator_bidder_cohorts(int, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.operator_bidder_cohorts(int, text) TO authenticated;

COMMIT;
