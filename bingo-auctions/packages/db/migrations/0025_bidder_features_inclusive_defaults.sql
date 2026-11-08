-- ============================================================================
-- Bidder-features: shift default policy from "operator opt-in" to
-- "operator opt-out" for flags that have no operator-specific dependency.
--
-- The original 0016 default was deliberately conservative: every "non-
-- universal" feature shipped as "off" so existing operators never
-- silently grew new bidder UI surface. In practice this produced a
-- noticeably thin default browse experience: only ending-soon and
-- newest sorts visible, no saved searches, no contested-most sort.
--
-- The flags below have no operator-specific data dependency:
--   - sort_highest_bid / sort_most_bids / sort_low_to_high_price /
--     sort_biggest_discount  — pure SQL ordering primitives
--   - saved_searches  — per-bidder, server-stored, not per-operator
--   - msrp_discount_filter  — pure client-side calc on lots.msrp_cents
--   - compare_lots  — local UI feature, no operator surface
--
-- Backfill flips each of those flags from "off" to "all" individually.
-- "pro" values are preserved (operator deliberately gated behind a
-- subscription); "all" values stay as-is.
-- ============================================================================

ALTER TABLE operators
  ALTER COLUMN bidder_features SET DEFAULT '{
    "search_bar": "all",
    "category_filter": "all",
    "condition_filter": "all",
    "msrp_discount_filter": "all",
    "multi_warehouse": "all",
    "sort_ending_soon": "all",
    "sort_newest": "all",
    "sort_highest_bid": "all",
    "sort_most_bids": "all",
    "sort_biggest_discount": "all",
    "sort_low_to_high_price": "all",
    "saved_searches": "all",
    "category_subscriptions": "off",
    "featured_deals": "off",
    "recently_viewed": "all",
    "compare_lots": "all",
    "operator_follow": "off"
  }'::jsonb;

-- Per-flag backfill: only flip flags that are currently exactly "off".
-- A flag set to "pro" is a deliberate paywall choice and is preserved.
DO $$
DECLARE
  flag TEXT;
  flags TEXT[] := ARRAY[
    'msrp_discount_filter',
    'sort_highest_bid',
    'sort_most_bids',
    'sort_biggest_discount',
    'sort_low_to_high_price',
    'saved_searches',
    'compare_lots'
  ];
BEGIN
  FOREACH flag IN ARRAY flags LOOP
    EXECUTE format(
      'UPDATE operators SET bidder_features = jsonb_set(bidder_features, %L, %L::jsonb) WHERE bidder_features->>%L = %L',
      '{' || flag || '}',
      '"all"',
      flag,
      'off'
    );
  END LOOP;
END $$;
