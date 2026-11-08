// GS1-128 / Data-Matrix Application Identifier (AI) parser.
//
// Recognises the FNC1 prefix (]C1 or ]d2 for Data-Matrix) and inline AIs.
// Emits each AI value as a candidate for downstream column probing.
//
// Supported AIs:
//   00  — SSCC-18 (Serial Shipping Container Code, 18 digits)
//   01  — GTIN (Global Trade Item Number, 14 digits)
//   421 — Ship-to postal code (variable length with ISO country prefix)
//
// Reference: GS1 General Specifications §7.

// GS1 FNC1 leader bytes emitted by decoders.
// ]C1 = Code-128 with GS1 mode
// ]d2 = Data-Matrix with GS1 mode
// ]Q3 = QR with GS1 mode
// Some decoders also emit \x1d (ASCII 29, GS character) inline.
const GS1_LEADERS = [']C1', ']d2', ']Q3', ']e0'];

// Fixed-length AIs: AI string → expected value length (digits).
const FIXED_AI_LENGTHS: Record<string, number> = {
  '00': 18, // SSCC-18
  '01': 14, // GTIN-14
  '02': 14, // GTIN-14 of contained trade item
  '03': 14, // GTIN-14 (obsolete)
  '04': 18, // GTIN-14 + component value
};

// Variable-length AIs that we care about (prefix → max length).
// Terminated by FNC1 (Group Separator, \x1d) or end-of-string in a composite.
const VARIABLE_AI_MAX: Record<string, number> = {
  '10':  20, // batch/lot number
  '21':  20, // serial number
  '30':  8,  // count of trade items
  '421': 15, // ship-to / deliver-to postal code with ISO country
  '420': 9,  // ship-to / deliver-to postal code (domestic)
};

/** Strip a known GS1 FNC1 leader from the raw string. Returns null if none. */
function stripLeader(raw: string): string | null {
  for (const leader of GS1_LEADERS) {
    if (raw.startsWith(leader)) return raw.slice(leader.length);
  }
  return null;
}

/**
 * Parse a GS1 composite payload (after leader removal) into (ai, value) pairs.
 * Returns extracted values — not the AIs themselves.
 */
function parsePayload(payload: string): string[] {
  const results: string[] = [];
  let pos = 0;

  while (pos < payload.length) {
    // Skip inline GS (FNC1 group separator character).
    if (payload[pos] === '\x1d') {
      pos++;
      continue;
    }

    // Try 3-digit AIs first (they are more specific).
    for (const aiLen of [3, 2]) {
      if (pos + aiLen > payload.length) continue;
      const ai = payload.slice(pos, pos + aiLen);

      const fixedLen = FIXED_AI_LENGTHS[ai];
      if (fixedLen !== undefined) {
        const value = payload.slice(pos + aiLen, pos + aiLen + fixedLen);
        if (value.length === fixedLen) {
          results.push(value);
          pos += aiLen + fixedLen;
        } else {
          pos += 1; // malformed — advance one and try again
        }
        break;
      }

      const maxLen = VARIABLE_AI_MAX[ai];
      if (maxLen !== undefined) {
        const dataStart = pos + aiLen;
        // Variable-length fields are terminated by GS (\x1d) or end.
        const gsPos = payload.indexOf('\x1d', dataStart);
        const end = gsPos === -1 ? Math.min(payload.length, dataStart + maxLen) : gsPos;
        const value = payload.slice(dataStart, end);
        if (value.length > 0) {
          results.push(value);
        }
        pos = end;
        break;
      }

      // Try the shorter AI prefix after the inner loop exhausts without match.
      if (aiLen === 2) {
        // Neither 3-digit nor 2-digit AI matched at this position.
        pos += 1;
      }
    }
  }

  return results;
}

/**
 * Attempt GS1-128 / Data-Matrix AI parsing on `raw`.
 *
 * Returns an array of extracted AI values (not including `raw` itself —
 * the caller deduplicates and prepends raw). Returns an empty array if
 * `raw` is not a GS1 composite.
 */
export function parseGs1Candidates(raw: string): string[] {
  const stripped = stripLeader(raw);
  if (stripped === null) return [];
  return parsePayload(stripped);
}
