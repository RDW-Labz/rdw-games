// The catalog lookup's refusal of shipping labels. Codes are from prod
// product_lookups rows that Sonar filled with invented products (2026-07..09).

import { describe, expect, it } from 'vitest';
import { catalogRefusal } from '../catalog-refusal';

const never = async () => false;
const always = async () => true;

describe('catalogRefusal', () => {
  it('refuses a FedEx tracking number that fails the UPC check digit', async () => {
    // 538160989509 was cached as a power-lift recliner; the box was a bath sconce.
    expect(await catalogRefusal('538160989509', never)).toBe('non_gtin_numeric');
  });

  it('refuses a check-digit-valid code that is a manifest tracking number', async () => {
    // 538157106950 (cached as AirPods Pro 3; the box was a standing desk) passes
    // the UPC-A check digit — 2 of the 16 poisoned codes did — so only the
    // manifest can tell it is a label.
    expect(await catalogRefusal('538157106950', never)).toBeNull();
    expect(await catalogRefusal('538157106950', always)).toBe('manifest_tracking');
  });

  it('passes a real retail UPC through untouched', async () => {
    expect(await catalogRefusal('036000291452', never)).toBeNull(); // valid UPC-A
    expect(await catalogRefusal('4006381333931', never)).toBeNull(); // valid EAN-13
  });

  it('only judges bare-numeric codes', async () => {
    for (const code of ['B08N5WRWNW', 'X004Z9D5K5', 'KD-55X85K', 'samsung tv', '0360-0029-1452']) {
      expect(await catalogRefusal(code, always)).toBeNull();
    }
  });

  it('refuses numeric codes of non-GTIN length (SSCC-18, 10-digit internal labels)', async () => {
    expect(await catalogRefusal('003456789012345678', never)).toBe('non_gtin_numeric');
    expect(await catalogRefusal('1234567890', never)).toBe('non_gtin_numeric');
  });

  it('falls back to the check-digit rule when the manifest query fails', async () => {
    const broken = async () => {
      throw new Error('db down');
    };
    expect(await catalogRefusal('538157106950', broken)).toBeNull();
    expect(await catalogRefusal('538160989509', broken)).toBe('non_gtin_numeric');
  });
});
