// Shared cross-auction lots query for /browse — extracted 2026-07-07 so the
// lot page can fetch prev/next neighbors with EXACTLY the same filters and
// ordering the customer was browsing with (swipe-through UX). Any filter or
// sort change here affects both surfaces by construction.

import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { getDemoOperatorIds, demoExclusionList } from '@/lib/demo-operators';
import { resolveCategoryFilterIds } from '@/lib/category-filter';
import { lotSearchFilter } from '@/lib/search-limits';
import type { SortOption } from '@/app/(public)/_components/FilterRail';

export const BROWSE_PAGE_SIZE = 24;

type AuctionClockRow = { status: string; starts_at: string | null };

/** Every column the browse grid + lot-page neighbor lookup select. */
export type BrowseLotRow = {
  id: string;
  lot_code: string;
  title: string;
  photo_urls: string[] | null;
  current_bid_cents: number | null;
  starting_bid_cents: number;
  close_at: string;
  bid_count: number | null;
  category_id: string | null;
  auction_id: string;
  condition: string | null;
  msrp_cents: number | null;
  status: string | null;
};

// ── Lots data loader (lots mode) ──────────────────────────────────────────────

export type LotQueryFilters = {
  /** Multi-select (2026-07-07): filter to the union of these category slugs
   *  (each expanded to include its children). Empty = no category filter. */
  categorySlugs: string[];
  conditions: string[];
  priceMinCents: number | null;
  priceMaxCents: number | null;
  sort: SortOption;
  page: number;
  /** Free-text query; applied as ILIKE on title + lot_code */
  searchQuery: string | null;
  /** S5a: warehouse UUID to scope results to a single warehouse */
  warehouseId: string | null;
  /** Warehouse city from the nav location picker. A city can hold more than
   *  one warehouse, so this is a set of ids resolved by the caller rather than
   *  a join — keeping this query a single flat select. Null = no city filter. */
  warehouseIdsInCity?: string[] | null;
  /** Row-range override for the lot-page prev/next neighbor fetch. Ignores
   *  `page`. Not supported with virtual conditions (post-query filters break
   *  absolute row indexing) — callers skip prev/next there. */
  rangeOverride?: { from: number; to: number };
};

export async function loadBrowseLots(
  filters: LotQueryFilters,
): Promise<{ lots: BrowseLotRow[]; total: number }> {
  const supabase = getSupabaseAdmin();

  // Coarse `status IN ('scheduled','live')` is the prefilter; the active set
  // keeps every non-ended auction (live OR upcoming) — a not-yet-open lot still
  // renders via LotCard with its static "Upcoming" pill (status threaded
  // below). starts_at + status are selected so membership is clock-gated, never
  // decided on the bare enum.
  // H4-c: exclude demo-operator auctions so demo lots never appear in /browse lots.
  const demoExclude = demoExclusionList(await getDemoOperatorIds());
  let activeAuctionQuery = supabase
    .from('auctions')
    .select('id, status, starts_at')
    .in('status', ['scheduled', 'live'])
    .eq('unlisted', false);
  if (demoExclude) activeAuctionQuery = activeAuctionQuery.not('operator_id', 'in', demoExclude);
  const { data: activeAuctions } = await activeAuctionQuery;

  const activeAuctionIds = ((activeAuctions ?? []) as Array<AuctionClockRow & { id: string }>)
    .filter((a) => a.status !== 'closed')
    .map((a) => a.id);
  if (activeAuctionIds.length === 0) {
    return { lots: [], total: 0 };
  }

  const realConditions = filters.conditions.filter((c) => !c.startsWith('virtual:'));
  const hasVirtualEndingSoon = filters.conditions.includes('virtual:ending-soon');
  const hasVirtualTopDeal = filters.conditions.includes('virtual:top-deal');
  const virtualConditionActive = hasVirtualEndingSoon || hasVirtualTopDeal;

  const nowIso = new Date().toISOString();
  let query = supabase
    .from('lots')
    .select(
      'id, lot_code, title, photo_urls, current_bid_cents, starting_bid_cents, close_at, bid_count, category_id, auction_id, condition, msrp_cents, status',
      { count: 'exact' },
    )
    .in('auction_id', activeAuctionIds)
    .is('deleted_at', null) // W6: match count query — exclude soft-deleted lots
    // M2: exclude lots that are no longer biddable (terminal status) or whose
    // close time has already elapsed but haven't been reconciled yet. Mirrors
    // the mobile browse query (apps/bidder-app/app/(tabs)/index.tsx).
    .in('status', ['scheduled', 'live'])
    .or(`close_at.gt.${nowIso},close_at.is.null`);

  // Category filter: union of every selected category (+ children).
  if (filters.categorySlugs.length > 0) {
    const catIds = await resolveCategoryFilterIds(supabase, filters.categorySlugs);
    if (catIds.length > 0) {
      query = query.in('category_id', catIds);
    }
  }

  if (realConditions.length > 0) {
    query = query.in('condition', realConditions);
  }

  if (filters.priceMinCents !== null) {
    query = query.gte('starting_bid_cents', filters.priceMinCents);
  }
  if (filters.priceMaxCents !== null) {
    query = query.lte('starting_bid_cents', filters.priceMaxCents);
  }

  // S5a: warehouse filter
  if (filters.warehouseId) {
    query = query.eq('warehouse_id', filters.warehouseId);
  }

  // Location picker (?city). Scopes lots the same way it scopes auctions, so
  // switching city can't leave another city's lots on screen.
  if (filters.warehouseIdsInCity && filters.warehouseIdsInCity.length > 0) {
    query = query.in('warehouse_id', filters.warehouseIdsInCity);
  }

  // Free-text search: match title, lot_code, or the physical sticker label
  // (case-insensitive). `sticker_code` was missing, and it is the code the
  // customer can actually read — `lotDisplayCode` renders the stripped sticker
  // in preference to `lot_code`, so a bidder searching the code shown on the
  // listing they are looking at found nothing whenever the lot was relisted.
  // 1–2 characters match word prefixes in the title instead of returning
  // nothing ("TV" must find TVs); 3+ match substrings. See lib/search-limits.ts.
  // `?q=` reaches here straight off the URL, and `.or()` takes filter SYNTAX:
  // lotSearchFilter sanitises it (lib/postgrest-filter.ts) before building one.
  const searchFilter = lotSearchFilter(filters.searchQuery);
  if (searchFilter) {
    query = query.or(searchFilter);
  }

  switch (filters.sort) {
    case 'ending-soon':
      query = query.order('close_at', { ascending: true });
      break;
    case 'newest':
      // Was `lot_code desc`, which is ALPHABETICAL, not chronological. Lot
      // codes come in two shapes — legacy go-live imports carry their printed
      // label ("TEA4959720") while re-lotted stock gets a synthetic
      // "BIN-######" — so descending ASCII put TEA > PPE > PNK > GRA > BRN >
      // "BIN-", and the whole first page of "Newest" was May go-live stock
      // while genuinely-new relisted lots sorted dead last. Order by the
      // column that actually means "new".
      query = query.order('created_at', { ascending: false });
      break;
    case 'most-bids':
      query = query.order('bid_count', { ascending: false, nullsFirst: false });
      break;
    // 2026-07-05 bidder-QoL: price sorts order by CURRENT bid, not starting
    // bid. On a $1-opening liquidation catalog every lot has the same
    // starting bid, which made both price sorts no-ops — the "I can't sort
    // by highest bids" complaint.
    case 'price-low':
      query = query
        .order('current_bid_cents', { ascending: true, nullsFirst: true })
        .order('close_at', { ascending: true });
      break;
    case 'price-high':
      query = query
        .order('current_bid_cents', { ascending: false, nullsFirst: false })
        .order('close_at', { ascending: true });
      break;
    default:
      query = query.order('close_at', { ascending: true });
  }

  const fetchLimit = virtualConditionActive ? BROWSE_PAGE_SIZE * 10 : BROWSE_PAGE_SIZE;
  const fetchFrom = virtualConditionActive ? 0 : (filters.page - 1) * BROWSE_PAGE_SIZE;
  if (filters.rangeOverride && !virtualConditionActive) {
    query = query.range(filters.rangeOverride.from, filters.rangeOverride.to);
  } else {
    query = query.range(fetchFrom, fetchFrom + fetchLimit - 1);
  }

  const { data, error, count } = await query;

  if (error) {
    console.error('[browse] lots query failed', error.message);
    return { lots: [], total: 0 };
  }

  let rows = (data ?? []) as unknown as BrowseLotRow[];

  if (virtualConditionActive) {
    const nowMs = Date.now();
    if (hasVirtualEndingSoon && !hasVirtualTopDeal) {
      rows = rows.filter((lot) => {
        const ms = new Date(lot.close_at).getTime();
        return ms > nowMs && ms - nowMs <= 5 * 60 * 1000;
      });
    } else if (hasVirtualTopDeal && !hasVirtualEndingSoon) {
      rows = rows.filter(
        (lot) =>
          lot.current_bid_cents !== null && lot.current_bid_cents < lot.starting_bid_cents * 1.5,
      );
    } else {
      rows = rows.filter((lot) => {
        const ms = new Date(lot.close_at).getTime();
        const isEndingSoon = ms > nowMs && ms - nowMs <= 5 * 60 * 1000;
        const isTopDeal =
          lot.current_bid_cents !== null && lot.current_bid_cents < lot.starting_bid_cents * 1.5;
        return isEndingSoon || isTopDeal;
      });
    }
    const filteredTotal = rows.length;
    const start = (filters.page - 1) * BROWSE_PAGE_SIZE;
    rows = rows.slice(start, start + BROWSE_PAGE_SIZE);
    return { lots: rows, total: filteredTotal };
  }

  return { lots: rows, total: count ?? 0 };
}
