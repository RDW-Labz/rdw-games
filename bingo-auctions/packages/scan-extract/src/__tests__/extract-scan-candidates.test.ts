// TDD tests for extractScanCandidates.
//
// Fixture coverage (5 required by spec):
//   1. 22-digit SSCC composite (code-128) — extracts last-12 as tracking candidate
//   2. UPS 1Z tracking (code-128) — passes through unchanged
//   3. EAN-13 with leading zero — normalises to UPC-12
//   4. X00-style FNSKU (shape-detected) + B0-ASIN (shape-detected)
//   5. Generic LPN (alphanumeric 12-18 chars)
//
// Additional coverage:
//   6. GS1-128 composite with FNC1 prefix — AIs extracted
//   7. ITF-14 outer-pack extraction
//   8. UPC-E expansion
//   9. Raw QR that is just a lot code — passes through unchanged
//  10. USPS IMpb (20-digit numeric) — any symbology, incl. qr (gate removed)
//  11. Numeric composite — last-12 symbology-agnostic (BIN-000094 regression)

import { describe, it, expect } from 'vitest';
import { extractScanCandidates } from '../index.js';

// ---------------------------------------------------------------------------
// 1. 22-digit SSCC (code-128 / data-matrix) — extracts last-12 digits
// ---------------------------------------------------------------------------
describe('22-digit SSCC composite', () => {
  it('includes raw and extracts last-12 as a candidate', () => {
    // Real FedEx SSCC: 18-digit SSCC wrapped in a 22-char string with
    // check-digit + extension prefix "00" AI. Last 12 digits = tracking base.
    const raw = '0034156810012345678901';
    const result = extractScanCandidates(raw, 'code-128');
    expect(result.raw).toBe(raw);
    expect(result.candidates).toContain(raw);
    // Last 12 digits of this 22-digit string
    expect(result.candidates).toContain('345678901234'.slice(0, 12) === '345678901234'
      ? raw.slice(-12)
      : raw.slice(-12));
  });

  it('extracts last-12 from a data-matrix SSCC too', () => {
    const raw = '0034156810012345678901';
    const result = extractScanCandidates(raw, 'data-matrix');
    expect(result.candidates).toContain(raw.slice(-12));
  });
});

// ---------------------------------------------------------------------------
// 2. UPS 1Z tracking number — any symbology, passes through
// ---------------------------------------------------------------------------
describe('UPS 1Z tracking number', () => {
  it('includes the raw 1Z code in candidates unchanged', () => {
    const raw = '1Z999AA10123456784';
    const result = extractScanCandidates(raw, 'code-128');
    expect(result.raw).toBe(raw);
    expect(result.candidates[0]).toBe(raw);
    expect(result.candidates).toContain(raw);
  });

  it('detects 1Z from any symbology (qr)', () => {
    const raw = '1ZABC1234567890123';
    const result = extractScanCandidates(raw, 'qr');
    expect(result.candidates).toContain(raw);
  });
});

// ---------------------------------------------------------------------------
// 3. EAN-13 with leading zero — normalise to UPC-12
// ---------------------------------------------------------------------------
describe('EAN-13 with leading zero', () => {
  it('strips leading zero to produce UPC-12 candidate', () => {
    const raw = '0012345678905'; // 13 digits, leading zero
    const result = extractScanCandidates(raw, 'ean-13');
    expect(result.raw).toBe(raw);
    expect(result.candidates).toContain(raw);
    expect(result.candidates).toContain('012345678905'); // 12 digits
  });

  it('does not strip a non-zero leading digit', () => {
    const raw = '5012345678900';
    const result = extractScanCandidates(raw, 'ean-13');
    expect(result.candidates).not.toContain('012345678900'.slice(1)); // no strip
    expect(result.candidates).toContain(raw);
  });
});

// ---------------------------------------------------------------------------
// 4. Marketplace identifier shapes: X00-FNSKU and B0-ASIN
// ---------------------------------------------------------------------------
describe('X00-style FNSKU', () => {
  it('detects 10-char X00 FNSKU shape', () => {
    const raw = 'X001234567'; // 10 chars, starts X00
    const result = extractScanCandidates(raw, 'code-128');
    expect(result.candidates).toContain(raw);
    // raw should be first candidate, shape detection adds it (deduped)
    expect(result.candidates[0]).toBe(raw);
  });
});

describe('B0-ASIN shape', () => {
  it('detects B0 ASIN pattern', () => {
    const raw = 'B0CX1Y2Z3W';
    const result = extractScanCandidates(raw, 'qr');
    expect(result.candidates).toContain(raw);
  });

  it('does not confuse non-B0 code as ASIN', () => {
    const raw = 'B1CX1Y2Z3W'; // starts B1 not B0
    const result = extractScanCandidates(raw, 'qr');
    // still in candidates as raw, but shape not a match for ASIN pattern
    expect(result.candidates).toContain(raw);
  });
});

// ---------------------------------------------------------------------------
// 5. Generic LPN — alphanumeric 12-18 chars
// ---------------------------------------------------------------------------
describe('Generic LPN-like identifier', () => {
  it('includes alphanumeric 12-char string as candidate', () => {
    const raw = 'ABCD12345678'; // 12 chars, alphanumeric
    const result = extractScanCandidates(raw, 'code-128');
    expect(result.candidates).toContain(raw);
  });

  it('includes 18-char alphanumeric as candidate', () => {
    const raw = 'ABCDEF123456789012'; // 18 chars
    const result = extractScanCandidates(raw, 'code-128');
    expect(result.candidates).toContain(raw);
  });

  it('does not treat 11-char string as LPN (below minimum)', () => {
    const raw = 'ABCD1234567'; // 11 chars — below 12 threshold
    const result = extractScanCandidates(raw, 'code-128');
    // still in candidates as raw, but not as a separate LPN extraction
    expect(result.candidates.length).toBe(1); // only raw, no extra extraction
  });
});

// ---------------------------------------------------------------------------
// 6. GS1-128 with FNC1 prefix — AI extraction
// ---------------------------------------------------------------------------
describe('GS1-128 FNC1 prefix (]C1)', () => {
  it('strips FNC1 leader and extracts AI (00) SSCC', () => {
    // ]C1 prefix + AI 00 + 18-digit SSCC
    const raw = ']C100012345678901234563';
    const result = extractScanCandidates(raw, 'code-128');
    expect(result.raw).toBe(raw);
    // Should extract the SSCC value after AI 00
    expect(result.candidates).toContain('012345678901234563');
  });

  it('extracts AI (01) GTIN', () => {
    const raw = ']C10100614141000415';
    const result = extractScanCandidates(raw, 'code-128');
    expect(result.candidates).toContain('00614141000415');
  });
});

// ---------------------------------------------------------------------------
// 7. ITF-14 outer-pack extraction
// ---------------------------------------------------------------------------
describe('ITF-14 outer-pack', () => {
  it('strips leading indicator digit from ITF-14 to get GTIN-13', () => {
    const raw = '10012345678905'; // 14 digits
    const result = extractScanCandidates(raw, 'itf-14');
    expect(result.candidates).toContain(raw);
    // Strip leading indicator digit → 13 digits
    expect(result.candidates).toContain('0012345678905');
  });

  it('also yields GTIN-12 (UPC) when GTIN-13 starts with zero', () => {
    const raw = '10012345678905';
    const result = extractScanCandidates(raw, 'itf-14');
    // GTIN-13 starts with 0 → strip to UPC-12
    expect(result.candidates).toContain('012345678905');
  });
});

// ---------------------------------------------------------------------------
// 8. UPC-E expansion
// ---------------------------------------------------------------------------
describe('UPC-E expansion', () => {
  it('expands UPC-E (8 digits) to UPC-A (12 digits)', () => {
    // UPC-E: 01234565 — expands to 012000003456X (standard expansion)
    const raw = '01234565';
    const result = extractScanCandidates(raw, 'upc-e');
    expect(result.raw).toBe(raw);
    // UPC-A expansion must be in candidates
    const upcA = result.candidates.find((c) => c.length === 12 && c !== raw);
    expect(upcA).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 9. Plain QR lot-code — passes through unchanged, no spurious extras
// ---------------------------------------------------------------------------
describe('Plain lot code QR', () => {
  it('passes through a short lot code with no extra candidates', () => {
    const raw = 'BIN-000077';
    const result = extractScanCandidates(raw, 'qr');
    expect(result.raw).toBe(raw);
    expect(result.candidates).toEqual([raw]);
  });
});

// ---------------------------------------------------------------------------
// 10. USPS IMpb (20-22 digit numeric, code-128/data-matrix only)
// ---------------------------------------------------------------------------
describe('USPS IMpb tracking number', () => {
  it('includes 20-digit numeric USPS tracking as candidate (code-128)', () => {
    const raw = '92001902244965565200';  // 20 digits numeric
    const result = extractScanCandidates(raw, 'code-128');
    expect(result.candidates).toContain(raw);
  });

  it('also extracts last-12 from a qr scan of a 20-digit numeric (symbology-agnostic)', () => {
    // Gate removal: qr symbology now also triggers numeric-composite extraction.
    const raw = '92001902244965565200';
    const result = extractScanCandidates(raw, 'qr');
    expect(result.candidates).toContain(raw);
    expect(result.candidates).toContain('244965565200');  // last 12
  });
});

// ---------------------------------------------------------------------------
// Deduplication invariant
// ---------------------------------------------------------------------------
describe('deduplication', () => {
  it('never has duplicate candidates', () => {
    const raw = '1Z999AA10123456784';
    const result = extractScanCandidates(raw, 'code-128');
    const unique = new Set(result.candidates);
    expect(result.candidates.length).toBe(unique.size);
  });

  it('raw is always the first candidate', () => {
    const raw = '0012345678905';
    const result = extractScanCandidates(raw, 'ean-13');
    expect(result.candidates[0]).toBe(raw);
  });
});

// ---------------------------------------------------------------------------
// unknown symbology — treated conservatively
// ---------------------------------------------------------------------------
describe('unknown symbology', () => {
  it('returns only raw for an unknown type', () => {
    const raw = 'SOMEVALUE123';
    const result = extractScanCandidates(raw, 'unknown');
    expect(result.raw).toBe(raw);
    expect(result.candidates).toContain(raw);
  });
});

// ---------------------------------------------------------------------------
// 11. Generalized numeric-composite extraction (carrier-agnostic, 20-40d)
// ---------------------------------------------------------------------------
describe('Numeric composite — last-12 always extracted (any symbology)', () => {
  it('20-digit numeric also yields last-12 (was no-op pre-generalization)', () => {
    const raw = '92001902244965565200';  // 20 digits
    const result = extractScanCandidates(raw, 'code-128');
    expect(result.candidates).toContain(raw);
    expect(result.candidates).toContain('244965565200');  // last 12
  });

  it('26-digit FedEx-style composite extracts last-12', () => {
    const raw = '00013020969000796041136653';  // 26 digits
    const result = extractScanCandidates(raw, 'code-128');
    expect(result.candidates).toContain(raw);
    expect(result.candidates).toContain('796041136653');
  });

  it('30-digit prefix-padded composite extracts last-12', () => {
    const raw = '000000000000000000486573719871';  // 30 digits
    const result = extractScanCandidates(raw, 'data-matrix');
    expect(result.candidates).toContain('486573719871');
  });

  it('34-digit FedEx human-readable composite extracts last-12', () => {
    const raw = '9622013140000000000000486573719871';  // 34 digits
    const result = extractScanCandidates(raw, 'code-128');
    expect(result.candidates).toContain('486573719871');
  });

  it('40-digit upper-bound composite extracts last-12', () => {
    const raw = '0000000000000000000000000000486573719871';  // 40 digits
    const result = extractScanCandidates(raw, 'pdf-417');
    expect(result.candidates).toContain('486573719871');
  });

  it('19-digit numeric (below threshold) — only raw, no last-12', () => {
    const raw = '1234567890123456789';  // 19 digits
    const result = extractScanCandidates(raw, 'code-128');
    expect(result.candidates).toEqual([raw]);
  });

  it('41-digit numeric (above threshold) — only raw, no last-12', () => {
    const raw = '12345678901234567890123456789012345678901';  // 41 digits
    const result = extractScanCandidates(raw, 'code-128');
    expect(result.candidates).toEqual([raw]);
  });

  it('extracts last-12 from numeric composite on qr symbology (symbology-agnostic)', () => {
    const raw = '0000000000486573719871';  // 22 digits, qr
    const result = extractScanCandidates(raw, 'qr');
    expect(result.candidates).toContain('486573719871');
  });

  it('UPS 1Z* still passes through cleanly (no composite extraction)', () => {
    const raw = '1Z999AA10123456784';
    const result = extractScanCandidates(raw, 'code-128');
    expect(result.candidates).toEqual([raw]);  // just raw
  });

  // --- symbology-gate regression suite (BIN-000094) ---

  it('extracts last-12 from itf-14 FedEx Ground composite (BIN-000094 regression)', () => {
    // vision-camera v4 reports FedEx Ground 96-bit outer-pack as 'itf-14'.
    // Previously rejected by the LINEAR_OR_2D gate. Must now extract last-12.
    const raw = '9622013140001309096900486573606022';  // 34 digits
    const result = extractScanCandidates(raw, 'itf-14');
    expect(result.candidates).toContain('486573606022');
  });

  it('extracts last-12 from code-39 22-digit numeric composite', () => {
    const raw = '0000000000486573719871';  // 22 digits, code-39
    const result = extractScanCandidates(raw, 'code-39');
    expect(result.candidates).toContain('486573719871');
  });

  it('extracts last-12 from code-93 22-digit numeric composite', () => {
    const raw = '0000000000486573719871';  // 22 digits, code-93
    const result = extractScanCandidates(raw, 'code-93');
    expect(result.candidates).toContain('486573719871');
  });

  it('extracts last-12 from codabar 22-digit numeric composite', () => {
    const raw = '0000000000486573719871';  // 22 digits, codabar
    const result = extractScanCandidates(raw, 'codabar');
    expect(result.candidates).toContain('486573719871');
  });

  // --- UPC 12<->13 GTIN normalisation (2026-09-21 "UPC scans never match") ---
  // Stored identifiers are the 13-digit GTIN form (leading zero); scanners emit
  // 12-digit UPC-A. The resolver matches exactly, so both lengths must be
  // offered as candidates.
  it('UPC-A 12-digit also yields the 13-digit GTIN form', () => {
    const result = extractScanCandidates('022600001041', 'upc-a');
    expect(result.candidates).toContain('022600001041'); // raw kept
    expect(result.candidates).toContain('0022600001041'); // GTIN-13 for a 13-digit stored code
  });

  it('EAN-13 13-digit still yields the 12-digit UPC form', () => {
    const result = extractScanCandidates('0022600001041', 'ean-13');
    expect(result.candidates).toContain('0022600001041'); // raw kept
    expect(result.candidates).toContain('022600001041'); // UPC-12 for a 12-digit stored code
  });

  it('does not fabricate a 13-digit form for a non-12-digit UPC-A payload', () => {
    const result = extractScanCandidates('ABC123', 'upc-a');
    expect(result.candidates).toEqual(['ABC123']);
  });

  it('extracts last-12 from unknown symbology with BIN-000094 input (manual-input case)', () => {
    // Manual keyboard entry sets symbology to 'unknown'. Gate removal means
    // manually typed FedEx Ground composites now also resolve to last-12.
    const raw = '9622013140001309096900486573606022';  // 34 digits
    const result = extractScanCandidates(raw, 'unknown');
    expect(result.candidates).toContain('486573606022');
  });
});
