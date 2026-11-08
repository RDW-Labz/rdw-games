/**
 * Public lot detail page — bingoauctions.com/lot/{lot_code}
 *
 * Server component, fully indexable. Renders lot info + photos + bid CTA.
 *
 * Auth states:
 *   - Anonymous: shows the lot + a "Sign in to bid" CTA pointing at
 *     /login?next=/lot/{lot_code}.
 *   - Signed-in bidder (no operator_users row): renders the BidWidget
 *     client component so they can place bids inline.
 *   - Signed-in operator on their own lot: shows the lot read-only with
 *     a "Manage in console" link. Operators can't bid on their own lots
 *     (RLS on the bids table would reject anyway — surface that early).
 *
 * Status-aware copy:
 *   - lot.status='in_inventory' or 'pending_intake' → "Not in an auction
 *     yet — add to your watchlist in the app." Hide the bid widget.
 *   - lot.status='scheduled' (auction not open) → countdown + "Sign in to
 *     get notified when bidding opens."
 *   - lot.status='live' → full bid widget.
 *   - lot.status='sold' / 'closed' / 'unsold' → final price + "Bidding
 *     has ended."
 *
 * SEO: title + description + og:image populated from lot row. Photo URLs
 * already live in Supabase Storage — they serve from a public bucket, so
 * the <img> tags work without auth.
 *
 * 2026-05-22 — Tier 1B/2 additions (mac.bid parity):
 *   - SAVE % badge + crossed-out MSRP near the price.
 *   - Pickup info card separating "Auction ends" from "Pickup by", with
 *     warehouse aisle/bay assembly + "NOT TRANSFERRABLE" pill.
 *   - Anonymized bid history table (Bidder #N / YOU mapping).
 *   - Similar lots horizontal carousel (same auction → same category → any).
 */

import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ShareBar } from '../../_components/ShareBar';
import { PhotoGalleryClient } from './PhotoGalleryClient';
import { BrowseLotNav } from './BrowseLotNav';
import { loadBrowseLots, BROWSE_PAGE_SIZE } from '@/lib/browse-lots';
import { parseCategorySlugs } from '@/lib/category-filter';
import type { SortOption } from '../../_components/FilterRail';
import { cdnImageUrl } from '@/lib/img-proxy';
import { JsonLd, productJsonLd, breadcrumbJsonLd, loadPrimaryBusiness, SITE_URL } from '@/lib/seo';
import type { Metadata } from 'next';
import type { BidIncrementTier } from '@auction-platform/shared';
import { stickerLabel, rankScannedLots, lotDisplayCode } from '@auction-platform/shared';
import {
  findLotsByAnyCode,
  isRetiredLot,
  loadSuccessorChain,
  type LineageLotRow,
} from '@/lib/lot-lineage';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { getSupabaseServer } from '@/lib/supabase-server';
import {
  formatInTimeZone,
  formatDateInTimeZone,
  formatTimeInTimeZone,
  warehouseTimezone,
  DEFAULT_TIME_ZONE,
} from '@/lib/datetime';
import { BidWidget } from './BidWidget';
import { isPaymentsDisabled } from '@/lib/payments-mode';
import { LotCard, type LotCardLot } from '../../_components/LotCard';
import { WatchlistButton } from '../../_components/WatchlistButton';
import { LotCountdown } from '../../_components/LotCountdown';
import {
  describeWarehousePickup,
  type WarehousePickupDescribed,
  type WarehousePickupSource,
} from '@/lib/warehouse-pickup';

const MAX_W = 1100;

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type LotRow = {
  id: string;
  lot_code: string;
  // Lineage resolution: `created_at` is the rankScannedLots tiebreak and
  // `relisted_from_lot_id` anchors the walk to the current incarnation.
  created_at: string | null;
  relisted_from_lot_id: string | null;
  // Pre-stickered physical label ({op}:{raw}); shown instead of the minted
  // lot_code so pickup customers see the code that's on the box.
  sticker_code: string | null;
  /** Computed column (mig 0315): box label resolved over the relist lineage. */
  display_code: string | null;
  operator_id: string;
  title: string;
  description: string | null;
  category: string | null;
  condition: string;
  msrp_cents: number | null;
  starting_bid_cents: number;
  current_bid_cents: number | null;
  bid_count: number;
  photo_urls: string[];
  status: string;
  auction_id: string | null;
  close_at: string | null;
  // Authoritative current leader. Public-safe (opaque uuid, never rendered
  // raw) — threaded to BidWidget only to compare against the signed-in
  // viewer for the "You're winning" / "Outbid" badge.
  winner_bidder_id: string | null;
  legacy_lot_code: string | null;
  legacy_platform: string | null;
  brand: string | null;
  model: string | null;
  upc: string | null;
  asin: string | null;
  fnsku: string | null;
  lpn: string | null;
  mpn: string | null;
  product_sku: string | null;
  site_sku: string | null;
  manufacture_sku: string | null;
  // Customer-facing preview location (2026-07-10): the intake shelf the item
  // physically sits on. Supabase to-one embed via the lots→bins FK.
  intake_bin: { code: string | null; aisle: string | null; bay: string | null } | null;
};

type OperatorLotSummary = {
  businessName: string | null;
  buyerPremiumPct: number;
  disputeWindowDays: number;
  pickupHoursText: string | null;
  customTermsMd: string | null;
};

interface BidRow {
  id: string;
  bidder_id: string;
  amount_cents: number;
  is_auto: boolean;
  placed_at: string;
}

interface BinAssignmentRow {
  bins: {
    code: string | null;
    aisle: string | null;
    bay: string | null;
  } | null;
}

interface SimilarLotRow {
  id: string;
  lot_code: string;
  title: string;
  photo_urls: string[] | null;
  current_bid_cents: number | null;
  starting_bid_cents: number;
  close_at: string;
  bid_count: number | null;
  condition: string | null;
  msrp_cents: number | null;
  // Preview-B: lifecycle status so the rail renders the static "Upcoming" pill
  // for scheduled lots instead of a live ticking countdown.
  status: string | null;
}

interface LoadLotResult {
  lot: LotRow | null;
  operator: OperatorLotSummary | null;
  auctionStatus: string | null;
  auctionTitle: string | null;
  auctionStartsAt: string | null;
  /** 0221: auction opted into preview pre-bidding (bids allowed before starts_at). */
  prebidEnabled: boolean;
  pickupEndsAt: string | null;
  /** IANA zone of the lot's auction's warehouse, for absolute-time labels. */
  warehouseTimeZone: string | null;
  /** Off-site pickup copy (0406 customer_notice); isOffsite=false renders as before. */
  pickupLoc: WarehousePickupDescribed;
  bids: BidRow[];
  /** kind 'pickup' = staged for pickup (post-sale); 'shelf' = intake shelf
   *  (preview/live — where a customer finds the item on the floor). */
  binLocation: {
    aisle: string | null;
    bay: string | null;
    code: string | null;
    kind: 'pickup' | 'shelf';
  } | null;
  similarLots: SimilarLotRow[];
  similarLotsMode: 'same-auction-category' | 'same-auction' | 'same-category' | 'none';
  /**
   * BID-3: the effective bid-increment schedule for this lot =
   * COALESCE(auction.bid_increment_schedule, operator.bid_increment_schedule).
   * null → the BidWidget uses the legacy ladder (mirrors the SQL fallback).
   */
  effectiveSchedule: BidIncrementTier[] | null;
}

// RLS bypass is fine — we explicitly select only public-safe columns.
// No cost_cents, no internal flags, nothing that leaks operator data
// beyond what the storefront already exposes.
const PUBLIC_LOT_COLUMNS = [
  'id',
  'lot_code',
  'sticker_code',
  'display_code',
  'operator_id',
  'status',
  // Lineage resolution inputs: `created_at` breaks rankScannedLots ties and
  // `relisted_from_lot_id` is what the successor walk follows.
  'created_at',
  'relisted_from_lot_id',
  'title',
  'description',
  'category',
  'condition',
  'msrp_cents',
  'starting_bid_cents',
  'current_bid_cents',
  'bid_count',
  'photo_urls',
  'auction_id',
  'close_at',
  'winner_bidder_id',
  'legacy_lot_code',
  'legacy_platform',
  'brand',
  'model',
  'upc',
  'asin',
  'fnsku',
  'lpn',
  'mpn',
  'product_sku',
  'site_sku',
  'manufacture_sku',
  // Preview location — the shelf the item sits on (aisle/bay/bin code).
  // Public-safe: it's the same info a preview visitor gets by asking staff.
  'intake_bin:bins!lots_intake_bin_id_fkey(code, aisle, bay)',
].join(', ');

/**
 * Resolve a URL code segment to the lot record that is actually on the floor.
 *
 * Three things a bare `.eq('lot_code', code)` got wrong (field report
 * 2026-07-30 — see lib/lot-lineage.ts for the full anatomy):
 *
 *  1. The code this page PRINTS is `stickerLabel(sticker_code) ?? lot_code`,
 *     so the identifier a customer copies off the listing (or reads off the
 *     box) is frequently a `sticker_code` that matches no `lot_code` at all.
 *  2. After a relist the ancestor row keeps the old `lot_code` forever, so
 *     that code resolved to a dead row — "Bidding isn't available right now"
 *     for an item with an auction closing that evening.
 *  3. When both rows exist, the ancestor won purely by being an exact match.
 *
 * Match both identifier columns, prefer the live row, then follow the relist
 * chain forward if we still landed on a retired one.
 */
async function resolveLotByCode(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  code: string,
): Promise<LotRow | null> {
  const candidates = await findLotsByAnyCode<LotRow & LineageLotRow>(
    supabase,
    code,
    PUBLIC_LOT_COLUMNS,
  );
  // rankScannedLots, not preferActiveLot: when both incarnations are active
  // (142 such pairs on prod) status can't break the tie, and the row holding
  // the sticker is the one the visitor is looking at.
  const best = rankScannedLots(candidates, code);
  if (!best) return null;
  if (!isRetiredLot(best.status)) return best;

  // Retired row — walk to the current incarnation. If the whole chain is
  // retired (item sold and never relisted again) we keep `best` so the page
  // still renders the record the visitor asked for rather than 404ing.
  const chain = await loadSuccessorChain<LotRow & LineageLotRow>(
    supabase,
    best.id,
    PUBLIC_LOT_COLUMNS,
  );
  const current = chain.length > 0 ? chain[chain.length - 1]! : null;
  return current && !isRetiredLot(current.status) ? current : best;
}

async function loadLot(code: string): Promise<LoadLotResult> {
  const supabase = getSupabaseAdmin();

  const lot = await resolveLotByCode(supabase, code);

  if (!lot) {
    return {
      lot: null,
      operator: null,
      auctionStatus: null,
      auctionTitle: null,
      auctionStartsAt: null,
      prebidEnabled: false,
      pickupEndsAt: null,
      warehouseTimeZone: null,
      pickupLoc: describeWarehousePickup(null),
      bids: [],
      binLocation: null,
      similarLots: [],
      similarLotsMode: 'none',
      effectiveSchedule: null,
    };
  }

  const lotRow = lot;


  // Parallelize all secondary queries — operator, auction, bids, bin, similar.
  const [operatorQ, auctionQ, bidsQ, binQ] = await Promise.all([
    supabase
      .from('operators')
      .select(
        'business_name, default_buyer_premium_bps, dispute_window_days, pickup_hours_text, custom_terms_md, bid_increment_schedule',
      )
      .eq('id', lotRow.operator_id)
      .maybeSingle(),
    lotRow.auction_id
      ? supabase
          .from('auctions')
          // warehouses(*) — timezone for labels; pickup-facing columns when
          // customer_notice marks an off-site warehouse (0406).
          // bid_increment_schedule — BID-3 per-auction override (wins over the
          // operator default below).
          .select('status, title, starts_at, prebid_enabled, pickup_ends_at, bid_increment_schedule, warehouses(*)')
          .eq('id', lotRow.auction_id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
    supabase
      .from('bids')
      // NOTE: never select max_amount_cents here — proxy ceilings are private
      // to the bidder + operator console (2026-07-05). is_auto is fetched but
      // only ever rendered on the VIEWER's own rows.
      .select('id, bidder_id, amount_cents, is_auto, placed_at')
      .eq('lot_id', lotRow.id)
      .order('placed_at', { ascending: false })
      .limit(50),
    // bin_assignments doesn't have removed_at — the schema uses status
    // ('staged' = active, 'picked_up'/'returned_to_floor' = done). Filter
    // to 'staged' for the active assignment.
    supabase
      .from('bin_assignments')
      .select('bins(code, aisle, bay)')
      .eq('lot_id', lotRow.id)
      .eq('status', 'staged')
      .order('assigned_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const opRow = operatorQ.data as {
    business_name?: string | null;
    default_buyer_premium_bps?: number | null;
    dispute_window_days?: number | null;
    pickup_hours_text?: string | null;
    custom_terms_md?: string | null;
    bid_increment_schedule?: BidIncrementTier[] | null;
  } | null;

  const auctionRow = auctionQ.data as {
    status?: string;
    title?: string;
    starts_at?: string | null;
    prebid_enabled?: boolean | null;
    pickup_ends_at?: string | null;
    bid_increment_schedule?: BidIncrementTier[] | null;
    warehouses?: WarehousePickupSource & { timezone: string | null } | null;
  } | null;

  const pickupLoc = describeWarehousePickup(auctionRow?.warehouses ?? null);

  // BID-3: per-auction override wins; else operator default; else null (legacy).
  const effectiveSchedule: BidIncrementTier[] | null =
    auctionRow?.bid_increment_schedule ?? opRow?.bid_increment_schedule ?? null;

  const bids = ((bidsQ.data as unknown as BidRow[]) ?? []).filter(Boolean);

  // Location resolution (mirrors staff "Find lot" + the lot_public_location
  // RPC in mig 0255): a staged bin_assignment (item pulled for pickup) wins;
  // otherwise, while the lot is still publicly listed (scheduled/live), fall
  // back to its intake shelf so preview customers can walk straight to it.
  // Auto-updates: this page is force-dynamic, so a staff move (new
  // intake_bin_id / staging) shows on the next load.
  const binRow = binQ.data as unknown as BinAssignmentRow | null;
  const intakeBinNode = Array.isArray(lotRow.intake_bin)
    ? (lotRow.intake_bin[0] as LotRow['intake_bin'])
    : lotRow.intake_bin;
  const publiclyListed = lotRow.status === 'scheduled' || lotRow.status === 'live';
  const binLocation = binRow?.bins
    ? {
        aisle: binRow.bins.aisle ?? null,
        bay: binRow.bins.bay ?? null,
        code: binRow.bins.code ?? null,
        kind: 'pickup' as const,
      }
    : intakeBinNode && publiclyListed
      ? {
          aisle: intakeBinNode.aisle ?? null,
          bay: intakeBinNode.bay ?? null,
          code: intakeBinNode.code ?? null,
          kind: 'shelf' as const,
        }
      : null;

  // ── Similar lots — same auction + same category first, then fall back. ──
  const similarLots = await loadSimilarLots(supabase, lotRow);

  return {
    lot: lotRow,
    operator: opRow
      ? {
          businessName: opRow.business_name ?? null,
          buyerPremiumPct: Math.round((opRow.default_buyer_premium_bps ?? 0) / 100),
          disputeWindowDays: opRow.dispute_window_days ?? 2,
          pickupHoursText: opRow.pickup_hours_text ?? null,
          customTermsMd: opRow.custom_terms_md ?? null,
        }
      : null,
    auctionStatus: auctionRow?.status ?? null,
    auctionTitle: auctionRow?.title ?? null,
    auctionStartsAt: auctionRow?.starts_at ?? null,
    prebidEnabled: auctionRow?.prebid_enabled === true,
    pickupEndsAt: auctionRow?.pickup_ends_at ?? null,
    warehouseTimeZone: warehouseTimezone(auctionRow?.warehouses),
    pickupLoc,
    bids,
    binLocation,
    similarLots: similarLots.lots,
    similarLotsMode: similarLots.mode,
    effectiveSchedule,
  };
}

/**
 * Three-tier fallback so the carousel always has something to show on an
 * active auction page. Order: same auction + same category → same auction
 * (any category) → any open auction + same category.
 */
async function loadSimilarLots(
  supabase: ReturnType<typeof getSupabaseAdmin>,
  lot: LotRow,
): Promise<{
  lots: SimilarLotRow[];
  mode: 'same-auction-category' | 'same-auction' | 'same-category' | 'none';
}> {
  const SIMILAR_COLS =
    'id, lot_code, title, photo_urls, current_bid_cents, starting_bid_cents, close_at, bid_count, condition, msrp_cents, status';
  const MIN = 4;
  const LIMIT = 8;

  // Tier 1: same auction + same category.
  if (lot.auction_id && lot.category) {
    const { data } = await supabase
      .from('lots')
      .select(SIMILAR_COLS)
      .eq('auction_id', lot.auction_id)
      .eq('category', lot.category)
      .in('status', ['live', 'scheduled'])
      .neq('id', lot.id)
      .limit(LIMIT);
    const lots = (data as unknown as SimilarLotRow[]) ?? [];
    if (lots.length >= MIN) {
      return { lots, mode: 'same-auction-category' };
    }
  }

  // Tier 2: same auction, any category.
  if (lot.auction_id) {
    const { data } = await supabase
      .from('lots')
      .select(SIMILAR_COLS)
      .eq('auction_id', lot.auction_id)
      .in('status', ['live', 'scheduled'])
      .neq('id', lot.id)
      .limit(LIMIT);
    const lots = (data as unknown as SimilarLotRow[]) ?? [];
    if (lots.length >= MIN) {
      return { lots, mode: 'same-auction' };
    }
  }

  // Tier 3: any open auction, same category. Unlike tiers 1-2 this reaches
  // other auctions, so it must skip unlisted test auctions (0242).
  if (lot.category) {
    const { data } = await supabase
      .from('lots')
      .select(`${SIMILAR_COLS}, auctions!inner(unlisted)`)
      .eq('auctions.unlisted', false)
      .eq('category', lot.category)
      .in('status', ['live', 'scheduled'])
      .neq('id', lot.id)
      .limit(LIMIT);
    const lots = (data as unknown as SimilarLotRow[]) ?? [];
    if (lots.length > 0) {
      return { lots, mode: 'same-category' };
    }
  }

  return { lots: [], mode: 'none' };
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ code: string }>;
}): Promise<Metadata> {
  const { code } = await params;
  const [{ lot }, biz] = await Promise.all([loadLot(code), loadPrimaryBusiness()]);
  if (!lot) return { title: 'Lot not found' };

  const rawPhoto = lot.photo_urls?.[0];
  // Own-storage photos go through the edge-cached proxy (absolute for OG).
  const photo = rawPhoto ? cdnImageUrl(rawPhoto, { absolute: true }) : undefined;
  const DEFAULT_OG = '/og-default.png';
  const ogImage = photo ?? DEFAULT_OG;
  const ogImageEntry = photo
    ? { url: photo }
    : { url: DEFAULT_OG, width: 1200, height: 628 };
  // City in the description (not the title — lot titles are long already):
  // "{item} auction {city}" searches match on it and the SERP snippet says
  // where pickup is before the click.
  const place = biz?.address ? ` Local auction in ${biz.address.city}, ${biz.address.state} — pickup at our warehouse.` : '';
  const description = `${lot.description ?? `${lot.title} — bid online at BinGo Auctions.`}${place}`;
  return {
    // Bare lot title — the root layout's title template appends
    // "— BinGo Auctions"; adding the business name here doubled the brand
    // ("· BinGo Auctions — BinGo Auctions", caught live 2026-07-06).
    title: lot.title,
    description,
    openGraph: {
      title: lot.title,
      description,
      url: `https://bingoauctions.com/lot/${lot.lot_code}`,
      siteName: 'BinGo Auctions',
      images: [ogImageEntry],
    },
    twitter: {
      card: 'summary_large_image',
      images: [ogImage],
    },
  };
}

// ── Browse prev/next context (2026-07-07) ────────────────────────────────────
// When a lot is opened from /browse, the card link carries `?bctx=<qs>`: the
// browse filter params plus `i=<absolute row index>`. We re-run the shared
// browse query for rows i-1..i+1 (same filters, same ordering) and render
// ‹ Prev / Next › so the customer can walk the whole filtered list without
// backing out. Skipped for virtual conditions (post-query filters break row
// indexing) and silently hidden if the list shifted under us.
type BrowseNavData = {
  prevHref: string | null;
  nextHref: string | null;
  position: number;
  total: number;
  backHref: string;
};

async function loadBrowseNav(bctxRaw: string, currentCode: string): Promise<BrowseNavData | null> {
  try {
    const inner = new URLSearchParams(bctxRaw);
    const i = parseInt(inner.get('i') ?? '', 10);
    if (!Number.isFinite(i) || i < 0) return null;
    const conditions = (inner.get('condition') ?? '').split(',').filter(Boolean);
    if (conditions.some((c) => c.startsWith('virtual:'))) return null;
    const sortRaw = inner.get('sort') ?? 'ending-soon';
    const sort: SortOption = (
      ['ending-soon', 'newest', 'most-bids', 'price-low', 'price-high'] as const
    ).includes(sortRaw as SortOption)
      ? (sortRaw as SortOption)
      : 'ending-soon';
    const warehouseRaw = inner.get('warehouse');
    const from = Math.max(0, i - 1);

    const { lots: neighbors, total } = await loadBrowseLots({
      categorySlugs: parseCategorySlugs(inner.get('category')),
      conditions,
      priceMinCents: inner.get('price_min')
        ? Math.round(parseFloat(inner.get('price_min')!) * 100)
        : null,
      priceMaxCents: inner.get('price_max')
        ? Math.round(parseFloat(inner.get('price_max')!) * 100)
        : null,
      sort,
      page: 1,
      searchQuery: inner.get('q')?.trim() || null,
      warehouseId: warehouseRaw && /^[0-9a-f-]{36}$/i.test(warehouseRaw) ? warehouseRaw : null,
      rangeOverride: { from, to: i + 1 },
    });

    const pos = neighbors.findIndex((l) => l.lot_code === currentCode);
    if (pos === -1) return null;

    const hrefFor = (lot: { lot_code: string }, absIndex: number) => {
      const ctx = new URLSearchParams(inner.toString());
      ctx.set('i', String(absIndex));
      return `/lot/${lot.lot_code}?bctx=${encodeURIComponent(ctx.toString())}`;
    };
    const absCurrent = from + pos;
    const prevLot = pos > 0 ? neighbors[pos - 1] : null;
    const nextLot = pos < neighbors.length - 1 ? neighbors[pos + 1] : null;

    const backQs = new URLSearchParams(inner.toString());
    backQs.delete('i');
    backQs.set('view', 'lots');
    const backPage = Math.floor(absCurrent / BROWSE_PAGE_SIZE) + 1;
    if (backPage > 1) backQs.set('page', String(backPage));

    return {
      prevHref: prevLot ? hrefFor(prevLot, absCurrent - 1) : null,
      nextHref: nextLot ? hrefFor(nextLot, absCurrent + 1) : null,
      position: absCurrent + 1,
      total,
      backHref: `/browse?${backQs.toString()}`,
    };
  } catch {
    return null; // malformed context — just render the lot page without nav
  }
}

export default async function LotPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: Promise<{ bctx?: string }>;
}) {
  const [{ code }, sp] = await Promise.all([params, searchParams]);
  const {
    lot,
    operator,
    auctionTitle,
    auctionStartsAt,
    prebidEnabled,
    pickupEndsAt,
    warehouseTimeZone,
    pickupLoc,
    bids,
    binLocation,
    similarLots,
    similarLotsMode,
    effectiveSchedule,
  } = await loadLot(code);

  // One lot, one URL. `code` may have been a sticker label, a differently-cased
  // spelling, or a retired ancestor's lot_code (see resolveLotByCode) — bounce
  // to the canonical code so a bookmark, a shared link, the JSON-LD, and the
  // operator console all name the same record. Safe from looping: an exact
  // lot_code match always resolves to itself.
  if (lot && lot.lot_code !== code) {
    redirect(`/lot/${lot.lot_code}${sp.bctx ? `?bctx=${encodeURIComponent(sp.bctx)}` : ''}`);
  }

  // Prev/next context — resolved with the lot's canonical code (the URL param
  // may differ in case). Cheap no-op when the customer didn't come from browse.
  const browseNav =
    sp.bctx && lot ? await loadBrowseNav(sp.bctx, lot.lot_code) : null;
  // Zone for all absolute-time labels on this page (lot's auction's
  // warehouse). NULL only when the lot has no auction; fall back to the
  // US-launch default so we never render in the SSR runtime zone (UTC).
  const tz = warehouseTimeZone ?? DEFAULT_TIME_ZONE;

  if (!lot) {
    // Render the same `<style>` block + `.lot-two-col` shell as the success
    // branch even when the lot is missing. The e2e regression in
    // audit-fixes.spec.ts asserts the @media rule + class are present in
    // ANY lot-detail render — deploys that show "Lot not found" still
    // need to prove the responsive layout shipped.
    return (
      <div style={pageWrap}>
        <div style={innerWrap}>
          <style>{`
            @media (min-width: 640px) {
              .lot-two-col {
                grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) !important;
                gap: 2.5rem !important;
              }
            }
          `}</style>
          <div className="lot-two-col" style={twoCol}>
            <div style={{ textAlign: 'center', padding: '4rem 0', gridColumn: '1 / -1' }}>
              <h1 style={{ fontSize: '2rem', fontWeight: 900, marginBottom: '0.5rem' }}>
                Lot not found
              </h1>
              <p style={{ color: 'var(--fg-muted)', marginBottom: '2rem' }}>
                We couldn&apos;t find a lot with code <code>{code}</code>. It may have been removed
                or the URL may be mistyped.
              </p>
              <Link href="/browse" className="btn-primary" style={{ padding: '0.75rem 1.5rem' }}>
                Browse all auctions
              </Link>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const server = await getSupabaseServer();
  const {
    data: { user },
  } = await server.auth.getUser();

  // Lookup state for signed-in users:
  //   - isOperatorOnOwnLot: gate so operators see "Manage in console" on
  //     their own lots (bidding on your own lot is RLS-forbidden anyway,
  //     but we surface the affordance early).
  //   - hasBidderRow: did the user finish /bidder/onboarding (DOB + consent)?
  //     If not, "Sign in to bid" → /signup branch picks up. If yes, the
  //     BidWidget renders.
  //   - hasCard: did the bidder finish /bidder/onboarding/payment-method?
  //     place_bid §A rejects without one, so the widget shows an "Add a
  //     card to bid" CTA instead of the bid input.
  //   - unpaidFeesCents: place_bid §B rejects until these clear.
  let isOperatorOnOwnLot = false;
  let hasBidderRow = false;
  let hasCard = false;
  let unpaidFeesCents = 0;
  // Customer feedback 2026-07-09: the watch star only existed on browse
  // cards — once inside the listing there was no way to (un)watch. The
  // detail page now renders the same WatchlistButton over the gallery;
  // SSR the initial state so it matches the card the customer came from.
  let initialWatched = false;
  if (user) {
    const [staffQ, bidderQ, watchQ] = await Promise.all([
      server.from('operator_users').select('operator_id').eq('user_id', user.id).maybeSingle(),
      server
        .from('bidders')
        .select('id, default_payment_method_id, unpaid_fees_cents')
        .eq('id', user.id)
        .maybeSingle(),
      server
        .from('watchlist')
        .select('lot_id')
        .eq('bidder_id', user.id)
        .eq('lot_id', lot.id)
        .maybeSingle(),
    ]);
    initialWatched = !!watchQ.data;
    const staffOpId = (staffQ.data as { operator_id?: string } | null)?.operator_id ?? null;
    isOperatorOnOwnLot = staffOpId === lot.operator_id;
    const bidderRow =
      (bidderQ.data as {
        id?: string;
        default_payment_method_id?: string | null;
        unpaid_fees_cents?: number | null;
      } | null) ?? null;
    hasBidderRow = !!bidderRow?.id;
    hasCard = !!bidderRow?.default_payment_method_id;
    unpaidFeesCents = bidderRow?.unpaid_fees_cents ?? 0;
  }
  // Platform test mode (no live card processor): bids don't require a saved
  // card, so the widget shows the bid input even when hasCard is false.
  const paymentsDisabled = await isPaymentsDisabled();

  // Persistent anonymous bidder numbers (mig 0254, customer request
  // 2026-07-09): the same account shows the same "Bidder #N" on every
  // auction, so regulars recognize themselves and each other. Falls back
  // to the old per-page sequence for any row missing a number.
  const viewerBidderId = user?.id ?? null;
  const historyBidderIds = Array.from(new Set(bids.map((b) => b.bidder_id)));
  let persistentNumbers = new Map<string, number>();
  if (historyBidderIds.length > 0) {
    const { data: numRows } = await getSupabaseAdmin()
      .from('bidders')
      .select('id, bidder_number')
      .in('id', historyBidderIds);
    persistentNumbers = new Map(
      ((numRows ?? []) as Array<{ id: string; bidder_number: number | null }>)
        .filter((r) => r.bidder_number !== null)
        .map((r) => [r.id, r.bidder_number as number]),
    );
  }
  const anonMap = buildAnonMap(bids, viewerBidderId, persistentNumbers);

  // schema.org structured data — Product (offer = current bid, expires at
  // close) + BreadcrumbList. Photos via the edge-cached proxy, absolute URLs.
  const jsonLdPhotos = (lot.photo_urls ?? [])
    .slice(0, 6)
    .map((u) => cdnImageUrl(u, { absolute: true }));
  const productLd = productJsonLd({
    lotCode: lot.lot_code,
    title: lot.title,
    description: lot.description,
    photoUrls: jsonLdPhotos,
    brand: lot.brand,
    model: lot.model,
    upc: lot.upc,
    mpn: lot.mpn,
    condition: lot.condition,
    status: lot.status,
    priceCents: lot.current_bid_cents ?? lot.starting_bid_cents,
    closeAt: lot.close_at,
    sellerName: operator?.businessName ?? 'BinGo Auctions',
  });
  const breadcrumbLd = breadcrumbJsonLd([
    { name: 'All auctions', url: `${SITE_URL}/browse` },
    ...(auctionTitle && lot.auction_id
      ? [{ name: auctionTitle, url: `${SITE_URL}/auction/${lot.auction_id}` }]
      : []),
    { name: lot.title, url: `${SITE_URL}/lot/${lot.lot_code}` },
  ]);

  return (
    <div style={pageWrap}>
      <JsonLd data={productLd} />
      <JsonLd data={breadcrumbLd} />
      <div style={innerWrap}>
        {/* Breadcrumb */}
        <div style={{ fontSize: 13, color: 'var(--fg-dim)', marginBottom: '1.25rem' }}>
          <Link href="/browse" style={breadcrumbLink}>
            All auctions
          </Link>
          {auctionTitle && lot.auction_id && (
            <>
              <span style={{ margin: '0 0.5rem' }}>›</span>
              <Link href={`/auction/${lot.auction_id}`} style={breadcrumbLink}>
                {auctionTitle}
              </Link>
            </>
          )}
        </div>

        {/* Prev/next through the customer's filtered browse list. */}
        {browseNav && <BrowseLotNav {...browseNav} />}

        {/* `.lot-two-col` is single-column on mobile (twoCol sets
            `grid-template-columns: 1fr`) and upgrades to two columns at
            >=640px via the <style> tag below. Without this, desktop
            bidders see the photo gallery stacked above the bid panel
            even on wide screens. */}
        <style>{`
          @media (min-width: 640px) {
            .lot-two-col {
              grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) !important;
              gap: 2.5rem !important;
            }
          }
        `}</style>
        <div className="lot-two-col" style={twoCol}>
          {/* Left column — photo gallery (client: thumb select + lightbox).
              The watch star overlays the gallery's top-right corner — same
              component and position as the browse cards, so state stays in
              sync via the shared watchlist table. */}
          <div style={{ position: 'relative' }}>
            <WatchlistButton
              lotId={lot.id}
              lotCode={lot.lot_code}
              initialWatched={initialWatched}
            />
            <PhotoGalleryClient photos={lot.photo_urls ?? []} title={lot.title} />
          </div>

          {/* Right column — bid panel */}
          <div>
            <div style={{ fontSize: 11, color: 'var(--fg-dim)', marginBottom: 4 }}>
              {lotDisplayCode(lot) ?? lot.lot_code}
              {lot.legacy_lot_code && (
                <span style={{ marginLeft: 8 }}>
                  · Legacy {lot.legacy_platform ? `${lot.legacy_platform}: ` : ''}
                  {lot.legacy_lot_code}
                </span>
              )}
            </div>
            <h1
              style={{
                fontSize: 'clamp(1.5rem, 3.5vw, 2.25rem)',
                fontWeight: 900,
                letterSpacing: -0.5,
                lineHeight: 1.15,
                marginBottom: '0.75rem',
              }}
            >
              {lot.title}
            </h1>
            {operator?.businessName && (
              <div style={{ fontSize: 13, color: 'var(--fg-muted)', marginBottom: '0.4rem' }}>
                Run by <strong>{operator.businessName}</strong>
                {operator.buyerPremiumPct > 0 && (
                  <span style={{ color: 'var(--fg-dim)' }}>
                    {' · '}Buyer&rsquo;s premium: <strong>{operator.buyerPremiumPct}%</strong>
                  </span>
                )}
              </div>
            )}
            {operator &&
              (operator.pickupHoursText ||
                (pickupLoc.isOffsite && pickupLoc.hoursLines.length > 0) ||
                operator.disputeWindowDays > 0) && (
              <div
                style={{
                  fontSize: 12,
                  color: 'var(--fg-dim)',
                  marginBottom: '1.25rem',
                }}
              >
                {pickupLoc.isOffsite && pickupLoc.hoursLines.length > 0 ? (
                  <>Pickup: {pickupLoc.hoursLines.join(' · ')}</>
                ) : (
                  operator.pickupHoursText && (
                    <>Pickup: {operator.pickupHoursText.split('\n')[0]}</>
                  )
                )}
                {(pickupLoc.isOffsite && pickupLoc.hoursLines.length > 0
                  ? true
                  : !!operator.pickupHoursText) &&
                  operator.disputeWindowDays > 0 &&
                  ' · '}
                {operator.disputeWindowDays > 0 && (
                  <>
                    {operator.disputeWindowDays}-day{operator.disputeWindowDays === 1 ? '' : 's'}{' '}
                    dispute window
                  </>
                )}
              </div>
            )}

            <BidPanel
              lot={lot}
              signedIn={!!user}
              isOperatorOnOwnLot={isOperatorOnOwnLot}
              hasBidderRow={hasBidderRow}
              hasCard={hasCard}
              paymentsDisabled={paymentsDisabled}
              unpaidFeesCents={unpaidFeesCents}
              viewerBidderId={user?.id ?? null}
              timeZone={tz}
              auctionStartsAt={auctionStartsAt}
              prebidEnabled={prebidEnabled}
              incrementSchedule={effectiveSchedule}
              operatorName={operator?.businessName ?? null}
            />

            {/* Savings + MSRP comparison */}
            <SavingsCallout
              msrpCents={lot.msrp_cents}
              displayPriceCents={lot.current_bid_cents ?? lot.starting_bid_cents}
            />

            {/* Share — same canonical URL as the OG metadata above */}
            <ShareBar
              url={`https://bingoauctions.com/lot/${lot.lot_code}`}
              title={lot.title}
              lotCode={lot.lot_code}
            />

            {/* Pickup + warehouse info card */}
            <PickupInfoCard
              lot={lot}
              pickupEndsAt={pickupEndsAt}
              binLocation={binLocation}
              timeZone={tz}
              pickupLoc={pickupLoc}
            />

            {/* Meta facts */}
            <div style={metaGrid}>
              {lot.brand && <MetaCell label="Brand" value={lot.brand} />}
              {lot.model && <MetaCell label="Model" value={lot.model} />}
              {lot.condition && (
                <MetaCell label="Condition" value={titleCase(lot.condition)} />
              )}
              {lot.category && <MetaCell label="Category" value={lot.category} />}
              {lot.upc && <MetaCell label="UPC" value={lot.upc} />}
              {lot.asin && <MetaCell label="ASIN" value={lot.asin} />}
              {lot.mpn && <MetaCell label="MPN" value={lot.mpn} />}
              {lot.product_sku && <MetaCell label="Product SKU" value={lot.product_sku} />}
              {lot.site_sku && <MetaCell label="Site SKU" value={lot.site_sku} />}
              {lot.manufacture_sku && <MetaCell label="Mfr SKU" value={lot.manufacture_sku} />}
              {lot.fnsku && <MetaCell label="FNSKU" value={lot.fnsku} />}
              {lot.lpn && <MetaCell label="LPN" value={lot.lpn} />}
              {lot.msrp_cents && (
                <MetaCell label="MSRP" value={formatMoney(lot.msrp_cents)} />
              )}
            </div>

            {lot.description && (
              <div style={{ marginTop: '1.75rem' }}>
                <div style={metaLabel}>Description</div>
                <p style={{ fontSize: 14, lineHeight: 1.65, color: 'var(--fg-muted)' }}>
                  {lot.description}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Bid history — full-width below the two-col block */}
        <BidHistoryTable bids={bids} anonMap={anonMap} viewerBidderId={viewerBidderId} tz={tz} />

        {/* Similar lots carousel */}
        <SimilarLotsRail lots={similarLots} mode={similarLotsMode} />
      </div>
    </div>
  );
}

// ─── Bid panel ───────────────────────────────────────────────────────────────

function BidPanel({
  lot,
  signedIn,
  isOperatorOnOwnLot,
  hasBidderRow,
  hasCard,
  paymentsDisabled,
  unpaidFeesCents,
  viewerBidderId,
  timeZone,
  auctionStartsAt,
  prebidEnabled,
  incrementSchedule,
  operatorName,
}: {
  lot: LotRow;
  // auctionStatus was previously surfaced on BidPanel for parent-auction-
  // aware copy. We no longer use it (lot.status drives everything); kept
  // out of the type for now and easy to add back when per-auction copy
  // ships.
  signedIn: boolean;
  isOperatorOnOwnLot: boolean;
  hasBidderRow: boolean;
  hasCard: boolean;
  paymentsDisabled: boolean;
  unpaidFeesCents: number;
  /** Signed-in viewer's bidder id (== auth.uid()), or null for anon / SEO.
   *  Forwarded to BidWidget for the leader badge comparison only. */
  viewerBidderId: string | null;
  /** Auction's warehouse IANA zone for the "Closes" timestamp. */
  timeZone: string;
  /** Preview-B: parent auction's starts_at (ISO) for the "Bidding opens {time}"
   *  copy on scheduled lots. null when the lot has no auction or no start time. */
  auctionStartsAt: string | null;
  /** 0221: preview pre-bidding — scheduled lots become biddable. */
  prebidEnabled: boolean;
  /** BID-3 effective increment schedule (auction override ?? operator default).
   *  null → BidWidget uses the legacy ladder. */
  incrementSchedule: BidIncrementTier[] | null;
  /** Operator display name for the seller-policy dialog. */
  operatorName: string | null;
}) {
  // The web BidWidget owns the full bid surface (price + input + button +
  // realtime). We only render it for signed-in bidders who can actually
  // bid — operators-on-own-lot, anonymous visitors, and pre-onboarding
  // users see the legacy server-rendered panel with a context-appropriate
  // CTA. (Onboarding sends the user back to the lot via ?next= so the
  // BidWidget mounts once they're fully set up.)
  // Preview-B (2026-06-11): only LIVE lots mount the bid widget. Scheduled
  // lots stay visible for watchlisting but show "Bidding opens {time}".
  // 0221: a scheduled lot in a prebid-enabled auction mounts the widget too —
  // the engine accepts the bid, keeps the lot 'scheduled', and skips the
  // anti-snipe clock until the auction opens.
  const canRenderWidget =
    (lot.status === 'live' || (lot.status === 'scheduled' && prebidEnabled)) &&
    signedIn &&
    !isOperatorOnOwnLot &&
    hasBidderRow;

  if (canRenderWidget) {
    return (
      <BidWidget
        lot={{
          id: lot.id,
          lot_code: lot.lot_code,
          status: lot.status,
          starting_bid_cents: lot.starting_bid_cents,
          current_bid_cents: lot.current_bid_cents,
          bid_count: lot.bid_count,
          close_at: lot.close_at,
          winner_bidder_id: lot.winner_bidder_id,
        }}
        hasCard={hasCard}
        paymentsDisabled={paymentsDisabled}
        unpaidFeesCents={unpaidFeesCents}
        viewerBidderId={viewerBidderId}
        incrementSchedule={incrementSchedule}
        warehouseTz={timeZone}
        prebidEnabled={prebidEnabled}
        auctionStartsAt={auctionStartsAt}
        operatorId={lot.operator_id}
        operatorName={operatorName}
      />
    );
  }

  // Status-aware messaging. We keep the price up front for SEO + skim
  // readability regardless of biddability.
  const currentBid = lot.current_bid_cents ?? lot.starting_bid_cents;
  const bidCountCopy =
    lot.bid_count === 0 ? 'No bids yet' : `${lot.bid_count} bid${lot.bid_count === 1 ? '' : 's'}`;

  return (
    <div style={bidPanelBox}>
      <div style={{ fontSize: 12, color: 'var(--fg-dim)', textTransform: 'uppercase', letterSpacing: 1.5 }}>
        {lot.status === 'live' ? 'Current bid' : 'Starting bid'}
      </div>
      <div
        style={{
          fontSize: '2.25rem',
          fontWeight: 900,
          marginTop: 4,
          marginBottom: 6,
          letterSpacing: -1,
        }}
      >
        {formatMoney(currentBid)}
      </div>
      <div style={{ fontSize: 13, color: 'var(--fg-muted)', marginBottom: '1.25rem' }}>
        {bidCountCopy}
        {lot.close_at && lot.status === 'live' && (
          <>
            {' · '}Closes {formatInTimeZone(lot.close_at, timeZone)}
          </>
        )}
      </div>

      {renderCta({ lot, signedIn, isOperatorOnOwnLot, hasBidderRow, timeZone, auctionStartsAt, prebidEnabled })}
    </div>
  );
}

function renderCta({
  lot,
  signedIn,
  isOperatorOnOwnLot,
  hasBidderRow,
  timeZone,
  auctionStartsAt,
  prebidEnabled,
}: {
  lot: LotRow;
  // `auctionStatus` is intentionally not consumed by renderCta — the
  // lot.status field is the single source of truth for CTA selection
  // (lots get to 'scheduled'/'live'/'sold' independent of the parent
  // auction's lifecycle). Kept on BidPanel's typed contract above for
  // future per-auction copy.
  signedIn: boolean;
  isOperatorOnOwnLot: boolean;
  hasBidderRow: boolean;
  /** Auction's warehouse IANA zone for the "Bidding opens {time}" copy. */
  timeZone: string;
  /** 0221: preview pre-bidding — changes the scheduled-lot copy. */
  prebidEnabled: boolean;
  /** Preview-B: parent auction's starts_at (ISO) — drives the scheduled CTA. */
  auctionStartsAt: string | null;
}) {
  if (isOperatorOnOwnLot) {
    // 2026-07-05 fix: this pointed at /lot/{uuid} — the PUBLIC route, which
    // looks up by lot_code and 404s on a UUID. The console lot page (bid
    // history incl. proxy ceilings, audit trail) lives at /lots/{id}.
    return (
      <Link
        href={`/lots/${lot.id}`}
        className="btn-secondary"
        style={{ display: 'inline-block', padding: '0.75rem 1.5rem' }}
      >
        Manage in operator console
      </Link>
    );
  }

  if (lot.status === 'pending_intake' || lot.status === 'in_inventory') {
    return (
      <div>
        <p style={{ fontSize: 14, color: 'var(--fg-muted)', marginBottom: '1rem' }}>
          This lot isn&apos;t in an open auction yet. Sign up to add it to your watchlist —
          you&apos;ll be notified when bidding opens.
        </p>
        <Link
          href={signedIn ? '/browse' : `/signup?next=${encodeURIComponent(`/lot/${lot.lot_code}`)}`}
          className="btn-primary"
          style={{ display: 'inline-block', padding: '0.75rem 1.5rem' }}
        >
          {signedIn ? 'Browse auctions' : 'Sign up'}
        </Link>
      </div>
    );
  }

  if (lot.status === 'sold' || lot.status === 'closed' || lot.status === 'unsold') {
    return (
      <div style={{ fontSize: 14, color: 'var(--fg-muted)' }}>
        Bidding has ended. Browse the next auction for similar lots.
      </div>
    );
  }

  if (lot.status === 'scheduled') {
    const opensCopy = prebidEnabled
      ? `Pre-bidding is open now — the live auction starts ${
          auctionStartsAt ? formatDateTime(auctionStartsAt, timeZone) : 'soon'
        }`
      : auctionStartsAt
        ? `Bidding opens ${formatDateTime(auctionStartsAt, timeZone)}`
        : 'Bidding hasn’t opened yet';
    return (
      <div>
        <p style={{ fontSize: 14, color: 'var(--fg-muted)', marginBottom: '1rem' }}>
          {opensCopy}. {signedIn ? 'We’ll notify you the moment it opens.' : 'Sign up and we’ll notify you the moment it opens.'}
        </p>
        <Link
          href={signedIn ? '/browse' : `/signup?next=${encodeURIComponent(`/lot/${lot.lot_code}`)}`}
          className="btn-primary"
          style={{ display: 'inline-block', padding: '0.75rem 1.5rem' }}
        >
          {signedIn ? 'Browse live auctions' : 'Sign up'}
        </Link>
      </div>
    );
  }

  if (!signedIn) {
    // Anonymous + biddable: prefer "Sign up" as the primary CTA (web-
    // first growth), with a quieter "Sign in" affordance underneath.
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', alignItems: 'flex-start' }}>
        <Link
          href={`/signup?next=${encodeURIComponent(`/lot/${lot.lot_code}`)}`}
          className="btn-primary"
          style={{ display: 'inline-block', padding: '0.75rem 1.5rem' }}
        >
          Sign up to bid
        </Link>
        <Link
          href={`/login?next=${encodeURIComponent(`/lot/${lot.lot_code}`)}`}
          style={{ color: 'var(--fg-muted)', fontSize: 13, textDecoration: 'underline' }}
        >
          Already have an account? Sign in
        </Link>
      </div>
    );
  }

  // Signed in but no bidder row — they're either an operator on someone
  // else's lot (no bidder identity yet) or a fresh OAuth user who skipped
  // onboarding. Either way, send them to /bidder/onboarding with a return
  // path so they land back here.
  if (!hasBidderRow) {
    return (
      <div>
        <p style={{ fontSize: 14, color: 'var(--fg-muted)', marginBottom: '1rem' }}>
          Finish creating your bidder account to place a bid.
        </p>
        <Link
          href={`/bidder/onboarding?next=${encodeURIComponent(`/lot/${lot.lot_code}`)}`}
          className="btn-primary"
          style={{ display: 'inline-block', padding: '0.75rem 1.5rem' }}
        >
          Finish setup
        </Link>
      </div>
    );
  }

  // Fallback — shouldn't normally hit this branch because canRenderWidget
  // covered the bidder-row + biddable case. Defensive copy in case of
  // status edge cases we didn't enumerate.
  return (
    <div style={{ fontSize: 14, color: 'var(--fg-muted)' }}>
      Bidding isn&apos;t available right now.
    </div>
  );
}

// ─── Savings callout ─────────────────────────────────────────────────────────
//
// "SAVE 85%" pill + crossed-out retail price. Only renders when:
//   - msrp_cents > 0
//   - msrp_cents > current/starting bid
//   - The computed savings percent is >= 10% (smaller savings aren't a
//     compelling sales hook so we suppress the chrome).

function SavingsCallout({
  msrpCents,
  displayPriceCents,
}: {
  msrpCents: number | null;
  displayPriceCents: number;
}) {
  if (!msrpCents || msrpCents <= 0 || msrpCents <= displayPriceCents) {
    return null;
  }
  const savingsPct = Math.round((1 - displayPriceCents / msrpCents) * 100);
  if (savingsPct < 10) return null;

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '0.75rem',
        marginTop: '-0.5rem',
        marginBottom: '1.25rem',
      }}
    >
      <span
        aria-label={`Save ${savingsPct} percent off retail`}
        style={{
          background: 'var(--urgent-red)',
          color: '#fff',
          fontWeight: 800,
          fontSize: 12,
          letterSpacing: 0.5,
          textTransform: 'uppercase',
          padding: '4px 10px',
          borderRadius: 999,
        }}
      >
        SAVE {savingsPct}%
      </span>
      <span
        style={{
          fontSize: '0.9rem',
          color: 'var(--fg-muted)',
          textDecoration: 'line-through',
        }}
      >
        {formatMoney(msrpCents)}
      </span>
      <span style={{ fontSize: 11, color: 'var(--fg-dim)' }}>retail</span>
    </div>
  );
}

// ─── Pickup info card ────────────────────────────────────────────────────────
//
// Auction-end vs pickup-end deadlines are visually distinct so bidders
// don't confuse them. Bin assignment (aisle + bay) renders when present.
// "NOT TRANSFERRABLE" badge sits at the bottom of the card.
//
// Hidden entirely for lots that aren't in an auction (in_inventory /
// pending_intake): nothing useful to show.

function OffsitePickupBlock({
  pickupLoc,
  style,
}: {
  pickupLoc: WarehousePickupDescribed;
  style?: React.CSSProperties;
}) {
  return (
    <div
      style={{
        border: '1px solid var(--urgent-red)',
        background: 'rgba(255, 59, 59, 0.08)',
        borderRadius: 10,
        padding: '0.85rem 1rem',
        ...style,
      }}
    >
      {pickupLoc.notice && (
        <p style={{ margin: '0 0 0.65rem', fontSize: 14, fontWeight: 800, lineHeight: 1.45 }}>
          {pickupLoc.notice}
        </p>
      )}
      {pickupLoc.addressLines.length > 0 && (
        <div style={pickupRow}>
          <span style={pickupLabel}>Pickup location</span>
          <span style={{ ...pickupValue, textAlign: 'right' }}>
            {pickupLoc.addressLines.map((line, i) => (
              <span key={i}>
                {line}
                {i < pickupLoc.addressLines.length - 1 ? <br /> : null}
              </span>
            ))}
          </span>
        </div>
      )}
      {pickupLoc.directionsUrl && (
        <div style={{ marginTop: 6, marginBottom: 4 }}>
          <a
            href={pickupLoc.directionsUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{ fontSize: 13, fontWeight: 700, color: 'var(--accent)' }}
          >
            Get directions
          </a>
        </div>
      )}
      {pickupLoc.hoursLines.length > 0 && (
        <div style={pickupRow}>
          <span style={pickupLabel}>Pickup hours</span>
          <span style={{ ...pickupValue, textAlign: 'right' }}>
            {pickupLoc.hoursLines.map((line, i) => (
              <span key={line}>
                {line}
                {i < pickupLoc.hoursLines.length - 1 ? <br /> : null}
              </span>
            ))}
          </span>
        </div>
      )}
      {pickupLoc.instructions && (
        <p style={{ margin: '0.65rem 0 0', fontSize: 13, color: 'var(--fg-muted)', lineHeight: 1.5 }}>
          {pickupLoc.instructions}
        </p>
      )}
    </div>
  );
}

function PickupInfoCard({
  lot,
  pickupEndsAt,
  binLocation,
  timeZone,
  pickupLoc,
}: {
  lot: LotRow;
  pickupEndsAt: string | null;
  binLocation: {
    aisle: string | null;
    bay: string | null;
    code: string | null;
    kind: 'pickup' | 'shelf';
  } | null;
  /** Auction's warehouse IANA zone for the "Auction ends" / "Pickup by" rows. */
  timeZone: string;
  pickupLoc: WarehousePickupDescribed;
}) {
  const hasAuction = lot.auction_id !== null;
  if (!hasAuction) return null;

  const auctionEndCopy = lot.close_at ? formatDateTime(lot.close_at, timeZone) : '—';
  const pickupEndCopy = pickupEndsAt ? formatDateTime(pickupEndsAt, timeZone) : '—';
  const aisleBay = binLocation ? formatBinLocation(binLocation) : null;

  // M4: live ticking countdown beneath the absolute "Auction ends" time.
  // Preview-B (2026-06-11): render the ticking pill for LIVE lots only — a
  // scheduled lot must not look live (no ticking timer; renderCta shows
  // "Bidding opens {time}" instead). Still guarded on close_at, and
  // LotCountdown itself returns null once the time elapses.
  const showCountdown = !!lot.close_at && lot.status === 'live';

  return (
    <div
      style={{
        background: 'var(--bg-elev)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        padding: '1.1rem 1.25rem',
        marginBottom: '1.5rem',
      }}
    >
      {pickupLoc.isOffsite && (
        <OffsitePickupBlock pickupLoc={pickupLoc} style={{ marginBottom: '1rem' }} />
      )}
      <div style={pickupRow}>
        <span style={pickupLabel}>Auction ends</span>
        <span style={pickupValue}>{auctionEndCopy}</span>
      </div>
      {/* M4: live ticking countdown beneath the absolute "Auction ends" time.
          LotCountdown is absolutely positioned (it's the photo-overlay pill),
          so it needs a positioned, fixed-height host to render inline here. */}
      {showCountdown && lot.close_at && (
        <div
          style={{
            position: 'relative',
            height: 32,
            marginTop: 4,
            marginBottom: 4,
          }}
        >
          <LotCountdown closeAt={lot.close_at} />
        </div>
      )}
      <div style={pickupRow}>
        <span style={pickupLabel}>Pickup by</span>
        <span style={pickupValue}>{pickupEndCopy}</span>
      </div>
      {aisleBay && (
        <div style={pickupRow}>
          <span style={pickupLabel}>
            {binLocation?.kind === 'shelf' ? 'Item location' : 'Pick up from'}
          </span>
          <span style={pickupValue}>{aisleBay}</span>
        </div>
      )}
      {binLocation?.kind === 'shelf' && aisleBay && (
        <p style={{ fontSize: 12, color: 'var(--fg-dim)', margin: '2px 0 0', lineHeight: 1.5 }}>
          Previewing in person? Find this item at the location above — it updates
          automatically if staff move it.
        </p>
      )}

      <div style={{ marginTop: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
        <span
          style={{
            background: 'rgba(255, 59, 59, 0.12)',
            color: 'var(--urgent-red)',
            fontSize: 11,
            fontWeight: 800,
            letterSpacing: 0.5,
            textTransform: 'uppercase',
            padding: '4px 10px',
            borderRadius: 999,
          }}
        >
          Not Transferrable
        </span>
      </div>
      <p style={{ fontSize: 12, color: 'var(--fg-dim)', marginTop: 6, lineHeight: 1.5 }}>
        All items must be picked up in person at the operator&rsquo;s warehouse. ID may be
        required.
      </p>
    </div>
  );
}

// ─── Bid history table ───────────────────────────────────────────────────────
//
// Anonymizes bidder identities to "Bidder #N" with stable per-page mapping
// (lowest bidder_id alphabetically → #1). The current viewer's own bids
// render as "YOU" so they can locate themselves in the action.
//
// The first 15 rows render inline; the rest live inside a <details>
// element so users opt in to the long history without any client JS.

function buildAnonMap(
  bids: BidRow[],
  viewerBidderId: string | null,
  // mig 0254: permanent account numbers. Preferred when present; the
  // per-page sequence below only labels rows missing one (legacy edge).
  persistentNumbers?: Map<string, number>,
): Map<string, number> {
  const uniqueBidderIds = Array.from(new Set(bids.map((b) => b.bidder_id)));
  // Sort deterministically (alphabetical) so the fallback mapping is stable
  // across renders / page navigations until a new unique bidder shows up.
  uniqueBidderIds.sort();
  const map = new Map<string, number>();
  let nextNumber = 1;
  for (const id of uniqueBidderIds) {
    if (id === viewerBidderId) continue; // The viewer renders as YOU, not a number.
    const persistent = persistentNumbers?.get(id);
    if (persistent !== undefined) {
      map.set(id, persistent);
    } else {
      map.set(id, nextNumber);
      nextNumber += 1;
    }
  }
  return map;
}

function BidHistoryTable({
  bids,
  anonMap,
  viewerBidderId,
  tz,
}: {
  bids: BidRow[];
  anonMap: Map<string, number>;
  viewerBidderId: string | null;
  tz: string;
}) {
  const INITIAL = 15;
  const visible = bids.slice(0, INITIAL);
  const overflow = bids.slice(INITIAL);

  return (
    <section style={{ marginTop: '2.5rem' }}>
      <div style={{ ...metaLabel, marginBottom: 12 }}>Bid History</div>
      {bids.length === 0 ? (
        <p style={{ fontSize: 14, color: 'var(--fg-muted)' }}>
          No bids yet — be the first!
        </p>
      ) : (
        <div
          className="bid-history"
          style={{
            background: 'var(--bg-elev)',
            border: '1px solid var(--border)',
            borderRadius: 12,
            overflow: 'hidden',
          }}
        >
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: 13,
            }}
          >
            <thead>
              <tr style={bidHeaderRow}>
                <th style={bidHeadCell}>#</th>
                <th style={bidHeadCell}>Amount</th>
                <th className="bid-history-date" style={bidHeadCell}>
                  Date
                </th>
                <th style={bidHeadCell}>Time</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((bid) => (
                <BidRowView
                  key={bid.id}
                  bid={bid}
                  anonMap={anonMap}
                  viewerBidderId={viewerBidderId}
                  tz={tz}
                />
              ))}
              {overflow.length > 0 && (
                <tr>
                  <td colSpan={5} style={{ padding: 0 }}>
                    <details>
                      <summary
                        style={{
                          padding: '0.7rem 1rem',
                          fontSize: 13,
                          color: 'var(--accent)',
                          cursor: 'pointer',
                          background: 'var(--bg-elev-2)',
                          listStyle: 'none',
                        }}
                      >
                        Show all ({bids.length})
                      </summary>
                      <table
                        style={{
                          width: '100%',
                          borderCollapse: 'collapse',
                          fontSize: 13,
                        }}
                      >
                        <tbody>
                          {overflow.map((bid) => (
                            <BidRowView
                              key={bid.id}
                              bid={bid}
                              anonMap={anonMap}
                              viewerBidderId={viewerBidderId}
                              tz={tz}
                            />
                          ))}
                        </tbody>
                      </table>
                    </details>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {/* Narrow-mobile: hide Date column to keep the row compact. */}
      <style>{`
        @media (max-width: 480px) {
          .bid-history .bid-history-date { display: none; }
        }
      `}</style>
    </section>
  );
}

function BidRowView({
  bid,
  anonMap,
  viewerBidderId,
  tz,
}: {
  bid: BidRow;
  anonMap: Map<string, number>;
  viewerBidderId: string | null;
  tz: string;
}) {
  const isYou = viewerBidderId !== null && bid.bidder_id === viewerBidderId;
  // 2026-07-05: bid TYPE is private. Your own rows show "(auto)" so you can
  // tell when your proxy acted; other bidders' rows never reveal whether a
  // human or a proxy placed the bid (that's snipe-target intel).
  const anonLabel = isYou
    ? bid.is_auto
      ? 'YOU (auto)'
      : 'YOU'
    : `Bidder #${anonMap.get(bid.bidder_id) ?? '?'}`;
  // Force the warehouse zone — a bare toLocale* here runs on the UTC SSR
  // runtime, so a 6 PM Central bid (stored 00:00 UTC in winter) printed as
  // "12:00 AM". Customers were confused (2026-07-13 feedback). Mirrors the
  // already-correct operator lot/bidder pages.
  const dateStr = formatDateInTimeZone(bid.placed_at, tz);
  const timeStr = formatTimeInTimeZone(bid.placed_at, tz);

  return (
    <tr style={{ borderTop: '1px solid var(--border)' }}>
      <td style={{ ...bidCell, fontWeight: isYou ? 800 : 600, color: isYou ? 'var(--accent)' : 'var(--fg)' }}>
        {anonLabel}
      </td>
      <td style={{ ...bidCell, fontWeight: 700 }}>{formatMoney(bid.amount_cents)}</td>
      <td className="bid-history-date" style={{ ...bidCell, color: 'var(--fg-muted)' }}>
        {dateStr}
      </td>
      <td style={{ ...bidCell, color: 'var(--fg-muted)' }}>{timeStr}</td>
    </tr>
  );
}

// ─── Similar lots carousel ───────────────────────────────────────────────────
//
// Horizontal scroll, scroll-snap, native overflow. Title adapts to the
// fallback tier the loader picked.

function SimilarLotsRail({
  lots,
  mode,
}: {
  lots: SimilarLotRow[];
  mode: 'same-auction-category' | 'same-auction' | 'same-category' | 'none';
}) {
  if (lots.length === 0 || mode === 'none') return null;

  const title =
    mode === 'same-auction-category' || mode === 'same-auction'
      ? 'More from this auction'
      : 'Similar lots';

  return (
    <section style={{ marginTop: '3rem' }}>
      <h2
        style={{
          fontSize: '1.15rem',
          fontWeight: 800,
          letterSpacing: -0.3,
          marginBottom: '1rem',
        }}
      >
        {title}
      </h2>
      <div
        className="similar-rail"
        style={{
          display: 'flex',
          gap: '0.85rem',
          overflowX: 'auto',
          scrollSnapType: 'x mandatory',
          paddingBottom: '0.5rem',
          WebkitOverflowScrolling: 'touch',
        }}
      >
        {lots.map((l) => {
          const lotCardLot: LotCardLot = {
            id: l.id,
            lot_code: l.lot_code,
            title: l.title,
            photo_urls: l.photo_urls,
            current_bid_cents: l.current_bid_cents,
            starting_bid_cents: l.starting_bid_cents,
            close_at: l.close_at,
            bid_count: l.bid_count,
            condition: l.condition,
            msrp_cents: l.msrp_cents,
            // Preview-B: scheduled similar lots show "Upcoming", not a live countdown.
            status: l.status,
          };
          return (
            <div
              key={l.lot_code}
              style={{
                flex: '0 0 200px',
                minWidth: 200,
                scrollSnapAlign: 'start',
              }}
            >
              <LotCard lot={lotCardLot} />
            </div>
          );
        })}
      </div>
      <style>{`
        @media (min-width: 768px) {
          .similar-rail::-webkit-scrollbar { display: none; }
          .similar-rail { scrollbar-width: none; }
        }
      `}</style>
    </section>
  );
}

// ─── Small components ────────────────────────────────────────────────────────

function MetaCell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div style={metaLabel}>{label}</div>
      <div style={{ fontSize: 14, color: 'var(--fg)' }}>{value}</div>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatMoney(cents: number | null | undefined): string {
  if (cents == null) return '—';
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Renders an absolute timestamp in the auction's warehouse zone (was a bare
// toLocaleString that printed SSR-runtime UTC). Defaults to the shared
// month/day/year/hour/minute + short-zone-abbreviation format.
function formatDateTime(iso: string, timeZone: string): string {
  return formatInTimeZone(iso, timeZone);
}

function formatBinLocation(loc: {
  aisle: string | null;
  bay: string | null;
  code: string | null;
}): string {
  const parts: string[] = [];
  if (loc.aisle) parts.push(`Aisle ${loc.aisle}`);
  if (loc.bay) parts.push(`Bay ${loc.bay}`);
  if (parts.length === 0) return loc.code ?? '';
  // Physical bins are labeled with the code — include it so a preview
  // customer can match the shelf tag, not just the aisle.
  return loc.code ? `${parts.join(', ')} · ${loc.code}` : parts.join(', ');
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const pageWrap: React.CSSProperties = {
  padding: '2.5rem 1.5rem 5rem',
};

const innerWrap: React.CSSProperties = {
  maxWidth: MAX_W,
  margin: '0 auto',
};

const twoCol: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr',
  gap: '1.5rem',
  alignItems: 'start',
};

const breadcrumbLink: React.CSSProperties = {
  color: 'var(--fg-muted)',
  textDecoration: 'none',
};

const bidPanelBox: React.CSSProperties = {
  background: 'var(--bg-elev-2)',
  border: '1px solid var(--border)',
  borderRadius: 12,
  padding: '1.5rem',
  marginBottom: '1.5rem',
};

const metaGrid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
  gap: '1rem',
  marginTop: '1.75rem',
};

const metaLabel: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: 1.5,
  color: 'var(--fg-dim)',
  marginBottom: 4,
};

const pickupRow: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'baseline',
  gap: 12,
  padding: '6px 0',
};

const pickupLabel: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--fg-muted)',
  textTransform: 'uppercase',
  letterSpacing: 1,
};

const pickupValue: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 700,
  color: 'var(--fg)',
  textAlign: 'right',
};

const bidHeaderRow: React.CSSProperties = {
  background: 'var(--bg-elev-2)',
};

const bidHeadCell: React.CSSProperties = {
  textAlign: 'left',
  padding: '0.55rem 0.85rem',
  fontSize: 11,
  fontWeight: 700,
  textTransform: 'uppercase',
  letterSpacing: 1,
  color: 'var(--fg-dim)',
};

const bidCell: React.CSSProperties = {
  padding: '0.55rem 0.85rem',
  fontSize: 13,
};
