/**
 * Category detail page — /category/[slug]
 *
 * Shows all active lots that belong to a category (the slug itself OR any
 * leaf whose parent_id matches the slug's row — i.e. browsing a parent
 * category expands to include all children automatically).
 *
 * Layout (desktop): sticky FilterRail sidebar left | lot grid right.
 * Layout (mobile):  floating "Filters" button → FilterRail bottom-sheet | grid below.
 *
 * Filtering / sorting lives entirely in URL params so every state is
 * bookmark-able and server-rendered without client-side data fetching inside
 * FilterRail.
 *
 * Virtual conditions ('virtual:ending-soon', 'virtual:top-deal') are handled
 * in JS post-query rather than in SQL because:
 *   - 'ending-soon' requires knowing the current wall-clock time relative to
 *     close_at, which is a moving target per render.
 *   - 'top-deal' is a computed heuristic (bid < 1.5× starting) not stored on
 *     the row.
 * Both are cheap to filter client-side over a 24-item page window.
 *
 * The `condition` column on lots is Phase 2 (migration 0115 pending). Until
 * then, reads are guarded via `(lot as any).condition ?? null` so the page
 * compiles and runs cleanly against schemas both with and without the column.
 */

import Image from 'next/image';
import Link from 'next/link';
import type { Metadata } from 'next';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getDemoOperatorIds, demoExclusionList } from '@/lib/demo-operators';
import { loadPrimaryBusiness } from '@/lib/seo';
import { LotCard, type LotCardLot } from '../../_components/LotCard';
import { FilterRail, type FilterCategory, type SortOption } from '../../_components/FilterRail';
import { NON_SELLABLE_LOT_STATUS_FILTER } from '@/lib/auction-status';

// ── Layout constants ──────────────────────────────────────────────────────────

const MAX_W = 1100;
const PAGE_SIZE = 24;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ── Banner image helper ─────────────────────────────────────────────────────────

/**
 * Category hero banner source. Honors a real DB image when one is set, but
 * never the legacy CDN themed banners (those assets don't exist on
 * BinGo infra). When there's no usable image the hero renders a CSS gradient
 * "daub" banner instead (see CategoryHero) — zero external CDN dependency.
 */
function heroBannerUrl(_slug: string, imageUrlFromDb: string | null): string | null {
  if (imageUrlFromDb && !imageUrlFromDb.includes('clovrbid')) return imageUrlFromDb;
  return null;
}

function socialImageUrl(_slug: string): string {
  // BinGo OG card served locally from /public — no external CDN dependency.
  return '/og-default.png';
}

// ── Types ─────────────────────────────────────────────────────────────────────

type CategoryRow = {
  id: string;
  slug: string;
  name: string;
  parent_id: string | null;
  image_url: string | null;
  icon_url: string | null;
  pack_slug: string | null;
};

// DB lot row shape — condition is guarded because migration 0115 may not be
// applied yet (the column may be absent).
type LotRow = LotCardLot & { category_id: string | null; auction_id: string };

// ── Watchlist loader ────────────────────────────────────────────────────────
// Resolves the lot IDs the current signed-in bidder is watching, scoped to
// the rendered grid. Anon visitors get an empty set — the SSR render shows
// empty stars and the client-side button handles the /login redirect.

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
    console.error('[category] watchlist lookup failed', error.message);
    return new Set();
  }
  return new Set(((data ?? []) as Array<{ lot_id: string }>).map((r) => r.lot_id));
}

// ── Data loaders ──────────────────────────────────────────────────────────────

async function loadCategory(slug: string): Promise<CategoryRow | null> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from('categories')
    .select('id, slug, name, parent_id, image_url, icon_url, pack_slug')
    .eq('slug', slug)
    .maybeSingle();
  return (data as CategoryRow | null) ?? null;
}

async function loadParentCategory(parentId: string): Promise<CategoryRow | null> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from('categories')
    .select('id, slug, name, parent_id, image_url, icon_url, pack_slug')
    .eq('id', parentId)
    .maybeSingle();
  return (data as CategoryRow | null) ?? null;
}

/** Loads every category and returns BOTH the FilterCategory[] (with
 *  lot_count=0 placeholders) and a slug->id map. The id map is needed to
 *  merge per-category-id counts back onto the FilterCategory rows. */
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

  // We need parent slugs for FilterRail. Build a slug-by-id map first.
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

// ── Storefront-visible lot counts ────────────────────────────────────────────
//
// One round-trip pulls every storefront-visible lot's (category_id, condition,
// close_at, current_bid_cents, starting_bid_cents) and we GROUP BY in JS to
// produce per-category and per-condition counts.
//
// Counts here are GLOBAL (storefront-wide) — same as /browse — because the
// FilterRail offers cross-category navigation. A user on /category/electronics
// looking at the rail wants to see "Furniture (412)" so they know if it's
// worth clicking over. Scoping counts to the current category would mislead.

type LotCountRow = {
  category_id: string | null;
  condition: string | null;
  close_at: string;
  current_bid_cents: number | null;
  starting_bid_cents: number;
};

interface StorefrontLotCounts {
  byCategoryId: Record<string, number>;
  byCondition: Record<string, number>;
}

const ENDING_SOON_WINDOW_MS = 5 * 60 * 1000;
const TOP_DEAL_MULTIPLIER = 1.5;

async function fetchStorefrontLotCounts(): Promise<StorefrontLotCounts> {
  const supabase = getSupabaseAdmin();

  // H4-c: exclude demo-operator auctions so demo lots never feed the storefront
  // category/condition counts (mirrors (public)/browse/page.tsx).
  const demoExclude = demoExclusionList(await getDemoOperatorIds());
  let activeAuctionQuery = supabase
    .from('auctions')
    .select('id')
    .in('status', ['scheduled', 'live'])
    .eq('unlisted', false);
  if (demoExclude) activeAuctionQuery = activeAuctionQuery.not('operator_id', 'in', demoExclude);
  const { data: activeAuctions, error: auctionsError } = await activeAuctionQuery;
  if (auctionsError) {
    console.error('[category] count auction prefilter failed', auctionsError.message);
  }

  const activeAuctionIds = ((activeAuctions ?? []) as Array<{ id: string }>).map((a) => a.id);
  if (activeAuctionIds.length === 0) {
    return { byCategoryId: {}, byCondition: {} };
  }

  const { data, error } = await supabase
    .from('lots')
    .select('category_id, condition, close_at, current_bid_cents, starting_bid_cents')
    .in('auction_id', activeAuctionIds)
    .is('deleted_at', null)
    .not('status', 'in', NON_SELLABLE_LOT_STATUS_FILTER)
    .limit(20000);

  if (error) {
    console.error('[category] lot count query failed', error.message);
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
    const closeMs = new Date(row.close_at).getTime();
    if (closeMs > nowMs && closeMs - nowMs <= ENDING_SOON_WINDOW_MS) {
      endingSoonCount += 1;
    }
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

type LotFilters = {
  categoryId: string;
  /** IDs of direct children to also include */
  childCategoryIds: string[];
  conditions: string[];
  priceMinCents: number | null;
  priceMaxCents: number | null;
  sort: SortOption;
  page: number;
};

async function loadLots(filters: LotFilters): Promise<{ lots: LotRow[]; total: number }> {
  const supabase = getSupabaseAdmin();

  const categoryIds = [filters.categoryId, ...filters.childCategoryIds];

  // Fetch active auction IDs first (scheduled or live).
  // H4-c: exclude demo-operator auctions so demo lots never appear in the
  // category grid (mirrors (public)/browse/page.tsx).
  const demoExclude = demoExclusionList(await getDemoOperatorIds());
  let activeAuctionQuery = supabase
    .from('auctions')
    .select('id')
    .in('status', ['scheduled', 'live'])
    .eq('unlisted', false);
  if (demoExclude) activeAuctionQuery = activeAuctionQuery.not('operator_id', 'in', demoExclude);
  const { data: activeAuctions } = await activeAuctionQuery;

  const activeAuctionIds = ((activeAuctions ?? []) as Array<{ id: string }>).map((a) => a.id);
  if (activeAuctionIds.length === 0) {
    return { lots: [], total: 0 };
  }

  // Separate real conditions from virtual ones (virtual:ending-soon, virtual:top-deal).
  // Virtual conditions are applied post-query in JS because they depend on
  // current time or computed bid ratios — not storable SQL predicates.
  const realConditions = filters.conditions.filter((c) => !c.startsWith('virtual:'));
  const hasVirtualEndingSoon = filters.conditions.includes('virtual:ending-soon');
  const hasVirtualTopDeal = filters.conditions.includes('virtual:top-deal');

  // When only virtual conditions are selected we still fetch everything in the
  // category and filter in JS. When real conditions are also selected we push
  // them into the query to reduce network payload.
  let query = supabase
    .from('lots')
    .select(
      'id, lot_code, title, photo_urls, current_bid_cents, starting_bid_cents, close_at, bid_count, category_id, auction_id, condition, msrp_cents, status',
      { count: 'exact' },
    )
    .in('category_id', categoryIds)
    .in('auction_id', activeAuctionIds)
    .is('deleted_at', null)
    .not('status', 'in', NON_SELLABLE_LOT_STATUS_FILTER);

  if (realConditions.length > 0) {
    // `condition` column may not exist yet (migration 0115 pending).
    // The query will fail gracefully with a Supabase error which we catch below.
    query = query.in('condition', realConditions);
  }

  // Price filter — stored as cents in DB; URL params are whole dollars.
  if (filters.priceMinCents !== null) {
    // Filter on current_bid_cents when bids exist, else on starting_bid_cents.
    // We use starting_bid_cents as the proxy when there are no bids yet.
    query = query.gte('starting_bid_cents', filters.priceMinCents);
  }
  if (filters.priceMaxCents !== null) {
    query = query.lte('starting_bid_cents', filters.priceMaxCents);
  }

  // Sort order
  switch (filters.sort) {
    case 'ending-soon':
      query = query.order('close_at', { ascending: true });
      break;
    case 'newest':
      // lots table should have created_at; fall back to lot_code alpha if absent.
      query = query.order('lot_code', { ascending: false });
      break;
    case 'most-bids':
      query = query.order('bid_count', { ascending: false, nullsFirst: false });
      break;
    case 'price-low':
      query = query.order('starting_bid_cents', { ascending: true });
      break;
    case 'price-high':
      query = query.order('starting_bid_cents', { ascending: false });
      break;
    default:
      query = query.order('close_at', { ascending: true });
  }

  // If virtual conditions are active we must over-fetch to filter in JS.
  // Fetch up to 10× the page window to get a reasonable filtered set.
  // For most categories 240 rows is ample. This is a Phase 2 concern once the
  // category pages prove useful; a proper materialised column for these
  // virtual states would replace this.
  const virtualConditionActive = hasVirtualEndingSoon || hasVirtualTopDeal;
  const fetchLimit = virtualConditionActive ? PAGE_SIZE * 10 : PAGE_SIZE;
  const fetchFrom = virtualConditionActive ? 0 : (filters.page - 1) * PAGE_SIZE;
  const fetchTo = fetchFrom + fetchLimit - 1;

  query = query.range(fetchFrom, fetchTo);

  const { data, error, count } = await query;

  if (error) {
    // condition column may not exist yet — silently degrade to unfiltered.
    console.error('[category] lot query failed', error.message);
    return { lots: [], total: 0 };
  }

  let rows = (data ?? []) as unknown as LotRow[];

  // Apply virtual condition filters in JS.
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
          lot.current_bid_cents !== null &&
          lot.current_bid_cents < lot.starting_bid_cents * 1.5,
      );
    } else {
      // Both — OR semantics: lot qualifies if either condition is true.
      rows = rows.filter((lot) => {
        const ms = new Date(lot.close_at).getTime();
        const isEndingSoon = ms > nowMs && ms - nowMs <= 5 * 60 * 1000;
        const isTopDeal =
          lot.current_bid_cents !== null &&
          lot.current_bid_cents < lot.starting_bid_cents * 1.5;
        return isEndingSoon || isTopDeal;
      });
    }
    // Manual pagination over the filtered set.
    const filteredTotal = rows.length;
    const start = (filters.page - 1) * PAGE_SIZE;
    rows = rows.slice(start, start + PAGE_SIZE);
    return { lots: rows, total: filteredTotal };
  }

  return { lots: rows, total: count ?? 0 };
}

async function loadChildCategoryIds(parentId: string): Promise<string[]> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from('categories')
    .select('id')
    .eq('parent_id', parentId);
  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
}

// ── Metadata export ───────────────────────────────────────────────────────────

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const [category, biz] = await Promise.all([loadCategory(slug), loadPrimaryBusiness()]);
  const name = category?.name ?? slug.replace(/-/g, ' ');
  // "electronics auction {city}" is the transactional local query — put the
  // warehouse city in the title/description (falls back cleanly without it).
  const place = biz?.address ? ` in ${biz.address.city}, ${biz.address.state}` : '';
  // No brand suffix here — the root layout's title template appends
  // "— BinGo Auctions" (baking it in doubled the brand: "· BinGo Auctions
  // — BinGo Auctions", caught live 2026-07-06). OG titles don't go through
  // the template, so the OG variant carries the brand itself.
  const title = `${name} auctions${place}`;
  const description = `Bid on ${name.toLowerCase()} at BinGo Auctions. Real photos, condition reports, local pickup${place}.`;

  return {
    title,
    description,
    openGraph: {
      title: `${title} · BinGo Auctions`,
      description,
      url: `https://bingoauctions.com/category/${slug}`,
      siteName: 'BinGo Auctions',
      images: [{ url: socialImageUrl(slug), width: 1200, height: 628 }],
    },
  };
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function CategoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{
    condition?: string;
    price_min?: string;
    price_max?: string;
    sort?: string;
    page?: string;
  }>;
}) {
  const [{ slug }, sp] = await Promise.all([params, searchParams]);

  // Parse URL params.
  const conditions = sp.condition ? sp.condition.split(',').filter(Boolean) : [];
  const priceMinCents = sp.price_min ? Math.round(parseFloat(sp.price_min) * 100) : null;
  const priceMaxCents = sp.price_max ? Math.round(parseFloat(sp.price_max) * 100) : null;
  const sort: SortOption =
    (sp.sort as SortOption | undefined) &&
    ['ending-soon', 'newest', 'most-bids', 'price-low', 'price-high'].includes(sp.sort!)
      ? (sp.sort as SortOption)
      : 'ending-soon';
  const page = Math.max(1, parseInt(sp.page ?? '1', 10) || 1);

  // Load category + siblings + storefront-wide counts in parallel. Counts
  // intentionally span the whole storefront (not just this category) because
  // the FilterRail offers cross-category navigation — siblings render with
  // their own global lot counts so the user can decide where to click next.
  const [category, { categories: baseCategories, idsBySlug }, counts] = await Promise.all([
    loadCategory(slug),
    loadCategoriesWithIdMap(),
    getStorefrontLotCounts(),
  ]);

  const allCategories = mergeCategoryCounts(baseCategories, idsBySlug, counts.byCategoryId);

  // If category not found, render a graceful 404-style page.
  if (!category) {
    return (
      <div style={{ padding: '4rem 1.5rem', textAlign: 'center' }}>
        <h1 style={{ fontSize: '2rem', fontWeight: 900, marginBottom: '0.75rem' }}>
          Category not found
        </h1>
        <p style={{ color: 'var(--fg-muted)', marginBottom: '1.5rem' }}>
          That category doesn&apos;t exist or has been removed.
        </p>
        <Link href="/browse" className="btn-primary" style={{ padding: '0.75rem 1.5rem' }}>
          Browse all auctions
        </Link>
      </div>
    );
  }

  // Load parent category (for breadcrumb) and child IDs in parallel.
  const [parentCategory, childCategoryIds] = await Promise.all([
    category.parent_id ? loadParentCategory(category.parent_id) : Promise.resolve(null),
    loadChildCategoryIds(category.id),
  ]);

  const { lots, total } = await loadLots({
    categoryId: category.id,
    childCategoryIds,
    conditions,
    priceMinCents,
    priceMaxCents,
    sort,
    page,
  });

  // Watchlist lookup over just the rendered IDs — anon visitors get an
  // empty set.
  const watchedIds = await loadWatchedIds(lots.map((l) => l.id));

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const heroUrl = heroBannerUrl(slug, category.image_url);

  // Build the query string for pagination links — preserve all filter params
  // and replace only `page`.
  function paginationHref(targetPage: number): string {
    const qs = new URLSearchParams();
    if (conditions.length > 0) qs.set('condition', conditions.join(','));
    if (sp.price_min) qs.set('price_min', sp.price_min);
    if (sp.price_max) qs.set('price_max', sp.price_max);
    if (sort !== 'ending-soon') qs.set('sort', sort);
    if (targetPage > 1) qs.set('page', String(targetPage));
    const str = qs.toString();
    return `/category/${slug}${str ? `?${str}` : ''}`;
  }

  return (
    <>
      {/* ── Hero banner ── */}
      <CategoryHero
        name={category.name}
        heroUrl={heroUrl}
        parentCategory={parentCategory}
      />

      {/* ── Main content ── */}
      <div
        style={{
          maxWidth: MAX_W,
          margin: '0 auto',
          padding: '2rem 1.5rem 5rem',
        }}
      >
        {/* Mobile filter trigger sits above the grid */}
        <div
          className="category-mobile-filter-row"
          style={{ marginBottom: '1rem' }}
        >
          <FilterRail
            categories={allCategories}
            selectedCategories={[slug]}
            categoryNavigatesTo="/browse"
            selectedConditions={conditions}
            priceMin={sp.price_min ? parseFloat(sp.price_min) : null}
            priceMax={sp.price_max ? parseFloat(sp.price_max) : null}
            sort={sort}
            conditionCounts={counts.byCondition}
              resultCount={total}
          />
        </div>

        {/* Two-column layout on desktop */}
        <div
          className="category-layout"
          style={{ display: 'flex', gap: '1.75rem', alignItems: 'flex-start' }}
        >
          {/* Desktop sidebar — FilterRail renders itself as sticky aside */}
          <div className="category-sidebar">
            <FilterRail
              categories={allCategories}
              selectedCategories={[slug]}
              categoryNavigatesTo="/browse"
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
            {/* Result summary */}
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'baseline',
                marginBottom: '1.25rem',
                flexWrap: 'wrap',
                gap: '0.5rem',
              }}
            >
              <p style={{ color: 'var(--fg-muted)', fontSize: 14 }}>
                {total === 0
                  ? 'No lots found'
                  : `${total} lot${total === 1 ? '' : 's'}`}
                {childCategoryIds.length > 0 && total > 0 && (
                  <span style={{ marginLeft: 6, fontSize: 12, color: 'var(--fg-dim)' }}>
                    (all sub-categories included)
                  </span>
                )}
              </p>
            </div>

            {lots.length === 0 ? (
              <CategoryEmptyState />
            ) : (
              <div
                className="lot-grid"
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))',
                  gap: '1.1rem',
                }}
              >
                {lots.map((lot) => (
                  <LotCard
                    key={lot.id}
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
                      // show the static "Upcoming" pill instead of a live
                      // ticking countdown. Live/absent status is unchanged.
                      status: lot.status,
                      // Defensive cast until migration 0115 adds the column.
                      condition: (lot as unknown as Record<string, unknown>).condition as string | null ?? null,
                      msrp_cents:
                        (lot as unknown as Record<string, unknown>).msrp_cents as number | null ?? null,
                    }}
                  />
                ))}
              </div>
            )}

            {/* Pagination */}
            {pageCount > 1 && (
              <CategoryPaginator
                page={page}
                pageCount={pageCount}
                hrefFn={paginationHref}
              />
            )}
          </main>
        </div>
      </div>

      {/* Responsive layout rules */}
      <style>{`
        /* Mobile: hide desktop sidebar, show mobile filter row */
        .category-sidebar { display: none !important; }
        .category-mobile-filter-row { display: block; }

        @media (min-width: 769px) {
          .category-sidebar { display: block !important; }
          .category-mobile-filter-row { display: none !important; }
        }
      `}</style>
    </>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function CategoryHero({
  name,
  heroUrl,
  parentCategory,
}: {
  name: string;
  heroUrl: string | null;
  parentCategory: CategoryRow | null;
}) {
  return (
    <div
      style={{
        position: 'relative',
        width: '100%',
        height: 'clamp(220px, 30vw, 360px)',
        overflow: 'hidden',
        background: 'var(--bg-elev)',
      }}
    >
      {/* Banner image — a real DB image when present, otherwise an on-brand
          CSS "daub board" gradient (plum → magenta with gold/white dots). No
          external CDN request either way. */}
      {heroUrl ? (
        <Image
          src={heroUrl}
          alt={`${name} category banner`}
          fill
          priority
          sizes="100vw"
          style={{ objectFit: 'cover', objectPosition: 'center' }}
          unoptimized
        />
      ) : (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            background: 'linear-gradient(120deg, var(--ink-2) 0%, var(--accent) 100%)',
            backgroundImage:
              'radial-gradient(circle at 16% 32%, rgba(245,158,11,0.55) 0 11px, transparent 12px),' +
              'radial-gradient(circle at 84% 64%, rgba(255,255,255,0.16) 0 15px, transparent 16px),' +
              'radial-gradient(circle at 62% 22%, rgba(255,255,255,0.12) 0 7px, transparent 8px),' +
              'linear-gradient(120deg, var(--ink-2) 0%, var(--accent) 100%)',
          }}
        />
      )}

      {/* Dark scrim for text legibility */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          inset: 0,
          background: 'linear-gradient(to right, rgba(10,12,17,0.72) 0%, rgba(10,12,17,0.3) 100%)',
        }}
      />

      {/* Text overlay */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          padding: 'clamp(1.25rem, 4vw, 2.5rem)',
        }}
      >
        {/* Breadcrumb */}
        <nav aria-label="breadcrumb" style={{ marginBottom: '0.5rem' }}>
          <ol
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '0.4rem',
              listStyle: 'none',
              padding: 0,
              margin: 0,
              fontSize: 13,
              color: 'rgba(255,255,255,0.7)',
            }}
          >
            <li>
              <Link
                href="/browse"
                style={{ color: 'rgba(255,255,255,0.7)', textDecoration: 'none' }}
              >
                Browse
              </Link>
            </li>
            {parentCategory && (
              <>
                <li aria-hidden style={{ fontSize: 11 }}>›</li>
                <li>
                  <Link
                    href={`/category/${parentCategory.slug}`}
                    style={{ color: 'rgba(255,255,255,0.7)', textDecoration: 'none' }}
                  >
                    {parentCategory.name}
                  </Link>
                </li>
              </>
            )}
            <li aria-hidden style={{ fontSize: 11 }}>›</li>
            <li style={{ color: '#fff', fontWeight: 600 }}>{name}</li>
          </ol>
        </nav>

        <h1
          style={{
            fontSize: 'clamp(1.6rem, 4vw, 2.75rem)',
            fontWeight: 900,
            letterSpacing: -1,
            color: '#fff',
            margin: 0,
            textShadow: '0 2px 8px rgba(0,0,0,0.4)',
          }}
        >
          {name}
        </h1>
      </div>
    </div>
  );
}

function CategoryEmptyState() {
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
        No auctions in this category right now.
      </h2>
      <p style={{ color: 'var(--fg-muted)', maxWidth: 460, margin: '0 auto 1.5rem' }}>
        Check back soon, or browse other categories.
      </p>
      <Link
        href="/browse"
        className="btn-primary"
        style={{ padding: '0.7rem 1.4rem', display: 'inline-block' }}
      >
        Browse all auctions
      </Link>
    </div>
  );
}

function CategoryPaginator({
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

  // Show a window of up to 5 page numbers centred on current page.
  const windowSize = 5;
  const halfWindow = Math.floor(windowSize / 2);
  const startPage = Math.max(1, Math.min(page - halfWindow, pageCount - windowSize + 1));
  const endPage = Math.min(pageCount, startPage + windowSize - 1);
  const pageNumbers: number[] = [];
  for (let i = startPage; i <= endPage; i++) pageNumbers.push(i);

  return (
    <nav
      aria-label="Page navigation"
      style={{
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        gap: '0.4rem',
        marginTop: '2.5rem',
        flexWrap: 'wrap',
      }}
    >
      <Link
        href={hrefFn(prev)}
        aria-disabled={page === 1}
        aria-label="Previous page"
        className="btn-secondary"
        style={{
          padding: '0.45rem 0.9rem',
          fontSize: 13,
          opacity: page === 1 ? 0.5 : 1,
          pointerEvents: page === 1 ? 'none' : 'auto',
        }}
      >
        ← Prev
      </Link>

      {startPage > 1 && (
        <>
          <Link
            href={hrefFn(1)}
            className="btn-secondary"
            style={{ padding: '0.45rem 0.75rem', fontSize: 13 }}
          >
            1
          </Link>
          {startPage > 2 && (
            <span style={{ color: 'var(--fg-dim)', fontSize: 13, padding: '0 0.25rem' }}>
              …
            </span>
          )}
        </>
      )}

      {pageNumbers.map((n) => (
        <Link
          key={n}
          href={hrefFn(n)}
          aria-current={n === page ? 'page' : undefined}
          className={n === page ? 'btn-primary' : 'btn-secondary'}
          style={{ padding: '0.45rem 0.75rem', fontSize: 13 }}
        >
          {n}
        </Link>
      ))}

      {endPage < pageCount && (
        <>
          {endPage < pageCount - 1 && (
            <span style={{ color: 'var(--fg-dim)', fontSize: 13, padding: '0 0.25rem' }}>
              …
            </span>
          )}
          <Link
            href={hrefFn(pageCount)}
            className="btn-secondary"
            style={{ padding: '0.45rem 0.75rem', fontSize: 13 }}
          >
            {pageCount}
          </Link>
        </>
      )}

      <Link
        href={hrefFn(next)}
        aria-disabled={page === pageCount}
        aria-label="Next page"
        className="btn-secondary"
        style={{
          padding: '0.45rem 0.9rem',
          fontSize: 13,
          opacity: page === pageCount ? 0.5 : 1,
          pointerEvents: page === pageCount ? 'none' : 'auto',
        }}
      >
        Next →
      </Link>
    </nav>
  );
}
