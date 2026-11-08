-- 0240 — auction performance v2: running (live) hammer + AUR inputs
--
-- Owner, 2026-07-06: "on auction performance page, can I get a current
-- hammer price with AUR". gross_cents only counts WON lots, so a live
-- auction reads $0 until lots start closing. Add:
--   open_hammer_cents — sum of current_bid_cents on still-open lots that
--                       have at least one bid (the hammer if it closed now)
--   open_bid_lots     — count of those lots (AUR denominator on the page:
--                       (gross + open_hammer) / (sold + open_bid_lots))
--
-- Full CREATE OR REPLACE of operator_auction_performance() (mig 0225),
-- same staff gate + shape otherwise. Idempotent.

BEGIN;

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
        'sold', s.sold,
        -- 'relisted' counts as unsold for the SOURCE auction: it didn't
        -- sell there and was pushed to a later auction.
        'unsold', s.unsold,
        'still_open', s.still_open,
        'gross_cents', s.gross_cents,
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
        count(*) FILTER (WHERE l.deleted_at IS NULL)                              AS lots_total,
        count(*) FILTER (WHERE l.status::text = 'won')                            AS sold,
        count(*) FILTER (WHERE l.status::text IN ('unsold', 'relisted'))          AS unsold,
        count(*) FILTER (WHERE l.status::text IN ('live', 'scheduled'))           AS still_open,
        coalesce(sum(l.current_bid_cents) FILTER (WHERE l.status::text = 'won'), 0) AS gross_cents,
        -- 0240: running hammer on open lots with at least one bid.
        coalesce(sum(l.current_bid_cents) FILTER (
          WHERE l.status::text IN ('live', 'scheduled') AND l.bid_count > 0
        ), 0)                                                                     AS open_hammer_cents,
        count(*) FILTER (
          WHERE l.status::text IN ('live', 'scheduled') AND l.bid_count > 0
        )                                                                         AS open_bid_lots,
        coalesce(sum(l.bid_count), 0)                                             AS bids,
        coalesce(sum(l.msrp_cents) FILTER (WHERE l.status::text = 'won'), 0)      AS msrp_sold_cents
      FROM public.lots l
      WHERE l.auction_id = a.id
    ) s ON true
    ORDER BY coalesce(a.ends_at, a.starts_at) DESC
    LIMIT 30
  ) t;

  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.operator_auction_performance() TO authenticated;

COMMIT;
