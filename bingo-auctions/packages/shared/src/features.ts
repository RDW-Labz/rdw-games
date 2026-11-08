// Per-operator bidder feature flags.
//
// Operators define which search/sort/filter conveniences their bidders
// see. Each flag has three states:
//   "all"  — every bidder sees it
//   "pro"  — only bidders with an active subscription to this operator
//   "off"  — feature hidden entirely (also the missing-key default)
//
// On cross-operator browse views (no specific operator selected), we
// fall back to a hardcoded "universal defaults" set rather than trying
// to merge flags across operators — the answer to "should I show the
// search bar when 14 different operators have different rules?" is
// always: show the basic universal stuff, defer the customizable
// stuff until the bidder narrows to one operator's storefront.

export type FlagValue = 'all' | 'pro' | 'off';

export type FeatureKey =
  // Search & filter
  | 'search_bar'
  | 'category_filter'
  | 'condition_filter'
  | 'msrp_discount_filter'
  | 'multi_warehouse'
  // Sorts
  | 'sort_ending_soon'
  | 'sort_newest'
  | 'sort_highest_bid'
  | 'sort_most_bids'
  | 'sort_biggest_discount'
  | 'sort_low_to_high_price'
  // Discovery convenience
  | 'saved_searches'
  | 'category_subscriptions'
  | 'featured_deals'
  | 'recently_viewed'
  | 'compare_lots'
  | 'operator_follow';

export type BidderFeatures = Partial<Record<FeatureKey, FlagValue>>;

export type BidderTier = 'free' | 'pro';

// Hardcoded universal defaults for the cross-operator browse. Includes
// every flag that has no operator-specific data dependency: pure SQL
// sort orderings, per-bidder server features, client-side filters, and
// local-only conveniences. Operator-coupled flags (multi_warehouse,
// featured_deals, operator_follow, category_subscriptions) stay opt-in
// because they only make sense scoped to a single operator's storefront.
export const UNIVERSAL_DEFAULTS: BidderFeatures = {
  // Search & filter
  search_bar: 'all',
  category_filter: 'all',
  condition_filter: 'all',
  msrp_discount_filter: 'all',
  // Sorts (every implemented sort in the bidder browse screen)
  sort_ending_soon: 'all',
  sort_newest: 'all',
  sort_highest_bid: 'all',
  sort_most_bids: 'all',
  sort_low_to_high_price: 'all',
  // Discovery — per-bidder or local-only, not per-operator
  saved_searches: 'all',
  recently_viewed: 'all',
  compare_lots: 'all',
};

export function isFeatureVisible(
  value: FlagValue | undefined,
  tier: BidderTier,
): boolean {
  if (value === 'all') return true;
  if (value === 'pro') return tier === 'pro';
  return false;
}

// Catalog of every flag plus a human-readable label and a one-line
// description. Used by both the operator admin page (settings UI) and
// any analytics/diagnostics. Order here = display order in the
// operator admin.
export const FEATURE_CATALOG: Array<{
  key: FeatureKey;
  group: 'search' | 'sort' | 'discovery';
  label: string;
  description: string;
}> = [
  // Search & filter
  {
    key: 'search_bar',
    group: 'search',
    label: 'Text search',
    description: 'Free-text search across lot titles and descriptions.',
  },
  {
    key: 'category_filter',
    group: 'search',
    label: 'Category filter',
    description: 'Filter chips for lot categories (Tools, Vanities, etc).',
  },
  {
    key: 'condition_filter',
    group: 'search',
    label: 'Condition filter',
    description: 'Filter by item condition: appears-new / open-box / good / as-is.',
  },
  {
    key: 'msrp_discount_filter',
    group: 'search',
    label: 'Discount filter',
    description: '"50%+ off MSRP" / "70%+ off" filter chips.',
  },
  {
    key: 'multi_warehouse',
    group: 'search',
    label: 'All warehouses',
    description: 'Browse lots across all of your warehouses (vs. single).',
  },
  // Sorts
  {
    key: 'sort_ending_soon',
    group: 'sort',
    label: 'Sort: ending soon',
    description: 'Default sort. Lots closing first appear first.',
  },
  {
    key: 'sort_newest',
    group: 'sort',
    label: 'Sort: newest',
    description: 'Most recently listed lots first.',
  },
  {
    key: 'sort_highest_bid',
    group: 'sort',
    label: 'Sort: highest current bid',
    description: 'Most expensive lots first.',
  },
  {
    key: 'sort_most_bids',
    group: 'sort',
    label: 'Sort: most contested',
    description: 'Most bid-on lots first — surfaces social proof.',
  },
  {
    key: 'sort_biggest_discount',
    group: 'sort',
    label: 'Sort: biggest discount',
    description: '% off MSRP, descending.',
  },
  {
    key: 'sort_low_to_high_price',
    group: 'sort',
    label: 'Sort: cheapest first',
    description: 'Bargain-hunter mode.',
  },
  // Discovery
  {
    key: 'saved_searches',
    group: 'discovery',
    label: 'Saved searches',
    description: 'Bidder saves a query, gets push when matching lots list.',
  },
  {
    key: 'category_subscriptions',
    group: 'discovery',
    label: 'Category subscriptions',
    description: 'Push notification per category.',
  },
  {
    key: 'featured_deals',
    group: 'discovery',
    label: 'Featured deals row',
    description: 'You curate a row of standouts at the top of browse.',
  },
  {
    key: 'recently_viewed',
    group: 'discovery',
    label: 'Recently viewed',
    description: 'Last 20 lots the bidder opened.',
  },
  {
    key: 'compare_lots',
    group: 'discovery',
    label: 'Compare lots',
    description: 'Side-by-side comparison of selected lots.',
  },
  {
    key: 'operator_follow',
    group: 'discovery',
    label: 'Follow operator',
    description: 'Notify the bidder when you list a new auction.',
  },
];
