// Which auctions' lots a customer may DISCOVER in the app (Browse grid, search,
// "similar lots"). One place so the rule cannot drift between screens.
//
// Unlisted auctions (auctions.unlisted, mig 0242) are staff test auctions. They
// are hidden from every discovery list but still reachable by direct navigation
// (deep link, QR scan, My Bids, Watchlist, lot page by id), which is how staff
// testers get to them. So this module filters LISTS only; nothing here should
// be used on a screen that opens one lot or one auction by id.
//
// The website applies the same rule with `.eq('unlisted', false)` on its
// auction queries (apps/operator-web/src/lib/browse-lots.ts).
//
// Pure module (type-only Supabase import) so vitest can drive it with a fake.

import type { SupabaseClient } from '@supabase/supabase-js';

type Client = Pick<SupabaseClient, 'from'>;

/** Auction statuses whose lots are open for bidding in the Browse grid. */
export const DISCOVERABLE_AUCTION_STATUSES = ['scheduled', 'live'] as const;

/**
 * Ids of open, listed auctions — the only auctions whose lots may appear in a
 * customer discovery list. Filters in the query, not after fetching.
 *
 * `auctionId` narrows to one auction the customer explicitly asked for (a
 * Browse link carrying `auction_id`). That is direct navigation, so an unlisted
 * auction is allowed there; it still has to be open.
 *
 * Returns [] on error, same as the Browse grid always did.
 */
export async function fetchDiscoverableAuctionIds(
  client: Client,
  opts: { auctionId?: string | null } = {},
): Promise<string[]> {
  let query = client
    .from('auctions')
    .select('id')
    .in('status', [...DISCOVERABLE_AUCTION_STATUSES]);
  query = opts.auctionId ? query.eq('id', opts.auctionId) : query.eq('unlisted', false);
  const { data } = await query;
  return ((data ?? []) as Array<{ id: string }>).map((a) => a.id);
}

/**
 * Drops rows that belong to an unlisted auction. For result sets that come
 * from somewhere we cannot add the filter to (the find_lots_by_identifier RPC),
 * and that include ended lots, so "keep only open listed auctions" would be
 * wrong. Rows with no auction are kept.
 *
 * Returns null if the check failed, so the caller can hide the results rather
 * than show test lots.
 */
export async function withoutUnlistedAuctionRows<T extends { auction_id: string | null }>(
  client: Client,
  rows: T[],
): Promise<T[] | null> {
  const auctionIds = Array.from(
    new Set(rows.map((r) => r.auction_id).filter((id): id is string => id != null)),
  );
  if (auctionIds.length === 0) return rows;
  const { data, error } = await client
    .from('auctions')
    .select('id')
    .in('id', auctionIds)
    .eq('unlisted', true);
  if (error) return null;
  const unlisted = new Set(((data ?? []) as Array<{ id: string }>).map((a) => a.id));
  return rows.filter((r) => r.auction_id == null || !unlisted.has(r.auction_id));
}
