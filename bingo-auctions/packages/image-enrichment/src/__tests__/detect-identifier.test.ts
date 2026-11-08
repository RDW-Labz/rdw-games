// detect-identifier.test.ts
//
// Unit tests for detectIdentifier(). Pure function — no mocks needed.

import { describe, it, expect } from 'vitest';
import { detectIdentifier } from '../detect-identifier.js';

describe('detectIdentifier — ASIN priority', () => {
  it('1. valid B0 ASIN → kind=asin', () => {
    const r = detectIdentifier({ asin: 'B08N5WRWNW' });
    expect(r.kind).toBe('asin');
    expect(r.value).toBe('B08N5WRWNW');
  });

  it('2. ASIN with leading/trailing whitespace → trimmed + kind=asin', () => {
    const r = detectIdentifier({ asin: '  B08N5WRWNW  ' });
    expect(r.kind).toBe('asin');
    expect(r.value).toBe('B08N5WRWNW');
  });

  it('3. ASIN lowercase → uppercased, kind=asin', () => {
    const r = detectIdentifier({ asin: 'b08n5wrwnw' });
    expect(r.kind).toBe('asin');
    expect(r.value).toBe('B08N5WRWNW');
  });

  it('4. ASIN present alongside UPC → ASIN wins (priority)', () => {
    const r = detectIdentifier({ asin: 'B08N5WRWNW', upc: '012345678901' });
    expect(r.kind).toBe('asin');
  });

  it('5. old-style ASIN not starting with B0 → rejected (not kind=asin)', () => {
    // ASIN shape rule: must start with B0
    const r = detectIdentifier({ asin: 'A12345678X' });
    expect(r.kind).not.toBe('asin');
  });

  it('6. ASIN too short (9 chars) → not matched', () => {
    const r = detectIdentifier({ asin: 'B08N5WRWN' });
    expect(r.kind).not.toBe('asin');
  });

  it('7. ASIN too long (11 chars) → not matched', () => {
    const r = detectIdentifier({ asin: 'B08N5WRWNWX' });
    expect(r.kind).not.toBe('asin');
  });

  it('8. FNSKU in fnsku field → ASIN shape check skips fnsku', () => {
    // FNSKU values like X001ABC123 should not be mistakenly mapped as ASIN
    const r = detectIdentifier({ fnsku: 'B08N5WRWNW' });
    // fnsku is NOT checked for ASIN; only asin field is
    expect(r.kind).not.toBe('asin');
  });
});

describe('detectIdentifier — UPC', () => {
  it('9. 12-digit UPC-A → kind=upc', () => {
    const r = detectIdentifier({ upc: '012345678901' });
    expect(r.kind).toBe('upc');
    expect(r.value).toBe('012345678901');
  });

  it('10. 13-digit EAN-13 (non-ISBN prefix) → kind=upc', () => {
    // 400 prefix is not ISBN
    const r = detectIdentifier({ upc: '4006381333931' });
    expect(r.kind).toBe('upc');
  });

  it('11. UPC in external_code fallback (no upc column) → kind=upc', () => {
    const r = detectIdentifier({ external_code: '012345678901' });
    expect(r.kind).toBe('upc');
    expect(r.value).toBe('012345678901');
  });

  it('12. 11-digit number → not UPC', () => {
    const r = detectIdentifier({ upc: '01234567890' });
    expect(r.kind).toBeNull();
  });

  it('13. 14-digit number → not UPC (EAN-14 not supported)', () => {
    const r = detectIdentifier({ upc: '00123456789012' });
    expect(r.kind).toBeNull();
  });

  it('14. UPC with whitespace → trimmed correctly', () => {
    const r = detectIdentifier({ upc: '  012345678901  ' });
    expect(r.kind).toBe('upc');
    expect(r.value).toBe('012345678901');
  });
});

describe('detectIdentifier — ISBN', () => {
  it('15. ISBN-13 with 978 prefix → kind=isbn', () => {
    const r = detectIdentifier({ upc: '9780306406157' });
    expect(r.kind).toBe('isbn');
    expect(r.value).toBe('9780306406157');
  });

  it('16. ISBN-13 with 979 prefix → kind=isbn', () => {
    const r = detectIdentifier({ upc: '9791032311615' });
    expect(r.kind).toBe('isbn');
  });

  it('17. ISBN-10 (9 digits + X) → kind=isbn', () => {
    const r = detectIdentifier({ upc: '030640615X' });
    expect(r.kind).toBe('isbn');
    expect(r.value).toBe('030640615X');
  });

  it('18. ISBN-10 all-numeric → kind=isbn', () => {
    const r = detectIdentifier({ upc: '0306406152' });
    expect(r.kind).toBe('isbn');
  });

  it('19. ISBN-13 in external_code when upc absent → kind=isbn', () => {
    const r = detectIdentifier({ external_code: '9780306406157' });
    expect(r.kind).toBe('isbn');
  });

  it('20. EAN-13 with 978 prefix alongside UPC → ISBN wins over EAN non-isbn', () => {
    // When upc field itself is ISBN-13-shaped, it should be isbn not upc
    const r = detectIdentifier({ upc: '9780306406157' });
    expect(r.kind).toBe('isbn');
  });
});

describe('detectIdentifier — null / no-op cases', () => {
  it('21. all fields empty → kind=null, value=""', () => {
    const r = detectIdentifier({});
    expect(r.kind).toBeNull();
    expect(r.value).toBe('');
  });

  it('22. all fields null → kind=null', () => {
    const r = detectIdentifier({ upc: null, asin: null, fnsku: null, lpn: null, external_code: null });
    expect(r.kind).toBeNull();
  });

  it('23. random string → kind=null', () => {
    const r = detectIdentifier({ upc: 'ABC-NOT-VALID' });
    expect(r.kind).toBeNull();
  });

  it('24. short numeric string (7 digits) → kind=null', () => {
    const r = detectIdentifier({ upc: '1234567' });
    expect(r.kind).toBeNull();
  });
});
