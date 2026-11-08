// Retail barcode normalisation — FORMAT-COUPLED.
//
// Produces normalised candidate values from retail barcode formats.
// All logic is keyed to barcode FORMAT FAMILIES, not retail chains or vendors.
//
// Operations:
//   UPC-E (8-digit, symbology 'upc-e') → UPC-A expansion (12 digits)
//   GTIN-13 (13-digit EAN, symbology 'ean-13') → UPC-12 when leading digit is '0'
//   ITF-14 (14-digit, symbology 'itf-14') → strip indicator → GTIN-13; then GTIN-13 → UPC-12

import type { Symbology } from './index';

// ── UPC-E → UPC-A expansion ──────────────────────────────────────────────
//
// UPC-E is a zero-suppressed form of UPC-A. The final digit of the 8-char
// UPC-E string (position 7, 0-indexed) is the "number system + check-digit"
// parity character. The 6 middle characters encode the UPC-A digits per
// the suppression rules below.
//
// Standard expansion rules (GS1 spec §5.2.2.3):
//   Last char 0: manufacturer XXXXX0, product 00000X → 0 XXXXX0 00000X C
//   Last char 1: manufacturer XXXXX1, product 00000X → 0 XXXXX1 00000X C  (same)
//   Last char 2: manufacturer XXXXX2, product 000XXX → varies...
//
// We implement the standard 6 rules that cover all valid UPC-E codes.
// Number system digit (first of UPC-A) is always '0' for standard UPC-E.

function expandUpcE(upcE: string): string | null {
  // Accept both 6-digit "bare" UPC-E (sans system+check) and 8-digit full form.
  let core: string;
  if (upcE.length === 8) {
    core = upcE.slice(1, 7); // drop number-system (pos 0) and check (pos 7)
  } else if (upcE.length === 6) {
    core = upcE;
  } else {
    return null;
  }

  const [d1, d2, d3, d4, d5, d6] = core.split('');
  if (!d1 || !d2 || !d3 || !d4 || !d5 || !d6) return null;

  let manuf: string;
  let prod: string;

  switch (d6) {
    case '0':
    case '1':
    case '2':
      manuf = `${d1}${d2}${d6}000`;
      prod = `00${d3}${d4}${d5}`;
      break;
    case '3':
      manuf = `${d1}${d2}${d3}000`;
      prod = `000${d4}${d5}`;
      break;
    case '4':
      manuf = `${d1}${d2}${d3}${d4}000`;
      prod = `0000${d5}`;
      break;
    default:
      // 5–9: manufacturer is 5 digits, product is 0000X
      manuf = `${d1}${d2}${d3}${d4}${d5}`;
      prod = `0000${d6}`;
      break;
  }

  const withoutCheck = `0${manuf}${prod}`;
  if (withoutCheck.length !== 11) return null;

  const check = computeUpcCheckDigit(withoutCheck);
  return `${withoutCheck}${check}`;
}

/** Standard UPC/EAN check digit (modulo-10 weighted sum). */
function computeUpcCheckDigit(digits11: string): string {
  let sum = 0;
  for (let i = 0; i < 11; i++) {
    const d = parseInt(digits11[i] ?? '0', 10);
    sum += i % 2 === 0 ? d * 3 : d;
  }
  return String((10 - (sum % 10)) % 10);
}

// ── GTIN-13 (EAN-13) → UPC-12 ────────────────────────────────────────────
//
// When the leading digit of a 13-digit GTIN is '0', stripping it yields
// the equivalent UPC-A (12-digit). Used to normalise to the form stored
// in import_rows.upc (which the importer normalises to digits-only 12).

function gtin13ToUpc12(raw: string): string | null {
  if (raw.length === 13 && raw[0] === '0') {
    return raw.slice(1);
  }
  return null;
}

// A UPC-A barcode is 12 digits; the GTIN-13 form of the same code is that value
// with a leading '0'. Our stored identifiers (import_rows.upc, product_lookups)
// are the 13-digit GTIN form (verified prod 2026-09-21: all 4,756 manifest UPCs
// are 13-digit, 4,469 leading-zero). A scanner reading a UPC-A emits 12 digits,
// and find_import_row_by_scan matches the stored value EXACTLY — so a 12-digit
// scan never equalled the 13-digit stored code and every UPC scan missed. This
// is the reverse of gtin13ToUpc12: emit the 13-digit form for a 12-digit code so
// both lengths are offered as candidates regardless of stored form.
function upc12ToGtin13(raw: string): string | null {
  if (raw.length === 12 && /^\d{12}$/.test(raw)) {
    return '0' + raw;
  }
  return null;
}

// ── ITF-14 outer-pack → GTIN-13 → UPC-12 ─────────────────────────────────
//
// ITF-14 (14-digit interleaved 2-of-5) encodes a GTIN-14 for outer
// cartons / pallets. Stripping the leading "indicator digit" (0–8) gives
// the GTIN-13 of the inner item. If THAT GTIN-13 starts with '0', we also
// yield the UPC-12.

function itf14ToGtin13(raw: string): string | null {
  if (raw.length === 14 && /^\d{14}$/.test(raw)) {
    return raw.slice(1); // 13 digits: strip leading indicator
  }
  return null;
}

/**
 * Extract retail barcode normalisation candidates from a raw scan.
 *
 * Returns values that differ from `raw` (caller prepends raw and deduplicates).
 * Returns empty array when no normalisation applies.
 */
export function extractRetailCandidates(raw: string, symbology: Symbology): string[] {
  const results: string[] = [];

  switch (symbology) {
    case 'upc-e': {
      const upcA = expandUpcE(raw);
      if (upcA) {
        results.push(upcA);
        // Also the GTIN-13 form, so a UPC-E scan matches a 13-digit stored code.
        const gtin13 = upc12ToGtin13(upcA);
        if (gtin13) results.push(gtin13);
      }
      break;
    }

    case 'upc-a': {
      // 12-digit UPC-A → also offer the 13-digit GTIN form (our stored form).
      // Without this, a UPC-A scan produced only its 12-digit self and missed
      // every 13-digit stored code — the 2026-09-21 "UPC scans never match".
      const gtin13 = upc12ToGtin13(raw);
      if (gtin13) results.push(gtin13);
      break;
    }

    case 'ean-13': {
      // 13-digit scan: the raw 13 is kept by the caller; also offer the
      // 12-digit UPC-A form for data stored in the shorter form.
      const upc12 = gtin13ToUpc12(raw);
      if (upc12) results.push(upc12);
      break;
    }

    case 'itf-14': {
      const gtin13 = itf14ToGtin13(raw);
      if (gtin13) {
        results.push(gtin13);
        const upc12 = gtin13ToUpc12(gtin13);
        if (upc12) results.push(upc12);
      }
      break;
    }

    default:
      break;
  }

  return results;
}
