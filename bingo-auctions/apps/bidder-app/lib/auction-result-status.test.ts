import { describe, expect, it } from 'vitest';
import { auctionCardRoute, isLotSold, lotResultLabel } from './auction-result-status';

describe('auctionCardRoute', () => {
  it('opens the lot list for an auction that has not closed', () => {
    for (const status of ['scheduled', 'live']) {
      expect(auctionCardRoute({ id: 'a1', status })).toEqual({
        pathname: '/',
        params: { auction_id: 'a1' },
      });
    }
  });

  it('opens the Results screen only for a closed auction', () => {
    expect(auctionCardRoute({ id: 'a1', status: 'closed' })).toBe('/auction/a1');
  });
});

describe('lot result label', () => {
  it('a scheduled lot with a leading pre-bid is not Sold (Crandall, 2026-10-14)', () => {
    // winner_bidder_id is set by the pre-bid, but it must not matter.
    const lot = { status: 'scheduled', winner_bidder_id: 'bidder-1' };
    expect(isLotSold(lot)).toBe(false);
    expect(lotResultLabel(lot)).toBe('Open');
  });

  it('only status won is Sold', () => {
    expect(lotResultLabel({ status: 'won' })).toBe('Sold');
    expect(isLotSold({ status: 'won' })).toBe(true);
    expect(lotResultLabel({ status: 'live' })).toBe('Open');
    expect(lotResultLabel({ status: 'unsold' })).toBe('Unsold');
    expect(lotResultLabel({ status: 'relisted' })).toBe('Unsold');
  });
});
