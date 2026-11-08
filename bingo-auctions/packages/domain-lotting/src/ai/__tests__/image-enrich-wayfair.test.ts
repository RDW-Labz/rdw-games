import { describe, it, expect } from 'vitest';
import { wayfairPdpUrls } from '../image-enrich-wayfair';

describe('wayfairPdpUrls', () => {
  it('builds slug-less PDP + keyword URLs for a SiteSKU', () => {
    const urls = wayfairPdpUrls('W004347105', null);
    expect(urls).toContain('https://www.wayfair.com/-/pdp/-W004347105.html');
    expect(urls).toContain('https://www.wayfair.com/keyword.php?keyword=W004347105');
  });

  it('includes the ProductSKU when it differs from the SiteSKU', () => {
    const urls = wayfairPdpUrls('W004347105', 'MFR-12345');
    expect(urls.some((u) => u.includes('W004347105'))).toBe(true);
    expect(urls.some((u) => u.includes('MFR-12345'))).toBe(true);
  });

  it('does not duplicate when both SKUs are equal', () => {
    const urls = wayfairPdpUrls('W1', 'W1'); // W1 too short → rejected anyway
    expect(urls).toEqual([]);
  });

  it('rejects junk / too-short / non-SKU values (no doomed fetch URLs)', () => {
    expect(wayfairPdpUrls('', '')).toEqual([]);
    expect(wayfairPdpUrls(null, null)).toEqual([]);
    expect(wayfairPdpUrls('ab', null)).toEqual([]); // < 3 chars
    // A FedEx tracking token must never become a Wayfair URL.
    expect(wayfairPdpUrls('797959221068 797959221079', null)).toEqual([]);
  });

  it('url-encodes SKUs so a stray space/char cannot break the URL', () => {
    // "W123 456" has a space → fails the strict SKU regex → dropped.
    expect(wayfairPdpUrls('W123 456', null)).toEqual([]);
    // A dash is allowed and passes through encoded verbatim.
    const urls = wayfairPdpUrls('AB-1234', null);
    expect(urls[0]).toBe('https://www.wayfair.com/-/pdp/-AB-1234.html');
  });
});
