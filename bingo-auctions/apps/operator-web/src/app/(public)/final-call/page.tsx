/**
 * Final Call page — bingoauctions.com/final-call
 *
 * Live view of every lot across the platform whose `close_at` is within the
 * next 2 minutes. Equivalent to MAC.BID's "Final Frenzy" but our brand.
 *
 * Server component. Loads:
 *   - The current 2-min-window lot set (filtered + sorted via URL params)
 *   - The full category list for FilterRail
 *   - The signed-in user (for ?mine=1 gating)
 *
 * Behaviour:
 *   - Same filter contract as /browse?view=lots (category / condition /
 *     price / sort). The FilterRail rewrites URL params; this page reads
 *     them and re-queries.
 *   - `?mine=1` filters the set to lots the user has watched OR bid on.
 *     Anon users that hit /final-call?mine=1 directly get redirected to
 *     /login. The toggle UI is in the client component.
 *   - `?city=<name>` matches the same convention as the rest of the site
 *     (joined via the warehouse).
 *   - All real-time + interactivity (toggle, list updates, polling) is in
 *     `FinalCallClient`. Page is otherwise pure SSR.
 *
 * Visual treatment:
 *   - FINAL CALL wordmark (CLOVR white, RUSH urgent-red).
 *   - Pulsing red LIVE dot underneath.
 *   - "Live now: N" pill matching the dynamic count.
 *   - Each card carries a subtle red glow (applied in the client component
 *     around <LotCard />).
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import type { Metadata } from 'next';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getDemoOperatorIds, demoExclusionList } from '@/lib/demo-operators';
import { parseCategorySlugs, resolveCategoryFilterIds } from '@/lib/category-filter';
import {
  FilterRail,
  type FilterCategory,
  type SortOption,
} from '../_components/FilterRail';
import { FinalCallClient, type FinalCallLot } from './FinalCallClient';
import { FINAL_CALL_WINDOW_MS } from './live-count';
import type { FinalCallSource } from '@/lib/posthog-events';

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_W = 1100;
/** Generous cap; the 2-min window is tiny so 100 is far more than expected
 *  even at scale. Higher would tax the FilterRail render with no real win. */
const HARD_LIMIT = 100;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Final Call — Auctions closing in under 2 minutes',
  description:
    'Every lot across BinGo Auctions that closes in the next 2 minutes. Bid now or miss it.',
  // Intentionally no openGraph image — this is a logged-in / power-user
  // surface; meta polish can land later.
};

// ── Types ─────────────────────────────────────────────────────────────────────

type FinalCallSearchParams = {
  category?: string;
  condition?: string;
  price_min?: string;
  price_max?: string;
  sort?: string;
  city?: string;
  mine?: string;
  from?: string;
};

const VALID_SORTS: SortOption[] = [
  'ending-soon',
  'newest',
  'most-bids',
  'price-low',
  'price-high',
];

function parseSort(raw: string | undefined): SortOption {
  if (raw && (VALID_SORTS as string[]).includes(raw)) return raw as SortOption;
  return 'ending-soon';
}

function parseSource(raw: string | undefined): FinalCallSource {
  if (raw === 'homepage' || raw === 'direct') return raw;
  return 'nav';
}

// ── Loader: categories for the filter rail ───────────────────────────────────

async function loadAllCategories(): Promise<FilterCategory[]> {
  const supabase = getSupabaseAdmin();
  const { data } = await supabase
    .from('categories')
    .select('id, slug, name, parent_id, icon_url, image_url_clean')
    .order('name', { ascending: true });

  if (!data) return [];

  const slugById = new Map<string, string>(
    (data as Array<{ id?: string; slug: string }>)
      .filter((r): r is { id: string; slug: string } => typeof r.id === 'string')
      .map((r) => [r.id, r.slug]),
  );

  return (
    data as Array<{
      id?: string;
      slug: string;
      name: string;
      parent_id: string | null;
      icon_url: string | null;
      image_url_clean: string | null;
    }>
  ).map((r) => ({
    slug: r.slug,
    name: r.name,
    parent_slug: r.parent_id ? slugById.get(r.parent_id) ?? null : null,
    icon_url: r.icon_url,
    image_url_clean: r.image_url_clean,
    // Final Call isn't on the lot-counts feature yet (tracked separately);
    // pass 0 here so the FilterRail dims category rows. The mobile sheet
    // and desktop sidebar in this view will show "(0)" next to every label
    // until final-call wires its own scoped count loader.
    lot_count: 0,
  }));
}

// ── Loader: in-window lots (with all filter + mine-only handling) ────────────

interface LoadLotsArgs {
  categorySlugs: string[];
  conditions: string[];
  priceMinCents: number | null;
  priceMaxCents: number | null;
  sort: SortOption;
  city: string | null;
  mineOnly: boolean;
  /** Auth user id when signed in. The bidders table primary key IS auth.users.id
   *  (see 0001_init.sql line 34-45), so we can use the user.id directly. */
  bidderId: string | null;
  /** loadListedAuctionIds — the only auctions Final Call may show. */
  listedAuctionIds: string[];
}

// H4-c: active, non-demo, listed auction IDs, so demo-operator lots and
// unlisted staff test auctions (0242) never appear in the Final Call window
// (mirrors (public)/browse/page.tsx). The lots query filters by status/close_at
// directly, so without this auction gate a live demo or test lot inside the
// 2-min window would leak. Also handed to FinalCallClient: its realtime path
// fetches newly in-window lots by id and must apply the same gate.
async function loadListedAuctionIds(): Promise<string[]> {
  const supabase = getSupabaseAdmin();
  const demoExclude = demoExclusionList(await getDemoOperatorIds());
  let activeAuctionQuery = supabase
    .from('auctions')
    .select('id')
    .in('status', ['scheduled', 'live'])
    .eq('unlisted', false);
  if (demoExclude) activeAuctionQuery = activeAuctionQuery.not('operator_id', 'in', demoExclude);
  const { data: activeAuctions } = await activeAuctionQuery;
  return ((activeAuctions ?? []) as Array<{ id: string }>).map((a) => a.id);
}

async function loadFinalCallLots(args: LoadLotsArgs): Promise<FinalCallLot[]> {
  const supabase = getSupabaseAdmin();
  const activeAuctionIds = args.listedAuctionIds;
  if (activeAuctionIds.length === 0) return [];

  // Mine-only requires both auth AND a 3-query union (watched ∪ bid ∪ window).
  // Postgrest can't easily express "in (subquery A) OR in (subquery B)" so we
  // fetch the two id sets in parallel with the main lots query and intersect.
  const watchedPromise =
    args.mineOnly && args.bidderId
      ? supabase
          .from('watchlist')
          .select('lot_id')
          .eq('bidder_id', args.bidderId)
      : Promise.resolve({ data: null as Array<{ lot_id: string }> | null });

  const bidsPromise =
    args.mineOnly && args.bidderId
      ? supabase.from('bids').select('lot_id').eq('bidder_id', args.bidderId)
      : Promise.resolve({ data: null as Array<{ lot_id: string }> | null });

  const realConditions = args.conditions.filter((c) => !c.startsWith('virtual:'));
  const hasVirtualEndingSoon = args.conditions.includes('virtual:ending-soon');
  const hasVirtualTopDeal = args.conditions.includes('virtual:top-deal');

  const nowIso = new Date().toISOString();
  const cutoffIso = new Date(Date.now() + FINAL_CALL_WINDOW_MS).toISOString();

  let query = supabase
    .from('lots')
    .select(
      'id, lot_code, title, photo_urls, current_bid_cents, starting_bid_cents, close_at, bid_count, condition, warehouse_id',
    )
    .in('auction_id', activeAuctionIds) // H4-c: non-demo active auctions only
    .eq('status', 'live')
    .is('deleted_at', null)
    .gt('close_at', nowIso)
    .lt('close_at', cutoffIso);

  // Category filter — union of selected categories + children (multi-select,
  // same pattern as /browse).
  if (args.categorySlugs.length > 0) {
    const catIds = await resolveCategoryFilterIds(supabase, args.categorySlugs);
    if (catIds.length > 0) {
      query = query.in('category_id', catIds);
    }
  }

  if (realConditions.length > 0) {
    query = query.in('condition', realConditions);
  }
  if (args.priceMinCents !== null) {
    query = query.gte('starting_bid_cents', args.priceMinCents);
  }
  if (args.priceMaxCents !== null) {
    query = query.lte('starting_bid_cents', args.priceMaxCents);
  }

  // City filter — join through warehouse. Two-step to keep PostgREST happy.
  if (args.city) {
    const { data: wh } = await supabase
      .from('warehouses')
      .select('id')
      .eq('city', args.city);
    const warehouseIds = ((wh ?? []) as Array<{ id: string }>).map((r) => r.id);
    if (warehouseIds.length === 0) return [];
    query = query.in('warehouse_id', warehouseIds);
  }

  // Sort.
  switch (args.sort) {
    case 'ending-soon':
      query = query.order('close_at', { ascending: true });
      break;
    case 'newest':
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

  query = query.limit(HARD_LIMIT);

  // Parallel-execute the three queries.
  const [{ data: lotData, error }, watchedRes, bidsRes] = await Promise.all([
    query,
    watchedPromise,
    bidsPromise,
  ]);

  if (error) {
    console.error('[final-call] lots query failed', error.message);
    return [];
  }

  let rows = (lotData ?? []) as Array<{
    id: string;
    lot_code: string;
    title: string;
    photo_urls: string[] | null;
    current_bid_cents: number | null;
    starting_bid_cents: number;
    close_at: string;
    bid_count: number | null;
    condition: string | null;
    warehouse_id: string;
  }>;

  // Apply mine-only intersection (JS-side) once we have all three sets.
  if (args.mineOnly && args.bidderId) {
    const mine = new Set<string>();
    for (const r of (watchedRes.data ?? []) as Array<{ lot_id: string }>) {
      mine.add(r.lot_id);
    }
    for (const r of (bidsRes.data ?? []) as Array<{ lot_id: string }>) {
      mine.add(r.lot_id);
    }
    rows = rows.filter((l) => mine.has(l.id));
  }

  // Virtual conditions — applied post-query because they're computed.
  // 'ending-soon' is always true here (the whole list is < 2 min); applying
  // it would be a no-op so we ignore that virtual flag for this view.
  // 'top-deal' is a heuristic on current_bid_cents — keep the same threshold
  // as LotCard's badge (current < 1.5 × starting).
  if (hasVirtualTopDeal && !hasVirtualEndingSoon) {
    rows = rows.filter(
      (l) =>
        l.current_bid_cents !== null &&
        l.current_bid_cents < l.starting_bid_cents * 1.5,
    );
  }

  // We selected warehouse_id but the LotCard doesn't need it; we also don't
  // need to resolve the city per-card for v1. Surface as null + drop the id.
  return rows.map((r) => ({
    id: r.id,
    lot_code: r.lot_code,
    title: r.title,
    photo_urls: r.photo_urls,
    current_bid_cents: r.current_bid_cents,
    starting_bid_cents: r.starting_bid_cents,
    close_at: r.close_at,
    bid_count: r.bid_count,
    condition: r.condition,
    warehouse_city: null,
  }));
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default async function FinalCallPage({
  searchParams,
}: {
  searchParams: Promise<FinalCallSearchParams>;
}) {
  const sp = await searchParams;

  const mineOnly = sp.mine === '1';
  const source = parseSource(sp.from);

  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Anon user requesting Mine-only → bounce to /login with a next= back here.
  if (mineOnly && !user) {
    redirect(`/login?next=${encodeURIComponent('/final-call?mine=1')}`);
  }

  const conditions = sp.condition ? sp.condition.split(',').filter(Boolean) : [];
  const priceMinCents = sp.price_min
    ? Math.round(parseFloat(sp.price_min) * 100)
    : null;
  const priceMaxCents = sp.price_max
    ? Math.round(parseFloat(sp.price_max) * 100)
    : null;
  const sort = parseSort(sp.sort);
  const categorySlugs = parseCategorySlugs(sp.category);
  const city = sp.city && sp.city !== 'all' ? sp.city : null;

  const listedAuctionIds = await loadListedAuctionIds();
  const [lots, allCategories] = await Promise.all([
    loadFinalCallLots({
      listedAuctionIds,
      categorySlugs,
      conditions,
      priceMinCents,
      priceMaxCents,
      sort,
      city,
      mineOnly,
      bidderId: user?.id ?? null,
    }),
    loadAllCategories(),
  ]);

  const totalLive = lots.length;

  // Aggregate condition counts from the in-window lot set so FilterRail pills
  // show real numbers instead of "(0)" for every condition.
  const conditionCounts = lots.reduce<Record<string, number>>((acc, lot) => {
    const c = lot.condition || 'unknown';
    acc[c] = (acc[c] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div style={{ padding: '3rem 1.5rem 5rem' }}>
      <div style={{ maxWidth: MAX_W, margin: '0 auto' }}>
        {/* ── Hero: wordmark + LIVE dot + count pill + subtitle ── */}
        <FinalCallHero totalLive={totalLive} />

        {/* ── Two-column layout (mirrors /browse Lots mode) ── */}
        <div
          className="final-call-mobile-filter-row"
          style={{ marginBottom: '1rem' }}
        >
          <FilterRail
            categories={allCategories}
            selectedCategories={categorySlugs}
            selectedConditions={conditions}
            priceMin={sp.price_min ? parseFloat(sp.price_min) : null}
            priceMax={sp.price_max ? parseFloat(sp.price_max) : null}
            sort={sort}
            conditionCounts={conditionCounts}
              resultCount={totalLive}
          />
        </div>

        <div
          className="final-call-layout"
          style={{ display: 'flex', gap: '1.75rem', alignItems: 'flex-start' }}
        >
          <div className="final-call-sidebar">
            <FilterRail
              categories={allCategories}
              selectedCategories={categorySlugs}
              selectedConditions={conditions}
              priceMin={sp.price_min ? parseFloat(sp.price_min) : null}
              priceMax={sp.price_max ? parseFloat(sp.price_max) : null}
              sort={sort}
              conditionCounts={conditionCounts}
              resultCount={totalLive}
            />
          </div>

          <main style={{ flex: 1, minWidth: 0 }}>
            <FinalCallClient
              initialLots={lots}
              listedAuctionIds={listedAuctionIds}
              isAuthed={!!user}
              mineOnly={mineOnly}
              source={source}
            />
          </main>
        </div>
      </div>

      <style>{`
        .final-call-sidebar { display: none !important; }
        .final-call-mobile-filter-row { display: block; }
        @media (min-width: 769px) {
          .final-call-sidebar { display: block !important; }
          .final-call-mobile-filter-row { display: none !important; }
        }
        @keyframes final-call-pulse {
          0% { opacity: 1; }
          50% { opacity: 0.4; }
          100% { opacity: 1; }
        }
      `}</style>
    </div>
  );
}

// ── Hero block ────────────────────────────────────────────────────────────────

function FinalCallHero({ totalLive }: { totalLive: number }) {
  return (
    <div style={{ marginBottom: '2rem' }}>
      <h1
        aria-label="Final Call"
        style={{
          display: 'inline-flex',
          alignItems: 'baseline',
          fontSize: 'clamp(2.4rem, 6vw, 3.75rem)',
          fontWeight: 900,
          letterSpacing: -2,
          lineHeight: 1,
          margin: 0,
        }}
      >
        <span style={{ color: 'var(--ink-2)' }}>FINAL&nbsp;</span>
        <span style={{ color: 'var(--accent)' }}>CALL</span>
      </h1>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          marginTop: '0.65rem',
          marginBottom: '0.5rem',
        }}
      >
        <span
          aria-hidden
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: 'var(--urgent-red)',
            animation: 'final-call-pulse 1.5s ease-in-out infinite',
            display: 'inline-block',
          }}
        />
        <span
          style={{
            fontSize: 12,
            fontWeight: 800,
            letterSpacing: 2,
            textTransform: 'uppercase',
            color: 'var(--urgent-red)',
          }}
        >
          Live
        </span>
        <span
          style={{
            background: 'var(--urgent-red)',
            color: '#fff',
            fontSize: 11,
            fontWeight: 900,
            letterSpacing: 0.5,
            textTransform: 'uppercase',
            padding: '2px 9px',
            borderRadius: 999,
          }}
        >
          Live now: {totalLive}
        </span>
      </div>

      <p
        style={{
          fontSize: 15,
          color: 'var(--fg-muted)',
          margin: 0,
          maxWidth: 540,
        }}
      >
        Auctions closing in under 2 minutes. Bid now or miss it.{' '}
        <Link
          href="/browse"
          style={{ color: 'var(--fg-muted)', textDecoration: 'underline' }}
        >
          Or browse the full list →
        </Link>
      </p>
    </div>
  );
}
