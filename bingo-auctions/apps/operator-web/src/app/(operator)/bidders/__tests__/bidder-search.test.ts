import { describe, expect, it } from 'vitest';
import { isExactBidderNumber, matchesBidderSearch, parseBidderSearch } from '../bidder-search';

const row = (over: Partial<Parameters<typeof matchesBidderSearch>[0]> = {}) => ({
  bidder_number: 2157,
  display_name: 'Pat Example',
  email: 'pat@example.test',
  phone: '479-555-0101',
  referral_code: 'PAT5',
  ...over,
});

describe('bidder search by number', () => {
  it('"2157" and "#2157" both find bidder #2157', () => {
    expect(matchesBidderSearch(row(), parseBidderSearch('2157'))).toBe(true);
    expect(matchesBidderSearch(row(), parseBidderSearch('#2157'))).toBe(true);
    expect(matchesBidderSearch(row(), parseBidderSearch('  # 2157 '))).toBe(true);
  });

  it('matches the number exactly, not as a prefix or substring', () => {
    expect(matchesBidderSearch(row({ bidder_number: 21570 }), parseBidderSearch('#2157'))).toBe(false);
    expect(matchesBidderSearch(row({ bidder_number: 215 }), parseBidderSearch('#2157'))).toBe(false);
    expect(isExactBidderNumber(row({ bidder_number: 21570 }), parseBidderSearch('2157'))).toBe(false);
  });

  it('"#N" matches the bidder number only; a bare number still finds phones', () => {
    const phoneOnly = row({ bidder_number: 9, phone: '479-555-2157' });
    expect(matchesBidderSearch(phoneOnly, parseBidderSearch('#2157'))).toBe(false);
    expect(matchesBidderSearch(phoneOnly, parseBidderSearch('2157'))).toBe(true);
  });

  it('a bidder with no number never matches a number search by number', () => {
    expect(isExactBidderNumber(row({ bidder_number: null }), parseBidderSearch('2157'))).toBe(false);
  });

  it('text search is unchanged', () => {
    expect(matchesBidderSearch(row(), parseBidderSearch('pat@'))).toBe(true);
    expect(matchesBidderSearch(row(), parseBidderSearch('nobody'))).toBe(false);
    expect(matchesBidderSearch(row(), parseBidderSearch(''))).toBe(true);
  });
});
