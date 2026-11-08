// __tests__/images.test.ts
//
// Vitest tests for isSafeImageUrl() and filterSafeImageUrls() from images.ts.
//
// NOTE: Both functions are pure (URL parsing only, no network I/O), so all
// test cases use inline URL literals. No fixtures file needed.
//
// Run via:
//
//   npm test --workspace=@auction-platform/domain-lotting

import { describe, it, expect } from 'vitest';

import { isSafeImageUrl, filterSafeImageUrls, ALLOWED_IMAGE_HOSTS } from '../images';

// ---------------------------------------------------------------------------
// isSafeImageUrl — allowed hosts
// ---------------------------------------------------------------------------

describe('isSafeImageUrl → true (known-good CDN URLs)', () => {
  it('eBay CDN', () =>
    expect(isSafeImageUrl('https://i.ebayimg.com/images/g/abc/s-l1600.jpg')).toBe(true));
  it('Amazon CDN', () =>
    expect(isSafeImageUrl('https://m.media-amazon.com/images/I/test.jpg')).toBe(true));
  it('Walmart CDN (i5)', () =>
    expect(isSafeImageUrl('https://i5.walmartimages.com/asr/test.jpg')).toBe(true));
  it('The Home Depot CDN', () =>
    expect(isSafeImageUrl('https://images.thdstatic.com/productImages/test.jpg')).toBe(true));
  it("Lowe's CDN", () =>
    expect(isSafeImageUrl('https://mobileimages.lowes.com/product/test.jpg')).toBe(true));
  it('Supabase project storage', () =>
    expect(
      isSafeImageUrl(
        'https://xgsujdzicnjenhqihovk.supabase.co/storage/v1/object/public/lots/test.jpg',
      ),
    ).toBe(true));
  it('Open Food Facts CDN', () =>
    expect(isSafeImageUrl('https://images.openfoodfacts.org/images/products/test.jpg')).toBe(
      true,
    ));
  it('BidFTA CDN', () =>
    expect(isSafeImageUrl('https://cdn.bidfta.com/images/test.jpg')).toBe(true));
  it('Shopify CDN', () =>
    expect(isSafeImageUrl('https://cdn.shopify.com/s/files/test.jpg')).toBe(true));
  it('Firebase Storage (Nellis)', () =>
    expect(
      isSafeImageUrl('https://firebasestorage.googleapis.com/v0/b/bucket/o/test.jpg'),
    ).toBe(true));
  it('Pinterest CDN', () =>
    expect(isSafeImageUrl('https://i.pinimg.com/originals/test.jpg')).toBe(true));
  it('Target Scene7 CDN', () =>
    expect(isSafeImageUrl('https://target.scene7.com/is/image/Target/test')).toBe(true));
});

// ---------------------------------------------------------------------------
// isSafeImageUrl → false (bad protocol, unknown host, non-string, malformed)
// ---------------------------------------------------------------------------

describe('isSafeImageUrl → false (rejected cases)', () => {
  it('http:// (not https) → false', () =>
    expect(isSafeImageUrl('http://i.ebayimg.com/images/test.jpg')).toBe(false));
  it('data: URI → false', () =>
    expect(isSafeImageUrl('data:image/jpeg;base64,/9j/4AAQ')).toBe(false));
  it('unknown host → false', () =>
    expect(isSafeImageUrl('https://evil.example.com/image.jpg')).toBe(false));
  it('null → false', () => expect(isSafeImageUrl(null)).toBe(false));
  it('undefined → false', () => expect(isSafeImageUrl(undefined)).toBe(false));
  it('number → false', () => expect(isSafeImageUrl(42)).toBe(false));
  it('empty string → false', () => expect(isSafeImageUrl('')).toBe(false));
  it('relative path → false', () => expect(isSafeImageUrl('/images/test.jpg')).toBe(false));
  it('malformed URL → false', () => expect(isSafeImageUrl('not a url at all')).toBe(false));
  it('javascript: URL → false', () =>
    expect(isSafeImageUrl('javascript:alert(1)')).toBe(false));
  // Subdomain of an allowed host must NOT pass (no wildcard matching)
  it('subdomain of allowed host → false', () =>
    expect(isSafeImageUrl('https://evil.i.ebayimg.com/images/test.jpg')).toBe(false));
});

describe('isSafeImageUrl — case-insensitive hostname', () => {
  it('uppercase hostname still matches', () =>
    expect(isSafeImageUrl('https://I.EBAYIMG.COM/images/test.jpg')).toBe(true));
  it('mixed-case hostname still matches', () =>
    expect(isSafeImageUrl('https://M.Media-Amazon.com/images/test.jpg')).toBe(true));
});

// ---------------------------------------------------------------------------
// filterSafeImageUrls
// ---------------------------------------------------------------------------

describe('filterSafeImageUrls', () => {
  it('returns only safe URLs from a mixed array', () => {
    const input = [
      'https://i.ebayimg.com/images/test.jpg',
      'http://i.ebayimg.com/images/test.jpg', // http — rejected
      'https://evil.example.com/image.jpg', // unknown host — rejected
      null,
      undefined,
      42,
      'https://m.media-amazon.com/images/test.jpg',
    ];
    expect(filterSafeImageUrls(input)).toEqual([
      'https://i.ebayimg.com/images/test.jpg',
      'https://m.media-amazon.com/images/test.jpg',
    ]);
  });

  it('returns empty array for all-bad input', () => {
    expect(filterSafeImageUrls(['http://bad.com/img', null, ''])).toEqual([]);
  });

  it('returns empty array for empty input', () => {
    expect(filterSafeImageUrls([])).toEqual([]);
  });

  it('preserves order', () => {
    const urls = [
      'https://i.ebayimg.com/a.jpg',
      'https://m.media-amazon.com/b.jpg',
      'https://i5.walmartimages.com/c.jpg',
    ];
    expect(filterSafeImageUrls(urls)).toEqual(urls);
  });

  it('preserves duplicates (dedup is caller responsibility)', () => {
    const url = 'https://i.ebayimg.com/images/test.jpg';
    expect(filterSafeImageUrls([url, url])).toEqual([url, url]);
  });
});

// ---------------------------------------------------------------------------
// ALLOWED_IMAGE_HOSTS invariants
// ---------------------------------------------------------------------------

describe('ALLOWED_IMAGE_HOSTS invariants', () => {
  it('is a Set', () => expect(ALLOWED_IMAGE_HOSTS).toBeInstanceOf(Set));
  it('contains at least 10 entries (sanity check for accidental truncation)', () =>
    expect(ALLOWED_IMAGE_HOSTS.size).toBeGreaterThanOrEqual(10));
  it('all entries are lowercase (hostname comparisons assume lowercase)', () => {
    for (const host of ALLOWED_IMAGE_HOSTS) {
      expect(host).toBe(host.toLowerCase());
    }
  });
  it('no entry contains a protocol prefix', () => {
    for (const host of ALLOWED_IMAGE_HOSTS) {
      expect(host).not.toMatch(/^https?:\/\//);
    }
  });
});
