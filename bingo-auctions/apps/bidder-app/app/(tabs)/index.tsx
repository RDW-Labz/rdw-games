// Browse — 2-column photo grid of live + scheduled lots across all
// operators. Sorted by ending-soon by default; closing-soon lots flash
// red on the heat badge to drive last-minute engagement.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import {
  View,
  Text,
  FlatList,
  Pressable,
  TextInput,
  RefreshControl,
  ScrollView,
  Alert,
  Modal,
  Platform,
} from 'react-native';
import { Image } from 'expo-image';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { supabase } from '@auction-platform/supabase-client';
import { BRANDED_BUTTON_GREEN, BrandedButton, colors, type } from '@auction-platform/design-system';
import { formatCents } from '@auction-platform/shared';
import { LotCard, RecentWinsRail, type LotCardData } from '@auction-platform/domain-bidding';
import { QuickBidButton } from '@/features/bidding/QuickBidButton';
import {
  UNIVERSAL_DEFAULTS,
  isFeatureVisible,
  type BidderFeatures,
  type FeatureKey,
} from '@auction-platform/shared/features';
import { useOperatorFeatures } from '@auction-platform/supabase-client';
import { useCategories } from '@auction-platform/domain-bidding';
import { getRecentlyViewed } from '@auction-platform/domain-bidding';
import { setPagerContext } from '../../lib/browse-pager';
import {
  fetchDiscoverableAuctionIds,
  withoutUnlistedAuctionRows,
} from '../../lib/discoverable-auctions';
import { fetchOffsiteSales, type OffsiteSaleRow } from '../../lib/offsite-sales';
import { LiveAuctionCard } from '../../components/home/LiveAuctionCard';
// _components were moved to apps/bidder-app/components/home/ on 2026-05-24:
// expo-router 6.x registers files inside `(tabs)/_components/` as routes
// despite the underscore prefix (the convention applies to files, not
// folders inside a route group). That added 3 phantom "_co..." tabs to the
// bottom bar which all threw "Element type is invalid" on tap (no default
// export). Moving them outside `app/` removes them from the router's scan.
import { CategoryIcon } from '../../components/CategoryIcon';
import { HomeHero } from '../../components/home/HomeHero';
import { CategoryGrid } from '../../components/home/CategoryGrid';
import { SectionBanner, sectionBannerMobileSrc } from '../../components/home/SectionBanner';
import { ZipPrompt } from '../../components/home/ZipPrompt';
import {
  createSavedSearch,
  defaultNameFromCriteria,
  type SavedSearchCriteria,
} from '@auction-platform/domain-bidding';

type LotRow = {
  id: string;
  lot_code: string;
  title: string;
  current_bid_cents: number | null;
  starting_bid_cents: number;
  msrp_cents: number | null;
  bid_count: number;
  close_at: string;
  status: string;
  condition: string | null;
  photo_urls: string[] | null;
  operator_id: string;
  warehouse_id: string | null;
  operators: {
    business_name: string;
    logo_url: string | null;
    brand_color: string | null;
  } | null;
};

type WarehouseOption = { id: string; name: string };

// ── Identifier (UPC / ASIN / SKU / model) lookup ──────────────────────────────
// The browse search above runs full-text search on lots.search_tsv, which only
// indexes title/description — typing a UPC, ASIN, FNSKU, LPN, external_code,
// model, or MPN there returns nothing. find_lots_by_identifier (mig 0189) does
// an exact, RLS-governed lookup across those identifier columns. We fire it in
// parallel whenever the typed query LOOKS like a code (alphanumeric, no spaces,
// length >= 6) and surface any matches in a thin rail above the grid so a bidder
// who scanned/typed a product code lands on the right lot without leaving search.
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9-]{5,}$/;

// Row shape returned by find_lots_by_identifier — a public-safe column allowlist
// (NOT full lots). Rendered as a compact tappable row, not a full LotCard,
// because matches can span operators and the RPC omits operator/bid metadata.
type IdentifierMatch = {
  id: string;
  lot_code: string;
  title: string;
  current_bid_cents: number | null;
  starting_bid_cents: number;
  close_at: string | null;
  status: string;
  photo_urls: string[] | null;
  auction_id: string | null;
};

const WAREHOUSE_FILTER_KEY = 'browse_warehouse_filter_v1';

type Sort =
  | 'ending_soon'
  | 'newest'
  | 'highest_bid'
  | 'most_bids'
  | 'low_to_high_price';

// Each sort maps to (a) the feature flag that gates it and (b) the
// PostgREST column + direction. Flag-gated sorts fall back to
// 'ending_soon' if the operator turns them off mid-session.
const SORT_DEFS: Record<
  Sort,
  { flag: FeatureKey; label: string; column: string; ascending: boolean }
> = {
  ending_soon: {
    flag: 'sort_ending_soon',
    label: 'Ending soon',
    column: 'close_at',
    ascending: true,
  },
  newest: {
    flag: 'sort_newest',
    label: 'Newest',
    column: 'created_at',
    ascending: false,
  },
  highest_bid: {
    flag: 'sort_highest_bid',
    label: 'Highest bid',
    column: 'current_bid_cents',
    ascending: false,
  },
  most_bids: {
    flag: 'sort_most_bids',
    label: 'Most contested',
    column: 'bid_count',
    ascending: false,
  },
  low_to_high_price: {
    flag: 'sort_low_to_high_price',
    label: 'Cheapest first',
    column: 'current_bid_cents',
    ascending: true,
  },
};
const SORT_ORDER: Sort[] = ['ending_soon', 'newest', 'highest_bid', 'most_bids', 'low_to_high_price'];

// ── Condition filter ─────────────────────────────────────────────────────────
//
// Aligned to the lotting canonical condition slugs defined in
// apps/field-mobile/features/lotting/SessionContext.tsx:25 and the
// DB enum in packages/db/migrations/0001_init.sql:23:
//   CREATE TYPE lot_condition AS ENUM ('appears_new','open_box','good','as_is')
//
// The 4 real slugs match what lotting writes to lots.condition. Two virtual
// slugs ('ending_soon', 'top_deal') are computed client-side from close_at +
// bid ratios after the fetch — they never touch the DB query.
//
// NOTE: The old filter had 'new', 'like_new', 'tested' which do NOT exist in
// the DB enum and produced empty results. Those phantom filter options are
// removed. If seed data carries legacy slugs ('new','tested','like-new'), the
// LotCard.CONDITION_LABEL_MAP already maps them for display — but they are not
// filterable via this pack because lotting never produces them.

type ConditionSlug =
  | 'appears_new'
  | 'open_box'
  | 'good'
  | 'as_is'
  | 'ending_soon'
  | 'top_deal';

const CONDITION_OPTIONS: Array<{ value: ConditionSlug; label: string }> = [
  { value: 'appears_new', label: 'Appears New' },
  { value: 'open_box', label: 'Open Box' },
  { value: 'good', label: 'Good' },
  { value: 'as_is', label: 'As-Is' },
  { value: 'ending_soon', label: 'Ending Soon' },
  { value: 'top_deal', label: 'Top Deal' },
];

const VIRTUAL_CONDITION_SLUGS: ReadonlyArray<ConditionSlug> = ['ending_soon', 'top_deal'];

const CONDITION_DB_VALUES: Record<
  Exclude<ConditionSlug, 'ending_soon' | 'top_deal'>,
  string[]
> = {
  // Each canonical slug maps to itself only — these ARE the DB enum values.
  // Legacy variant spellings ('appears-new', 'open-box', 'as-is' with
  // hyphens) are included for rows written by older code paths.
  appears_new: ['appears_new'],
  open_box: ['open_box', 'open-box'],
  good: ['good'],
  as_is: ['as_is', 'as-is'],
};

// Same thresholds the web uses + LotCard badge.
const ENDING_SOON_WINDOW_MS = 5 * 60 * 1000;
const TOP_DEAL_MULTIPLIER = 1.5;

// Hard ceiling for price input so a typo can't produce e.g. 999999999999
// dollars which overflows BIGINT cents when × 100. $10M is an order of
// magnitude beyond any real lot.
const MAX_PRICE_DOLLARS = 10_000_000;

// Lots per page. Module-level so it's stable across renders and safe
// to include in useCallback dep arrays without triggering unnecessary
// re-memoisation.
const PAGE_SIZE = 40;

type Operator = { id: string; business_name: string };

export default function BrowseScreen() {
  const router = useRouter();
  const [lots, setLots] = useState<LotRow[]>([]);
  const [operators, setOperators] = useState<Operator[]>([]);
  const [operatorFilter, setOperatorFilter] = useState<string | 'all'>('all');
  // Multi-select (2026-07-07, customer request): every selected top-level
  // category id. Empty set = all categories.
  const [categoryFilters, setCategoryFilters] = useState<Set<string>>(new Set());
  const toggleCategoryFilter = useCallback((id: string | null) => {
    setCategoryFilters((prev) => {
      if (id === null) return new Set<string>();
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const [discountFilter, setDiscountFilter] = useState<0 | 50 | 70 | 90>(0); // % off MSRP minimum
  // Multi-select Condition chips. Mirrors web's FilterRail behaviour: each
  // tap toggles the slug in/out of the set. Order is irrelevant for the
  // query so we keep it as Set<string> to make membership tests O(1).
  const [selectedConditions, setSelectedConditions] = useState<Set<ConditionSlug>>(
    () => new Set(),
  );
  // Price min/max in DOLLARS (not cents). null = unbounded. Applied lots
  // are converted to cents at query time. We keep a separate "draft" pair
  // of strings for the two TextInputs so the user can type a partial
  // number ("10.") without it being treated as a real bound until Apply.
  const [priceMinDollars, setPriceMinDollars] = useState<number | null>(null);
  const [priceMaxDollars, setPriceMaxDollars] = useState<number | null>(null);
  const [priceMinDraft, setPriceMinDraft] = useState<string>('');
  const [priceMaxDraft, setPriceMaxDraft] = useState<string>('');
  // Inline validation message for the price row. Cleared on next valid Apply.
  const [priceError, setPriceError] = useState<string | null>(null);
  // Warehouse filter — 'all' or a specific warehouse id. Persisted in
  // AsyncStorage so the selection survives navigation and app restarts.
  const [warehouseFilter, setWarehouseFilter] = useState<string | 'all'>('all');
  const [warehouses, setWarehouses] = useState<WarehouseOption[]>([]);

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort>('ending_soon');
  const [now, setNow] = useState(Date.now());

  // Identifier (UPC/ASIN/SKU/model) matches for the current search term.
  // Populated only when `search` looks like a code; cleared otherwise.
  const [codeMatches, setCodeMatches] = useState<IdentifierMatch[]>([]);

  // ── Pagination ──────────────────────────────────────────────────────────────
  // cursor-based: we remember how many lots we've loaded so far and append
  // the next PAGE_SIZE on "Load more". Resetting to 0 triggers a fresh full
  // load from the top (used when any filter/sort changes).
  const [lotOffset, setLotOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  // ── Auction-id filter (from the Live Auctions rail tap) ────────────────────
  const [auctionIdFilter, setAuctionIdFilter] = useState<string | null>(null);
  // Modal-based filter sheet. The Browse screen used to stack ~260 lines
  // of filter rails above the lot grid, forcing the user to scroll past
  // them before seeing any lots. We now keep only search + sort inline
  // and hide everything else behind a single "Filters" pill that opens
  // a bottom sheet (formSheet on iOS, full-screen on Android).
  const [filterSheetOpen, setFilterSheetOpen] = useState<boolean>(false);

  // 0105 unpaid-fees banner state. Fetched once per mount; refreshed
  // when the user pulls-to-refresh so a fee paid in another screen is
  // reflected on the next browse. The banner is a permanent CTA, not
  // a transient toast — it lives until the balance is zero.
  const [unpaidFeesCents, setUnpaidFeesCents] = useState<number>(0);

  const loadUnpaidFees = useCallback(async () => {
    const { data: u } = await supabase.auth.getUser();
    if (!u.user) {
      setUnpaidFeesCents(0);
      return;
    }
    const { data } = await supabase
      .from('bidders')
      .select('unpaid_fees_cents')
      .eq('id', u.user.id)
      .single();
    setUnpaidFeesCents((data?.unpaid_fees_cents as number | null) ?? 0);
  }, []);

  useEffect(() => {
    loadUnpaidFees();
  }, [loadUnpaidFees]);

  // ── Live Auctions rail ──────────────────────────────────────────────────────
  // Fetches auctions with status IN ('scheduled','live'). Includes:
  //   - operator_id  for multi-tenant scoping
  //   - title        for the auction name
  //   - ends_at      for the first-lot close time (badge + display)
  //   - last_lot_ends_at (nullable) for the full window close
  //   - status       for the LIVE/UPCOMING badge
  // lot_count is a separate count query (auctions table has no cached
  // counter column). We do a single count per auction via a second query
  // scoped by operator_ids present in the auction list (no N+1).

  type AuctionRailRow = {
    id: string;
    title: string;
    operator_id: string;
    status: string;
    starts_at: string | null;
    ends_at: string;
    last_lot_ends_at: string | null;
    operators: { business_name: string } | null;
    warehouses: { timezone: string | null } | null;
  };

  const [liveAuctions, setLiveAuctions] = useState<(AuctionRailRow & { lot_count: number })[]>([]);
  const [offsiteSales, setOffsiteSales] = useState<OffsiteSaleRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const sales = await fetchOffsiteSales(supabase);
      if (!cancelled) setOffsiteSales(sales);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('auctions')
        .select('id, title, operator_id, status, starts_at, ends_at, last_lot_ends_at, operators:operators_public(business_name), warehouses(timezone)')
        .in('status', ['scheduled', 'live'])
        .eq('unlisted', false)
        .order('ends_at', { ascending: true });

      if (cancelled || !data) return;
      const rows = (data as unknown as AuctionRailRow[]).filter((a) => a.operators != null);
      if (rows.length === 0) {
        setLiveAuctions([]);
        return;
      }

      // Per-auction head-count queries. The previous single row-fetch hit
      // PostgREST's silent 1000-row default cap, so with >1000 live lots the
      // rail under-counted badly (owner report 2026-07-07: "reads like what's
      // been bid on") — the exact bug/fix from web /browse (2026-07-06).
      const auctionIds = rows.map((a) => a.id);
      const countEntries = await Promise.all(
        auctionIds.map(async (id) => {
          const { count } = await supabase
            .from('lots')
            .select('id', { count: 'exact', head: true })
            .eq('auction_id', id)
            .in('status', ['scheduled', 'live'])
            .is('deleted_at', null);
          return [id, count ?? 0] as const;
        }),
      );

      if (cancelled) return;
      const countMap = new Map<string, number>(countEntries);

      setLiveAuctions(rows.map((a) => ({ ...a, lot_count: countMap.get(a.id) ?? 0 })));
    })();
    return () => { cancelled = true; };
  }, []);

  // Restore persisted warehouse filter on mount.
  useEffect(() => {
    AsyncStorage.getItem(WAREHOUSE_FILTER_KEY).then((stored) => {
      if (stored && stored !== 'all') setWarehouseFilter(stored);
    }).catch(() => {});
  }, []);

  // Fetch warehouses for the operator when a single operator is selected,
  // or all warehouses when viewing all operators. The chip group is only
  // shown when there is more than one warehouse to choose from.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let q = supabase.from('warehouses').select('id, name').order('name');
      if (operatorFilter !== 'all') q = q.eq('operator_id', operatorFilter);
      const { data } = await q;
      if (cancelled || !data) return;
      const rows = (data as WarehouseOption[]);
      setWarehouses(rows);
      // If the persisted selection is no longer valid (warehouse removed),
      // fall back to 'all'.
      if (warehouseFilter !== 'all') {
        const still_valid = rows.some((w) => w.id === warehouseFilter);
        if (!still_valid) {
          setWarehouseFilter('all');
          AsyncStorage.removeItem(WAREHOUSE_FILTER_KEY).catch(() => {});
        }
      }
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [operatorFilter]);

  const categories = useCategories();

  // When the bidder taps "Apply" on a saved search, we navigate here
  // with the criteria as URL params. Apply them once on first
  // render — subsequent param changes are ignored so the bidder can
  // freely override without the URL re-imposing.
  const incomingParams = useLocalSearchParams<{
    q?: string;
    category_id?: string;
    operator_id?: string;
    min_discount_pct?: string;
    auction_id?: string;
  }>();
  const appliedRef = useRef(false);
  useEffect(() => {
    if (appliedRef.current) return;
    if (incomingParams.q) setSearch(incomingParams.q);
    if (incomingParams.category_id) setCategoryFilters(new Set([incomingParams.category_id]));
    if (incomingParams.operator_id) setOperatorFilter(incomingParams.operator_id);
    if (incomingParams.min_discount_pct) {
      const n = Number(incomingParams.min_discount_pct);
      if ([50, 70, 90].includes(n)) setDiscountFilter(n as 50 | 70 | 90);
    }
    if (incomingParams.auction_id) setAuctionIdFilter(incomingParams.auction_id);
    if (
      incomingParams.q ||
      incomingParams.category_id ||
      incomingParams.operator_id ||
      incomingParams.min_discount_pct ||
      incomingParams.auction_id
    ) {
      appliedRef.current = true;
    }
  }, [
    incomingParams.q,
    incomingParams.category_id,
    incomingParams.operator_id,
    incomingParams.min_discount_pct,
    incomingParams.auction_id,
  ]);

  // A Sale-page auction card can open this tab again with a different
  // auction_id after the one-shot param effect above already ran.
  useEffect(() => {
    if (incomingParams.auction_id) setAuctionIdFilter(incomingParams.auction_id);
  }, [incomingParams.auction_id]);

  // When the bidder narrows to a single operator, fetch that operator's
  // bidder_features + the bidder's tier with that operator. When viewing
  // all operators we fall back to the universal defaults — see the
  // comment in lib/features.ts on why we don't try to merge across.
  const operatorFeatures = useOperatorFeatures(
    operatorFilter !== 'all' ? operatorFilter : null,
  );
  const activeFeatures: BidderFeatures = useMemo(
    () =>
      operatorFilter === 'all'
        ? UNIVERSAL_DEFAULTS
        : operatorFeatures?.flags ?? {},
    [operatorFilter, operatorFeatures?.flags],
  );
  const tier = operatorFeatures?.tier ?? 'free';

  // Visible sort options for the current view. Always includes
  // ending_soon as a hard floor so the bidder is never left without a
  // sort option even if the operator misconfigures everything off.
  const visibleSorts: Sort[] = useMemo(() => {
    const out = SORT_ORDER.filter((s) =>
      isFeatureVisible(activeFeatures[SORT_DEFS[s].flag], tier),
    );
    return out.length > 0 ? out : ['ending_soon'];
  }, [activeFeatures, tier]);

  // If the currently selected sort got hidden (operator changed
  // settings, or we just switched to an operator who doesn't allow it),
  // gracefully fall back to the first visible option.
  useEffect(() => {
    if (!visibleSorts.includes(sort)) setSort(visibleSorts[0] ?? 'ending_soon');
  }, [visibleSorts, sort]);

  const showSearch = isFeatureVisible(activeFeatures.search_bar, tier);
  const showCategoryFilter = isFeatureVisible(activeFeatures.category_filter, tier);
  const showDiscountFilter = isFeatureVisible(activeFeatures.msrp_discount_filter, tier);
  const showRecentlyViewed = isFeatureVisible(activeFeatures.recently_viewed, tier);
  const showSavedSearches = isFeatureVisible(activeFeatures.saved_searches, tier);

  // The bidder has expressed search intent worth saving when at least
  // one criterion is non-default — typing nothing and saving "all
  // lots" would be noise.
  const hasActiveCriteria =
    search.trim().length > 0 ||
    categoryFilters.size > 0 ||
    operatorFilter !== 'all' ||
    warehouseFilter !== 'all' ||
    discountFilter > 0 ||
    selectedConditions.size > 0 ||
    priceMinDollars !== null ||
    priceMaxDollars !== null ||
    auctionIdFilter !== null;

  // Count of active sheet-side filters, shown on the "Filters" pill. We
  // intentionally exclude `search` (it has its own inline input) and
  // `sort` (always visible inline as pills) so the badge reflects only
  // the criteria the user can't see while the sheet is closed.
  const activeFilterCount =
    categoryFilters.size +
    (selectedConditions.size > 0 ? 1 : 0) +
    (priceMinDollars !== null || priceMaxDollars !== null ? 1 : 0) +
    (discountFilter > 0 ? 1 : 0) +
    (operatorFilter !== 'all' ? 1 : 0) +
    (warehouseFilter !== 'all' ? 1 : 0);

  // ── Condition + price handlers ──────────────────────────────────────────
  function toggleCondition(slug: ConditionSlug) {
    setSelectedConditions((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) {
        next.delete(slug);
      } else {
        next.add(slug);
      }
      return next;
    });
  }

  function clearConditions() {
    setSelectedConditions(new Set());
  }

  function applyPrice() {
    // Parse drafts. Empty string → null (unbounded on that side).
    // parseFloat handles partial decimals ("10.50") and rejects "abc"
    // with NaN, which we treat as "missing input" and convert to null.
    const parse = (raw: string): number | null => {
      const trimmed = raw.trim();
      if (trimmed === '') return null;
      const num = parseFloat(trimmed);
      return Number.isFinite(num) ? num : NaN; // NaN preserved so we can flag invalid input
    };
    const min = parse(priceMinDraft);
    const max = parse(priceMaxDraft);

    // Validation. We surface the first failing rule rather than a
    // concatenated list — keeps the inline error short on a mobile row.
    if (
      (typeof min === 'number' && (Number.isNaN(min) || min < 0)) ||
      (typeof max === 'number' && (Number.isNaN(max) || max < 0))
    ) {
      setPriceError('Enter a non-negative number.');
      return;
    }
    if (typeof min === 'number' && min > MAX_PRICE_DOLLARS) {
      setPriceError(`Min cannot exceed $${MAX_PRICE_DOLLARS.toLocaleString()}.`);
      return;
    }
    if (typeof max === 'number' && max > MAX_PRICE_DOLLARS) {
      setPriceError(`Max cannot exceed $${MAX_PRICE_DOLLARS.toLocaleString()}.`);
      return;
    }
    if (typeof min === 'number' && typeof max === 'number' && min > max) {
      setPriceError('Min must be less than or equal to max.');
      return;
    }
    setPriceError(null);
    setPriceMinDollars(typeof min === 'number' ? min : null);
    setPriceMaxDollars(typeof max === 'number' ? max : null);
  }

  function clearAllFilters() {
    setOperatorFilter('all');
    setWarehouseFilter('all');
    AsyncStorage.removeItem(WAREHOUSE_FILTER_KEY).catch(() => {});
    setCategoryFilters(new Set());
    setDiscountFilter(0);
    setSearch('');
    setSelectedConditions(new Set());
    setPriceMinDollars(null);
    setPriceMaxDollars(null);
    setPriceMinDraft('');
    setPriceMaxDraft('');
    setPriceError(null);
    setAuctionIdFilter(null);
  }

  async function onSaveSearch() {
    const criteria: SavedSearchCriteria = {
      ...(search.trim() ? { q: search.trim() } : {}),
      // Saved-search criteria are single-category by schema — save the first
      // selected one (matches the pre-multi-select behavior).
      ...(categoryFilters.size > 0 ? { category_id: Array.from(categoryFilters)[0] } : {}),
      ...(operatorFilter !== 'all' ? { operator_id: operatorFilter } : {}),
      ...(discountFilter > 0 ? { min_discount_pct: discountFilter } : {}),
    };
    const categoryNameById = (id: string) =>
      categories?.byId[id]?.name;
    const operatorNameById = (id: string) =>
      operators.find((o) => o.id === id)?.business_name;
    const name = defaultNameFromCriteria(criteria, {
      categoryNameById,
      operatorNameById,
    });
    const created = await createSavedSearch({ name, criteria });
    if (created) {
      Alert.alert(
        'Search saved',
        `"${name}". You'll get a push when new lots match. Manage in Profile.`,
      );
    } else {
      Alert.alert('Save failed', 'Try again in a moment.');
    }
  }

  // Recently-viewed rail — only render when no other filter is active,
  // so the rail isn't competing visually with focused browsing.
  const noFilterActive =
    operatorFilter === 'all' &&
    warehouseFilter === 'all' &&
    categoryFilters.size === 0 &&
    discountFilter === 0 &&
    search.trim() === '' &&
    selectedConditions.size === 0 &&
    priceMinDollars === null &&
    priceMaxDollars === null &&
    auctionIdFilter === null;
  // Lots inside the 2-minute Final Call window among what's loaded. `now`
  // already ticks at 1Hz for the card countdowns, so this stays fresh.
  const FINAL_CALL_WINDOW_MS = 2 * 60 * 1000;
  const finalCallCount = useMemo(() => {
    return lots.filter((l) => {
      if (!l.close_at) return false;
      const msLeft = new Date(l.close_at).getTime() - now;
      return msLeft > 0 && msLeft <= FINAL_CALL_WINDOW_MS;
    }).length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lots, Math.floor(now / 5000)]);

  const [recentLots, setRecentLots] = useState<LotRow[]>([]);
  useEffect(() => {
    if (!showRecentlyViewed || !noFilterActive) {
      setRecentLots([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const ids = await getRecentlyViewed();
      if (cancelled || ids.length === 0) return;
      const { data } = await supabase
        .from('lots')
        .select(
          'id, lot_code, sticker_code, display_code, title, current_bid_cents, starting_bid_cents, msrp_cents, bid_count, close_at, status, condition, photo_urls, operator_id, operators:operators_public(business_name, logo_url, brand_color)',
        )
        .in('id', ids);
      if (cancelled || !data) return;
      // Preserve the user's recency order (DB returns rows arbitrarily).
      const byId = new Map((data as unknown as LotRow[]).map((l) => [l.id, l]));
      const ordered = ids
        .map((id) => byId.get(id))
        .filter((l): l is LotRow => l != null && l.operators != null);
      setRecentLots(ordered);
    })();
    return () => {
      cancelled = true;
    };
  }, [showRecentlyViewed, noFilterActive, lots.length]);

  // ── Shared lot-query builder ─────────────────────────────────────────────────
  // Extracted so both `load` (page 0) and `loadMore` (next page) share
  // identical filter/sort logic. Returns the raw filtered rows for one page.

  const buildLotQuery = useCallback(
    (activeAuctionIds: string[], offset: number) => {
      const nowIso = new Date().toISOString();

      let query = supabase
        .from('lots')
        .select(
          'id, lot_code, sticker_code, display_code, title, current_bid_cents, starting_bid_cents, msrp_cents, bid_count, close_at, status, condition, photo_urls, operator_id, warehouse_id, operators:operators_public(business_name, logo_url, brand_color)',
        )
        .in('status', ['scheduled', 'live'])
        .in('auction_id', activeAuctionIds)
        .or(`close_at.gt.${nowIso},close_at.is.null`)
        .range(offset, offset + PAGE_SIZE - 1);

      const sortDef = SORT_DEFS[sort];
      query = query.order(sortDef.column, {
        ascending: sortDef.ascending,
        nullsFirst: false,
      });

      if (operatorFilter !== 'all') query = query.eq('operator_id', operatorFilter);
      if (warehouseFilter !== 'all') query = query.eq('warehouse_id', warehouseFilter);

      // Auction-id filter — tapping a card in the Live Auctions rail narrows
      // the lot grid to that auction's lots only.
      if (auctionIdFilter !== null) query = query.eq('auction_id', auctionIdFilter);

      if (categoryFilters.size > 0 && categories) {
        // Union of every selected category's leaves (multi-select).
        const ids = Array.from(
          new Set(
            Array.from(categoryFilters).flatMap(
              (cid) => categories.leafIdsByParentId[cid] ?? [cid],
            ),
          ),
        );
        query = query.in('category_id', ids);
      }

      const realConditionSlugs = Array.from(selectedConditions).filter(
        (s): s is Exclude<ConditionSlug, 'ending_soon' | 'top_deal'> =>
          !VIRTUAL_CONDITION_SLUGS.includes(s),
      );
      if (realConditionSlugs.length > 0) {
        const dbValues = realConditionSlugs.flatMap((slug) => CONDITION_DB_VALUES[slug]);
        query = query.in('condition', dbValues);
      }

      if (priceMinDollars !== null) {
        query = query.gte('current_bid_cents', priceMinDollars * 100);
      }
      if (priceMaxDollars !== null) {
        query = query.lte('current_bid_cents', priceMaxDollars * 100);
      }

      const q = search.trim();
      if (q.length > 0) {
        const ftsQuery = q
          .split(/\s+/)
          .map((token) => (/^[a-zA-Z0-9'-]+$/.test(token) ? `${token}:*` : token))
          .join(' & ');
        query = query.textSearch('search_tsv', ftsQuery);
      }

      return query;
    },
    [
      sort,
      operatorFilter,
      warehouseFilter,
      auctionIdFilter,
      categoryFilters,
      categories,
      selectedConditions,
      priceMinDollars,
      priceMaxDollars,
      search,
    ],
  );

  // Apply client-side virtual filters (discount + ending_soon/top_deal) that
  // can't be expressed cleanly in PostgREST.
  const applyClientFilters = useCallback(
    (rows: LotRow[]): LotRow[] => {
      let result = rows;

      if (discountFilter > 0) {
        const min = discountFilter / 100;
        result = result.filter((l) => {
          if (l.msrp_cents == null || l.msrp_cents <= 0) return false;
          const price = l.current_bid_cents ?? l.starting_bid_cents;
          return 1 - price / l.msrp_cents >= min;
        });
      }

      const wantEndingSoon = selectedConditions.has('ending_soon');
      const wantTopDeal = selectedConditions.has('top_deal');
      if (wantEndingSoon || wantTopDeal) {
        const nowMs = Date.now();
        result = result.filter((l) => {
          const closeMs = new Date(l.close_at).getTime();
          const isEndingSoon =
            closeMs > nowMs && closeMs - nowMs <= ENDING_SOON_WINDOW_MS;
          const isTopDeal =
            l.current_bid_cents !== null &&
            l.current_bid_cents < l.starting_bid_cents * TOP_DEAL_MULTIPLIER;
          if (wantEndingSoon && wantTopDeal) return isEndingSoon || isTopDeal;
          if (wantEndingSoon) return isEndingSoon;
          return isTopDeal;
        });
      }

      return result;
    },
    [discountFilter, selectedConditions],
  );

  const load = useCallback(async () => {
    // Show lots whose close_at is in the future OR not yet set. Scheduled
    // lots can legitimately have null close_at until the auction goes
    // live, so a strict `close_at > now` predicate hides them entirely.
    // Already-ended lots are excluded by the `status in (scheduled, live)`
    // filter — the closeLot worker flips them to 'won'/'unsold' as soon
    // as their close_at passes.
    //
    // S6a defense-in-depth: also join auctions and require auction.status
    // IN ('scheduled','live') so lots from a finalized-but-not-yet-
    // reconciled auction don't leak. advance_auction_lifecycle() runs
    // every 60s; this join closes the race window.

    // Resolve open, LISTED auction IDs first (same pattern as web browse).
    // Unlisted staff test auctions (mig 0242) must not reach this grid.
    const activeAuctionIds = await fetchDiscoverableAuctionIds(supabase, {
      auctionId: auctionIdFilter,
    });
    if (activeAuctionIds.length === 0) {
      setLots([]);
      setOperators([]);
      setLoading(false);
      setRefreshing(false);
      setHasMore(false);
      setLotOffset(0);
      return;
    }

    const { data } = await buildLotQuery(activeAuctionIds, 0);
    const rows = applyClientFilters(
      ((data ?? []) as unknown as LotRow[]).filter((l) => l.operators != null),
    );

    setLots(rows);
    setLotOffset(PAGE_SIZE);
    // hasMore reflects whether the SERVER returned a full page — NOT the
    // post-client-filter count. Otherwise active discount/ending-soon/top-deal
    // chips (which prune rows client-side) would shrink the page below
    // PAGE_SIZE and hide "Load more" even when the server has more rows.
    setHasMore((data?.length ?? 0) === PAGE_SIZE);

    const seen = new Map<string, Operator>();
    for (const r of rows) {
      if (r.operators && !seen.has(r.operator_id)) {
        seen.set(r.operator_id, { id: r.operator_id, business_name: r.operators.business_name });
      }
    }
    setOperators(
      Array.from(seen.values()).sort((a, b) => a.business_name.localeCompare(b.business_name)),
    );

    setLoading(false);
    setRefreshing(false);
  }, [buildLotQuery, applyClientFilters, auctionIdFilter]);

  // Append the next page of lots. Shares the same filter/sort query as load().
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);

    const activeAuctionIds = await fetchDiscoverableAuctionIds(supabase, {
      auctionId: auctionIdFilter,
    });
    if (activeAuctionIds.length === 0) {
      setHasMore(false);
      setLoadingMore(false);
      return;
    }

    const { data } = await buildLotQuery(activeAuctionIds, lotOffset);
    const newRows = applyClientFilters(
      ((data ?? []) as unknown as LotRow[]).filter((l) => l.operators != null),
    );

    setLots((prev) => [...prev, ...newRows]);
    setLotOffset((prev) => prev + PAGE_SIZE);
    // Raw server page size, not post-client-filter count (see load()).
    setHasMore((data?.length ?? 0) === PAGE_SIZE);
    setLoadingMore(false);
  }, [loadingMore, hasMore, lotOffset, buildLotQuery, applyClientFilters, auctionIdFilter]);

  useEffect(() => {
    load();
  }, [load]);

  // ── Identifier lookup ───────────────────────────────────────────────────────
  // When the typed query looks like a product code, also probe the identifier
  // columns via find_lots_by_identifier (mig 0189) and surface matches in a
  // rail above the grid. Debounced 300ms so we don't fire on every keystroke.
  // RLS on lots governs visibility (the RPC is SECURITY INVOKER), so a bidder
  // only ever sees published/live lots here — minus unlisted test auctions,
  // which are filtered client-side below. Cleared when the term isn't a code.
  useEffect(() => {
    const q = search.trim();
    if (!showSearch || !IDENTIFIER_RE.test(q)) {
      setCodeMatches([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(async () => {
      const { data, error } = await supabase.rpc('find_lots_by_identifier', {
        p_identifier: q,
        p_kind: 'auto',
      });
      if (cancelled) return;
      if (error || !data) {
        setCodeMatches([]);
        return;
      }
      // The RPC doesn't know about unlisted test auctions (mig 0242), so drop
      // their lots here. null = the check failed; hide the rail rather than
      // risk showing test lots.
      const listed = await withoutUnlistedAuctionRows(
        supabase,
        data as unknown as IdentifierMatch[],
      );
      if (cancelled) return;
      setCodeMatches(listed ?? []);
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [search, showSearch]);

  // Re-poll the grid every 25s while the Browse tab is FOCUSED so prices +
  // bid counts stay fresh without a manual pull-to-refresh. Battery-safe:
  // useFocusEffect tears the interval down on blur, so a backgrounded tab
  // stops polling. `load` is a useCallback keyed on the active filters, so
  // the interval re-runs the CURRENT query and re-subscribes whenever a
  // filter changes. Lot detail keeps its realtime websocket; the grid uses
  // cheap polling. The interval does not fire on mount (the useEffect above
  // already did the initial load), so there's no double-fetch.
  // Keep bid data fresh on the grid WITHOUT throwing the bidder back to the
  // top. load() rebuilds from page 0, so polling it blindly discarded every
  // "Load more" page and snapped the list to the top mid-scroll (customer reports
  // report 2026-07-22). Skip the refresh once the list is expanded past the
  // first page; pull-to-refresh (and lot-detail realtime) still update bids.
  const lotOffsetRef = useRef(0);
  lotOffsetRef.current = lotOffset;
  useFocusEffect(
    useCallback(() => {
      const id = setInterval(() => {
        if (lotOffsetRef.current > PAGE_SIZE) return;
        load();
      }, 25000);
      return () => clearInterval(id);
    }, [load]),
  );

  // 1Hz countdown tick. One state update fans out to all cards via props.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // ── Vertical browse pager entry (2026-07-07) ─────────────────────────────
  // Tap on a grid card opens the full-screen swipe pager seeded at that lot.
  // Refs (not deps) keep the handler stable so LotCard's memo comparator —
  // which ignores callback props — never captures a stale list.
  const lotsRef = useRef<LotRow[]>([]);
  lotsRef.current = lots;
  const hasMoreRef = useRef(false);
  hasMoreRef.current = hasMore;
  const openPager = useCallback(
    (lotId: string) => {
      const list = lotsRef.current;
      const idx = list.findIndex((l) => l.id === lotId);
      if (idx === -1) {
        router.push({ pathname: '/lot/[id]', params: { id: lotId, source: 'browse' } });
        return;
      }
      setPagerContext({
        lots: list.map(cardData),
        startIndex: idx,
        hasMore: hasMoreRef.current,
      });
      router.push('/lot/pager' as never);
    },
    // cardData is a pure row→card mapping with no reactive deps.
    [router],
  );

  // Quick Bid on the thumbnail (request 2026-07-29): last-second bidding
  // without waiting for the listing to load. A stable module-level-ish callback
  // returning a self-contained component — LotCard's memo comparator ignores
  // this prop, so the button owns its own busy state (see QuickBidButton).
  const renderQuickBid = useCallback(
    (l: LotCardData) => <QuickBidButton lot={l} />,
    [],
  );

  const cardData = (l: LotRow): LotCardData => ({
    id: l.id,
    lot_code: l.lot_code,
    title: l.title,
    photo_urls: l.photo_urls,
    current_bid_cents: l.current_bid_cents,
    starting_bid_cents: l.starting_bid_cents,
    msrp_cents: l.msrp_cents,
    bid_count: l.bid_count,
    close_at: l.close_at,
    status: l.status,
    condition: l.condition,
    operator_business_name: l.operators?.business_name ?? '?',
    operator_logo_url: l.operators?.logo_url ?? null,
    operator_brand_color: l.operators?.brand_color ?? null,
  });

  return (
    <View testID="browse-screen" style={{ flex: 1, backgroundColor: colors.bg }}>
      {/* 0105 unpaid-fees banner — only when balance > 0. Sticky at the
          top of Browse so the bidder sees it every time they open the
          app. Tapping routes to /profile/pay-fees which charges the
          saved card and clears the balance. */}
      {unpaidFeesCents > 0 && (
        <Pressable
          onPress={() => router.push('/profile/pay-fees' as never)}
          style={{
            margin: 12,
            marginBottom: 0,
            padding: 14,
            backgroundColor: colors.dangerDim,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: colors.danger,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <View style={{ flex: 1 }}>
            <Text style={{ color: colors.danger, fontSize: 11, ...type.label }}>
              Fees due
            </Text>
            <Text style={{ color: colors.text, fontSize: 14, marginTop: 2 }}>
              {`You owe ${formatCents(unpaidFeesCents)} in fees. Pay now to bid.`}
            </Text>
          </View>
          <Text style={{ color: colors.danger, fontSize: 14, fontWeight: '800' }}>
            Pay →
          </Text>
        </Pressable>
      )}
      <View style={{ padding: 12, gap: 8 }}>
        {/* Inline rail — only search + sort + a single "Filters" pill.
            All other rails (discount, condition, price, operator,
            save-search) live inside the modal sheet below so the lot grid
            is visible above the fold on a phone. The top-level category
            chip row is the exception: it's an above-the-fold discovery
            affordance, so it stays inline here (mirrors the in-sheet
            Category rail but lifted up for one-tap browsing). */}
        {showSearch && (
          <View style={{ flexDirection: 'row', gap: 8, alignItems: 'center' }}>
            <TextInput
              placeholder="Search lots…"
              placeholderTextColor={colors.textMuted}
              value={search}
              onChangeText={setSearch}
              style={{
                flex: 1,
                padding: 12,
                backgroundColor: colors.surface,
                borderColor: colors.border,
                borderWidth: 1,
                borderRadius: 10,
                color: colors.text,
                fontSize: 15,
              }}
            />
            {/* Search → Scan cross-link. Routes to the Scan tab so a bidder
                who'd rather point their camera at a sticker than type can
                switch in one tap. Matches the Scan screen's reciprocal
                "Search lots instead" link. */}
            <Pressable
              testID="browse-scan-barcode"
              onPress={() => router.push('/(tabs)/scan' as never)}
              accessibilityRole="button"
              accessibilityLabel="Scan a barcode"
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                paddingVertical: 12,
                paddingHorizontal: 14,
                backgroundColor: colors.surface,
                borderColor: colors.border,
                borderWidth: 1,
                borderRadius: 10,
              }}
            >
              <Text style={{ fontSize: 15 }}>📷</Text>
              <Text style={{ color: colors.primary, fontSize: 12, ...type.label }}>
                Scan
              </Text>
            </Pressable>
          </View>
        )}
        {/* Top-level category chip row — horizontal scroll, mirrors the
            "Live auctions" rail styling. Reuses the same `categories`
            (useCategories) + `categoryFilter`/`setCategoryFilter` state as
            the in-sheet Category rail; tapping an active chip clears it. */}
        {showCategoryFilter && categories && categories.topLevel.length > 0 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 8, paddingVertical: 2, paddingRight: 12 }}
          >
            <CategoryChip
              active={categoryFilters.size === 0}
              slug="all"
              icon="📦"
              label="All"
              onPress={() => toggleCategoryFilter(null)}
            />
            {categories.topLevel.map((c) => (
              <CategoryChip
                key={c.id}
                active={categoryFilters.has(c.id)}
                slug={c.slug}
                icon={c.icon ?? '📦'}
                label={c.name}
                onPress={() => toggleCategoryFilter(c.id)}
              />
            ))}
          </ScrollView>
        )}
        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {/* Final Call — appears only while loaded lots are inside the
              2-minute closing rush (same window as the web /final-call page;
              the app previously had NO Final Call surface — owner, 2026-07-07).
              Tap = jump to the ending-soon view. */}
          {finalCallCount > 0 && (
            <Pressable
              onPress={() => {
                setSort('ending_soon');
                setSelectedConditions(new Set<ConditionSlug>(['ending_soon']));
              }}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                backgroundColor: colors.dangerDim,
                borderColor: colors.danger,
                borderWidth: 1,
                borderRadius: 999,
                paddingVertical: 6,
                paddingHorizontal: 12,
              }}
              accessibilityRole="button"
              accessibilityLabel={`Final Call — ${finalCallCount} lots closing in under 2 minutes`}
            >
              <View
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: 3,
                  backgroundColor: colors.danger,
                }}
              />
              <Text style={{ color: colors.danger, fontSize: 12, fontWeight: '800' }}>
                Final Call · {finalCallCount}
              </Text>
            </Pressable>
          )}
          {visibleSorts.map((s) => (
            <SortPill
              key={s}
              active={sort === s}
              onPress={() => setSort(s)}
              label={SORT_DEFS[s].label}
            />
          ))}
          <SortPill
            testID="browse-open-filters"
            active={activeFilterCount > 0}
            onPress={() => setFilterSheetOpen(true)}
            label={activeFilterCount > 0 ? `Filters · ${activeFilterCount}` : 'Filters'}
          />
        </View>
        {/* Location — always visible, never behind the Filters sheet.
            Reported 2026-08-26: "The Android version does not provide a
            visible location filter either." It existed, but only inside the
            filter modal and labelled "Warehouse", so a customer had no reason
            to look for it. A Harrison customer had already bought out of a
            Dodge City auction. Buying from the wrong warehouse costs a refund
            and a wasted drive, so this is the one control that does not get
            hidden to save a row. Same state as the sheet's chips — this is a
            second surface onto `warehouseFilter`, not a second filter. */}
        {warehouses.length > 1 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 6, paddingRight: 8 }}
            style={{ marginTop: 8 }}
          >
            <Text
              style={{
                color: colors.textMuted,
                fontSize: 11,
                alignSelf: 'center',
                marginRight: 2,
                ...type.label,
              }}
            >
              Location
            </Text>
            <SortPill
              testID="browse-location-all"
              active={warehouseFilter === 'all'}
              onPress={() => {
                setWarehouseFilter('all');
                AsyncStorage.removeItem(WAREHOUSE_FILTER_KEY).catch(() => {});
              }}
              label="All"
            />
            {warehouses.map((w) => (
              <SortPill
                key={w.id}
                testID={`browse-location-${w.id}`}
                active={warehouseFilter === w.id}
                onPress={() => {
                  const next = warehouseFilter === w.id ? 'all' : w.id;
                  setWarehouseFilter(next);
                  if (next === 'all') AsyncStorage.removeItem(WAREHOUSE_FILTER_KEY).catch(() => {});
                  else AsyncStorage.setItem(WAREHOUSE_FILTER_KEY, next).catch(() => {});
                }}
                label={w.name}
              />
            ))}
          </ScrollView>
        )}
        {/* When the sheet is closed and any sheet-side filter is active,
            offer a small "Clear all" link inline so the user can reset
            without re-opening the sheet. */}
        {activeFilterCount > 0 && (
          <Pressable
            testID="browse-clear-all-filters-inline"
            onPress={clearAllFilters}
            hitSlop={8}
            style={{ alignSelf: 'flex-start' }}
          >
            <Text
              style={{
                color: colors.primary,
                fontSize: 12,
                ...type.label,
              }}
            >
              Clear all
            </Text>
          </Pressable>
        )}
      </View>
      {/* Filter sheet — slides from the bottom. iOS uses formSheet so the
          underlying screen is still partially visible behind a card;
          Android falls back to full-screen since formSheet isn't
          supported there. All previously-stacked rails live inside. */}
      <Modal
        visible={filterSheetOpen}
        animationType="slide"
        transparent={false}
        presentationStyle={Platform.OS === 'ios' ? 'formSheet' : 'fullScreen'}
        onRequestClose={() => setFilterSheetOpen(false)}
      >
        <View style={{ flex: 1, backgroundColor: colors.bg }}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              paddingHorizontal: 16,
              paddingTop: 16,
              paddingBottom: 8,
            }}
          >
            <Text style={{ color: colors.text, fontSize: 18, fontWeight: '700' }}>
              Filters
            </Text>
            <Pressable
              testID="browse-close-filters"
              onPress={() => setFilterSheetOpen(false)}
              hitSlop={8}
            >
              <Text style={{ color: colors.textMuted, fontSize: 22, lineHeight: 22 }}>
                ×
              </Text>
            </Pressable>
          </View>
          <ScrollView
            contentContainerStyle={{ padding: 12, gap: 12, paddingBottom: 24 }}
            keyboardShouldPersistTaps="handled"
          >
            {showCategoryFilter && categories && categories.topLevel.length > 0 && (
              <View style={{ gap: 6 }}>
                <Text style={{ color: colors.textMuted, fontSize: 11, ...type.label }}>
                  Category
                </Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{ gap: 8, paddingVertical: 2, paddingRight: 12 }}
                >
                  <CategoryChip
                    active={categoryFilters.size === 0}
                    slug="all"
                    icon="📦"
                    label="All"
                    onPress={() => toggleCategoryFilter(null)}
                  />
                  {categories.topLevel.map((c) => (
                    <CategoryChip
                      key={c.id}
                      active={categoryFilters.has(c.id)}
                      slug={c.slug}
                      icon={c.icon ?? '📦'}
                      label={c.name}
                      onPress={() => toggleCategoryFilter(c.id)}
                    />
                  ))}
                </ScrollView>
              </View>
            )}
            {showDiscountFilter && (
              <View style={{ gap: 6 }}>
                <Text style={{ color: colors.textMuted, fontSize: 11, ...type.label }}>
                  Discount
                </Text>
                <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                  {([0, 50, 70, 90] as const).map((d) => (
                    <SortPill
                      key={d}
                      active={discountFilter === d}
                      onPress={() => setDiscountFilter(d)}
                      label={d === 0 ? 'Any discount' : `${d}%+ off`}
                    />
                  ))}
                </View>
              </View>
            )}
            {/* Condition chips. Multi-select. Mirrors web's FilterRail —
                5 real DB-stored values + 2 virtual ones ('ending_soon',
                'top_deal') filtered client-side after fetch. */}
            <View style={{ gap: 6 }}>
              <View
                style={{
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <Text style={{ color: colors.textMuted, fontSize: 11, ...type.label }}>
                  Condition
                </Text>
                {selectedConditions.size > 0 && (
                  <Pressable
                    testID="browse-clear-conditions"
                    onPress={clearConditions}
                    hitSlop={8}
                  >
                    <Text
                      style={{
                        color: colors.textMuted,
                        fontSize: 11,
                        ...type.label,
                      }}
                    >
                      Clear
                    </Text>
                  </Pressable>
                )}
              </View>
              <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                {CONDITION_OPTIONS.map((opt) => (
                  <ConditionChip
                    key={opt.value}
                    active={selectedConditions.has(opt.value)}
                    label={opt.label}
                    onPress={() => toggleCondition(opt.value)}
                    testID={`browse-condition-chip-${opt.value}`}
                  />
                ))}
              </View>
            </View>
            {/* Price min/max. Whole-dollar numeric inputs that apply on the
                current_bid_cents column. Apply button uses BrandedButton from
                the design-system package (PR #20). */}
            <View style={{ gap: 6 }}>
              <Text style={{ color: colors.textMuted, fontSize: 11, ...type.label }}>
                Price
              </Text>
              <View
                style={{
                  flexDirection: 'row',
                  gap: 8,
                  alignItems: 'center',
                }}
              >
                <TextInput
                  testID="browse-price-min-input"
                  placeholder="Min $"
                  placeholderTextColor={colors.textDim}
                  value={priceMinDraft}
                  onChangeText={setPriceMinDraft}
                  keyboardType="numeric"
                  accessibilityLabel="Minimum price in dollars"
                  style={{
                    flex: 1,
                    padding: 10,
                    backgroundColor: colors.surface,
                    borderColor: priceError ? colors.danger : colors.border,
                    borderWidth: 1,
                    borderRadius: 10,
                    color: colors.text,
                    fontSize: 14,
                  }}
                />
                <Text style={{ color: colors.textDim, fontSize: 13 }}>—</Text>
                <TextInput
                  testID="browse-price-max-input"
                  placeholder="Max $"
                  placeholderTextColor={colors.textDim}
                  value={priceMaxDraft}
                  onChangeText={setPriceMaxDraft}
                  keyboardType="numeric"
                  accessibilityLabel="Maximum price in dollars"
                  style={{
                    flex: 1,
                    padding: 10,
                    backgroundColor: colors.surface,
                    borderColor: priceError ? colors.danger : colors.border,
                    borderWidth: 1,
                    borderRadius: 10,
                    color: colors.text,
                    fontSize: 14,
                  }}
                />
                <BrandedButton
                  testID="browse-price-apply"
                  variant="primary"
                  size="sm"
                  onPress={applyPrice}
                >
                  Apply
                </BrandedButton>
              </View>
              {priceError && (
                <Text
                  testID="browse-price-error"
                  style={{ color: colors.danger, fontSize: 12 }}
                >
                  {priceError}
                </Text>
              )}
            </View>
            {operators.length > 1 && (
              <View style={{ gap: 6 }}>
                <Text style={{ color: colors.textMuted, fontSize: 11, ...type.label }}>
                  Operator
                </Text>
                <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                  <SortPill
                    active={operatorFilter === 'all'}
                    onPress={() => setOperatorFilter('all')}
                    label="All operators"
                  />
                  {operators.map((o) => (
                    <SortPill
                      key={o.id}
                      active={operatorFilter === o.id}
                      onPress={() => setOperatorFilter(o.id)}
                      label={o.business_name}
                    />
                  ))}
                </View>
              </View>
            )}
            {/* S5a — Warehouse filter. Only shown when there is more than
                one warehouse to choose from (single-warehouse operators
                don't need the filter). Selection is persisted in
                AsyncStorage across navigations and app restarts. */}
            {warehouses.length > 1 && (
              <View style={{ gap: 6 }}>
                <Text style={{ color: colors.textMuted, fontSize: 11, ...type.label }}>
                  Warehouse
                </Text>
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={{ gap: 8, paddingVertical: 2, paddingRight: 12 }}
                >
                  <SortPill
                    active={warehouseFilter === 'all'}
                    onPress={() => {
                      setWarehouseFilter('all');
                      AsyncStorage.removeItem(WAREHOUSE_FILTER_KEY).catch(() => {});
                    }}
                    label="All"
                  />
                  {warehouses.map((w) => (
                    <SortPill
                      key={w.id}
                      active={warehouseFilter === w.id}
                      onPress={() => {
                        const next = warehouseFilter === w.id ? 'all' : w.id;
                        setWarehouseFilter(next);
                        if (next === 'all') {
                          AsyncStorage.removeItem(WAREHOUSE_FILTER_KEY).catch(() => {});
                        } else {
                          AsyncStorage.setItem(WAREHOUSE_FILTER_KEY, next).catch(() => {});
                        }
                      }}
                      label={w.name}
                    />
                  ))}
                </ScrollView>
              </View>
            )}
            {showSavedSearches && hasActiveCriteria && (
              <Pressable
                onPress={onSaveSearch}
                style={{
                  alignSelf: 'flex-start',
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 6,
                  paddingVertical: 7,
                  paddingHorizontal: 12,
                  borderWidth: 1,
                  borderColor: colors.primary,
                  backgroundColor: colors.primaryDim,
                  borderRadius: 999,
                }}
              >
                <Text style={{ fontSize: 12 }}>💾</Text>
                <Text
                  style={{
                    color: colors.primary,
                    fontSize: 12,
                    ...type.label,
                  }}
                >
                  Save this search
                </Text>
              </Pressable>
            )}
          </ScrollView>
          {/* Sheet footer — Clear all on the left, Show lots on the right.
              "Show lots" is the primary close affordance; tapping it just
              dismisses the modal (filters are already applied live). */}
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12,
              padding: 12,
              borderTopWidth: 1,
              borderTopColor: colors.border,
              backgroundColor: colors.bg,
            }}
          >
            <Pressable
              testID="browse-clear-all-filters"
              onPress={clearAllFilters}
              hitSlop={8}
              style={{
                paddingVertical: 10,
                paddingHorizontal: 14,
              }}
            >
              <Text
                style={{
                  color: colors.primary,
                  fontSize: 14,
                  ...type.label,
                }}
              >
                Clear all
              </Text>
            </Pressable>
            <BrandedButton
              testID="browse-apply-filters"
              variant="primary"
              size="md"
              onPress={() => setFilterSheetOpen(false)}
            >
              Show lots
            </BrandedButton>
          </View>
        </View>
      </Modal>
      {loading ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <Text style={{ color: colors.textMuted }}>Loading…</Text>
        </View>
      ) : (
        <FlatList
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              tintColor={colors.textMuted}
              onRefresh={() => {
                setRefreshing(true);
                load();
                loadUnpaidFees();
                fetchOffsiteSales(supabase).then(setOffsiteSales);
              }}
            />
          }
          data={lots}
          keyExtractor={(l) => l.id}
          numColumns={2}
          columnWrapperStyle={{ paddingHorizontal: 8, gap: 8 }}
          renderItem={({ item }) => (
            <LotCard
              lot={cardData(item)}
              now={now}
              showWatchlistHeart
              onPressOverride={openPager}
              quickBid={renderQuickBid}
            />
          )}
          contentContainerStyle={{ paddingTop: 4 }}
          windowSize={5}
          maxToRenderPerBatch={10}
          initialNumToRender={8}
          onEndReached={loadMore}
          onEndReachedThreshold={0.4}
          ListHeaderComponent={
            <>
              {/* Identifier (UPC/ASIN/SKU/model) matches for the typed code.
                  Sits above everything else so a bidder who searched a product
                  code sees the exact lot first. Self-hides when empty. */}
              <IdentifierMatchRail
                matches={codeMatches}
                query={search.trim()}
                onPress={(id) =>
                  router.push({ pathname: '/lot/[id]', params: { id, source: 'identifier_search' } })
                }
              />
              <OffsiteSaleButtons sales={offsiteSales} router={router} />
              <HomeTabHeader
                auctions={liveAuctions}
                now={now}
                activeAuctionId={auctionIdFilter}
                onAuctionPress={(id) =>
                  setAuctionIdFilter((prev) => (prev === id ? null : id))
                }
              />
              {/* Recently closed rail REMOVED 2026-08-26.
                  It sat between the live rail and the lot grid, and tapping a
                  live auction filters that grid — which is below it. So the
                  screen appeared not to react: "the customer has to scroll
                  past all the recently closed auctions before they can see the
                  live auction they just selected," and customers concluded the
                  auction had not opened. Closed auctions stay reachable at
                  /auction/[id] (from My Bids and invoices); nothing needs a
                  browse rail that buries the thing the customer just tapped. */}
            </>
          }
          ListFooterComponent={
            <>
              {hasMore && (
                <Pressable
                  onPress={loadMore}
                  disabled={loadingMore}
                  style={{
                    margin: 16,
                    paddingVertical: 12,
                    paddingHorizontal: 24,
                    borderRadius: 8,
                    borderWidth: 1,
                    borderColor: colors.border,
                    alignItems: 'center',
                    alignSelf: 'center',
                  }}
                >
                  <Text style={{ color: loadingMore ? colors.textMuted : colors.text, fontSize: 14 }}>
                    {loadingMore ? 'Loading…' : 'Load more'}
                  </Text>
                </Pressable>
              )}
              <HomeTabFooter
                onCategoryPress={(id) => toggleCategoryFilter(id)}
                activeCategoryId={
                  categoryFilters.size > 0 ? Array.from(categoryFilters)[0]! : null
                }
                onSortEndingSoon={() => setSort('ending_soon')}
                recentLots={recentLots}
                cardData={cardData}
                now={now}
                router={router}
              />
            </>
          }
          ListEmptyComponent={
            <View
              testID="browse-empty-state"
              style={{ padding: 24, alignItems: 'center', gap: 12 }}
            >
              <Image
                source={require('../../assets/art/empty-search.png')}
                style={{ width: 220, height: 165, borderRadius: 12 }}
                contentFit="cover"
              />
              <Text style={{ color: colors.textMuted, textAlign: 'center' }}>
                {hasActiveCriteria
                  ? 'No lots match your filters. Try removing some.'
                  : search
                    ? `No lots matching "${search}".`
                    : 'No live lots right now.'}
              </Text>
              {hasActiveCriteria && (
                <BrandedButton
                  testID="browse-empty-clear-filters"
                  variant="secondary"
                  size="sm"
                  onPress={clearAllFilters}
                >
                  Clear filters
                </BrandedButton>
              )}
            </View>
          }
        />
      )}
      {/* 0434: one-time ZIP ask. Browse only, dismissible, never over the
          filter sheet; hides itself when this tab loses focus. */}
      <ZipPrompt suppressed={filterSheetOpen} />
    </View>
  );
}

// ── IdentifierMatchRail ───────────────────────────────────────────────────────
//
// Renders exact-match lots for a typed product code (UPC / ASIN / FNSKU / LPN /
// external_code / model / MPN) returned by find_lots_by_identifier (mig 0189).
// Compact tappable rows — NOT full LotCards — because the RPC returns a
// public-safe column allowlist (no operator/bid-count/msrp metadata) and matches
// can span operators. Tapping routes into the lot detail screen. Self-hides when
// there are no matches.
function IdentifierMatchRail({
  matches,
  query,
  onPress,
}: {
  matches: IdentifierMatch[];
  query: string;
  onPress: (id: string) => void;
}) {
  if (matches.length === 0) return null;

  return (
    <View
      testID="browse-identifier-matches"
      style={{
        marginHorizontal: 12,
        marginTop: 8,
        marginBottom: 4,
        padding: 12,
        backgroundColor: colors.surface,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: colors.primary,
        gap: 8,
      }}
    >
      <Text style={{ color: colors.primary, fontSize: 11, ...type.label }}>
        {matches.length === 1
          ? `1 match for code "${query}"`
          : `${matches.length} matches for code "${query}"`}
      </Text>
      {matches.map((m) => {
        const priceLabel =
          m.current_bid_cents != null
            ? `Current ${formatCents(m.current_bid_cents)}`
            : `Starts ${formatCents(m.starting_bid_cents)}`;
        // Live lots get a subtle highlight so the bidder knows they can bid now.
        const isLive = m.status === 'live';
        return (
          <Pressable
            key={m.id}
            testID={`browse-identifier-match-${m.id}`}
            onPress={() => onPress(m.id)}
            accessibilityRole="button"
            accessibilityLabel={`${m.title}, lot ${m.lot_code}, ${priceLabel}`}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
              paddingVertical: 8,
              paddingHorizontal: 10,
              borderRadius: 8,
              borderWidth: 1,
              borderColor: isLive ? colors.primary : colors.border,
              backgroundColor: colors.bg,
            }}
          >
            <View style={{ flex: 1 }}>
              <Text numberOfLines={1} style={{ color: colors.text, fontSize: 14 }}>
                {m.title || `Lot ${m.lot_code}`}
              </Text>
              <Text style={{ color: colors.textMuted, fontSize: 11, marginTop: 2 }}>
                {m.lot_code} · {priceLabel}
                {isLive ? ' · LIVE' : ''}
              </Text>
            </View>
            <Text style={{ color: colors.primary, fontSize: 14, fontWeight: '800' }}>
              View →
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

function SortPill({
  active,
  onPress,
  label,
  testID,
}: {
  active: boolean;
  onPress: () => void;
  label: string;
  testID?: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      testID={testID}
      style={{
        paddingVertical: 7,
        paddingHorizontal: 14,
        borderWidth: 1,
        borderColor: active ? colors.primary : colors.border,
        backgroundColor: active ? colors.primaryDim : 'transparent',
        borderRadius: 999,
      }}
    >
      <Text
        style={{
          color: active ? colors.primary : colors.textMuted,
          fontSize: 12,
          ...type.label,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

// Condition pill — distinct from SortPill because the active state uses
// the brighter v3 brand-green (#5FE065 / BRANDED_BUTTON_GREEN) to match
// what the spec calls for, while SortPill's active state uses the
// darker primary (#22c55e) that's been on the screen since pre-v3 and
// is referenced from countdown chips and bid badges. Keeping the two
// styles separate so we don't have to re-audit every existing pill.
function ConditionChip({
  active,
  label,
  onPress,
  testID,
}: {
  active: boolean;
  label: string;
  onPress: () => void;
  testID?: string;
}) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={{
        paddingVertical: 7,
        paddingHorizontal: 14,
        borderWidth: 1,
        borderColor: BRANDED_BUTTON_GREEN,
        backgroundColor: active ? BRANDED_BUTTON_GREEN : colors.surface,
        borderRadius: 999,
      }}
    >
      <Text
        style={{
          // Near-black on bright green for the active state — same
          // contrast pattern as BrandedButton's primary variant. Brand
          // green on dark surface for the inactive state matches the
          // v3 outline look.
          color: active ? '#0a0c11' : BRANDED_BUTTON_GREEN,
          fontSize: 12,
          ...type.label,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function OffsiteSaleButtons({
  sales,
  router,
}: {
  sales: OffsiteSaleRow[];
  router: ReturnType<typeof useRouter>;
}) {
  if (sales.length === 0) return null;

  return (
    <View style={{ paddingHorizontal: 12, paddingTop: 8, paddingBottom: 4, gap: 12 }}>
      {sales.map((sale) => (
        <View key={sale.warehouse_id}>
          <Pressable
            onPress={() => router.push(`/sale/${sale.warehouse_id}`)}
            accessibilityRole="button"
            style={{
              alignSelf: 'flex-start',
              backgroundColor: BRANDED_BUTTON_GREEN,
              paddingVertical: 10,
              paddingHorizontal: 16,
              borderRadius: 10,
            }}
          >
            <Text style={{ color: '#0a0c11', fontWeight: '800', fontSize: 15 }}>
              {sale.name} Sale →
            </Text>
          </Pressable>
          <Text
            numberOfLines={1}
            style={{ color: colors.textMuted, fontSize: 13, marginTop: 6 }}
          >
            {sale.customer_notice.trim()}
          </Text>
        </View>
      ))}
    </View>
  );
}

// ── HomeTabHeader ─────────────────────────────────────────────────────────────
//
// ListHeaderComponent for the lot FlatList. Renders the "Live Auctions"
// horizontal rail above the lot grid so bidders can answer "what's live this
// week?" at a glance. Self-hides when there are no active auctions.
//
// Tapping an auction card toggles the auction_id filter — same mechanism as
// the existing operator/category filters in the Browse screen. Tapping a
// second time on the same card deselects (clears the filter). The "Clear
// filter" affordance in the section header does the same.

type AuctionRailItem = {
  id: string;
  title: string;
  status: string;
  starts_at: string | null;
  ends_at: string;
  last_lot_ends_at: string | null;
  lot_count: number;
  operators: { business_name: string } | null;
  warehouses: { timezone: string | null } | null;
};

interface HomeTabHeaderProps {
  auctions: AuctionRailItem[];
  activeAuctionId: string | null;
  onAuctionPress: (id: string) => void;
  /** Ticking clock (1Hz, from the parent) so the LIVE/UPCOMING badge flips at
   *  starts_at without a refetch. */
  now: number;
}

interface HomeTabFooterProps {
  onCategoryPress: (id: string) => void;
  activeCategoryId: string | null;
  onSortEndingSoon: () => void;
  recentLots: LotRow[];
  cardData: (l: LotRow) => import('@auction-platform/domain-bidding').LotCardData;
  now: number;
  router: ReturnType<typeof useRouter>;
}

function HomeTabHeader({ auctions, activeAuctionId, onAuctionPress, now }: HomeTabHeaderProps) {
  if (auctions.length === 0) return null;

  return (
    <View style={{ marginBottom: 4 }}>
      {/* Section label */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: 12,
          paddingTop: 8,
          paddingBottom: 6,
        }}
      >
        <Text style={{ color: colors.textMuted, fontSize: 11, ...type.label }}>
          LIVE AUCTIONS
        </Text>
        {activeAuctionId !== null && (
          <Pressable onPress={() => onAuctionPress(activeAuctionId)} hitSlop={8}>
            <Text style={{ color: colors.primary, fontSize: 11, ...type.label }}>
              Clear filter
            </Text>
          </Pressable>
        )}
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: 8, paddingHorizontal: 12, paddingBottom: 8 }}
      >
        {auctions.map((auction) => (
          <LiveAuctionCard
            key={auction.id}
            auction={auction}
            now={now}
            isActive={activeAuctionId === auction.id}
            onPress={() => onAuctionPress(auction.id)}
          />
        ))}
      </ScrollView>
    </View>
  );
}

// ── HomeTabFooter ─────────────────────────────────────────────────────────────
//
// ListFooterComponent for the lot FlatList. Renders below the live lot grid
// so inventory is the first thing a bidder sees on Browse. Renders in order:
//   1. CategoryGrid — browse by category after seeing the full lot firehose
//   2. HomeHero     — branding / social-proof band (compact, no CTA)
//   3. RecentWinsRail — self-hides on empty/error
//   4. SectionBanner × 3 — ending soon, pickup ready, trusted auctions
//   5. Recently viewed rail (only when populated)
//
// 2026-05-30: HomeHero + CategoryGrid moved here from ListHeaderComponent so
// the lot grid is visible without scrolling on cold app open.

function HomeTabFooter({
  onCategoryPress,
  activeCategoryId,
  onSortEndingSoon,
  recentLots,
  cardData,
  now,
  router,
}: HomeTabFooterProps) {
  return (
    <View>
      {/* 1. Category grid — browse by category after seeing lots */}
      <CategoryGrid
        onCategoryPress={onCategoryPress}
        activeCategoryId={activeCategoryId}
      />

      {/* 2. Compact hero band — branding, no CTA (CTA removed: this position
           is below the lots the button would scroll back to) */}
      <HomeHero
        title="Better Deals. Better Bids."
        subtitle="Online auctions, run by the people who run them."
      />

      {/* 3. Recent wins rail — self-hides on empty/error */}
      <RecentWinsRail />

      {/* Ending soon banner */}
      <SectionBanner
        mobileSrc={sectionBannerMobileSrc('ending-soon')}
        alt="Daily deals and ending soon auctions"
        ctaText="See deals ending soon →"
        overlayAlign="right"
        onPress={() => {
          onSortEndingSoon();
        }}
      />

      {/* Pickup ready banner */}
      <SectionBanner
        mobileSrc={sectionBannerMobileSrc('pickup-ready')}
        alt="Local pickup locations"
        ctaText="Find pickup near you →"
        overlayAlign="left"
        onPress={() => {
          router.push('/pickup' as never);
        }}
      />

      {/* Trusted auctions banner */}
      <SectionBanner
        mobileSrc={sectionBannerMobileSrc('trusted-auctions')}
        alt="Trusted auctions on BinGo Auctions"
        ctaText="Sign up free →"
        overlayAlign="right"
        onPress={() => {
          // route is /(auth)/signup, not /sign-up (the previous href landed
          // on Unmatched Route).
          router.push('/(auth)/signup' as never);
        }}
      />

      {/* Recently viewed (only when the rail is populated) */}
      {recentLots.length > 0 && (
        <View style={{ marginBottom: 12, marginTop: 8 }}>
          <Text
            style={{
              color: colors.textMuted,
              fontSize: 11,
              paddingHorizontal: 12,
              paddingBottom: 6,
              ...type.label,
            }}
          >
            Recently viewed
          </Text>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 8, paddingHorizontal: 12 }}
          >
            {recentLots.map((l) => (
              <View key={l.id} style={{ width: 140 }}>
                <LotCard lot={cardData(l)} now={now} />
              </View>
            ))}
          </ScrollView>
        </View>
      )}
    </View>
  );
}

// Larger chip with a stroke-glyph icon (CategoryIcon, keyed by slug;
// falls back to the DB emoji for unmapped slugs) — used for the
// top-level category rail so the rail reads at a glance (icons scan
// faster than text while skimming horizontally).
function CategoryChip({
  active,
  slug,
  icon,
  label,
  onPress,
}: {
  active: boolean;
  slug?: string | null;
  icon: string;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingVertical: 8,
        paddingHorizontal: 14,
        borderWidth: 1,
        borderColor: active ? colors.primary : colors.border,
        backgroundColor: active ? colors.primaryDim : colors.surface,
        borderRadius: 999,
      }}
    >
      <CategoryIcon
        slug={slug}
        emoji={icon}
        size={16}
        color={active ? colors.primary : colors.text}
      />
      <Text
        style={{
          color: active ? colors.primary : colors.text,
          fontSize: 13,
          fontWeight: '700',
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

