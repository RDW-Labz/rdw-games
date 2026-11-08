-- 0343 — rank categories by how many people actually bid in them, so the ad
-- catalog can target the ones that work without anybody choosing items by hand.
--
-- ── WHY ─────────────────────────────────────────────────────────────────────
-- Bidders-per-lot is what sets the price of everything. Controlled for MSRP,
-- recovery runs 2.8% at one bidder and 24.5% at six. So the question "what
-- should we advertise" is really "what draws a second and third bidder", and
-- that is answerable from 45 days of closed lots rather than from taste.
--
-- Measured over the last 45 days (11,470 closed lots), the spread between
-- categories is 3.4×:
--
--   Patio Furniture      4.48 bidders/lot     Cell Phones & Acc.   0.80
--   Small Appliances     4.27                 Office & School      1.24
--   Appliances           3.89                 Auto & Powersports   1.32
--   Cleaning Supplies    3.88                 Appliance Parts      1.35
--   Living Room          3.85                 Party & Seasonal     1.51
--
-- The shape of the winning list is a real thing about the customer base, not
-- noise: they are self-contained working goods. A window A/C, a smoker, a
-- storage shed — items that arrive complete and work on arrival. The bottom of
-- the list is parts, accessories and flat-pack, where a missing piece is both
-- likely and fatal, and where a discount headline cannot fix it.
--
-- ── WHAT THIS FUNCTION IS FOR ───────────────────────────────────────────────
-- The Meta catalog feed (lib/marketing/product-feed.ts) stamps each tier onto
-- custom_label_2. A product set in Commerce Manager filtered to
-- custom_label_2 = proven then contains, at any moment, whatever is live in the
-- categories that draw bidders — about 200 lots, refreshed hourly with no human
-- picking anything. Meta's Advantage+ generates the ads from it.
--
-- ── WHY A DB FUNCTION AND NOT APP CODE ──────────────────────────────────────
-- The feed is fetched hourly and renders live state, so this has to be one
-- cheap round trip. Aggregating in the app would mean pulling 11k closed lots
-- and their bids over the wire every hour to compute 46 numbers.
--
-- ── THRESHOLDS ARE RELATIVE, NOT ABSOLUTE ───────────────────────────────────
-- Tiers are multiples of the platform-wide average (2.64 today), not fixed
-- bidder counts. Traffic grows, seasons turn, and a fixed 3.0 cut-off would
-- quietly relabel the whole catalog as "proven" the first good month. A ratio
-- keeps asking the only question worth asking: better or worse than our norm?

BEGIN;

CREATE OR REPLACE FUNCTION public.category_demand_tiers(
  p_window_days integer DEFAULT 45,
  p_min_lots    integer DEFAULT 40
)
RETURNS TABLE (
  category_id  uuid,
  name         text,
  lots         bigint,
  avg_bidders  numeric,
  tier         text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
  WITH per_lot AS (
    -- One row per closed lot with its distinct-bidder count. DISTINCT matters:
    -- a bid war between two people is six bids and two bidders, and it is the
    -- two that predicts what the next lot in that category will do.
    --
    -- LEFT JOIN so a lot nobody bid on counts as a zero rather than vanishing.
    -- Dropping them would flatter every slow category — the ones full of lots
    -- that got no bids at all are exactly what this is trying to find.
    SELECT l.id,
           l.category_id,
           count(DISTINCT b.bidder_id) AS bidders
      FROM lots l
      LEFT JOIN bids b ON b.lot_id = l.id
     WHERE l.deleted_at IS NULL
       AND l.category_id IS NOT NULL
       AND l.close_at < now()
       AND l.close_at > now() - make_interval(days => GREATEST(p_window_days, 1))
     GROUP BY l.id, l.category_id
  ),
  -- The benchmark: every closed lot in the window, categorised or not.
  platform AS (
    SELECT avg(bidders) AS avg_bidders FROM per_lot
  ),
  cat AS (
    SELECT p.category_id, count(*) AS lots, avg(p.bidders) AS avg_bidders
      FROM per_lot p
     GROUP BY p.category_id
  )
  SELECT c.category_id,
         cats.name,
         c.lots,
         round(c.avg_bidders, 2) AS avg_bidders,
         CASE
           -- Too few closings to say anything. Deliberately its own tier and
           -- NOT 'slow': "we have no evidence" and "we have evidence it does
           -- badly" are different claims, and collapsing them would bury a new
           -- category before it ever got shown to anyone.
           WHEN c.lots < GREATEST(p_min_lots, 1) THEN 'unproven'
           WHEN c.avg_bidders >= 1.15 * (SELECT avg_bidders FROM platform) THEN 'proven'
           WHEN c.avg_bidders <= 0.70 * (SELECT avg_bidders FROM platform) THEN 'slow'
           ELSE 'steady'
         END AS tier
    FROM cat c
    JOIN categories cats ON cats.id = c.category_id
   ORDER BY c.avg_bidders DESC;
$function$;

COMMENT ON FUNCTION public.category_demand_tiers(integer, integer) IS
  'Trailing-window distinct-bidders-per-lot by category, tiered against the platform average. Feeds custom_label_2 in the Meta catalog.';

-- The catalog feed runs as service_role. Granted to authenticated as well so
-- the operator UI can show the same ranking without a second implementation
-- drifting away from this one; it exposes only aggregate counts over lots that
-- are already public on /browse.
GRANT EXECUTE ON FUNCTION public.category_demand_tiers(integer, integer)
  TO authenticated, service_role;

-- No new index. The obvious one — lots(close_at DESC, category_id) — was built
-- on prod inside a rolled-back transaction and EXPLAIN chose lots_pkey anyway:
-- the plan is a merge join against bids_lot_idx, which wants rows in id order,
-- so a close_at index cannot feed it. 187ms once an hour, entirely from shared
-- buffers. An index the planner declines to use is pure write amplification on
-- a table that takes an UPDATE on every bid.

COMMIT;
