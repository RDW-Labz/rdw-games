// isNonUpcCode decides whether a manifest miss may reach the catalog/web
// lookup. 2026-09-28: a FedEx 12-digit tracking number read as Code-128 counted
// as a numeric GTIN and went to the lookup, which invented products for it.

import { describe, it, expect } from 'vitest';
import { isNonUpcCode } from '../index';

describe('isNonUpcCode', () => {
  it('a numeric code read as Code-128 is a label, not a GTIN (the FedEx case)', () => {
    expect(isNonUpcCode('538157106950', 'code-128')).toBe(true); // a real 0372 tracking number
    expect(isNonUpcCode('486571079143', 'code-128')).toBe(true);
    for (const s of ['code-39', 'code-93', 'codabar', 'qr', 'pdf-417', 'data-matrix', 'aztec'] as const) {
      expect(isNonUpcCode('123456789012', s)).toBe(true);
    }
  });

  it('retail symbologies stay product barcodes', () => {
    expect(isNonUpcCode('036000291452', 'upc-a')).toBe(false);
    expect(isNonUpcCode('0036000291452', 'ean-13')).toBe(false);
    expect(isNonUpcCode('96385074', 'ean-8')).toBe(false);
    expect(isNonUpcCode('01234565', 'upc-e')).toBe(false);
    expect(isNonUpcCode('10036000291459', 'itf-14')).toBe(false);
  });

  it('a typed numeric code keeps the old rule: treated as a GTIN', () => {
    expect(isNonUpcCode('036000291452', 'unknown')).toBe(false);
    expect(isNonUpcCode('12345678', 'unknown')).toBe(false);
  });

  it('non-numeric and out-of-range codes are labels whatever the symbology', () => {
    expect(isNonUpcCode('X004Z9D5K5', 'code-128')).toBe(true); // FNSKU
    expect(isNonUpcCode('B0CHX1W1XY', 'unknown')).toBe(true); // ASIN
    expect(isNonUpcCode('PNK4860366', 'code-39')).toBe(true); // roll label
    expect(isNonUpcCode('9622013140001309096900486573151363', 'code-128')).toBe(true); // FedEx 34-digit
    expect(isNonUpcCode('1234567', 'unknown')).toBe(true); // too short for a GTIN
  });
});
