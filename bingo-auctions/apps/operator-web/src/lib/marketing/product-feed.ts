// Meta (Facebook/Instagram) commerce catalog feed for BinGo lots.
//
// Marketing wants to run Advantage+ / dynamic product ads against live lots.
// Meta's catalog is fed by a URL it polls on a schedule, so this is a PULL
// model: there is no cron, no sync job, and no stored mirror of the catalog.
// The feed renders current DB state at fetch time, which is what makes the
// hard requirement — "an ad must never point at a closed auction" — hold by
// construction rather than by a job that has to be remembered.
//
// ── How takedown actually works ──────────────────────────────────────────
// Simply dropping a row is a WEAK signal: Meta treats a missing row as
// "unchanged, maybe the feed is partial" for a while before expiring it, so
// a closed lot can keep serving ads for hours. An explicit
// `availability: out of stock` is the strong signal — Meta stops delivery on
// the next fetch. So a lot that has closed is not dropped; it is emitted for
// FEED_TAIL_DAYS with availability=out of stock and
// quantity_to_sell_on_facebook=0, and only then falls out of the feed
// entirely, by which point Meta has long since stopped serving it.
//
// That means the worst case is bounded by Meta's fetch interval, not by us.
// Set the catalog's schedule to hourly (Commerce Manager -> Catalog -> Data
// sources -> Scheduled feed) — see docs at the route.
//
// ── Why /l/{qr_token} links ──────────────────────────────────────────────
// `lotShareUrl` returns the short form, which is the only path both the iOS
// AASA and the Android assetlinks file claim. A tap from an ad therefore
// opens the app for users who have it and falls back to the web lot page for
// everyone else. Linking /lot/{code} directly would silently lose that.

import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { getDemoOperatorIds, demoExclusionList } from '@/lib/demo-operators';
import { cdnImageUrl } from '@/lib/img-proxy';
import { lotShareUrl } from '@/lib/app-links';

/** How long a closed lot keeps being emitted as out-of-stock before it is
 *  dropped. A couple of days covers a missed or failed fetch; longer just
 *  bloats the feed with items Meta has already stopped serving. */
export const FEED_TAIL_DAYS = 3;

/**
 * How close to its close time a lot stops being advertised as available.
 *
 * ── THE PROBLEM THIS SOLVES ──────────────────────────────────────────────
 * `price` is the CURRENT BID (see bidPriceCents), and Meta only learns it when
 * it next fetches — hourly at best. So the advertised price is a snapshot, and
 * the question is how wrong that snapshot gets.
 *
 * Measured against seven days of prod bids rather than assumed:
 *
 *   - 1,385 open lots; about 42 of them take a bid in any given hour (peak
 *     186). So on a quiet lot the snapshot is right ~97% of the time, which is
 *     fine for a catalog and not worth engineering away.
 *   - But 23.6% of ALL bids land in the final 60 minutes, and 16.6% in the
 *     final 15. A quarter of every price movement happens inside the one
 *     window an hourly feed cannot see.
 *
 * That endgame is where both failures land at once: the price on the ad is
 * stale by the largest margin it will ever be, and the lot then CLOSES before
 * the next fetch — so it keeps being served as in-stock, at a price nobody can
 * pay any more, until Meta comes back. A click in that window costs money and
 * lands on a page that disagrees with the ad, which is also what gets items
 * flagged for price mismatch.
 *
 * ── WHY OUT-OF-STOCK AND NOT DROPPED ─────────────────────────────────────
 * Same reason a closed lot is not dropped (see the header): a missing row is a
 * weak signal Meta sits on for hours, while `availability: out of stock` stops
 * delivery on the next fetch. So a lot in its endgame stays in the feed and is
 * marked unavailable — it just stops being advertised.
 *
 * ── WHY 90 MINUTES ───────────────────────────────────────────────────────
 * It has to exceed the fetch interval, or a lot can still close inside the
 * gap. Hourly fetches do not land exactly on the hour, so 60 would leave no
 * margin for jitter; 90 covers an hour plus a half-hour of slack.
 *
 * The cost is small and self-limiting. Lots close in staggered waves of
 * roughly 100–138 per auction spread over 45–91 minutes, so this withholds
 * about 7% of the feed for an hour or so around a close, and nothing at all
 * the rest of the time — while those lots are exactly the ones whose
 * advertised price is about to be wrong.
 */
export const FEED_CLOSING_SOON_MINUTES = 90;

/** Supabase caps a single select at 1000 rows; the live catalog is ~1800. */
const PAGE = 1000;

/**
 * Auction statuses whose lots belong in the feed.
 *
 * The `auction_status` enum is exactly: draft, scheduled, live, closed,
 * canceled (verified against prod 2026-08-07). This list previously contained
 * "ended", which is NOT a member — PostgREST rejected the whole query with
 * `22P02 invalid input value for enum auction_status`, so the feed returned
 * 500 on every request from the moment it shipped. Any change here must be
 * checked against the enum, not guessed from the word that sounds right.
 *
 * `draft` is excluded: those auctions were never public.
 *
 * `canceled` is deliberately INCLUDED. Its lots are closed, so `toFeedRow`
 * emits them as out-of-stock — which is the strong takedown signal. Excluding
 * canceled auctions would instead make their lots silently vanish from the
 * feed, which is the weak signal this whole design exists to avoid.
 */
export const FEED_AUCTION_STATUSES = ['scheduled', 'live', 'closed', 'canceled'] as const;

/** Meta rejects a row with no image, so lots without a photo are skipped. */
export type FeedLot = {
  id: string;
  lot_code: string | null;
  qr_token: string | null;
  title: string | null;
  description: string | null;
  condition: string | null;
  status: string | null;
  photo_urls: string[] | null;
  current_bid_cents: number | null;
  starting_bid_cents: number | null;
  msrp_cents: number | null;
  close_at: string | null;
  /** Denormalised counter on lots, maintained as bids land. Verified against
   *  prod: of 787 live lots it disagrees with a COUNT(*) over `bids` on 96,
   *  but never in the direction that matters — there is not one lot where it
   *  says 0 and bids exist, nor the reverse. So the has-activity / no-activity
   *  boundary this feeds is exact, and the higher buckets are conservative. */
  bid_count: number | null;
  // Selected via an `auctions!inner` embed, so the visibility columns come
  // back alongside the title even though only the title is rendered.
  auctions: {
    title: string | null;
    status?: string | null;
    unlisted?: boolean | null;
    operator_id?: string | null;
  } | null;
  categories: { name: string | null } | null;
};

/** One CSV record. Keys are Meta's column names — do not rename. */
export type FeedRow = Record<string, string>;

/** Column order of the emitted CSV. Meta matches on the header row, so the
 *  order is cosmetic, but a stable order keeps diffs readable. */
export const FEED_COLUMNS = [
  'id',
  'title',
  'description',
  'availability',
  'condition',
  'price',
  'link',
  'image_link',
  'additional_image_link',
  'brand',
  'product_type',
  'quantity_to_sell_on_facebook',
  'custom_label_0',
  'custom_label_1',
  'custom_label_2',
  'custom_label_3',
] as const;

/**
 * BinGo's condition enum -> Meta's, which allows only new/refurbished/used.
 *
 * `appears_new` and `open_box` are customer-returns that were never used, so
 * they map to `new`. `good` and `as_is` map to `used`. Nothing maps to
 * `refurbished` — BinGo does not refurbish. An unknown value falls back to
 * `used`, which is the conservative direction: overstating condition is what
 * draws Meta policy strikes and chargebacks.
 */
export function metaCondition(condition: string | null | undefined): string {
  switch (condition) {
    case 'appears_new':
    case 'open_box':
      return 'new';
    case 'good':
    case 'as_is':
      return 'used';
    default:
      return 'used';
  }
}

/** Cents -> Meta's "12.99 USD". Meta rejects 0, so anything at or below zero
 *  is floored to one cent rather than emitting an invalid row. */
export function formatPrice(cents: number | null | undefined): string {
  const c = Math.max(1, Math.round(cents ?? 0));
  return `${(c / 100).toFixed(2)} USD`;
}

/**
 * The advertised price.
 *
 * Deliberately the CURRENT BID, not MSRP. Meta requires `price` to be what
 * the buyer actually transacts at, and an ad showing a $250 retail value for
 * an item currently bid at $1 is the kind of thing that gets a catalog
 * flagged for misrepresentation. Retail value is honest context, so it goes
 * in the description as text, never in `price` or `sale_price`.
 */
export function bidPriceCents(lot: FeedLot): number {
  return lot.current_bid_cents ?? lot.starting_bid_cents ?? 0;
}

const CONDITION_LABEL: Record<string, string> = {
  appears_new: 'Appears new',
  open_box: 'Open box',
  good: 'Good',
  as_is: 'As-is',
};

/**
 * Order photos so self-hosted ones come first, preserving relative order.
 *
 * Found by reading real rows: plenty of lots still carry a retail-CDN hotlink
 * (m.media-amazon.com/...) as photo #1 with our own re-hosted copy at #2. Two
 * problems if that leads: Meta's crawler is routinely 403'd by those CDNs, so
 * the item gets rejected for a broken image_link, and running someone else's
 * product photography as our ad creative is a policy risk we don't need to
 * take when we have our own copy sitting right there.
 *
 * `cdnImageUrl` only rewrites buckets we own, so "did it change?" is exactly
 * the "is this ours?" test — no second source of truth to keep in sync.
 */
export function orderPhotosForAds(photos: string[]): string[] {
  const ours: string[] = [];
  const theirs: string[] = [];
  for (const url of photos) {
    (cdnImageUrl(url) !== url ? ours : theirs).push(url);
  }
  return [...ours, ...theirs];
}

/** Meta truncates at 200 (title) / 9999 (description); trim on a word so the
 *  copy doesn't end mid-token. */
export function clampText(value: string, max: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * What the copy has to say about this lot right now.
 *
 * Three states, not two. Withholding a closing lot from delivery made a
 * boolean wrong: 'closing' is NOT advertisable (its price is about to move and
 * it will be shut before the next fetch) but it has emphatically not ended,
 * and describing it as ended would be a lie visible to anyone who reaches the
 * catalog entry — the exact class of "the data was right, the sentence was
 * wrong" bug the staff app has been paying down all week.
 */
type FeedState = 'open' | 'closing' | 'ended';

function buildDescription(lot: FeedLot, state: FeedState): string {
  const parts: string[] = [];
  const base = (lot.description ?? '').trim();
  if (base) parts.push(base);

  const conditionLabel = CONDITION_LABEL[lot.condition ?? ''] ?? null;
  if (conditionLabel) parts.push(`Condition: ${conditionLabel}.`);

  if (lot.msrp_cents && lot.msrp_cents > 0) {
    parts.push(`Estimated retail value $${(lot.msrp_cents / 100).toFixed(2)}.`);
  }

  parts.push(
    state === 'open'
      ? 'Online auction — place your bid before this lot closes. Local pickup at BinGo Auctions.'
      : state === 'closing'
        ? // No price in this sentence on purpose: this lot is in the window
          // where a quarter of all bidding happens, so any figure quoted here
          // is the one most likely to be wrong by the time it is read.
          'Closing soon — bidding ends shortly. Open the listing for the current bid.'
        : 'This auction has ended.',
  );

  return clampText(parts.join(' '), 9999);
}

/**
 * How well a category actually does, as `category_demand_tiers()` grades it.
 * See migration 0343 for the measurement and the thresholds.
 */
export type DemandTier = 'proven' | 'steady' | 'slow' | 'unproven';

/** category name (lowercased) -> tier. Keyed by NAME rather than id because
 *  that is what the feed row already carries as product_type; the join to
 *  categories happens once, in SQL. */
export type DemandTiers = Map<string, DemandTier>;

const TIER_VALUES = new Set<string>(['proven', 'steady', 'slow', 'unproven']);

/**
 * Read the category ranking.
 *
 * Never throws. A feed that 500s makes Meta retain the previous catalog, which
 * is the right failure for a closed lot still showing as in-stock — but this
 * label is an optimisation, and losing the whole catalog because a ranking
 * query timed out would be trading a real outcome for a nice-to-have. On
 * failure every lot simply gets `unproven`, and the ads keep running.
 */
export async function loadDemandTiers(): Promise<DemandTiers> {
  const tiers: DemandTiers = new Map();
  try {
    const { data, error } = await getSupabaseAdmin().rpc('category_demand_tiers');
    if (error) {
      console.warn('[meta-catalog] demand tiers unavailable:', error.message);
      return tiers;
    }
    for (const row of (data ?? []) as Array<{ name?: string | null; tier?: string | null }>) {
      const name = row.name?.trim().toLowerCase();
      if (name && row.tier && TIER_VALUES.has(row.tier)) {
        tiers.set(name, row.tier as DemandTier);
      }
    }
  } catch (err) {
    console.warn('[meta-catalog] demand tiers threw:', (err as Error).message);
  }
  return tiers;
}

/**
 * This lot's own bidding, bucketed — custom_label_3.
 *
 * Category demand (label 2) is a prior; this is the evidence. It is the label
 * that answers "push the things people are already bidding on", and it is
 * category-blind on purpose: a grill in a category with too few closings to
 * rank is invisible to label 2, but if six people are bidding on it right now
 * that is worth more than any average.
 *
 * Buckets rather than the raw number because Meta product-set rules match on
 * exact string equality — a rule per integer is unusable, four is a filter.
 * `bids-0` is emitted rather than left blank so "no bids yet" can be targeted
 * (or excluded) explicitly; an empty label matches nothing.
 */
export function bidActivityLabel(bidCount: number | null | undefined): string {
  const n = Math.max(0, Math.round(bidCount ?? 0));
  if (n === 0) return 'bids-0';
  if (n <= 2) return 'bids-1-2';
  if (n <= 5) return 'bids-3-5';
  return 'bids-6-plus';
}

/**
 * Map one lot row to a feed record, or null if it can't be advertised.
 *
 * `now` is injected so the open/closed boundary is testable and so every row
 * in a single render is judged against the same instant. `tiers` defaults to
 * empty, which yields `unproven` — the safe reading of "we don't know".
 */
export function toFeedRow(lot: FeedLot, now: Date, tiers: DemandTiers = new Map()): FeedRow | null {
  const title = (lot.title ?? '').trim();
  if (!title) return null;

  // Meta requires image_link. A lot with no photo is dropped rather than
  // emitted with a placeholder, which would be a bad ad anyway.
  const photos = orderPhotosForAds(
    (lot.photo_urls ?? []).filter((u) => typeof u === 'string' && u.trim()),
  );
  if (photos.length === 0) return null;

  const closeAt = lot.close_at ? new Date(lot.close_at) : null;
  if (!closeAt || Number.isNaN(closeAt.getTime())) return null;

  // Open means BOTH the clock and the lot status agree. Status alone lags a
  // few minutes behind the close (the close worker runs on an interval), and
  // the clock alone would keep advertising a lot that was pulled early.
  const stillRunning =
    closeAt.getTime() > now.getTime() && (lot.status === 'live' || lot.status === 'scheduled');

  // ...and "advertisable" is narrower than "running": a lot inside its final
  // FEED_CLOSING_SOON_MINUTES will have closed, or moved a long way in price,
  // before Meta fetches again. Advertising it means paying for clicks that
  // land on a price nobody can pay. See FEED_CLOSING_SOON_MINUTES.
  const closingSoon =
    closeAt.getTime() - now.getTime() <= FEED_CLOSING_SOON_MINUTES * 60_000;

  const isOpen = stillRunning && !closingSoon;
  const state: FeedState = isOpen ? 'open' : stillRunning ? 'closing' : 'ended';

  return {
    // The lot's UUID, not its lot_code. A relist mints a NEW lot row, which is
    // genuinely a new listing with its own photos and price — reusing the code
    // would make Meta overwrite the old item's stats with the new one's.
    id: lot.id,
    title: clampText(title, 200),
    description: buildDescription(lot, state),
    availability: isOpen ? 'in stock' : 'out of stock',
    condition: metaCondition(lot.condition),
    price: formatPrice(bidPriceCents(lot)),
    link: lotShareUrl({ qr_token: lot.qr_token, lot_code: lot.lot_code }),
    // Absolute + through the /img proxy: Meta fetches these from its own
    // crawlers, repeatedly, and unproxied Supabase storage bills egress per
    // byte (see lib/img-proxy).
    image_link: cdnImageUrl(photos[0]!, { absolute: true }),
    additional_image_link: photos
      .slice(1, 11)
      .map((u) => cdnImageUrl(u, { absolute: true }))
      .join(','),
    brand: 'BinGo Auctions',
    product_type: lot.categories?.name ?? '',
    // 0 is a second, independent stop signal alongside availability.
    quantity_to_sell_on_facebook: isOpen ? '1' : '0',
    custom_label_0: lot.auctions?.title ?? '',
    custom_label_1: closeAt.toISOString().slice(0, 10),
    // The two labels that let Meta pick items on its own. A product set on
    // custom_label_2 = proven is ~200 live lots at any moment, refreshed
    // hourly, in the ten categories that measurably draw bidders; one on
    // custom_label_3 = bids-6-plus is whatever is hot right now regardless of
    // category. See migration 0343 and bidActivityLabel.
    custom_label_2: tiers.get((lot.categories?.name ?? '').trim().toLowerCase()) ?? 'unproven',
    custom_label_3: bidActivityLabel(lot.bid_count),
  };
}

/**
 * Fetch every lot that belongs in the feed: open lots from listed, non-demo
 * auctions, plus lots that closed within the tail window so their takedown is
 * announced rather than implied.
 *
 * Visibility is enforced through an `auctions!inner` embed rather than by
 * fetching auction ids first and passing them to `.in()`. The two-step version
 * put every matching auction id in the query string — 125 UUIDs (~4.6KB) today,
 * but auctions only accumulate, so that URL grows without bound until
 * PostgREST or the edge rejects it. Filtering on the embedded table is O(1) in
 * auction count; the only thing that pages is lots, which is already bounded
 * by the tail window.
 */
export async function loadFeedLots(now: Date): Promise<FeedLot[]> {
  const supabase = getSupabaseAdmin();

  // Same visibility rules as /browse — an ad must never surface a lot a
  // customer couldn't have found on the site.
  const demoExclude = demoExclusionList(await getDemoOperatorIds());
  const tailStart = new Date(now.getTime() - FEED_TAIL_DAYS * 86_400_000).toISOString();

  const rows: FeedLot[] = [];
  for (let from = 0; ; from += PAGE) {
    let query = supabase
      .from('lots')
      .select(
        'id, lot_code, qr_token, title, description, condition, status, photo_urls, ' +
          'current_bid_cents, starting_bid_cents, msrp_cents, close_at, bid_count, ' +
          'auctions!inner(title, status, unlisted, operator_id), categories(name)',
      )
      .is('deleted_at', null)
      .gt('close_at', tailStart)
      .eq('auctions.unlisted', false)
      .in('auctions.status', FEED_AUCTION_STATUSES)
      .order('close_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (demoExclude) query = query.not('auctions.operator_id', 'in', demoExclude);

    const { data, error } = await query;
    if (error) throw new Error(`feed: lots query failed — ${error.message}`);
    const page = (data ?? []) as unknown as FeedLot[];
    rows.push(...page);
    if (page.length < PAGE) break;
  }

  return rows;
}

/** RFC 4180: quote every field, double any embedded quote. Titles routinely
 *  contain commas and quotes (`24" Monitor, Black`), so unquoted output would
 *  corrupt the column count. */
export function csvEscape(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

export function toCsv(rows: FeedRow[]): string {
  const lines = [FEED_COLUMNS.join(',')];
  for (const row of rows) {
    lines.push(FEED_COLUMNS.map((c) => csvEscape(row[c] ?? '')).join(','));
  }
  // Trailing newline: some parsers drop the final record without it.
  return `${lines.join('\n')}\n`;
}

/** Build the whole feed. Returns the CSV plus counts for observability. */
export async function buildMetaFeed(
  now: Date = new Date(),
): Promise<{
  csv: string;
  total: number;
  inStock: number;
  skipped: number;
  /** In-stock rows in a proven category — the size of the ad product set. */
  proven: number;
}> {
  // Both queries at once: the ranking does not depend on which lots are live,
  // and Meta fetches this on a schedule it does not tell us about, so the
  // wall-clock cost of a serial second round trip buys nothing.
  const [lots, tiers] = await Promise.all([loadFeedLots(now), loadDemandTiers()]);
  const rows: FeedRow[] = [];
  let skipped = 0;

  for (const lot of lots) {
    const row = toFeedRow(lot, now, tiers);
    if (row) rows.push(row);
    else skipped++;
  }

  return {
    csv: toCsv(rows),
    total: rows.length,
    inStock: rows.filter((r) => r.availability === 'in stock').length,
    skipped,
    proven: rows.filter((r) => r.availability === 'in stock' && r.custom_label_2 === 'proven')
      .length,
  };
}
