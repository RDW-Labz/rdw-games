/**
 * Single source of truth for an auction's PUBLIC lifecycle state.
 *
 * The `auctions.status` enum alone is NOT trustworthy for public surfaces:
 * the lifecycle cron (and bid/relist promotion of a lot→auction) can flip
 * status to 'live' BEFORE `starts_at` actually passes. Trusting the bare
 * status made a card show "LIVE" while the detail page still said
 * "Bidding Opens" — they disagreed.
 *
 * Both the browse card and the detail page derive from this one function so
 * they always agree: an auction reads as 'upcoming' until `starts_at` has
 * actually passed on the clock, even if the status is already 'live'.
 */

export type PublicAuctionState = 'upcoming' | 'live' | 'ended';

export function publicAuctionState(
  a: { status: string; starts_at: string | null },
  nowMs: number = Date.now(),
): PublicAuctionState {
  if (a.status === 'closed') return 'ended';
  const start = a.starts_at ? new Date(a.starts_at).getTime() : null;
  if (a.status === 'live' && (start === null || start <= nowMs)) return 'live';
  return 'upcoming';
}

// ── Lot statuses the storefront must never show ─────────────────────────────
//
// Owner, 2026-09-11, about TEA5010388 in the LIVE "Hello, September Deals":
// "This item is live on auction and will not let customers bid why?"
//
// Because it had been destroyed three days earlier. remove_lot_from_inventory
// sets status='disposed' but never clears auction_id, lot_number or close_at,
// so the lot stays attached to its auction — and the auction page selected
// lots by auction_id filtering only deleted_at, with no status filter at all.
// The storefront therefore advertised a destroyed item, complete with photos
// and a SAVE 100% badge, while the bidder UI (which DOES gate on status)
// correctly refused to take a bid. Eleven lots were in that state across two
// live auctions.
//
// Every other storefront surface already filtered — home, browse, final-call
// and the related-lots rail all whitelist scheduled/live. The auction page,
// the category page and the search suggester did not.
//
// An exclusion rather than a whitelist, deliberately: the auction page also
// renders CLOSED auctions so shared links keep working, and their lots are
// 'won'/'unsold'. A scheduled/live whitelist would blank every ended auction.
// These two statuses mean "this item is not for sale and never will be".
export const NON_SELLABLE_LOT_STATUSES = ['disposed', 'canceled'] as const;

/** PostgREST list form for `.not('status', 'in', …)`. */
export const NON_SELLABLE_LOT_STATUS_FILTER = `(${NON_SELLABLE_LOT_STATUSES.map((s) => `"${s}"`).join(',')})`;
