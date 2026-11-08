// Post composition — pure functions, no network, no credentials.
//
// Split out from the Graph client on purpose: this is the half that decides
// what the world sees, and it should be reviewable and testable without a Meta
// app existing. It is also the half most likely to be edited later by someone
// tuning copy, so it should not require touching API plumbing to change.

/** Public site origin. Overridable for previews; defaults to prod. */
const SITE = (process.env.NEXT_PUBLIC_SITE_URL || 'https://bingoauctions.com').replace(/\/$/, '');

export type SocialPlatform = 'facebook_page' | 'instagram';

export interface LotForPost {
  id: string;
  lot_code: string | null;
  display_code: string | null;
  title: string;
  msrp_cents: number | null;
  starting_bid_cents: number | null;
  photo_urls: string[] | null;
  close_at: string | null;
}

/**
 * Campaign-tagged destination.
 *
 * This is the entire basis of attribution: bidders.acquisition_source (0323) is
 * populated from utm_source on landing, so an untagged link produces a signup
 * we can never credit. Every post MUST route through here.
 *
 * The lot page resolves display_code as well as lot_code (findLotsByAnyCode),
 * so we link the code printed on the box — the same identity customers see at
 * pickup, rather than an internal BIN-######.
 */
export function buildTaggedUrl(
  lot: Pick<LotForPost, 'lot_code' | 'display_code'>,
  platform: SocialPlatform,
  campaign: string,
): string {
  const code = lot.display_code ?? lot.lot_code;
  const base = code ? `${SITE}/lot/${encodeURIComponent(code)}` : SITE;
  const params = new URLSearchParams({
    utm_source: platform,
    utm_medium: 'social',
    utm_campaign: campaign,
  });
  return `${base}?${params.toString()}`;
}

function money(cents: number | null): string | null {
  if (cents == null || cents <= 0) return null;
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
}

function hoursUntil(iso: string | null): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  return Number.isFinite(ms) ? ms / 3_600_000 : null;
}

/**
 * Copy for a single lot.
 *
 * Shaped around what actually drives a click on a local auction: the retail
 * price it beats, and the fact that it ends soon. Deliberately plain — no
 * emoji storm, no ALL CAPS. This posts as the business, several times a day,
 * and copy that reads as spam trains people to scroll past it, which costs
 * more than any single post gains.
 *
 * Instagram gets hashtags (they still drive discovery there); Facebook does
 * not (they read as noise in feed and do nothing for reach).
 */
export function composeLotPost(
  lot: LotForPost,
  platform: SocialPlatform,
  url: string,
): string {
  const lines: string[] = [lot.title];

  const msrp = money(lot.msrp_cents);
  const start = money(lot.starting_bid_cents);
  if (msrp && start) {
    lines.push(`Retail ${msrp} — bidding opens at ${start}.`);
  } else if (msrp) {
    lines.push(`Retail ${msrp}.`);
  } else if (start) {
    lines.push(`Bidding opens at ${start}.`);
  }

  const h = hoursUntil(lot.close_at);
  if (h != null && h > 0) {
    if (h <= 3) lines.push(`Closes in under ${Math.max(1, Math.round(h))} hours.`);
    else if (h <= 24) lines.push('Closes today.');
    else if (h <= 48) lines.push('Closes tomorrow.');
  }

  // Instagram captions cannot carry a clickable link, so pointing at a URL
  // there is a dead end. Send people somewhere they can actually go.
  lines.push(platform === 'instagram' ? 'Link in bio to bid.' : url);

  if (platform === 'instagram') {
    lines.push('', '#auction #liquidation #onlineauction #dealsofthe day #bingoauctions');
  }

  return lines.join('\n');
}

/**
 * Copy for an auction-level post.
 *
 * Often outperforms one-lot-one-post: it advertises breadth rather than a
 * single item someone may not want, and it does not burn a lot's novelty. Kept
 * as a first-class shape (social_posts.lot_id is nullable) for that reason.
 */
export function composeAuctionPost(
  auctionTitle: string,
  lotCount: number,
  endsAt: string | null,
  platform: SocialPlatform,
  campaign: string,
): { message: string; url: string } {
  const params = new URLSearchParams({
    utm_source: platform,
    utm_medium: 'social',
    utm_campaign: campaign,
  });
  const url = `${SITE}?${params.toString()}`;

  const lines = [`${lotCount} lots closing in ${auctionTitle}.`];
  const h = hoursUntil(endsAt);
  if (h != null && h > 0 && h <= 24) lines.push('Bidding ends tonight.');
  lines.push(platform === 'instagram' ? 'Link in bio to browse.' : url);
  if (platform === 'instagram') {
    lines.push('', '#auction #liquidation #onlineauction #bingoauctions');
  }
  return { message: lines.join('\n'), url };
}

/**
 * Instagram REQUIRES an image and Meta fetches it server-side, so the URL has
 * to be publicly reachable — a signed or private storage URL renders fine in
 * our console and fails here. Facebook can post link-only.
 */
export function firstPublicImage(lot: LotForPost): string | null {
  const urls = lot.photo_urls ?? [];
  return urls.find((u) => typeof u === 'string' && /^https:\/\//.test(u)) ?? null;
}

/** Stable per-day campaign tag, so a day's posts group together in reporting. */
export function campaignTag(kind: 'lot' | 'auction', now = new Date()): string {
  const day = now.toISOString().slice(0, 10);
  return `${kind}-${day}`;
}
