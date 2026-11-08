// AI identification normalizers — port of ai/normalize.ts.
//
// This module re-implements normalizeIdentification and normalizePriceData
// using the atomic helpers from the normalize/ package rather than inline
// string operations. The originals in ai/normalize.ts are now thin wrappers
// that re-export from here for backwards compatibility.

import {
  CATEGORIES,
  CONDITIONS,
  CONFIDENCE_LEVELS,
  isValidSubcategory,
} from '../constants';
import type { Category, Condition, Confidence } from '../constants';

// Common categories the AI keeps inventing (observed 2026-05-13 with
// Nemotron 3 omni). Each maps to a valid (parent, subcategory) pair so
// scans don't fall into 'Other' just because the model used a name from
// its training data that we don't expose. Keys are lowercased — match
// is case-insensitive. Add entries when you see new invents in
// ai_calls output.
const INVENTED_CATEGORY_REMAP: Record<string, { category: Category; subcategory: string }> = {
  'party supplies': { category: 'Home & Garden', subcategory: 'Seasonal & Party Supplies' },
  'office supplies': { category: 'Office', subcategory: 'Office Supplies' },
  'school supplies': { category: 'Office', subcategory: 'School Supplies' },
  'cleaning supplies': { category: 'Home & Garden', subcategory: 'Cleaning Supplies' },
  'kitchen appliances': { category: 'Appliances', subcategory: 'Small Kitchen (Air Fryers / Blenders / Coffee)' },
  'major appliances': { category: 'Appliances', subcategory: 'Major (Refrigerators / Washers / Dryers / Stoves)' },
  'small appliances': { category: 'Appliances', subcategory: 'Small Kitchen (Air Fryers / Blenders / Coffee)' },
  'home decor': { category: 'Home & Garden', subcategory: 'Home Decor' },
  'home improvement': { category: 'Tools & Hardware', subcategory: 'Hardware & Fasteners' },
  'lighting': { category: 'Tools & Hardware', subcategory: 'Lighting (Bulbs / Fixtures)' },
  'apparel': { category: 'Clothing', subcategory: '' },
  'shoes': { category: 'Clothing', subcategory: 'Shoes & Footwear' },
  'audio equipment': { category: 'Electronics', subcategory: 'Headphones & Speakers' },
  'computers': { category: 'Electronics', subcategory: 'Computers, Laptops & Tablets' },
  'phones': { category: 'Electronics', subcategory: 'Cell Phones & Accessories' },
  'cell phones': { category: 'Electronics', subcategory: 'Cell Phones & Accessories' },
  'video games': { category: 'Toys & Games', subcategory: 'Educational Toys' },
  'fitness': { category: 'Sporting Goods', subcategory: 'Fitness Equipment' },
  'fitness equipment': { category: 'Sporting Goods', subcategory: 'Fitness Equipment' },
  'camping': { category: 'Sporting Goods', subcategory: 'Camping & Hiking' },
  'pet food': { category: 'Pet Supplies', subcategory: 'Dog' },
  'dog supplies': { category: 'Pet Supplies', subcategory: 'Dog' },
  'cat supplies': { category: 'Pet Supplies', subcategory: 'Cat' },
  'beauty': { category: 'Health & Beauty', subcategory: 'Makeup' },
  'personal care': { category: 'Health & Beauty', subcategory: 'Personal Care (Deodorant / Oral)' },
  'medical supplies': { category: 'Health & Beauty', subcategory: 'Medical Supplies & Equipment' },
  'vitamins': { category: 'Health & Beauty', subcategory: 'Vitamins & Supplements' },
  'auto parts': { category: 'Automotive', subcategory: 'Auto Parts' },
  'tires': { category: 'Automotive', subcategory: 'Tires & Wheels' },
  'storage': { category: 'Home & Garden', subcategory: 'Storage & Organization' },
  'rugs': { category: 'Bedding & Linens', subcategory: 'Rugs' },
};
import type { Identification, PriceData } from '../types';
import { normalizeBrand, normalizeModel, normalizeTitle } from './text';
import { normalizeReadUpc } from './upc';
import { filterSafeImageUrls } from './images';
import { extractBrand } from './brand';

// ── Placeholder / junk rejection (C1 hardening, 2026-06-21) ──────────────────
// Vision models hallucinate non-answers into the brand/model slots: generic
// placeholders ("N/A", "Unknown", "Generic"), or prompt-leakage words like
// "BEFORE"/"AFTER" (observed on a phone-case lot — model="BEFORE"). The
// pre-2026-06-21 normalizer only stripped Amazon-shaped model codes, so these
// landed as junk fields. Reject the known placeholder tokens; the field becomes
// '' — a valid "unknown" value the rest of the pipeline already handles.
const PLACEHOLDER_TOKENS: ReadonlySet<string> = new Set([
  'n/a', 'n.a.', 'na', 'none', 'null', 'nil', 'undefined', 'unknown',
  'unspecified', 'unbranded', 'generic', 'no brand', 'no model', 'nobrand',
  'brand', 'model', 'not visible', 'not available', 'not applicable',
  'not specified', 'see image', 'see photo', 'see picture', 'see label',
  'tbd', 'various', 'assorted', 'misc', 'miscellaneous', 'before', 'after',
  '-', '--', '.', '?', '...', 'item', 'product',
]);

/** Drop generic placeholders / prompt-leakage words to ''. Real values pass through. */
function rejectPlaceholder(value: string): string {
  const v = value.trim();
  if (!v) return '';
  return PLACEHOLDER_TOKENS.has(v.toLowerCase()) ? '' : v;
}

// A real brand/model is short; anything longer is a sentence the model dumped
// into the wrong field. Titles/descriptions get generous caps.
const MAX_BRAND = 60;
const MAX_MODEL = 60;
const MAX_TITLE = 250;
const MAX_DESCRIPTION = 2000;

/**
 * Normalize a raw AI-returned identification object into a typed
 * `Identification`. Returns `null` on non-object input.
 *
 * Differences vs the original ai/normalize.ts version:
 *   - brand, model, upc run through their canonical normalizers.
 *   - title uses normalizeTitle (collapses whitespace, strips sentinels).
 *   - upc is '' unless it could be a real barcode (normalizeReadUpc). Never
 *     the model's raw text: an invented UPC must not reach a saved lot.
 */
export function normalizeIdentification(data: unknown): Identification | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;

  const rawUpc = String(d['upc'] ?? '').trim();
  // 2026-09-23: this used to fall back to the raw string when normalization
  // failed, so whatever the model wrote — including an invented
  // 00012345678901 — reached the review card and could be saved onto a real
  // item. ASIN/FNSKU are extracted separately from the visible text, so
  // nothing legitimate is lost by dropping a UPC we cannot trust.
  const upc = normalizeReadUpc(rawUpc) ?? '';

  const rawTitle = normalizeTitle(d['title']) ?? '';

  // If the AI returned no brand, fall back to dictionary extraction on the
  // title. This fires when the model is uncertain or the photo was too blurry
  // to read the logo — the dictionary still catches the majority of cases.
  const aiBrand = rejectPlaceholder(normalizeBrand(d['brand']) ?? '');
  const brand = (aiBrand || (extractBrand(rawTitle) ?? '')).slice(0, MAX_BRAND);

  // ── Model field cleanup (anti-prompt-leakage) ─────────────────────────
  // Small vision models (observed on Nemotron 3 nano omni 30B, 2026-05-13)
  // tend to duplicate Amazon codes into the `model` slot even when the
  // prompt explicitly forbids it. The `model` field is meant for
  // manufacturer SKU / part number, not ASIN / FNSKU. We catch the
  // duplicate post-hoc:
  //   1. Pattern-match: B[0-9][A-Z0-9]{8} = ASIN, X[0-9][A-Z0-9]{8} = FNSKU
  //   2. Exact match against the dedicated identifier fields the model
  //      returned. Belt + suspenders.
  let rawModel = normalizeModel(d['model']) ?? '';
  const aiAsin = String(d['asin'] ?? '').trim().toUpperCase();
  const aiFnsku = String(d['fnsku'] ?? '').trim().toUpperCase();
  if (rawModel) {
    const upperModel = rawModel.toUpperCase();
    const isAmazonShaped = /^[BX][0-9][A-Z0-9]{8}$/.test(upperModel);
    const matchesDedicatedId = upperModel === aiAsin || upperModel === aiFnsku;
    if (isAmazonShaped || matchesDedicatedId) {
      rawModel = '';
    }
  }
  // C1 (2026-06-21): reject hallucinated placeholder / prompt-leakage words
  // ("BEFORE", "N/A", "Unknown", …) the Amazon-shape check above doesn't catch,
  // and cap length so a dumped sentence never lands in the `model` field.
  rawModel = rejectPlaceholder(rawModel).slice(0, MAX_MODEL);

  // Category + subcategory: validate as a pair. If the AI invented a
  // category not in the list, we first try mapping common inventions to
  // the right parent + subcategory before falling back to 'Other'.
  //
  // INVENTED_CATEGORY_REMAP is the short-list of category names the AI
  // keeps suggesting that aren't on our 22-item list. Each maps to a
  // valid (parent, subcategory) pair. Observed in production output
  // 2026-05-13 ("Party Supplies", "Office Supplies", etc.). Saves
  // those scans from ending up in 'Other' where operators can't find
  // them.
  const rawCategory = String(d['category'] ?? '');
  const remapped = INVENTED_CATEGORY_REMAP[rawCategory.toLowerCase()];
  let category: Category;
  let subcategory: string;
  if ((CATEGORIES as readonly string[]).includes(rawCategory)) {
    category = rawCategory as Category;
    const rawSubcategory = String(d['subcategory'] ?? '').trim();
    subcategory = isValidSubcategory(category, rawSubcategory) ? rawSubcategory : '';
  } else if (remapped) {
    category = remapped.category;
    subcategory = remapped.subcategory;
  } else {
    category = 'Other';
    subcategory = '';
  }

  // packagingMsrp: parse the AI's "MSRP printed on the box" reading.
  // Three accepted field names, in priority order:
  //   1. msrp_guess_cents  — current OCR-First prompt (2026-05-15+).
  //      Integer USD cents. Pre-multiplied by the model.
  //   2. packagingMsrp / packaging_msrp — legacy field name. Dollar
  //      amount; we multiply by 100.
  // Anything that doesn't parse to a positive finite number → null.
  let packagingMsrp: number | null = null;
  const rawMsrpCents = d['msrp_guess_cents'];
  if (rawMsrpCents !== null && rawMsrpCents !== undefined && rawMsrpCents !== '') {
    const cleaned = String(rawMsrpCents).replace(/[^0-9.]/g, '');
    const cents = parseFloat(cleaned);
    if (Number.isFinite(cents) && cents > 0 && cents < 100_000_000) {
      // msrp_guess_cents is in cents; convert to dollars for the
      // existing packagingMsrp dollar-typed contract.
      packagingMsrp = Math.round(cents) / 100;
    }
  }
  if (packagingMsrp === null) {
    const rawPackagingMsrp = d['packagingMsrp'] ?? d['packaging_msrp'] ?? null;
    if (rawPackagingMsrp !== null && rawPackagingMsrp !== undefined && rawPackagingMsrp !== '') {
      const cleaned = String(rawPackagingMsrp).replace(/[^0-9.]/g, '');
      const n = parseFloat(cleaned);
      if (Number.isFinite(n) && n > 0 && n < 1_000_000) {
        packagingMsrp = Math.round(n * 100) / 100;
      }
    }
  }

  return {
    title: rawTitle.slice(0, MAX_TITLE),
    brand,
    model: rawModel,
    upc,
    category,
    subcategory,
    condition: ((CONDITIONS as readonly string[]).includes(String(d['condition']))
      ? d['condition']
      : '') as Condition | '',
    description: String(d['description'] ?? '').trim().slice(0, MAX_DESCRIPTION),
    packagingMsrp,
    searchQuery: String(d['searchQuery'] ?? d['title'] ?? '').trim(),
    // 2026-07-09 regression fix: the photo-identify prompt emits a NUMERIC
    // `confidence_score` (0-1), but this only ever read a string `confidence`
    // — so every scan silently defaulted to 'medium', killing the
    // low-confidence early-exit, escalation, and the alternates picker
    // ("AI confidently returns a single incorrect result"). Accept both:
    // the string field when present, else bucket the numeric score.
    confidence: (((CONFIDENCE_LEVELS as readonly string[]).includes(String(d['confidence']))
      ? d['confidence']
      : typeof d['confidence_score'] === 'number'
        ? d['confidence_score'] >= 0.8
          ? 'high'
          : d['confidence_score'] >= 0.5
            ? 'medium'
            : 'low'
        : 'medium')) as Confidence,
    notes: String(d['notes'] ?? '').trim(),
  };
}

/**
 * Normalize a raw AI-returned price data object into a typed `PriceData`.
 * Returns `null` on non-object input.
 *
 * Uses filterSafeImageUrls for stockPhotos (security boundary: M2).
 */
export function normalizePriceData(data: unknown): PriceData | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;

  const rawPrices = Array.isArray(d['prices']) ? (d['prices'] as unknown[]) : [];
  const prices = rawPrices
    .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object')
    .filter((p) => typeof p['retailer'] === 'string' && Number(p['price']) > 0)
    .map((p) => ({
      retailer: String(p['retailer']).trim(),
      price: Math.round(Number(p['price']) * 100) / 100,
      url: String(p['url'] ?? '').trim(),
    }))
    // Dedupe by retailer (keep first match — typically the highest).
    .reduce<{ retailer: string; price: number; url: string }[]>((acc, p) => {
      if (!acc.find((x) => x.retailer.toLowerCase() === p.retailer.toLowerCase()))
        acc.push(p);
      return acc;
    }, []);

  // Stock photos — filter through isSafeImageUrl (security boundary M2).
  // Also accept URLs with image-like paths even without a file extension,
  // for CDN URLs that use query params instead of extensions.
  const rawPhotos = Array.isArray(d['stockPhotos']) ? (d['stockPhotos'] as unknown[]) : [];
  const stockPhotos = filterSafeImageUrls(
    rawPhotos.filter(
      (u) =>
        typeof u === 'string' &&
        u.startsWith('http') &&
        (/\.(jpg|jpeg|png|webp|gif)/i.test(u) || u.includes('/images/') || u.includes('media')),
    ),
  ).slice(0, 8);

  const validPrices = prices.map((p) => p.price).filter((p) => p > 0);
  const msrp = Number(d['msrp']) || (validPrices.length ? Math.max(...validPrices) : 0);
  const avg =
    Number(d['avg']) ||
    (validPrices.length
      ? Math.round((validPrices.reduce((a, b) => a + b, 0) / validPrices.length) * 100) / 100
      : 0);
  const startBid = Number(d['startBid']) || (avg > 0 ? Math.round(avg * 0.3) : 0);

  return {
    prices,
    stockPhotos,
    msrp: msrp || null,
    avg: avg || null,
    startBid: startBid || null,
    fullTitle: String(d['fullTitle'] ?? '').trim(),
    specs: String(d['specs'] ?? '').trim(),
  };
}
