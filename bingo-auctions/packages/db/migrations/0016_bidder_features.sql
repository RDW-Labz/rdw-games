-- ============================================================================
-- Per-operator bidder feature flags.
--
-- Operators (our SaaS customers) want to differentiate their bidder-
-- facing experience: which search/sort/filter conveniences are visible,
-- and which are gated behind a per-operator paid bidder tier (Pro).
-- A single JSONB column on operators keeps the schema simple and lets
-- us add new flags without migrations.
--
-- Value semantics per flag:
--   "all"  — visible to everyone (free + Pro bidders)
--   "pro"  — visible only to bidders with active Pro subscription
--            on this operator (subscriptions table, status='active')
--   "off"  — feature hidden entirely
--   missing — treated as "off"
--
-- The bidder app reads bidder_features for each operator on screen
-- and gates UI accordingly. The operator dashboard exposes a settings
-- page where the operator picks the value for each flag.
--
-- Default seeds the basics as "all" so existing operators keep parity
-- with the pre-flags experience until they explicitly customize.
-- ============================================================================

ALTER TABLE operators
  ADD COLUMN IF NOT EXISTS bidder_features JSONB NOT NULL DEFAULT '{
    "search_bar": "all",
    "category_filter": "all",
    "condition_filter": "all",
    "msrp_discount_filter": "off",
    "multi_warehouse": "all",
    "sort_ending_soon": "all",
    "sort_newest": "all",
    "sort_highest_bid": "off",
    "sort_most_bids": "off",
    "sort_biggest_discount": "off",
    "sort_low_to_high_price": "off",
    "saved_searches": "off",
    "category_subscriptions": "off",
    "featured_deals": "off",
    "recently_viewed": "all",
    "compare_lots": "off",
    "operator_follow": "off"
  }'::jsonb;

COMMENT ON COLUMN operators.bidder_features IS
  'Per-operator bidder UI flags. Each key is a feature name, each value is "all" | "pro" | "off". Missing keys are treated as "off". The bidder app reads this to gate which search/sort/filter controls are visible to this operator''s bidders. Pro values require an active subscription on this operator.';

-- Backfill: any pre-existing rows that had a row-level default at create
-- time will still have it. Newly added flags become "off" implicitly via
-- the missing-key rule, so existing operators don't suddenly see new
-- features without opting in.
