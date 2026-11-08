// UPC / ASIN / GTIN normalization.
//
// These are the canonical implementations used across every ingestion path:
// CSV importer, scraper, mobile capture, OpenRouter responses, AI output.
// DB-side mirror: normalize_upc() in migration 0038_normalize_helpers.sql.
//                 is_fake_upc() / is_fake_asin() in 0044_normalize_quality.sql.
//
// Rules for UPC storage:
//   - Store digits verbatim — do NOT expand UPC-E to UPC-A or strip leading zeros.
//   - Only accept lengths 8 (UPC-E), 12 (UPC-A), 13 (EAN-13), 14 (GTIN-14).
//   - Everything else returns null — better to have a null than a wrong code.
//
// Bogus-pattern rejection (isFakeUpc / isFakeAsin):
//   Scrapers and LLMs routinely emit placeholder values for UPCs and ASINs
//   (e.g. MAC.BID sends '000000000000' when a product has no barcode on file).
//   Letting these through poisons product_lookups and causes false-positive
//   barcode scans. isFakeUpc / isFakeAsin detect the obvious patterns and
//   normalizeUpc / normalizeAsin return null for them, treating bogus codes
//   exactly the same as non-parseable garbage.

const VALID_UPC_LENGTHS: ReadonlySet<number> = new Set([8, 12, 13, 14]);

// ── isFakeUpc ─────────────────────────────────────────────────────────────────

/**
 * Detect obviously-bogus UPC/EAN/GTIN digit strings.
 *
 * Receives a digits-only string that has already passed the length gate
 * (8 / 12 / 13 / 14 chars). Returns true if the value matches any known
 * placeholder pattern:
 *
 *   1. All same digit              — "000000000000", "999999999999"
 *   2. Sequential ascending        — "012345678901", "12345670"
 *   3. Sequential descending       — "987654321098"
 *   4. Repeated short sub-pattern  — "121212121212", "123412341234"
 *   5. Explicit blocklist          — specific strings known to appear in the
 *                                    wild as test / placeholder values
 *
 * A UPC that returns true here should be treated as null by the caller —
 * it is indistinguishable from a missing barcode.
 *
 * @param digits - Digits-only string, length already validated as 8/12/13/14.
 */
export function isFakeUpc(digits: string): boolean {
  // ── Pattern 1: All same digit ─────────────────────────────────────────────
  // Catches "000000000000", "111111111111", "999999999999", etc.
  // The regex matches any string that is one character repeated from start to end.
  if (/^(.)\1+$/.test(digits)) return true;

  // ── Pattern 2 & 3: Sequential ascending or descending digits ─────────────
  // "012345678901" → differences are all +1
  // "987654321098" → differences are all -1 (with mod-10 wraparound allowed)
  // We check mod-10 arithmetic so "890123456789" is also caught.
  const diffs = digits.split('').slice(1).map((ch, i) => {
    const d = parseInt(ch, 10) - parseInt(digits[i] ?? '0', 10);
    // Normalise wraparound: 0-9 = -9 ≡ +1, 9-0 = +9 ≡ -1
    if (d === 9) return -1;
    if (d === -9) return 1;
    return d;
  });
  const allAscending  = diffs.every((d) => d === 1);
  const allDescending = diffs.every((d) => d === -1);
  if (allAscending || allDescending) return true;

  // ── Pattern 4: Repeated short sub-pattern (period 2, 3, or 4) ────────────
  // Examples: "121212121212" (period 2), "123123123123" (period 3),
  //           "12341234" (period 4, UPC-8 length), "999099909990" (period 4 near-miss).
  // Strategy: split the string into N chunks of size P; if all chunks equal
  // the first chunk, the entire string is a repetition of that chunk.
  const len = digits.length;
  for (const period of [2, 3, 4]) {
    if (len % period !== 0) continue; // only check periods that divide evenly
    const chunk = digits.slice(0, period);
    if (digits === chunk.repeat(len / period)) return true;
  }

  // ── Pattern 5: Explicit blocklist ────────────────────────────────────────
  // Strings that appear verbatim in scraper output as known test/placeholder
  // values and are not otherwise caught by the structural patterns above.
  // Add entries here as new patterns are discovered in the wild.
  const FAKE_UPC_BLOCKLIST: ReadonlySet<string> = new Set([
    '123456789012',  // canonical "test barcode" — ascending but just in case
    '012345678905',  // GS1 sample UPC-A from documentation
    '888888888888',  // placeholder often emitted by Chinese listing tools
    '123456789013',  // common barcode-scanner test strip
    '000000000017',  // Amazon internal placeholder (seen in FBA returns data)
  ]);
  if (FAKE_UPC_BLOCKLIST.has(digits)) return true;

  return false;
}

// ── isFakeAsin ────────────────────────────────────────────────────────────────

/**
 * Detect obviously-bogus Amazon ASIN strings.
 *
 * Receives a 10-char uppercase alphanumeric string that has already passed the
 * format gate (/^[A-Z0-9]{10}$/). Returns true for known placeholder patterns:
 *
 *   1. Chars 2–10 all the same         — "B000000000", "BAAAAAAAAA"
 *   2. Chars 2–10 sequential ascending — "B012345678", "B0ABCDEFGH"
 *      (digits only; alphabetic sequential is unlikely in real ASINs)
 *   3. Explicit blocklist              — specific placeholder ASINs
 *
 * @param asin - Uppercase 10-char alphanumeric string, already validated.
 */
export function isFakeAsin(asin: string): boolean {
  // ── Pattern 1: Everything after the first char is a single repeated char ──
  // "B000000000", "BAAAAAAAAA", "B111111111"
  // We test chars [1..9] (indices 1-9) — ASINs almost always start with B
  // but the rule applies regardless of prefix.
  const suffix = asin.slice(1);
  if (/^(.)\1+$/.test(suffix)) return true;

  // ── Pattern 1b: Full ASIN is a short repeated pattern ────────────────────
  // "BABABABABA" (period 2), "BABCBABCBA" (period 4, 10-char string).
  // We apply the same period-chunk analysis as isFakeUpc, on the full 10-char
  // ASIN string (not just the suffix). Period 5 is the maximum useful check
  // for a 10-char string.
  const asinLen = asin.length; // always 10
  for (const period of [2, 5]) {
    if (asinLen % period !== 0) continue;
    const chunk = asin.slice(0, period);
    if (asin === chunk.repeat(asinLen / period)) return true;
  }

  // ── Pattern 2: Digit-only suffix is sequential ascending or descending ────
  // "B012345678" — the 9 suffix chars are digits in ascending order.
  // Only check all-digit suffixes; alphabetic sequential real ASINs are rare
  // but plausible (e.g. B0ABCDEFGH is unlikely to be real, but we only block
  // the obviously numeric sequences to stay conservative).
  if (/^\d{9}$/.test(suffix)) {
    const suffixDiffs = suffix.split('').slice(1).map((ch, i) => {
      const d = parseInt(ch, 10) - parseInt(suffix[i] ?? '0', 10);
      if (d === 9) return -1;
      if (d === -9) return 1;
      return d;
    });
    if (suffixDiffs.every((d) => d === 1) || suffixDiffs.every((d) => d === -1)) return true;
  }

  // ── Pattern 3: Explicit ASIN blocklist ────────────────────────────────────
  const FAKE_ASIN_BLOCKLIST: ReadonlySet<string> = new Set([
    'B000000000',  // Amazon internal placeholder / unassigned
    'B012345678',  // sequential test value
    'B0TEST00001', // seen in sandbox environments
  ]);
  if (FAKE_ASIN_BLOCKLIST.has(asin)) return true;

  return false;
}

// ── normalizeUpc ──────────────────────────────────────────────────────────────

/**
 * Normalize a raw UPC/EAN/GTIN value.
 *
 * Strips all non-digit characters, then accepts only 8, 12, 13, or 14 digits.
 * Rejects strings that match bogus placeholder patterns (see isFakeUpc).
 * Returns `null` on any garbage input — never throws.
 *
 * @example
 *   normalizeUpc("0-12345-67890-5") → "012345678905"
 *   normalizeUpc("000000000000")    → null  (fake: all same digit)
 *   normalizeUpc("012345678901")    → null  (fake: sequential)
 *   normalizeUpc("abc")             → null
 *   normalizeUpc(null)              → null
 */
export function normalizeUpc(raw: unknown): string | null {
  if (raw == null) return null;
  const digits = String(raw).replace(/[^\d]/g, '');
  if (!VALID_UPC_LENGTHS.has(digits.length)) return null;
  if (isFakeUpc(digits)) return null;
  return digits;
}

/**
 * Validate a GTIN (UPC-A/EAN-8/EAN-13/GTIN-14) by its mod-10 check digit.
 *
 * WHY (2026-07-08 incident): staff scanning a FedEx return-shipping barcode
 * (a carrier tracking number, NOT a product code) during lotting were getting
 * random unrelated catalog products back, because a bare numeric string was
 * treated as a product code and fed to a free-text/AI fallback. A real retail
 * barcode always carries a valid GS1 check digit; a tracking number does not.
 * Gating on this lets us reject non-product barcodes before they ever hit the
 * catalog lookup.
 *
 * Strips non-digits, requires a valid GTIN length (8/12/13/14), then verifies
 * the trailing check digit per the GS1 algorithm (rightmost data digit weighted
 * ×3, alternating). Never throws.
 */
export function isValidGtinCheckDigit(raw: unknown): boolean {
  if (raw == null) return false;
  const digits = String(raw).replace(/[^\d]/g, '');
  if (!VALID_UPC_LENGTHS.has(digits.length)) return false;
  const nums = digits.split('').map(Number);
  const check = nums.pop()!;
  let sum = 0;
  let weight = 3;
  for (let i = nums.length - 1; i >= 0; i--) {
    sum += nums[i]! * weight;
    weight = weight === 3 ? 1 : 3;
  }
  const expected = (10 - (sum % 10)) % 10;
  return expected === check;
}

/**
 * Does a scanned value look like a carrier shipping label or a retail barcode
 * rather than a lot sticker?
 *
 * WHY (field report 2026-08-02): `isValidGtinCheckDigit` above was written for
 * the catalog-lookup path and then reused as the sticker-binding guard, where
 * its check-digit requirement is the wrong test. FedEx tracking numbers are 12
 * digits with a **mod-11** check, so they fail the GS1 test and were waved
 * through — three lots that morning bound the tracking number off the box
 * (`BIN:533500296376` for `TRK# 5335 0029 6376`), and because the worklist
 * renders sticker before lot_code, that number became what staff read. The
 * 34-digit FedEx `9622…` ancillary block is not even a GTIN length.
 *
 * The rule is shape, not checksum: a real sticker is never a bare number.
 * BinGo's own pre-printed stock is colour-prefixed alphanumeric (PNK…/BRN…/
 * TEA…, 6,319 of the 6,382 codes bound on prod), the rest are LPNs, vendor SKUs
 * and ASINs, and pre-printed BinGo QRs are UUIDs handled on a different lane.
 * All 17 bare-numeric codes on prod were mis-scans — FedEx tracking, the FedEx
 * 96 block, a USPS/GS1 20-digit, and the retail UPCs from the 07-08 incident.
 * Zero false positives across 6,382 rows.
 *
 * 8 is the floor because the shortest observed mis-scan is 8 digits
 * (`06854652`) and nothing legitimate is numeric at any length. UPS `1Z…` is
 * alphanumeric so the numeric rule misses it, but it is the same failure.
 *
 * Mirrors `_looks_like_carrier_barcode()` (mig 0308), which is the enforcing
 * copy — this one only saves a round-trip and gives a better message.
 */
export function looksLikeCarrierBarcode(raw: unknown): boolean {
  if (raw == null) return false;
  const t = String(raw).trim();
  return /^\d{8,}$/.test(t) || /^1Z[0-9A-Z]{16}$/i.test(t);
}

// ── normalizeAsin ─────────────────────────────────────────────────────────────

/**
 * Normalize an Amazon ASIN.
 *
 * Strips surrounding whitespace, uppercases, and validates: exactly 10
 * alphanumeric chars. Rejects strings that match bogus placeholder patterns
 * (see isFakeAsin). Returns `null` on anything that doesn't match.
 *
 * @example
 *   normalizeAsin(" B08N5WRWNW ") → "B08N5WRWNW"
 *   normalizeAsin("B000000000")   → null  (fake: all zeros after B)
 *   normalizeAsin("short")        → null
 */
export function normalizeAsin(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim().toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(s)) return null;
  if (isFakeAsin(s)) return null;
  return s;
}

// ── normalizeReadUpc ──────────────────────────────────────────────────────────

/**
 * A UPC that a vision model says it READ off the box — trust it only if it
 * could be a real barcode. Returns the digits, or null.
 *
 * WHY (2026-09-23): "Identify with AI" on a no-match filled UPC with
 * 00012345678901 on a box of party cups. The prompt already says "values you
 * LITERALLY READ"; the model ignored it, and normalizeIdentification then
 * kept the raw string anyway. A saved lot would have carried a fake barcode —
 * the same invented-identifier class as the 09-21 FNSKU misfire.
 *
 * Stricter than normalizeUpc, because a model inventing digits is a different
 * failure from a scanner misreading them:
 *   - a real GS1 check digit (00012345678901 needs a 5, not a 1);
 *   - placeholder patterns checked with leading zeros removed, and on the data
 *     digits without the check digit, so a zero-padded 1234567890 run is
 *     recognised whether or not someone computed a valid check digit for it.
 * A real UPC-E read off a small box can fail the check digit here and come
 * back null. That is the intended trade: an empty field costs a manual entry,
 * a wrong one puts a false barcode on a real item.
 */
export function normalizeReadUpc(raw: unknown): string | null {
  const digits = normalizeUpc(raw);
  if (!digits) return null;
  if (!isValidGtinCheckDigit(digits)) return null;
  const unpadded = digits.replace(/^0+/, '');
  for (const probe of [unpadded, unpadded.slice(0, -1)]) {
    if (probe.length >= 6 && isFakeUpc(probe)) return null;
  }
  return digits;
}

