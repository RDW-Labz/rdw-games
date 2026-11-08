// Multi-SKU shelf/pallet scanning via Sonnet 4.6 vision.
//
// shelfScan(base64, mediaType)
//   Sends a single photo to the `shelf_scan` task (always Sonnet 4.6,
//   no escalation — see llm.ts). Asks the model to identify every
//   distinct SKU visible and return 1-20 candidates ordered by
//   prominence. Returns LotCandidate[] stripped of price data — the
//   operator runs per-lot price lookup in a follow-up step if needed.
//
// No UPC lookups, no web search, no price data. Fast enumeration only.

import { CATEGORIES, CONDITIONS } from '../constants';
import type { LotCandidate } from '../types';
import { complete } from './llm';
import { normalizeIdentification } from './normalize';

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------

// The prompt is the most load-bearing part of shelf_scan. Key design
// decisions:
//
//   1. "Distinct SKU" framing — 5 identical drills = 1 candidate, not 5.
//      The quantity stepper on the mobile UI handles quantity.
//
//   2. Ordered by prominence — the most visible item comes first so that
//      when the operator skips some, the prominent ones are already at
//      the top.
//
//   3. Confidence per-candidate — operators can quickly skip low-confidence
//      entries. String values match the CONFIDENCE_LEVELS constant.
//
//   4. No price fields — removes the temptation for the model to hallucinate
//      prices. A deliberate follow-up step does pricing.
//
//   5. Category and condition constrained to the platform enums — avoids
//      normalization edge cases downstream.
//
//   6. Max 20 candidates — prevents runaway JSON for photo-booth shots with
//      dozens of mixed items.

const SHELF_SCAN_PROMPT = `You are a liquidation warehouse intake expert examining a photo of a pallet, shelf, bin, or table of products for an online auction house.

Your job: identify every DISTINCT SKU (model number / product type) visible in the photo.

GROUPING RULE — identical units count as ONE candidate:
  • 5 copies of the same Milwaukee drill → 1 candidate (not 5)
  • 3 identical Instant Pots → 1 candidate
  • A DeWalt drill AND a Milwaukee drill → 2 candidates (different SKUs)

For each distinct SKU, extract:
  1. What the product IS — brand, model number if visible, full descriptive name
  2. Condition clues from visible packaging / item state
  3. How prominent/certain the identification is

Return ONLY a valid JSON object — no markdown, no commentary:
{
  "candidates": [
    {
      "title": "Brand + model# + descriptive product name (e.g. DeWalt DCD771C2 20V MAX Compact Drill Driver)",
      "brand": "brand name only",
      "model": "model/part/SKU number if legible, otherwise empty string",
      "upc": "barcode digits if clearly legible, otherwise empty string",
      "category": "EXACTLY one of: ${CATEGORIES.join(', ')}",
      "condition": "EXACTLY one of: ${CONDITIONS.join(', ')}",
      "description": "1-2 sentence auction listing. Mention what is visible, packaging state, any obvious damage.",
      "notes": "damage, open packaging, missing parts visible in the photo. Empty string if nothing notable.",
      "confidence": "high if brand+model clearly visible, medium if brand clear but model uncertain, low if best guess"
    }
  ]
}

Rules:
  • Order candidates by prominence — most visible / largest item FIRST
  • Return 1 to 20 candidates maximum
  • Do NOT list price data — omit prices, msrp, startBid, avg fields entirely
  • If you genuinely cannot identify something, still include it with confidence "low"
  • Do NOT hallucinate model numbers — use empty string if not legible
  • category must be one of the exact strings listed above
  • condition must be one of the exact strings listed above`;

// ---------------------------------------------------------------------------
// Normalization for shelf-scan candidates
// ---------------------------------------------------------------------------

// Each raw candidate is normalized through normalizeIdentification which
// coerces category, condition, and confidence to the platform enums and
// fills in missing fields with safe defaults.
//
// Price fields (prices, stockPhotos, msrp, avg, startBid, fullTitle, specs)
// are absent from the model response and filled in as empty/null here —
// matching the LotCandidate shape so persistence.createDraftLotFromCandidate
// can accept these directly without modification.

function normalizeCandidate(raw: unknown): LotCandidate | null {
  const id = normalizeIdentification(raw);
  if (!id) return null;

  // Price stub — intentionally empty; operator runs lookup per-lot later.
  return {
    ...id,
    prices: [],
    stockPhotos: [],
    msrp: null,
    avg: null,
    startBid: null,
    fullTitle: '',
    specs: '',
    visibleText: [],
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Identify every distinct SKU visible in a pallet/shelf photo.
 *
 * Uses the `shelf_scan` task (Sonnet 4.6, no escalation). Returns 1-20
 * LotCandidate objects ordered by visual prominence. Price fields are
 * intentionally empty — run per-lot price lookup after operator confirms.
 *
 * Telemetry fires automatically via the existing sink in llm.ts
 * (task = 'shelf_scan', model = 'anthropic/claude-sonnet-4-6').
 */
export async function shelfScan(
  base64: string,
  mediaType: string,
  signal?: AbortSignal,
): Promise<LotCandidate[]> {
  const result = await complete({
    task: 'shelf_scan',
    messages: [
      {
        role: 'user',
        content: SHELF_SCAN_PROMPT,
      },
    ],
    image: { base64, mediaType },
    schema: 'json',
    signal,
  });

  if (!result || typeof result !== 'object') return [];

  const rawCandidates = (result as Record<string, unknown>)['candidates'];
  if (!Array.isArray(rawCandidates)) return [];

  const candidates: LotCandidate[] = [];
  for (const raw of rawCandidates) {
    const normalized = normalizeCandidate(raw);
    if (normalized) candidates.push(normalized);
  }

  // Cap at 20 (the model is asked to respect this, but verify here).
  return candidates.slice(0, 20);
}
