// What a bidder is told about a lot they bid on but are not leading.
//
// 2026-10-06, chandelier TEA4841758: a customer bid $15, the lot closed at
// $15 to another bidder whose $15 maximum was placed 36 minutes earlier
// (equal maximums go to the one set first). Her lot screen said only
// "Closed", and the outbid banner disappears once a lot closes, so she was left
// guessing. The rules are right; the screen now says what happened.
//
// "Earlier maximum" is only claimed when it is certainly true: the viewer's own
// maximum is at least the current price and they still are not leading, which
// only happens when another bidder's equal-or-higher maximum was already there.

export type LotOutcomeInput = {
  me: string | null;
  winnerBidderId: string | null;
  /** The viewer has placed at least one bid of their own (not an auto-bid). */
  iHaveBid: boolean;
  /** Highest maximum across the viewer's own bids on this lot. */
  myMaxCents: number | null;
  currentBidCents: number | null;
  closed: boolean;
};

export type LotOutcome =
  | { kind: 'none' }
  | { kind: 'outbid'; closed: boolean; earlierMax: boolean; finalCents: number | null };

export function lotOutcome(i: LotOutcomeInput): LotOutcome {
  if (!i.me || !i.iHaveBid || !i.winnerBidderId || i.winnerBidderId === i.me) {
    return { kind: 'none' };
  }
  const earlierMax =
    i.myMaxCents != null && i.currentBidCents != null && i.myMaxCents >= i.currentBidCents;
  return { kind: 'outbid', closed: i.closed, earlierMax, finalCents: i.currentBidCents };
}

/** One sentence for the outbid / result banner; null keeps the plain "Outbid". */
export function outbidMessage(o: LotOutcome, fmt: (cents: number) => string): string | null {
  if (o.kind !== 'outbid') return null;
  if (o.closed) {
    if (o.earlierMax && o.finalCents != null) {
      return `Outbid — another bidder's maximum bid of ${fmt(o.finalCents)} was placed earlier`;
    }
    return o.finalCents != null
      ? `Outbid — sold to another bidder for ${fmt(o.finalCents)}`
      : 'Outbid — sold to another bidder';
  }
  return o.earlierMax ? "You've been outbid by an earlier maximum bid." : null;
}

/**
 * The bid counter. lots.bid_count counts bids people placed (auto-bids from a
 * maximum are not counted, mig 0191). A bidder can only read their own bids,
 * so the history list shows theirs alone; say so in the count.
 */
export function bidCountLabel(total: number, mine: number): string {
  const bids = `${total} ${total === 1 ? 'bid' : 'bids'}`;
  return mine > 0 ? `${bids}, ${mine} yours` : bids;
}
