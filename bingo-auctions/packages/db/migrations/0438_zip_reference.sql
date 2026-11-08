-- 0438 — ZIP-to-city reference table + city/state filters for Bidders by ZIP.
--
-- DATA AND LICENCE
--   public.zip_reference is filled by scripts/load-zip-reference.mjs (service
--   role), not by this migration, from GeoNames' US postal code dump:
--     https://download.geonames.org/export/zip/US.zip  (readme.txt in the zip)
--   GeoNames licence: Creative Commons Attribution 4.0
--     https://creativecommons.org/licenses/by/4.0/
--   ATTRIBUTION IS REQUIRED wherever the data is shown or exported: credit
--   GeoNames with a link to https://www.geonames.org. The console shows
--   "ZIP places © GeoNames (geonames.org), CC BY 4.0" under the Bidders by
--   ZIP report, and the CSV export carries the same line. Keep both if the
--   report moves. The data is provided "as is" (GeoNames readme).
--   One place per ZIP (GeoNames' primary place name), incl. PO-box ZIPs.
--   APO/FPO/DPO ZIPs keep the military "state" codes AA / AE / AP.
--
-- WHAT
--   1. zip_reference (empty here; the loader fills it). No personal data.
--      RLS on; SELECT for authenticated only; no anon; only service_role
--      writes (it bypasses RLS).
--   2. operator_bidder_location_summary_by_place(...): 0434's report plus
--      city/state columns and optional p_state / p_city filters. A NEW
--      function, not a change to 0434's: the extra output columns would
--      force a DROP of the live 0434 function (CREATE OR REPLACE can't change
--      a return type), and an overload with defaulted extra args makes 0434's
--      4-argument calls ambiguous. The console calls this one and falls back
--      to 0434's when it is missing, so the page works before and after.
--   3. operator_bidder_places(): the state / city choices for the filter
--      dropdowns, each with >= 3 registered bidders.
--
-- PRIVACY ORDER (same rules as 0434)
--   The ZIP roll-up (< 3 registered bidders → 'Other (fewer than 3)') is
--   computed over ALL bidders first, then the city / state filter selects
--   bidders. A city or state with fewer than 3 registered bidders returns no
--   rows at all (indistinguishable from none), and is not offered by
--   operator_bidder_places(). city/state are NULL on 'Other' and 'Unknown'
--   rows. A real ZIP not in zip_reference has NULL city/state (shown as
--   'Unlisted ZIP') and drops out under a city or state filter.
--   p_city needs p_state (city names repeat across states).
--
-- LOCKS: a new table and new functions only; nothing touches lots, bids,
--   invoices or bidders' rows. Additive; safe any hour (Rule 9).
-- EMPTY DATABASE: safe; creates an empty table and functions (plpgsql bodies
--   are not checked against bidders.postal_code until called).
-- Rollback: scripts/prod-rig/0438_ROLLBACK_zip_reference.sql

SET lock_timeout = '3s';

BEGIN;

-- ── 1. zip_reference ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.zip_reference (
  postal_code text PRIMARY KEY CHECK (postal_code ~ '^[0-9]{5}$'),
  city        text NOT NULL CHECK (length(btrim(city)) BETWEEN 1 AND 100),
  state       text NOT NULL CHECK (state ~ '^[A-Z]{2}$'),
  county      text,
  lat         numeric(7,4),
  lon         numeric(7,4),
  source      text NOT NULL DEFAULT 'geonames',
  loaded_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS zip_reference_state_city_idx
  ON public.zip_reference (state, lower(city));

COMMENT ON TABLE public.zip_reference IS
  '0438: one primary place per US ZIP, from GeoNames US.zip (CC BY 4.0, '
  'credit GeoNames with a link to geonames.org wherever shown). Filled by '
  'scripts/load-zip-reference.mjs (service role). No personal data.';

ALTER TABLE public.zip_reference ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS zip_reference_read ON public.zip_reference;
CREATE POLICY zip_reference_read ON public.zip_reference
  FOR SELECT TO authenticated
  USING (true);

-- Supabase's default privileges grant ALL on new tables to anon,
-- authenticated and service_role. Take that back, then grant exactly.
REVOKE ALL ON TABLE public.zip_reference FROM PUBLIC;
REVOKE ALL ON TABLE public.zip_reference FROM anon;
REVOKE ALL ON TABLE public.zip_reference FROM authenticated;
GRANT SELECT ON TABLE public.zip_reference TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.zip_reference TO service_role;

-- ── 2. operator_bidder_location_summary_by_place ────────────────────────────

CREATE OR REPLACE FUNCTION public.operator_bidder_location_summary_by_place(
  p_from         timestamptz,
  p_to           timestamptz,
  p_warehouse_id uuid DEFAULT NULL,
  p_zip_prefix   text DEFAULT NULL,
  p_state        text DEFAULT NULL,
  p_city         text DEFAULT NULL
)
RETURNS TABLE(
  postal_code     text,
  city            text,
  state           text,
  warehouse_id    uuid,
  warehouse_name  text,
  registered      bigint,
  active_bidders  bigint,
  buyers          bigint,
  paid_invoices   bigint,
  sales_net_cents bigint
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
  v_state  text := upper(nullif(btrim(coalesce(p_state, '')), ''));
  v_city   text := lower(nullif(btrim(coalesce(p_city, '')), ''));
BEGIN
  IF v_op IS NULL
     OR current_operator_role() IS NULL
     OR current_operator_role()::text NOT IN ('admin', 'manager') THEN
    RAISE EXCEPTION 'bidder_location_forbidden' USING ERRCODE = '42501';
  END IF;

  IF p_warehouse_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM warehouses w WHERE w.id = p_warehouse_id AND w.operator_id = v_op
  ) THEN
    RAISE EXCEPTION 'bidder_location_forbidden' USING ERRCODE = '42501';
  END IF;

  IF v_prefix IS NOT NULL AND v_prefix !~ '^[0-9]{1,5}$' THEN
    RAISE EXCEPTION 'invalid_zip_prefix' USING ERRCODE = '22023';
  END IF;
  IF v_state IS NOT NULL AND v_state !~ '^[A-Z]{2}$' THEN
    RAISE EXCEPTION 'invalid_state' USING ERRCODE = '22023';
  END IF;
  IF v_city IS NOT NULL AND (v_state IS NULL OR length(v_city) > 100) THEN
    RAISE EXCEPTION 'invalid_city' USING ERRCODE = '22023',
      HINT = 'A city filter needs a state (p_state) and at most 100 characters.';
  END IF;

  RETURN QUERY
  WITH
  -- Roll-up first, over ALL non-deleted bidders (0434's rule), so no filter
  -- can change which ZIPs are shown by name.
  zip_sizes AS (
    SELECT b.postal_code AS zip, count(*) AS n
      FROM bidders b
     WHERE b.deleted_at IS NULL AND b.postal_code IS NOT NULL
     GROUP BY b.postal_code
  ),
  bp AS (
    SELECT b.id, b.deleted_at, b.postal_code AS zip, zr.city AS zcity, zr.state AS zstate
      FROM bidders b
      LEFT JOIN zip_reference zr ON zr.postal_code = b.postal_code
  ),
  place_ok AS (
    -- the filtered state / city has >= 3 registered bidders (else: no rows)
    SELECT
      (v_state IS NULL OR (SELECT count(*) FROM bp WHERE bp.deleted_at IS NULL AND bp.zstate = v_state) >= 3)
      AND
      (v_city IS NULL OR (SELECT count(*) FROM bp WHERE bp.deleted_at IS NULL AND bp.zstate = v_state
                                                   AND lower(bp.zcity) = v_city) >= 3) AS ok
  ),
  bz AS (
    SELECT bp.id AS bidder_id,
           bp.deleted_at,
           CASE WHEN bp.zip IS NULL           THEN 'Unknown'
                WHEN coalesce(zs.n, 0) < 3    THEN 'Other (fewer than 3)'
                ELSE bp.zip END               AS zip_group,
           CASE WHEN bp.zip IS NOT NULL AND coalesce(zs.n, 0) >= 3 THEN bp.zcity  END AS g_city,
           CASE WHEN bp.zip IS NOT NULL AND coalesce(zs.n, 0) >= 3 THEN bp.zstate END AS g_state
      FROM bp
      LEFT JOIN zip_sizes zs ON zs.zip = bp.zip
      CROSS JOIN place_ok
     WHERE place_ok.ok
       AND (v_prefix IS NULL OR bp.zip LIKE v_prefix || '%')
       AND (v_state  IS NULL OR bp.zstate = v_state)
       AND (v_city   IS NULL OR lower(bp.zcity) = v_city)
  ),
  bid_act AS (
    SELECT DISTINCT bd.bidder_id, w.id AS wh
      FROM bids bd
      JOIN lots l            ON l.id = bd.lot_id
      LEFT JOIN auctions a   ON a.id = l.auction_id
      LEFT JOIN warehouses w ON w.id = a.warehouse_id AND w.operator_id = v_op
     WHERE l.operator_id = v_op
       AND (p_from IS NULL OR bd.placed_at >= p_from)
       AND (p_to   IS NULL OR bd.placed_at <  p_to)
  ),
  inv AS (
    SELECT i.id, i.bidder_id, w.id AS wh,
           coalesce(i.subtotal_cents, 0)      AS subtotal,
           coalesce(i.buyer_premium_cents, 0) AS premium,
           i.status::text                     AS status
      FROM invoices i
      LEFT JOIN auctions a   ON a.id = i.auction_id
      LEFT JOIN warehouses w ON w.id = a.warehouse_id AND w.operator_id = v_op
     WHERE i.operator_id = v_op
       AND i.paid_at IS NOT NULL
       AND i.status::text IN ('paid', 'partially_refunded', 'refunded')
       AND (p_from IS NULL OR i.paid_at >= p_from)
       AND (p_to   IS NULL OR i.paid_at <  p_to)
  ),
  inv_net AS (
    SELECT inv.id, inv.bidder_id, inv.wh,
           CASE WHEN inv.status = 'refunded' THEN 0::bigint
                ELSE (inv.subtotal + inv.premium - coalesce((
                  SELECT sum(il.winning_bid_cents
                             + CASE WHEN inv.subtotal > 0
                                    THEN round(inv.premium::numeric * il.winning_bid_cents
                                               / inv.subtotal)::bigint
                                    ELSE 0 END)
                    FROM invoice_lots il
                   WHERE il.invoice_id = inv.id
                     AND il.refunded_at IS NOT NULL), 0))::bigint
           END AS net
      FROM inv
  ),
  act AS (
    SELECT ba.bidder_id, ba.wh, true AS is_bid, NULL::uuid AS invoice_id, 0::bigint AS net
      FROM bid_act ba
    UNION ALL
    SELECT n.bidder_id, n.wh, false, n.id, n.net
      FROM inv_net n
  ),
  act_rows AS (
    SELECT bz.zip_group, bz.g_city, bz.g_state,
           act.wh,
           count(DISTINCT act.bidder_id)                                  AS registered,
           count(DISTINCT act.bidder_id) FILTER (WHERE act.is_bid)        AS active_bidders,
           count(DISTINCT act.bidder_id) FILTER (WHERE NOT act.is_bid)    AS buyers,
           count(act.invoice_id)                                          AS paid_invoices,
           coalesce(sum(act.net), 0)::bigint                              AS sales_net_cents
      FROM act
      JOIN bz ON bz.bidder_id = act.bidder_id
     WHERE p_warehouse_id IS NULL OR act.wh = p_warehouse_id
     GROUP BY bz.zip_group, bz.g_city, bz.g_state, act.wh
  ),
  idle_rows AS (
    SELECT bz.zip_group, bz.g_city, bz.g_state, count(*) AS registered
      FROM bz
     WHERE bz.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM act WHERE act.bidder_id = bz.bidder_id)
     GROUP BY bz.zip_group, bz.g_city, bz.g_state
  ),
  out_rows AS (
    SELECT ar.zip_group, ar.g_city, ar.g_state, ar.wh,
           CASE WHEN ar.wh IS NULL THEN 'Unassigned' ELSE w.name END AS wh_name,
           ar.registered, ar.active_bidders, ar.buyers, ar.paid_invoices, ar.sales_net_cents,
           0 AS idle_sort
      FROM act_rows ar
      LEFT JOIN warehouses w ON w.id = ar.wh
    UNION ALL
    SELECT ir.zip_group, ir.g_city, ir.g_state, NULL::uuid, 'No activity in range',
           ir.registered, 0::bigint, 0::bigint, 0::bigint, 0::bigint,
           1
      FROM idle_rows ir
     WHERE p_warehouse_id IS NULL
  )
  SELECT o.zip_group::text,
         o.g_city::text,
         o.g_state::text,
         o.wh,
         o.wh_name::text,
         o.registered::bigint,
         o.active_bidders::bigint,
         o.buyers::bigint,
         o.paid_invoices::bigint,
         o.sales_net_cents::bigint
    FROM out_rows o
   ORDER BY CASE o.zip_group WHEN 'Other (fewer than 3)' THEN 1 WHEN 'Unknown' THEN 2 ELSE 0 END,
            o.zip_group,
            o.idle_sort,
            o.wh_name;
END;
$function$;

COMMENT ON FUNCTION public.operator_bidder_location_summary_by_place(timestamptz, timestamptz, uuid, text, text, text) IS
  '0438: operator_bidder_location_summary (0434) + city/state (GeoNames via '
  'zip_reference) and optional p_state / p_city filters. ZIP roll-up (< 3) is '
  'computed before the filters; a state/city with < 3 bidders returns no rows. '
  'Admin/manager of current_operator_id() only (42501). Read-only.';

REVOKE ALL ON FUNCTION public.operator_bidder_location_summary_by_place(timestamptz, timestamptz, uuid, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.operator_bidder_location_summary_by_place(timestamptz, timestamptz, uuid, text, text, text) FROM anon;
GRANT EXECUTE ON FUNCTION public.operator_bidder_location_summary_by_place(timestamptz, timestamptz, uuid, text, text, text)
  TO authenticated, service_role;

-- ── 3. operator_bidder_places ───────────────────────────────────────────────
-- Filter choices: one row per state (city NULL) and per city with >= 3
-- registered (non-deleted) bidders whose ZIP is in zip_reference.

CREATE OR REPLACE FUNCTION public.operator_bidder_places()
RETURNS TABLE(state text, city text, registered bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
#variable_conflict use_column
BEGIN
  IF current_operator_id() IS NULL
     OR current_operator_role() IS NULL
     OR current_operator_role()::text NOT IN ('admin', 'manager') THEN
    RAISE EXCEPTION 'bidder_location_forbidden' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH bp AS (
    SELECT zr.state AS s, zr.city AS c
      FROM bidders b
      JOIN zip_reference zr ON zr.postal_code = b.postal_code
     WHERE b.deleted_at IS NULL
  )
  SELECT x.s::text, x.c::text, x.n::bigint
    FROM (
      SELECT bp.s, NULL::text AS c, count(*) AS n FROM bp GROUP BY bp.s HAVING count(*) >= 3
      UNION ALL
      SELECT bp.s, min(bp.c), count(*) FROM bp GROUP BY bp.s, lower(bp.c) HAVING count(*) >= 3
    ) x
   ORDER BY x.s, x.c NULLS FIRST;
END;
$function$;

COMMENT ON FUNCTION public.operator_bidder_places() IS
  '0438: states and cities (GeoNames via zip_reference) with >= 3 registered '
  'bidders, for the Bidders by ZIP filters. Admin/manager only (42501). Read-only.';

REVOKE ALL ON FUNCTION public.operator_bidder_places() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.operator_bidder_places() FROM anon;
GRANT EXECUTE ON FUNCTION public.operator_bidder_places() TO authenticated, service_role;

COMMIT;
