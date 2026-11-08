/**
 * Public browse page — bingoauctions.com/browse
 *
 * Two modes, toggled by a tab at the top:
 *
 *   Lots tab (DEFAULT — anything that isn't ?view=auctions):
 *     Flat cross-auction lot discovery with the FilterRail sidebar/sheet.
 *     Same LotCard grid + pagination pattern as /category/[slug].
 *
 *   Auctions tab (opt-in — ?view=auctions only):
 *     Lists every operator's currently-running and upcoming auctions.
 *
 * ⚠️ This block used to say the opposite — "Auctions tab (default)" — while
 * isLotsMode() below did the reverse. The stale comment outlived the
 * lots-first change and got WEB-01 triaged as a routing bug when the real
 * defect was three links that promised auctions and pointed at bare /browse
 * (homepage hero CTA, nav "Auctions", footer "Live auctions" — all now carry
 * ?view=auctions). The default itself is deliberate; see isLotsMode.
 *
 * Server component. All filter state lives in URL search params so every
 * view is SSR-rendered, bookmark-able, and shareable.
 *
 * Virtual conditions ('virtual:ending-soon', 'virtual:top-deal') are handled
 * post-query in JS — see comment in /category/[slug]/page.tsx for rationale.
 */

import Link from 'next/link';
import type { Metadata } from 'next';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { parseCategorySlugs } from '@/lib/category-filter';
import { loadBrowseLots } from '@/lib/browse-lots';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getDemoOperatorIds, demoExclusionList } from '@/lib/demo-operators';
import { LotCard } from '../_components/LotCard';
import { PublicAuctionCard } from '../_components/PublicAuctionCard';
import { OffsiteSaleButtons } from '../_components/OffsiteSaleButtons';
import { FilterRail, type FilterCategory, type SortOption } from '../_components/FilterRail';
import { SortSelect } from '../_components/SortSelect';
import { BrowseAutoRefresh } from '../_components/BrowseAutoRefresh';
import { loadPrimaryBusiness } from '@/lib/seo';
import { GoToPage } from './GoToPage';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_W = 1100;
const PAGE_SIZE = 24;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Dynamic for the warehouse city — "auctions near {city}" is the query that
// should land here. Falls back to the region-free copy when the lookup fails.
export async function generateMetadata(): Promise<Metadata> {
  const biz = await loadPrimaryBusiness();
  const place = biz?.address ? ` in ${biz.address.city}, ${biz.address.state}` : '';
  return {
    title: `Browse Auctions${place}`,
    description: `Bid on every BinGo Auctions auction from one place. Live and upcoming auctions with local pickup${place}.`,
    openGraph: {
      images: [{ url: '/og-default.png', width: 1200, height: 628 }],
    },
  };
}

// ── Types ─────────────────────────────────────────────────────────────────────

type AuctionClockRow = { status: string; starts_at: string | null };

type AuctionRow = {
  id: string;
  title: string;
  status: string;
  description: string | null;
  starts_at: string | null;
  ends_at: string | null;
  last_lot_ends_at: string | null;
  featured_image_urls: string[] | null;
  operator_id: string;
  lot_count: number;
  // supabase-js infers this embed as an array; warehouseTimezone() normalizes
  // either shape at the call site.
  warehouses: { timezone: string | null }[] | null;
};


// ── Demo-operator exclusion ────────────────────────────────────────────────
//
// H4-c (2026-06-03): the demo operator (Demo Auctioneer) carries a permanent
// "BinGo Auctions Demo Auction — App Review" auction so Apple/Google reviewers always
// have something biddable. Real users must NOT see it on the public storefront.
//
// `getDemoOperatorIds` + `demoExclusionList` were lifted to
// `@/lib/demo-operators` (2026-06-10) so every public web loader can share the
// same exclusion — the helpers used to live here and the other public loaders
// leaked the demo content. The loaders below use the service-role admin client
// (getSupabaseAdmin), which BYPASSES RLS, so the exclusion must live in the
// query (see the lib for the full rationale).

// ── Watchlist loader ─────────────────────────────────────────────────────────
//
// Returns the set of lot IDs the current signed-in bidder is watching, scoped
// to the given lot ID list (we never fetch the bidder's whole watchlist —
// just the rows that intersect with what we're about to render). Anon
// visitors get an empty set so the SSR render shows empty stars and the
// client-side toggle handles the /login redirect on click.

async function loadWatchedIds(lotIds: string[]): Promise<Set<string>> {
  if (lotIds.length === 0) return new Set();
  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return new Set();

  const { data, error } = await supabase
    .from('watchlist')
    .select('lot_id')
    .eq('bidder_id', user.id)
    .in('lot_id', lotIds);

  if (error) {
    console.error('[browse] watchlist lookup failed', error.message);
    return new Set();
  }
  return new Set(((data ?? []) as Array<{ lot_id: string }>).map((r) => r.lot_id));
}

// ── Auction data loader (original behaviour) ──────────────────────────────────

async function loadAuctions(
  page: number,
  city: string | null,
): Promise<{ auctions: AuctionRow[]; total: number }> {
  const supabase = getSupabaseAdmin();

  const from = (page - 1) * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  // H4-c: exclude demo-operator auctions from the public storefront.
  const demoExclude = demoExclusionList(await getDemoOperatorIds());

  // The nav location picker writes ?city. Until 2026-08-26 nothing on this page
  // read it, so every auction in the catalogue rendered no matter which city
  // was chosen — and a Harrison customer bought out of a Dodge City auction.
  // `warehouses!inner` makes the join filtering rather than decorative: an
  // auction whose warehouse is in another city is dropped, and `count` reflects
  // the filtered set so pagination stays honest.
  const whJoin = city ? 'warehouses!inner(timezone, city)' : 'warehouses(timezone)';

  let auctionQuery = supabase
    .from('auctions')
    .select(
      `id, title, status, description, starts_at, ends_at, last_lot_ends_at, featured_image_urls, operator_id, ${whJoin}`,
      { count: 'exact' },
    )
    .in('status', ['scheduled', 'live'])
    .eq('unlisted', false);
  if (city) auctionQuery = auctionQuery.eq('warehouses.city', city);
  if (demoExclude) auctionQuery = auctionQuery.not('operator_id', 'in', demoExclude);

  const { data, error, count } = await auctionQuery
    .order('last_lot_ends_at', { ascending: true, nullsFirst: false })
    .order('ends_at', { ascending: true, nullsFirst: false })
    .range(from, to);

  if (error) {
    console.error('[browse] auctions list failed', error);
    return { auctions: [], total: 0 };
  }

  const auctionIds = (data ?? []).map((a) => (a as { id: string }).id);
  let lotCounts: Record<string, number> = {};
  if (auctionIds.length) {
    // Per-auction head-count queries instead of fetching lot rows and
    // counting client-side: the old row fetch had no .limit(), so
    // PostgREST's default 1,000-row cap silently dropped everything past
    // row 1000 once the catalog crossed ~1,200 active lots — auctions
    // whose lots fell past the cap showed "0 lots" (owner report,
    // 2026-07-06). count:'exact', head:true transfers zero rows and has
    // no cap to outgrow; at most PAGE_SIZE (24) parallel queries.
    const counts = await Promise.all(
      auctionIds.map((id) =>
        supabase
          .from('lots')
          .select('id', { count: 'exact', head: true })
          .eq('auction_id', id)
          .is('deleted_at', null)
          .then((res) => [id, res.count ?? 0] as const),
      ),
    );
    lotCounts = Object.fromEntries(counts);
  }

  const auctions = (data ?? []).map((a) => {
    const row = a as Omit<AuctionRow, 'lot_count'>;
    return { ...row, lot_count: lotCounts[row.id] ?? 0 };
  });

  return { auctions, total: count ?? 0 };
}

// ── Recently-closed auctions ("Results" view) ─────────────────────────────────
// Issue 5 (2026-06-02): a closed auction correctly drops out of the active
// list (loadAuctions filters scheduled/live), but bidders had no way to reach
// its aggregate page from browse — only a direct link worked, after #175 made
// closed auctions render instead of 404. This surfaces the most recent closed
// auctions in a distinct "Recently closed" section so results stay
// discoverable. Capped at 12; RLS already lets bidders read closed auctions
// (auctions_bidder_read_published, mig 0133).
async function loadRecentlyClosed(city: string | null): Promise<AuctionRow[]> {
  const supabase = getSupabaseAdmin();
  // H4-c: exclude demo-operator auctions from the public "Recently closed" rail.
  const demoExclude = demoExclusionList(await getDemoOperatorIds());
  const whJoin = city ? 'warehouses!inner(timezone, city)' : 'warehouses(timezone)';
  let closedQuery = supabase
    .from('auctions')
    .select(
      `id, title, status, description, starts_at, ends_at, last_lot_ends_at, featured_image_urls, operator_id, ${whJoin}`,
    )
    .eq('status', 'closed')
    .eq('unlisted', false); // 0242: closed test auctions stay off the public rail
  if (city) closedQuery = closedQuery.eq('warehouses.city', city);
  if (demoExclude) closedQuery = closedQuery.not('operator_id', 'in', demoExclude);
  const { data, error } = await closedQuery
    .order('last_lot_ends_at', { ascending: false, nullsFirst: false })
    .order('ends_at', { ascending: false, nullsFirst: false })
    // Keep the public "Recently closed" rail short so old (test) auctions don't
    // clutter the homepage — only the few newest closed auctions.
    .limit(4);

  if (error) {
    console.error('[browse] recently-closed list failed', error);
    return [];
  }
  return (data ?? []).map((a) => {
    const row = a as Omit<AuctionRow, 'lot_count'>;
    return { ...row, lot_count: 0 };
  });
}

// ── Storefront-visible lot counts ────────────────────────────────────────────
//
// One round-trip pulls every storefront-visible lot's (category_id, condition,
// close_at, current_bid_cents, starting_bid_cents) and we GROUP BY in JS to
// produce per-category and per-condition counts. This matches MAC.BID's
// pattern ("Home & Kitchen 988") while costing one query instead of N.
//
// Scope: same set of lots the storefront actually shows — auction status in
// ('live','scheduled'), lot deleted_at IS NULL. Anything stricter (or looser)
// would lie to users about what they'd see if they clicked through.

type LotCountRow = {
  category_id: string | null;
  condition: string | null;
  close_at: string;
  current_bid_cents: number | null;
  starting_bid_cents: number;
};

interface StorefrontLotCounts {
  /** Map of category_id -> count of storefront-visible lots in that category. */
  byCategoryId: Record<string, number>;
  /** Map of condition slug -> count. Includes the 2 virtual conditions
   *  ('virtual:ending-soon','virtual:top-deal') computed from close_at +
   *  bid ratios; mirrors the filter's post-query JS logic. */
  byCondition: Record<string, number>;
}

/** Ending-soon window matches the LotCard badge + filter post-query logic. */
const ENDING_SOON_WINDOW_MS = 5 * 60 * 1000;
/** Top-deal heuristic threshold matches the filter post-query + LotCard badge. */
const TOP_DEAL_MULTIPLIER = 1.5;

async function fetchStorefrontLotCounts(): Promise<StorefrontLotCounts> {
  const supabase = getSupabaseAdmin();

  // Resolve active auction IDs first — same gate every storefront page uses.
  // Coarse `status IN ('scheduled','live')` is the query prefilter; the final
  // active set keeps every non-ended auction (live OR upcoming) because these
  // counts mirror loadLots, which renders live + upcoming lots alike (a not-yet
  // open lot shows its Upcoming pill). starts_at + status are selected so the
  // set is classified on the clock, never the bare enum.
  // H4-c: exclude demo-operator auctions so demo lots never feed the counts.
  const demoExclude = demoExclusionList(await getDemoOperatorIds());
  let activeAuctionQuery = supabase
    .from('auctions')
    .select('id, status, starts_at')
    .in('status', ['scheduled', 'live'])
    .eq('unlisted', false);
  if (demoExclude) activeAuctionQuery = activeAuctionQuery.not('operator_id', 'in', demoExclude);
  const { data: activeAuctions, error: auctionsError } = await activeAuctionQuery;
  if (auctionsError) {
    // Surfaced, not swallowed — a failure here previously returned all-zero
    // counts with no trace.
    console.error('[browse] count auction prefilter failed', auctionsError.message);
  }

  const activeAuctionIds = ((activeAuctions ?? []) as Array<AuctionClockRow & { id: string }>)
    .filter((a) => a.status !== 'closed')
    .map((a) => a.id);
  if (activeAuctionIds.length === 0) {
    return { byCategoryId: {}, byCondition: {} };
  }

  // Single round-trip: pull the minimum columns needed to bucket counts in JS.
  // Per the spec a per-category `count: 'exact'` head query is not helpful
  // (PostgREST doesn't expose GROUP BY) — pulling the rows + grouping in
  // memory keeps it to one DB hit. Cap at 20k rows to bound worst case; if
  // the storefront ever exceeds this we'll graduate to a materialised view.
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from('lots')
    .select('category_id, condition, close_at, current_bid_cents, starting_bid_cents')
    .in('auction_id', activeAuctionIds)
    .is('deleted_at', null)
    .in('status', ['scheduled', 'live'])
    .or(`close_at.gt.${nowIso},close_at.is.null`)
    .limit(20000);

  if (error) {
    console.error('[browse] lot count query failed', error.message);
    return { byCategoryId: {}, byCondition: {} };
  }

  const rows = (data ?? []) as LotCountRow[];
  const byCategoryId: Record<string, number> = {};
  const byCondition: Record<string, number> = {};
  const nowMs = Date.now();
  let endingSoonCount = 0;
  let topDealCount = 0;

  for (const row of rows) {
    if (row.category_id !== null) {
      byCategoryId[row.category_id] = (byCategoryId[row.category_id] ?? 0) + 1;
    }
    if (row.condition) {
      byCondition[row.condition] = (byCondition[row.condition] ?? 0) + 1;
    }
    // Virtual condition: ending-soon — open lot closing within 5 min.
    const closeMs = new Date(row.close_at).getTime();
    if (closeMs > nowMs && closeMs - nowMs <= ENDING_SOON_WINDOW_MS) {
      endingSoonCount += 1;
    }
    // Virtual condition: top-deal — has bids AND current_bid < 1.5× starting.
    if (
      row.current_bid_cents !== null &&
      row.current_bid_cents < row.starting_bid_cents * TOP_DEAL_MULTIPLIER
    ) {
      topDealCount += 1;
    }
  }

  byCondition['virtual:ending-soon'] = endingSoonCount;
  byCondition['virtual:top-deal'] = topDealCount;

  return { byCategoryId, byCondition };
}

// Direct per-render call — deliberately NOT unstable_cache. On the Cloudflare
// Workers runtime the cache froze the first computed value: an empty result
// captured when the DB was unreachable served zeros forever (tester
// 2026-07-04 — every rail count 0 while the grid showed 100 lots).
// CLOVRBID-WEB-8 class. Two small selects per render is negligible here.
const getStorefrontLotCounts = fetchStorefrontLotCounts;

/** Merge per-category-id counts into the FilterCategory[] returned by
 *  loadAllCategories(). Requires the raw category id list — we need to look
 *  up id by slug because the FilterCategory shape doesn't carry the id. */
function mergeCategoryCounts(
  categories: FilterCategory[],
  idsBySlug: Map<string, string>,
  byCategoryId: Record<string, number>,
): FilterCategory[] {
  // Own count first, then roll each child's count into its parent — a parent
  // row must reflect what clicking it shows (the lot query filters on
  // [parent, ...children]). Two-level taxonomy, so one pass suffices.
  const own = (slug: string): number => {
    const id = idsBySlug.get(slug);
    return id ? (byCategoryId[id] ?? 0) : 0;
  };
  const childSum = new Map<string, number>();
  for (const c of categories) {
    if (c.parent_slug) {
      childSum.set(c.parent_slug, (childSum.get(c.parent_slug) ?? 0) + own(c.slug));
    }
  }
  return categories.map((c) => ({
    ...c,
    lot_count: own(c.slug) + (childSum.get(c.slug) ?? 0),
  }));
}

/** Re-load categories with the id->slug map exposed so we can merge counts
 *  against the byCategoryId result (which is keyed by id, not slug). */
async function loadCategoriesWithIdMap(): Promise<{
  categories: FilterCategory[];
  idsBySlug: Map<string, string>;
}> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from('categories')
    .select('id, slug, name, parent_id, icon_url, image_url_clean')
    .order('name', { ascending: true });

  if (!data) return { categories: [], idsBySlug: new Map() };

  const slugById = new Map<string, string>(
    (data as Array<{ id?: string; slug: string }>)
      .filter((r): r is { id: string; slug: string } => typeof r.id === 'string')
      .map((r) => [r.id, r.slug]),
  );

  const idsBySlug = new Map<string, string>();
  for (const [id, slug] of slugById) {
    idsBySlug.set(slug, id);
  }

  const categories: FilterCategory[] = (data as Array<{
    id?: string;
    slug: string;
    name: string;
    parent_id: string | null;
    icon_url: string | null;
    image_url_clean: string | null;
  }>).map((r) => ({
    slug: r.slug,
    name: r.name,
    parent_slug: r.parent_id ? (slugById.get(r.parent_id) ?? null) : null,
    icon_url: r.icon_url,
    image_url_clean: r.image_url_clean,
    lot_count: 0,
  }));

  return { categories, idsBySlug };
}


// ── Warehouse loader (S5a) ────────────────────────────────────────────────────
//
// Fetches all warehouses that have lots in active auctions. One DB round-trip.
// Returns an empty list when there is only one warehouse (no chip needed).

type WarehouseOption = { id: string; name: string };

async function loadActiveWarehouses(): Promise<WarehouseOption[]> {
  const supabase = getSupabaseAdmin();

  // Coarse `status IN ('scheduled','live')` is the prefilter; the active set
  // keeps every non-ended auction (live OR upcoming) to match loadLots, and
  // selects starts_at + status so membership is clock-gated, not enum-gated.
  // H4-c: exclude demo-operator auctions so the demo warehouse never appears
  // as a storefront warehouse chip.
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
  if (activeAuctionIds.length === 0) return [];

  // Distinct warehouse_ids from lots in active auctions.
  const { data: lotWh } = await supabase
    .from('lots')
    .select('warehouse_id')
    .in('auction_id', activeAuctionIds)
    .in('status', ['scheduled', 'live'])
    .not('warehouse_id', 'is', null);

  const whIds = Array.from(
    new Set(
      ((lotWh ?? []) as Array<{ warehouse_id: string | null }>)
        .map((r) => r.warehouse_id)
        .filter((id): id is string => id !== null),
    ),
  );
  if (whIds.length <= 1) return []; // no chip if zero or one warehouse

  const { data: wh } = await supabase
    .from('warehouses')
    .select('id, name')
    .in('id', whIds)
    .order('name');

  return (wh ?? []) as WarehouseOption[];
}

// Resolve the nav picker's city to the warehouse ids in it. A city can hold
// more than one warehouse, so this is a set, not a single id.
async function warehouseIdsForCity(city: string | null): Promise<string[] | null> {
  if (!city) return null;
  const supabase = getSupabaseAdmin();
  const { data } = await supabase.from('warehouses').select('id').eq('city', city);
  const ids = ((data ?? []) as Array<{ id: string }>).map((w) => w.id);
  // An unknown city must return NOTHING rather than silently falling back to
  // "everywhere" — showing another city's lots is the bug we are fixing.
  return ids;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const VALID_SORTS: SortOption[] = [
  'ending-soon', 'newest', 'most-bids', 'price-low', 'price-high',
];

function parseSort(raw: string | undefined): SortOption {
  if (raw && (VALID_SORTS as string[]).includes(raw)) return raw as SortOption;
  return 'ending-soon';
}

/** Lots-first landing (mac.bid / nellis pattern): the bare /browse URL shows
 *  the cross-auction lot firehose so buyable inventory is visible above the
 *  fold. The auctions list is now opt-in via ?view=auctions. Any filter/search
 *  param (category/condition/price/sort/q) also resolves to lots — but since
 *  lots is now the default, that's just the natural fallthrough. */
function isLotsMode(sp: BrowseSearchParams): boolean {
  return sp.view !== 'auctions';
}

type BrowseSearchParams = {
  page?: string;
  view?: string;
  category?: string;
  condition?: string;
  price_min?: string;
  price_max?: string;
  sort?: string;
  /** Free-text search: filters lots by title ILIKE %q% OR lot_code ILIKE %q% */
  q?: string;
  /** S5a: warehouse UUID to scope results */
  warehouse?: string;
  /** Warehouse city from the nav location picker. Scopes auctions AND lots. */
  city?: string;
};

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function BrowsePage({
  searchParams,
}: {
  searchParams: Promise<BrowseSearchParams>;
}) {
  const sp = await searchParams;
  const lotsMode = isLotsMode(sp);
  const page = Math.max(1, parseInt(sp.page ?? '1', 10) || 1);

  if (lotsMode) {
    // ── Lots mode ─────────────────────────────────────────────────────────────
    const conditions = sp.condition ? sp.condition.split(',').filter(Boolean) : [];
    const priceMinCents = sp.price_min ? Math.round(parseFloat(sp.price_min) * 100) : null;
    const priceMaxCents = sp.price_max ? Math.round(parseFloat(sp.price_max) * 100) : null;
    const sort = parseSort(sp.sort);
    const categorySlugs = parseCategorySlugs(sp.category);
    const searchQuery = sp.q?.trim() ?? null;
    // S5a: validate warehouse param is a UUID format to avoid injection.
    const warehouseId =
      sp.warehouse && /^[0-9a-f-]{36}$/i.test(sp.warehouse) ? sp.warehouse : null;
    const cityFilter = sp.city && sp.city !== 'all' ? sp.city.trim() : null;
    const warehouseIdsInCity = await warehouseIdsForCity(cityFilter);

    const [
      { lots, total },
      { categories: baseCategories, idsBySlug },
      counts,
      warehouseOptions,
    ] = await Promise.all([
      loadBrowseLots({ categorySlugs, conditions, priceMinCents, priceMaxCents, sort, page, searchQuery, warehouseId, warehouseIdsInCity }),
      loadCategoriesWithIdMap(),
      getStorefrontLotCounts(),
      loadActiveWarehouses(),
    ]);

    // Merge per-category lot counts into the rail data.
    const allCategories = mergeCategoryCounts(baseCategories, idsBySlug, counts.byCategoryId);

    // Resolve which of the rendered lots the signed-in bidder is already
    // watching so the star icon paints correctly on first render. Anon
    // visitors get an empty set.
    const watchedIds = await loadWatchedIds(lots.map((l) => l.id));

    const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

    function lotsPaginationHref(targetPage: number): string {
      const qs = new URLSearchParams();
      qs.set('view', 'lots');
      if (categorySlugs.length > 0) qs.set('category', categorySlugs.join(','));
      if (conditions.length > 0) qs.set('condition', conditions.join(','));
      if (sp.price_min) qs.set('price_min', sp.price_min);
      if (sp.price_max) qs.set('price_max', sp.price_max);
      if (sort !== 'ending-soon') qs.set('sort', sort);
      if (searchQuery) qs.set('q', searchQuery);
      if (cityFilter) qs.set('city', cityFilter);
      if (warehouseId) qs.set('warehouse', warehouseId);
      if (targetPage > 1) qs.set('page', String(targetPage));
      return `/browse?${qs.toString()}`;
    }

    // 2026-07-05 bidder-QoL: removable chips for every active filter. Each
    // chip is a server-rendered Link to the same URL minus that one filter
    // (page reset), so clearing a search/filter is one obvious tap instead
    // of hand-editing the URL.
    function hrefWithout(remove: {
      q?: boolean;
      /** Remove ONE selected category slug (multi-select chips). */
      category?: string;
      condition?: string;
      price?: boolean;
      warehouse?: boolean;
      all?: boolean;
    }): string {
      const qs = new URLSearchParams();
      qs.set('view', 'lots');
      if (remove.all) return `/browse?${qs.toString()}`;
      const keptCategories = remove.category
        ? categorySlugs.filter((c) => c !== remove.category)
        : categorySlugs;
      if (keptCategories.length > 0) qs.set('category', keptCategories.join(','));
      const keptConditions = remove.condition
        ? conditions.filter((c) => c !== remove.condition)
        : conditions;
      if (keptConditions.length > 0) qs.set('condition', keptConditions.join(','));
      if (!remove.price) {
        if (sp.price_min) qs.set('price_min', sp.price_min);
        if (sp.price_max) qs.set('price_max', sp.price_max);
      }
      if (sort !== 'ending-soon') qs.set('sort', sort);
      if (searchQuery && !remove.q) qs.set('q', searchQuery);
      if (cityFilter) qs.set('city', cityFilter);
      if (warehouseId && !remove.warehouse) qs.set('warehouse', warehouseId);
      return `/browse?${qs.toString()}`;
    }

    const CONDITION_LABELS: Record<string, string> = {
      appears_new: 'Appears New',
      open_box: 'Open Box',
      good: 'Good',
      as_is: 'As-Is',
      'virtual:ending-soon': 'Ending Soon',
      'virtual:top-deal': 'Top Deal',
    };

    const activeChips: Array<{ key: string; label: string; href: string }> = [];
    if (searchQuery) {
      activeChips.push({ key: 'q', label: `“${searchQuery}”`, href: hrefWithout({ q: true }) });
    }
    for (const slug of categorySlugs) {
      const catName = allCategories.find((c) => c.slug === slug)?.name ?? slug;
      activeChips.push({ key: `cat-${slug}`, label: catName, href: hrefWithout({ category: slug }) });
    }
    for (const c of conditions) {
      activeChips.push({
        key: `cond-${c}`,
        label: CONDITION_LABELS[c] ?? c,
        href: hrefWithout({ condition: c }),
      });
    }
    if (sp.price_min || sp.price_max) {
      const label =
        sp.price_min && sp.price_max
          ? `$${sp.price_min}–$${sp.price_max}`
          : sp.price_min
            ? `Over $${sp.price_min}`
            : `Under $${sp.price_max}`;
      activeChips.push({ key: 'price', label, href: hrefWithout({ price: true }) });
    }
    if (warehouseId) {
      const whName = warehouseOptions.find((w) => w.id === warehouseId)?.name ?? 'Warehouse';
      activeChips.push({ key: 'wh', label: whName, href: hrefWithout({ warehouse: true }) });
    }

    // Prev/next browse context threaded to lot pages (2026-07-07). Virtual
    // conditions post-filter after the DB query, which breaks absolute row
    // indexing — skip the context there and lot pages just render plain.
    const hasVirtualConditions = conditions.some((c) => c.startsWith('virtual:'));
    const bctxBase = new URLSearchParams();
    if (categorySlugs.length > 0) bctxBase.set('category', categorySlugs.join(','));
    if (conditions.length > 0) bctxBase.set('condition', conditions.join(','));
    if (sp.price_min) bctxBase.set('price_min', sp.price_min);
    if (sp.price_max) bctxBase.set('price_max', sp.price_max);
    if (sort !== 'ending-soon') bctxBase.set('sort', sort);
    if (searchQuery) bctxBase.set('q', searchQuery);
    if (warehouseId) bctxBase.set('warehouse', warehouseId);
    function lotHrefQuery(indexOnPage: number): string {
      if (hasVirtualConditions) return '';
      const ctx = new URLSearchParams(bctxBase.toString());
      ctx.set('i', String((page - 1) * PAGE_SIZE + indexOnPage));
      return `?bctx=${encodeURIComponent(ctx.toString())}`;
    }

    return (
      <div style={{ padding: '3rem 1.5rem 5rem' }}>
        <div style={{ maxWidth: MAX_W, margin: '0 auto' }}>
          {/* Page heading + view toggle */}
          <BrowseHeader lotsMode={true} />
          <OffsiteSaleButtons />

          {/* Invisible client island: re-runs this server component every 30s
              so lot prices + bid counts stay fresh (countdowns tick on their
              own via LotCountdown). */}
          <BrowseAutoRefresh />

          {/* Active filters — each chip removes exactly one filter; the ✕ on
              the search chip is the "how do I clear the search" answer. */}
          {activeChips.length > 0 && (
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: '0.5rem',
                marginBottom: '1rem',
                marginTop: '-0.5rem',
              }}
            >
              {activeChips.map((chip) => (
                <Link
                  key={chip.key}
                  href={chip.href}
                  aria-label={`Remove filter ${chip.label}`}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '0.3rem 0.7rem',
                    background: 'var(--bg-elev)',
                    border: '1px solid var(--accent)',
                    borderRadius: 999,
                    color: 'var(--fg)',
                    fontSize: 13,
                    fontWeight: 600,
                    textDecoration: 'none',
                    lineHeight: 1.2,
                  }}
                >
                  {chip.label}
                  <span aria-hidden style={{ color: 'var(--fg-muted)', fontWeight: 800 }}>
                    ✕
                  </span>
                </Link>
              ))}
              {activeChips.length > 1 && (
                <Link
                  href={hrefWithout({ all: true })}
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    color: 'var(--accent)',
                    textDecoration: 'none',
                    marginLeft: 4,
                  }}
                >
                  Clear all
                </Link>
              )}
            </div>
          )}

          {/* S5a — Warehouse chip group. Only shown when there are multiple
              warehouses with active lots. Each chip is a Link so it is
              SSR-consistent and bookmark-able. */}
          {warehouseOptions.length > 1 && (
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '0.5rem',
                marginBottom: '1rem',
                alignItems: 'center',
              }}
            >
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  letterSpacing: 1,
                  textTransform: 'uppercase',
                  color: 'var(--fg-muted)',
                  marginRight: 4,
                }}
              >
                Warehouse
              </span>
              <WarehouseChip
                label="All"
                active={!warehouseId}
                href={(() => {
                  const qs = new URLSearchParams();
                  qs.set('view', 'lots');
                  if (categorySlugs.length > 0) qs.set('category', categorySlugs.join(','));
                  if (conditions.length > 0) qs.set('condition', conditions.join(','));
                  if (sp.price_min) qs.set('price_min', sp.price_min);
                  if (sp.price_max) qs.set('price_max', sp.price_max);
                  if (sort !== 'ending-soon') qs.set('sort', sort);
                  if (searchQuery) qs.set('q', searchQuery);
      if (cityFilter) qs.set('city', cityFilter);
                  return `/browse?${qs.toString()}`;
                })()}
              />
              {warehouseOptions.map((w) => {
                const qs = new URLSearchParams();
                qs.set('view', 'lots');
                if (categorySlugs.length > 0) qs.set('category', categorySlugs.join(','));
                if (conditions.length > 0) qs.set('condition', conditions.join(','));
                if (sp.price_min) qs.set('price_min', sp.price_min);
                if (sp.price_max) qs.set('price_max', sp.price_max);
                if (sort !== 'ending-soon') qs.set('sort', sort);
                if (searchQuery) qs.set('q', searchQuery);
      if (cityFilter) qs.set('city', cityFilter);
                qs.set('warehouse', w.id);
                return (
                  <WarehouseChip
                    key={w.id}
                    label={w.name}
                    active={warehouseId === w.id}
                    href={`/browse?${qs.toString()}`}
                  />
                );
              })}
            </div>
          )}

          {/* Mobile filter trigger */}
          <div className="browse-mobile-filter-row" style={{ marginBottom: '1rem' }}>
            <FilterRail
              categories={allCategories}
              selectedCategories={categorySlugs}
              selectedConditions={conditions}
              priceMin={sp.price_min ? parseFloat(sp.price_min) : null}
              priceMax={sp.price_max ? parseFloat(sp.price_max) : null}
              sort={sort}
              conditionCounts={counts.byCondition}
              resultCount={total}
            />
          </div>

          {/* Two-column layout */}
          <div
            className="browse-layout"
            style={{ display: 'flex', gap: '1.75rem', alignItems: 'flex-start' }}
          >
            {/* Desktop sidebar */}
            <div className="browse-sidebar">
              <FilterRail
                categories={allCategories}
                selectedCategories={categorySlugs}
                selectedConditions={conditions}
                priceMin={sp.price_min ? parseFloat(sp.price_min) : null}
                priceMax={sp.price_max ? parseFloat(sp.price_max) : null}
                sort={sort}
                conditionCounts={counts.byCondition}
              resultCount={total}
              />
            </div>

            {/* Lot grid */}
            <main style={{ flex: 1, minWidth: 0 }}>
              {/* Toolbar: count + always-visible sort (2026-07-05 bidder-QoL —
                  sort used to hide at the bottom of the Filters panel). */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '0.75rem',
                  flexWrap: 'wrap',
                  marginBottom: '1.25rem',
                }}
              >
                <p style={{ color: 'var(--fg-muted)', fontSize: 14, margin: 0 }}>
                  {total === 0 ? 'No lots found' : `${total} lot${total === 1 ? '' : 's'}`}
                </p>
                <SortSelect sort={sort} />
              </div>

              {lots.length === 0 ? (
                <LotsEmptyState />
              ) : (
                <div
                  className="lot-grid"
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
                    gap: '1.1rem',
                  }}
                >
                  {lots.map((lot, lotIdx) => (
                    <LotCard
                      key={lot.id}
                      hrefQuery={lotHrefQuery(lotIdx)}
                      initialWatched={watchedIds.has(lot.id)}
                      lot={{
                        id: lot.id,
                        lot_code: lot.lot_code,
                        title: lot.title,
                        photo_urls: lot.photo_urls,
                        current_bid_cents: lot.current_bid_cents,
                        starting_bid_cents: lot.starting_bid_cents,
                        close_at: lot.close_at,
                        bid_count: lot.bid_count,
                        // Preview-B: thread lifecycle status so scheduled lots
                        // render the static "Upcoming" pill instead of a live
                        // ticking countdown. Live/absent status is unchanged.
                        status: lot.status,
                        condition:
                          (lot as unknown as Record<string, unknown>).condition as string | null ?? null,
                        msrp_cents:
                          (lot as unknown as Record<string, unknown>).msrp_cents as number | null ?? null,
                      }}
                    />
                  ))}
                </div>
              )}

              {pageCount > 1 && (
                <BrowsePaginator
                  page={page}
                  pageCount={pageCount}
                  hrefFn={lotsPaginationHref}
                />
              )}
            </main>
          </div>
        </div>

        <style>{`
          .browse-sidebar { display: none !important; }
          .browse-mobile-filter-row { display: block; }
          @media (min-width: 769px) {
            .browse-sidebar { display: block !important; }
            .browse-mobile-filter-row { display: none !important; }
          }
        `}</style>
      </div>
    );
  }

  // ── Auctions mode (default) ───────────────────────────────────────────────
  const cityFilter = sp.city && sp.city !== 'all' ? sp.city.trim() : null;
  const { auctions, total } = await loadAuctions(page, cityFilter);
  // Issue 5: show recently-closed auctions (Results) on the first page only.
  const recentlyClosed = page === 1 ? await loadRecentlyClosed(cityFilter) : [];
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // Auto-flip auction cards (Upcoming→Live, Live→Results) without a manual reload
  // when the clock crosses a start/close boundary — the RSC badges are computed
  // once at request time on CF Workers, so a left-open tab went stale (2026-06-19).
  const auctionBoundaries = auctions.flatMap((a) => {
    const close = a.last_lot_ends_at ?? a.ends_at;
    return [
      a.starts_at ? new Date(a.starts_at).getTime() : null,
      close ? new Date(close).getTime() : null,
    ];
  });

  return (
    <div style={{ padding: '3rem 1.5rem 5rem' }}>
      <BrowseAutoRefresh intervalMs={0} boundaries={auctionBoundaries} />
      <div style={{ maxWidth: MAX_W, margin: '0 auto' }}>
        <BrowseHeader lotsMode={false} />
        <OffsiteSaleButtons />

        <p style={{ color: 'var(--fg-muted)', fontSize: '1.05rem', maxWidth: 620, marginBottom: '2rem' }}>
          {total === 0
            ? "No auctions are open right now. New auctions go live every week — check back soon."
            : `${total} active auction${total === 1 ? '' : 's'} on BinGo Auctions.`}
        </p>

        {auctions.length === 0 ? (
          <AuctionsEmptyState />
        ) : (
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
              gap: '1.25rem',
            }}
          >
            {auctions.map((auction) => (
              <PublicAuctionCard key={auction.id} auction={auction} />
            ))}
          </div>
        )}

        {pageCount > 1 && (
          <BrowsePaginator
            page={page}
            pageCount={pageCount}
            hrefFn={(p) => (p === 1 ? '/browse?view=auctions' : `/browse?view=auctions&page=${p}`)}
          />
        )}

        {/* Issue 5: recently-closed auctions ("Results"). Lets bidders find an
            auction that just ended (e.g. Test Auction.4) instead of it silently
            vanishing from the live list. Each card carries a "Results" badge and
            still links to /auction/[id], which renders closed auctions (#175). */}
        {recentlyClosed.length > 0 && (
          <section style={{ marginTop: '3rem' }}>
            <h2 style={{ fontSize: '1.2rem', fontWeight: 800, marginBottom: '0.35rem' }}>
              Recently closed
            </h2>
            <p style={{ color: 'var(--fg-muted)', fontSize: '0.95rem', marginBottom: '1.25rem' }}>
              These auctions have ended — view results and won lots.
            </p>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                gap: '1.25rem',
              }}
            >
              {recentlyClosed.map((auction) => (
                <PublicAuctionCard key={auction.id} auction={auction} />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function BrowseHeader({ lotsMode }: { lotsMode: boolean }) {
  return (
    <div style={{ marginBottom: '1.75rem' }}>
      <h1
        style={{
          fontSize: 'clamp(2rem, 4.5vw, 3rem)',
          fontWeight: 900,
          letterSpacing: -1.5,
          marginBottom: '1rem',
        }}
      >
        Browse
      </h1>

      {/* Auctions | Lots tab toggle */}
      <div
        role="tablist"
        aria-label="Browse mode"
        style={{
          display: 'inline-flex',
          background: 'var(--bg-elev)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: 3,
          gap: 2,
        }}
      >
        <Link
          href="/browse?view=auctions"
          role="tab"
          aria-selected={!lotsMode}
          style={{
            padding: '0.45rem 1.1rem',
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 700,
            textDecoration: 'none',
            background: !lotsMode ? 'var(--accent)' : 'transparent',
            color: !lotsMode ? '#000' : 'var(--fg-muted)',
            transition: 'background 0.12s ease, color 0.12s ease',
          }}
        >
          Auctions
        </Link>
        <Link
          href="/browse?view=lots"
          role="tab"
          aria-selected={lotsMode}
          style={{
            padding: '0.45rem 1.1rem',
            borderRadius: 6,
            fontSize: 13,
            fontWeight: 700,
            textDecoration: 'none',
            background: lotsMode ? 'var(--accent)' : 'transparent',
            color: lotsMode ? '#000' : 'var(--fg-muted)',
            transition: 'background 0.12s ease, color 0.12s ease',
          }}
        >
          Lots
        </Link>
      </div>
    </div>
  );
}

function AuctionsEmptyState() {
  return (
    <div
      style={{
        background: 'var(--bg-elev-2)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        padding: '3rem 1.5rem',
        textAlign: 'center',
      }}
    >
      <div style={{ fontSize: 36, marginBottom: 8 }}>&#128270;</div>
      <h2 style={{ fontSize: '1.25rem', fontWeight: 800, marginBottom: 8 }}>
        No auctions are running right now.
      </h2>
      <p style={{ color: 'var(--fg-muted)', maxWidth: 480, margin: '0 auto 1.5rem' }}>
        BinGo Auctions operators run new auctions every week. Get the app and we&apos;ll notify you when
        a new auction goes live in your area.
      </p>
      <Link
        href="/download"
        className="btn-primary"
        style={{ padding: '0.75rem 1.5rem', display: 'inline-block' }}
      >
        Get the app
      </Link>
    </div>
  );
}

function LotsEmptyState() {
  return (
    <div
      style={{
        background: 'var(--bg-elev-2)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        padding: '3.5rem 1.5rem',
        textAlign: 'center',
      }}
    >
      <img
        src="/art/empty-search.webp"
        alt=""
        width={220}
        height={165}
        style={{ maxWidth: '100%', height: 'auto', borderRadius: 12, marginBottom: 16 }}
      />
      <h2 style={{ fontSize: '1.2rem', fontWeight: 800, marginBottom: 8 }}>
        No lots match right now.
      </h2>
      <p style={{ color: 'var(--fg-muted)', maxWidth: 460, margin: '0 auto 1.5rem' }}>
        Nothing live matches these filters at the moment — new lots are added every
        day. Clear your filters, browse by category, or check the lots ending soonest.
      </p>
      {/* Real destinations only. The old "Browse all auctions" CTA pointed at
          ?view=auctions, which is itself empty whenever lots are — a dead end.
          The homepage category grid and Final Call are always navigable. */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '0.75rem',
          justifyContent: 'center',
        }}
      >
        <Link
          href="/"
          className="btn-primary"
          style={{ padding: '0.7rem 1.4rem', display: 'inline-block' }}
        >
          Browse all categories
        </Link>
        <Link
          href="/final-call"
          className="btn-secondary"
          style={{ padding: '0.7rem 1.4rem', display: 'inline-block' }}
        >
          See lots ending soon
        </Link>
      </div>
    </div>
  );
}

/** S5a — Warehouse chip. Link-based so it works in a server component. */
function WarehouseChip({
  label,
  active,
  href,
}: {
  label: string;
  active: boolean;
  href: string;
}) {
  return (
    <Link
      href={href}
      style={{
        padding: '0.35rem 0.9rem',
        borderRadius: 999,
        fontSize: 12,
        fontWeight: 700,
        textDecoration: 'none',
        border: '1px solid',
        borderColor: active ? 'var(--accent)' : 'var(--border)',
        background: active ? 'var(--accent)' : 'transparent',
        color: active ? '#000' : 'var(--fg-muted)',
        transition: 'background 0.12s ease, color 0.12s ease',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </Link>
  );
}

// Windowed page numbers: 1 … p-2 p-1 [p] p+1 p+2 … last. `null` = ellipsis.
function pageWindow(page: number, pageCount: number): Array<number | null> {
  const wanted = new Set<number>([1, pageCount]);
  for (let n = page - 2; n <= page + 2; n++) {
    if (n >= 1 && n <= pageCount) wanted.add(n);
  }
  const sorted = Array.from(wanted).sort((a, b) => a - b);
  const out: Array<number | null> = [];
  let prev = 0;
  for (const n of sorted) {
    if (prev && n - prev > 1) out.push(null);
    out.push(n);
    prev = n;
  }
  return out;
}

// Customer report 2026-07-09: "Page 1 of 101" with only Prev/Next — getting
// back to page ~50 meant tapping Next dozens of times. Now: First/Last,
// numbered pages around the current one, and a go-to-page box on big lists.
function BrowsePaginator({
  page,
  pageCount,
  hrefFn,
}: {
  page: number;
  pageCount: number;
  hrefFn: (page: number) => string;
}) {
  const prev = Math.max(1, page - 1);
  const next = Math.min(pageCount, page + 1);

  const edgeBtn = (disabled: boolean): React.CSSProperties => ({
    padding: '0.5rem 0.85rem',
    fontSize: 13,
    opacity: disabled ? 0.5 : 1,
    pointerEvents: disabled ? 'none' : 'auto',
  });
  const numBtn = (active: boolean): React.CSSProperties => ({
    minWidth: 36,
    textAlign: 'center',
    padding: '0.5rem 0.55rem',
    fontSize: 13,
    fontWeight: active ? 800 : 500,
    borderRadius: 8,
    textDecoration: 'none',
    border: '1px solid',
    borderColor: active ? 'var(--accent)' : 'var(--border)',
    background: active ? 'var(--accent)' : 'transparent',
    color: active ? '#000' : 'var(--fg-muted)',
    pointerEvents: active ? 'none' : 'auto',
  });

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: '0.75rem',
        marginTop: '2.5rem',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '0.4rem',
        }}
      >
        <Link href={hrefFn(1)} aria-disabled={page === 1} aria-label="First page" className="btn-secondary" style={edgeBtn(page === 1)}>
          «
        </Link>
        <Link href={hrefFn(prev)} aria-disabled={page === 1} aria-label="Previous page" className="btn-secondary" style={edgeBtn(page === 1)}>
          ‹ Prev
        </Link>
        {pageWindow(page, pageCount).map((n, i) =>
          n === null ? (
            <span key={`gap-${i}`} style={{ color: 'var(--fg-muted)', fontSize: 13, padding: '0 0.15rem' }}>
              …
            </span>
          ) : (
            <Link
              key={n}
              href={hrefFn(n)}
              aria-current={n === page ? 'page' : undefined}
              style={numBtn(n === page)}
            >
              {n}
            </Link>
          ),
        )}
        <Link href={hrefFn(next)} aria-disabled={page === pageCount} aria-label="Next page" className="btn-secondary" style={edgeBtn(page === pageCount)}>
          Next ›
        </Link>
        <Link href={hrefFn(pageCount)} aria-disabled={page === pageCount} aria-label="Last page" className="btn-secondary" style={edgeBtn(page === pageCount)}>
          »
        </Link>
      </div>
      {pageCount > 7 && <GoToPage pageCount={pageCount} baseHref={hrefFn(1)} />}
    </div>
  );
}
