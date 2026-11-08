// Pins what the lot screen says to a bidder who is not leading (2026-10-06,
// chandelier TEA4841758: lost on a tie at $15 and the screen said "Closed").

import { describe, it, expect } from 'vitest';
import { bidCountLabel, lotOutcome, outbidMessage } from './lot-outcome';

const fmt = (c: number) => `$${(c / 100).toFixed(0)}`;
const base = {
  me: 'me',
  winnerBidderId: 'other',
  iHaveBid: true,
  myMaxCents: 1500,
  currentBidCents: 1500,
  closed: true,
};

describe('lotOutcome / outbidMessage', () => {
  it('closed, lost on a tie: names the earlier maximum and the price (the chandelier)', () => {
    expect(outbidMessage(lotOutcome(base), fmt)).toBe(
      "Outbid — another bidder's maximum bid of $15 was placed earlier",
    );
  });

  it('closed, outbid by a higher bid: does not claim an earlier maximum', () => {
    const o = lotOutcome({ ...base, myMaxCents: 1300 });
    expect(o).toEqual({ kind: 'outbid', closed: true, earlierMax: false, finalCents: 1500 });
    expect(outbidMessage(o, fmt)).toBe('Outbid — sold to another bidder for $15');
  });

  it('live, tied by an earlier maximum: the live sentence', () => {
    expect(outbidMessage(lotOutcome({ ...base, closed: false }), fmt)).toBe(
      "You've been outbid by an earlier maximum bid.",
    );
  });

  it('live, outbid by a higher bid: keeps the plain Outbid banner', () => {
    expect(outbidMessage(lotOutcome({ ...base, closed: false, myMaxCents: 1300 }), fmt)).toBeNull();
  });

  it('says nothing to the winner, to someone who never bid, or when nobody leads', () => {
    expect(lotOutcome({ ...base, winnerBidderId: 'me' })).toEqual({ kind: 'none' });
    expect(lotOutcome({ ...base, iHaveBid: false })).toEqual({ kind: 'none' });
    expect(lotOutcome({ ...base, winnerBidderId: null })).toEqual({ kind: 'none' });
    expect(lotOutcome({ ...base, me: null })).toEqual({ kind: 'none' });
  });

  it('unknown own maximum never claims an earlier maximum', () => {
    expect(lotOutcome({ ...base, myMaxCents: null })).toMatchObject({ earlierMax: false });
  });
});

describe('bidCountLabel', () => {
  it('shows how many of the counted bids are yours (the chandelier: 11, 7 hers)', () => {
    expect(bidCountLabel(11, 7)).toBe('11 bids, 7 yours');
  });
  it('plain count when you have not bid', () => {
    expect(bidCountLabel(11, 0)).toBe('11 bids');
    expect(bidCountLabel(1, 0)).toBe('1 bid');
  });
});
