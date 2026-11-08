// Client-side mirror of the SQL min_bid_increment_cents() function.
// MUST match packages/db/migrations/0194_configurable_bid_increments.sql exactly
// (which extends the original 0003 ladder with the configurable schedule).
// The server-side function is authoritative; this is for UX (showing "next
// minimum bid" without a round-trip).
//
// BID-3 (mig 0194): an optional increment SCHEDULE can override the legacy
// ladder. A schedule is an ascending array of tiers; the increment for a given
// current_cents is the step_cents of the tier with the GREATEST min_cents that
// is <= max(current_cents, 0). When the schedule is absent / null / empty /
// has no matching tier, we fall back to the EXACT legacy ladder below — the
// same fallback the SQL uses, so existing operators/auctions (NULL schedule)
// behave identically to before.

import type { Cents } from './money';

// One tier of a configurable bid-increment schedule. min_cents is the inclusive
// lower bound of the current-bid range this step applies to; step_cents is the
// minimum increment within that range. Mirrors the JSONB row shape consumed by
// jsonb_to_recordset(schedule) AS t(min_cents bigint, step_cents bigint).
export type BidIncrementTier = { min_cents: number; step_cents: number };

export function minBidIncrementCents(
  currentCents: Cents | null | undefined,
  schedule?: BidIncrementTier[] | null,
): Cents {
  const c = currentCents ?? 0;

  // Configurable schedule (mig 0194): greatest min_cents tier whose floor is
  // <= the current bid. Identical rule to the SQL:
  //   WHERE min_cents <= COALESCE(current_cents,0) ORDER BY min_cents DESC LIMIT 1
  // Any of {no schedule, empty array, no tier with min_cents <= c, a tier with
  // a non-finite step} falls through to the legacy ladder below — matching the
  // SQL's COALESCE(<subselect>, <ladder>).
  if (Array.isArray(schedule) && schedule.length > 0) {
    let best: BidIncrementTier | null = null;
    for (const tier of schedule) {
      if (
        tier == null ||
        typeof tier.min_cents !== 'number' ||
        typeof tier.step_cents !== 'number' ||
        !Number.isFinite(tier.min_cents) ||
        !Number.isFinite(tier.step_cents)
      ) {
        continue;
      }
      if (tier.min_cents <= c && (best === null || tier.min_cents > best.min_cents)) {
        best = tier;
      }
    }
    if (best !== null) return best.step_cents;
  }

  // LEGACY LADDER — byte-identical to the SQL fallback (0003/0191/0194). The
  // first two SQL branches (< 500 and < 2500) both return 100, so the single
  // `c < 2500` check below is equivalent. DO NOT change these boundaries.
  if (c < 2500) return 100;
  if (c < 10000) return 200;
  if (c < 25000) return 500;
  if (c < 100000) return 1000;
  if (c < 500000) return 2500;
  return 5000;
}

export function nextMinimumBidCents(
  currentBidCents: Cents | null | undefined,
  startingBidCents: Cents,
  schedule?: BidIncrementTier[] | null,
): Cents {
  if (currentBidCents == null) return startingBidCents;
  return currentBidCents + minBidIncrementCents(currentBidCents, schedule);
}

export type PlaceBidResult = {
  ok: boolean;
  reason: string;
  lot_id: string;
  current_bid_cents: number | null;
  current_leader_id: string | null;
  close_at: string | null;
  was_extended: boolean;
  outbid_bidder_id: string | null;
};
