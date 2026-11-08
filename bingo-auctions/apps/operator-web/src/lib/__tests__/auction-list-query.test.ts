import { describe, expect, it } from 'vitest';
import {
  AUCTION_PAGE_SIZE,
  auctionListHref,
  pageRange,
  parseAuctionListParams,
  titleIlikePattern,
} from '../auction-list-query';

describe('parseAuctionListParams', () => {
  it('defaults q, status, and page', () => {
    expect(parseAuctionListParams({})).toEqual({ q: '', status: 'all', page: 1 });
  });

  it('coerces unknown status to all', () => {
    expect(parseAuctionListParams({ status: 'bogus' }).status).toBe('all');
  });

  it('parses page', () => {
    expect(parseAuctionListParams({ page: '3' }).page).toBe(3);
    expect(parseAuctionListParams({ page: '0' }).page).toBe(1);
    expect(parseAuctionListParams({ page: 'abc' }).page).toBe(1);
  });

  it('trims and caps q at 100 characters', () => {
    const long = 'x'.repeat(120);
    expect(parseAuctionListParams({ q: `  ${long}  ` }).q).toHaveLength(100);
    expect(parseAuctionListParams({ q: '  hello  ' }).q).toBe('hello');
  });
});

describe('titleIlikePattern', () => {
  it('returns null for empty q', () => {
    expect(titleIlikePattern('')).toBeNull();
    expect(titleIlikePattern('   ')).toBeNull();
  });

  it('sanitises structural chars in Boo, Bid & Buy', () => {
    const pattern = titleIlikePattern('Boo, Bid & Buy');
    expect(pattern).not.toBeNull();
    expect(pattern!).not.toContain(',');
    expect(pattern!).toContain('Boo');
  });

  it('escapes ilike metacharacters and maps * to space', () => {
    expect(titleIlikePattern('a_b%c*')).toBe('%a\\_b\\%c %');
  });
});

describe('auctionListHref', () => {
  it('omits default params', () => {
    expect(auctionListHref({ q: '', status: 'all', page: 1 })).toBe('/auctions');
  });

  it('encodes q, status, and page', () => {
    expect(
      auctionListHref({ q: 'a&b', status: 'live', page: 2 }),
    ).toBe('/auctions?q=a%26b&status=live&page=2');
  });

  it('omits status when all', () => {
    expect(auctionListHref({ q: 'x', status: 'all', page: 1 })).toBe('/auctions?q=x');
  });
});

describe('pageRange', () => {
  it('returns inclusive PostgREST range for page 1 and 3', () => {
    expect(pageRange(1)).toEqual([0, AUCTION_PAGE_SIZE - 1]);
    expect(pageRange(3)).toEqual([100, 149]);
  });
});
