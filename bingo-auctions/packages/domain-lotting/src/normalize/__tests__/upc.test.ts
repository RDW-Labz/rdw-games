// __tests__/upc.test.ts
//
// Vitest tests for isFakeUpc, isFakeAsin, normalizeUpc, normalizeAsin.
// Run via:
//
//   npm test --workspace=@auction-platform/domain-lotting
//
// Originally written with a hand-rolled assertion helper before Vitest was
// wired into the package; converted to describe/it/expect when the runner
// was added.

import { describe, it, expect } from 'vitest';

import {
  isFakeUpc,
  isFakeAsin,
  normalizeUpc,
  normalizeAsin,
  looksLikeCarrierBarcode,
  normalizeReadUpc,
} from '../upc';

describe('isFakeUpc → true (bogus patterns)', () => {
  // Pattern 1: All same digit — every valid UPC length.
  it('all-zeros-12', () => expect(isFakeUpc('000000000000')).toBe(true));
  it('all-nines-12', () => expect(isFakeUpc('999999999999')).toBe(true));
  it('all-ones-12', () => expect(isFakeUpc('111111111111')).toBe(true));
  it('all-fives-12', () => expect(isFakeUpc('555555555555')).toBe(true));
  it('all-zeros-8', () => expect(isFakeUpc('00000000')).toBe(true));
  it('all-zeros-13', () => expect(isFakeUpc('0000000000000')).toBe(true));
  it('all-zeros-14', () => expect(isFakeUpc('00000000000000')).toBe(true));
  it('all-eights-12 (also in blocklist)', () => expect(isFakeUpc('888888888888')).toBe(true));

  // Pattern 2: Sequential ascending (with wraparound).
  it('sequential-asc-12', () => expect(isFakeUpc('012345678901')).toBe(true));
  it('sequential-asc-12b (also in blocklist)', () =>
    expect(isFakeUpc('123456789012')).toBe(true));
  it('sequential-asc-8', () => expect(isFakeUpc('12345678')).toBe(true));
  it('sequential-asc-wrap (9→0)', () => expect(isFakeUpc('890123456789')).toBe(true));

  // Pattern 3: Sequential descending.
  it('sequential-desc-12', () => expect(isFakeUpc('987654321098')).toBe(true));
  it('sequential-desc-12b', () => expect(isFakeUpc('876543210987')).toBe(true));
  it('sequential-desc-8', () => expect(isFakeUpc('87654321')).toBe(true));

  // Pattern 4: Repeated short sub-pattern.
  it('repeat-period2-12', () => expect(isFakeUpc('121212121212')).toBe(true));
  it('repeat-period2-12b', () => expect(isFakeUpc('010101010101')).toBe(true));
  it('repeat-period3-12', () => expect(isFakeUpc('123123123123')).toBe(true));
  it('repeat-period4-12', () => expect(isFakeUpc('123412341234')).toBe(true));
  it('repeat-period4-8 (UPC-8 length)', () => expect(isFakeUpc('12341234')).toBe(true));
  it('repeat-period2-14', () => expect(isFakeUpc('12121212121212')).toBe(true));

  // Pattern 5: Explicit blocklist.
  it('blocklist-012345678905', () => expect(isFakeUpc('012345678905')).toBe(true));
  it('blocklist-000000000017', () => expect(isFakeUpc('000000000017')).toBe(true));
});

describe('isFakeUpc → false (real UPCs from catalog)', () => {
  // Real UPCs from existing product_lookups (MAC.BID seed data).
  it('real-upc-zlight', () => expect(isFakeUpc('685659203974')).toBe(false));
  it('real-upc-199291', () => expect(isFakeUpc('199291112094')).toBe(false));
  // Realistic UPCs that share properties with fake patterns but are not fake.
  it('real-upc-starts-0 (different from sequential by last digit)', () =>
    expect(isFakeUpc('012345678906')).toBe(false));
  it('real-upc-leadingzero (has zeros but mixed)', () =>
    expect(isFakeUpc('012000678906')).toBe(false));
  it('real-upc-dewalt', () => expect(isFakeUpc('885911548632')).toBe(false));
  it('real-upc-mixed', () => expect(isFakeUpc('741234112094')).toBe(false));
  // 13-digit EAN — length check (14 chars — skip is original comment; this is 13).
  it('real-ean13', () => expect(isFakeUpc('9780201379624')).toBe(false));
  it('real-ean13-valid', () => expect(isFakeUpc('4006381333931')).toBe(false));
});

describe('isFakeAsin → true (bogus ASINs)', () => {
  it('asin-all-zeros', () => expect(isFakeAsin('B000000000')).toBe(true));
  it('asin-all-A', () => expect(isFakeAsin('BAAAAAAAAA')).toBe(true));
  it('asin-all-1', () => expect(isFakeAsin('B111111111')).toBe(true));
  it('asin-all-9', () => expect(isFakeAsin('B999999999')).toBe(true));
  it('asin-repeated-ABAB (period 2)', () => expect(isFakeAsin('BABABABABA')).toBe(true));
  it('asin-sequential', () => expect(isFakeAsin('B012345678')).toBe(true));
  it('asin-blocklist', () => expect(isFakeAsin('B000000000')).toBe(true));
  // All-same first char + same char after (10 chars same).
  it('asin-AAAAAAAAAA', () => expect(isFakeAsin('AAAAAAAAAA')).toBe(true));
});

describe('isFakeAsin → false (real ASINs)', () => {
  it('real-asin-dewalt', () => expect(isFakeAsin('B01N5MB4LX')).toBe(false));
  it('real-asin-airpods', () => expect(isFakeAsin('B0BDHB9Y8H')).toBe(false));
  it('real-asin-mixed', () => expect(isFakeAsin('B07FZ8S74R')).toBe(false));
  it('real-asin-numeric', () => expect(isFakeAsin('B08N5WRWNW')).toBe(false));
});

describe('normalizeUpc — end-to-end', () => {
  // Accepts valid real UPCs.
  it('norm-real', () => expect(normalizeUpc('685659203974')).toBe('685659203974'));
  it('norm-strips-dashes', () => expect(normalizeUpc('6-85659-20397-4')).toBe('685659203974'));
  it('norm-strips-spaces', () => expect(normalizeUpc(' 685659203974 ')).toBe('685659203974'));
  // Rejects bogus patterns.
  it('norm-fake-zeros', () => expect(normalizeUpc('000000000000')).toBeNull());
  it('norm-fake-seq', () => expect(normalizeUpc('012345678901')).toBeNull());
  it('norm-fake-repeat', () => expect(normalizeUpc('121212121212')).toBeNull());
  // Rejects garbage.
  it('norm-null', () => expect(normalizeUpc(null)).toBeNull());
  it('norm-undefined', () => expect(normalizeUpc(undefined)).toBeNull());
  it('norm-text', () => expect(normalizeUpc('abc')).toBeNull());
  it('norm-short', () => expect(normalizeUpc('12345')).toBeNull());
  // Passes unknown-but-structurally-valid UPCs through.
  it('norm-unknown-valid', () => expect(normalizeUpc('885911548632')).toBe('885911548632'));
});

describe('normalizeAsin — end-to-end', () => {
  // Accepts real ASINs.
  it('asin-real', () => expect(normalizeAsin('B01N5MB4LX')).toBe('B01N5MB4LX'));
  it('asin-trims', () => expect(normalizeAsin(' B01N5MB4LX ')).toBe('B01N5MB4LX'));
  it('asin-uppercases', () => expect(normalizeAsin('b01n5mb4lx')).toBe('B01N5MB4LX'));
  // Rejects bogus.
  it('asin-fake-zeros', () => expect(normalizeAsin('B000000000')).toBeNull());
  it('asin-fake-AAAA', () => expect(normalizeAsin('BAAAAAAAAA')).toBeNull());
  // Rejects garbage.
  it('asin-null', () => expect(normalizeAsin(null)).toBeNull());
  it('asin-short (9 chars)', () => expect(normalizeAsin('B01N5MB4L')).toBeNull());
  it('asin-spaces (space in middle)', () => expect(normalizeAsin('B01N5 B4LX')).toBeNull());
});

describe('looksLikeCarrierBarcode — sticker mis-scan guard (mig 0308)', () => {
  // The 2026-08-02 report: the FedEx 1D barcode on a Wayfair returns box wins
  // the camera frame and binds itself as the lot's sticker. None of these carry
  // a valid GS1 check digit, which is why isValidGtinCheckDigit missed them.
  it('fedex-tracking-1', () => expect(looksLikeCarrierBarcode('533500296376')).toBe(true));
  it('fedex-tracking-2', () => expect(looksLikeCarrierBarcode('533500190515')).toBe(true));
  it('fedex-tracking-3', () => expect(looksLikeCarrierBarcode('533499739230')).toBe(true));
  // The 34-digit FedEx ancillary block — not a GTIN length at all.
  it('fedex-96-block', () =>
    expect(looksLikeCarrierBarcode('9622013140001309096900533500618795')).toBe(true));
  it('usps-gs1-20-digit', () => expect(looksLikeCarrierBarcode('00401955552480570222')).toBe(true));
  it('ups-1z', () => expect(looksLikeCarrierBarcode('1Z999AA10123456784')).toBe(true));
  it('ups-1z-lowercase', () => expect(looksLikeCarrierBarcode('1z999aa10123456784')).toBe(true));
  // Retail barcodes — the 2026-07-08 class the original guard did catch.
  it('ean-13', () => expect(looksLikeCarrierBarcode('5407007656684')).toBe(true));
  it('upc-a', () => expect(looksLikeCarrierBarcode('0013562300662')).toBe(true));
  it('ean-8-shortest-observed', () => expect(looksLikeCarrierBarcode('06854652')).toBe(true));
  it('trims-whitespace', () => expect(looksLikeCarrierBarcode(' 533500296376 ')).toBe(true));

  // The accept side is what keeps lotting working. 6,319 of the 6,382 codes
  // bound on prod are colour-prefixed BinGo stickers; the rest are LPNs,
  // vendor SKUs and ASINs. A tightening that flags any of these stops the floor.
  it('bingo-pink', () => expect(looksLikeCarrierBarcode('PNK4819555')).toBe(false));
  it('bingo-brown', () => expect(looksLikeCarrierBarcode('BRN4380112')).toBe(false));
  it('bingo-teal', () => expect(looksLikeCarrierBarcode('TEA3822650')).toBe(false));
  it('bingo-lowercase-as-scanned', () => expect(looksLikeCarrierBarcode('brn4046321')).toBe(false));
  it('amazon-lpn', () => expect(looksLikeCarrierBarcode('LPNNB6JW2WVJT')).toBe(false));
  it('asin', () => expect(looksLikeCarrierBarcode('X004Q9MODX')).toBe(false));
  it('vendor-sku-hyphenated', () =>
    expect(looksLikeCarrierBarcode('SZQW-US-VD035-WE-A-M05')).toBe(false));
  it('vendor-sku-mostly-digits', () => expect(looksLikeCarrierBarcode('RDB-15-01-01')).toBe(false));
  it('vendor-ref', () => expect(looksLikeCarrierBarcode('N729P285543K')).toBe(false));
  it('alphanumeric-8', () => expect(looksLikeCarrierBarcode('39Y69JBA')).toBe(false));
  // Below the 8-digit floor, deliberately allowed.
  it('seven-digits-under-floor', () => expect(looksLikeCarrierBarcode('1234567')).toBe(false));
  // 1Z prefix but the wrong length is not the UPS form.
  it('near-miss-1z-short', () => expect(looksLikeCarrierBarcode('1Z999AA1012345678')).toBe(false));
  // Garbage in, false out — never throws.
  it('null', () => expect(looksLikeCarrierBarcode(null)).toBe(false));
  it('undefined', () => expect(looksLikeCarrierBarcode(undefined)).toBe(false));
  it('empty', () => expect(looksLikeCarrierBarcode('')).toBe(false));
});

// ── normalizeReadUpc — a UPC a vision model claims it read ──────────────────
describe('normalizeReadUpc', () => {
  // 2026-09-23, party cups: the model invented this on a no-match.
  it('rejects the invented 00012345678901 (bad check digit, padded run)', () =>
    expect(normalizeReadUpc('00012345678901')).toBeNull());
  it('rejects a zero-padded run even with a valid check digit', () =>
    expect(normalizeReadUpc('00012345678905')).toBeNull());
  it('keeps a real UPC-A', () => expect(normalizeReadUpc('036000291452')).toBe('036000291452'));
  it('keeps a real EAN-13', () => expect(normalizeReadUpc('4006381333931')).toBe('4006381333931'));
  it('rejects a real-length code with a wrong check digit', () =>
    expect(normalizeReadUpc('036000291453')).toBeNull());
  it('rejects garbage, empty and non-strings', () => {
    expect(normalizeReadUpc('')).toBeNull();
    expect(normalizeReadUpc('X004TGOPSP')).toBeNull();
    expect(normalizeReadUpc(null)).toBeNull();
  });
});

