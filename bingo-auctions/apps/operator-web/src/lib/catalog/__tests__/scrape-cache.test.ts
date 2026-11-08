import { describe, it, expect } from 'vitest';

import { retailerCodeForUrl } from '../scrape-cache';

describe('retailerCodeForUrl', () => {
  it('extracts a raw ASIN for Amazon /dp/ and /gp/product/', () => {
    expect(retailerCodeForUrl('https://www.amazon.com/dp/B09B8V1LZ3')).toBe('B09B8V1LZ3');
    expect(
      retailerCodeForUrl('https://www.amazon.com/Some-Title/dp/b09b8v1lz3/ref=sr_1_1'),
    ).toBe('B09B8V1LZ3');
    expect(retailerCodeForUrl('https://amazon.com/gp/product/B07FP323DV')).toBe('B07FP323DV');
  });

  it('keys the major retailers by their stable item id', () => {
    expect(retailerCodeForUrl('https://www.walmart.com/ip/Cool-Thing/123456789')).toBe(
      'walmart:123456789',
    );
    expect(
      retailerCodeForUrl('https://www.target.com/p/some-product/-/A-79294191'),
    ).toBe('target:79294191');
    expect(
      retailerCodeForUrl('https://www.homedepot.com/p/Brand-Widget/314556789'),
    ).toBe('homedepot:314556789');
    expect(retailerCodeForUrl('https://www.lowes.com/pd/Brand-Thing/1000123456')).toBe(
      'lowes:1000123456',
    );
    expect(retailerCodeForUrl('https://www.bestbuy.com/site/x/6565837.p?skuId=6565837')).toBe(
      'bestbuy:6565837',
    );
    expect(retailerCodeForUrl('https://www.ebay.com/itm/256123456789')).toBe(
      'ebay:256123456789',
    );
    expect(retailerCodeForUrl('https://www.etsy.com/listing/1234567890/handmade')).toBe(
      'etsy:1234567890',
    );
  });

  it('falls back to a normalized url: key for an allowlisted host with no parsed id', () => {
    const code = retailerCodeForUrl('https://www.costco.com/some-odd-listing-page');
    expect(code).toBe('url:costco.com/some-odd-listing-page');
  });

  it('strips query + trailing slash from the url: fallback so variants collapse', () => {
    expect(retailerCodeForUrl('https://www.wayfair.com/furniture/pdp/widget/?refid=abc')).toBe(
      retailerCodeForUrl('https://www.wayfair.com/furniture/pdp/widget'),
    );
  });

  it('returns null for an unparseable URL', () => {
    expect(retailerCodeForUrl('not a url')).toBeNull();
  });
});
