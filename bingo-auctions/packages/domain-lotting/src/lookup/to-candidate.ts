// Map a ProductLookup (Tier 1 cache row) into the existing LotCandidate
// shape so createDraftLotFromCandidate() works unchanged. The persistence
// layer doesn't need to know whether the data came from eBay, AI, or
// manual entry.

import type { LotCandidate } from '../types';
import { CATEGORIES } from '../constants';
import type { ProductLookup } from './types';

export function productToCandidate(p: ProductLookup): LotCandidate {
  // Convert cents → dollars for the LotCandidate shape (it predates the
  // platform's strict cents discipline). createDraftLotFromCandidate
  // converts back to cents on insert.
  const msrp = p.msrp_cents != null ? p.msrp_cents / 100 : null;
  // Prefer median sold price as the "avg" signal — it's the realized
  // auction comp, more honest than asking-price average.
  const avg =
    p.median_sold_cents != null
      ? p.median_sold_cents / 100
      : p.avg_asking_cents != null
        ? p.avg_asking_cents / 100
        : null;
  const startBid = p.start_bid_cents != null ? p.start_bid_cents / 100 : null;

  // Map the platform's category_raw onto LotTR's loose category enum.
  // We don't strictly need this — persistence.ts ignores `category` if
  // category_id resolves via category_aliases — but keep it for the
  // candidate-card UI which still renders the string.
  const category: LotCandidate['category'] =
    (CATEGORIES as readonly string[]).includes(String(p.category_raw))
      ? (p.category_raw as LotCandidate['category'])
      : 'Other';

  // The upc field on LotCandidate is shown to the operator in the UI.
  // Strip synthetic keys ('asin:...', 'fnsku:...') so the UPC box
  // doesn't display internal plumbing. The real identifier is in asin/fnsku/lpn.
  const isSyntheticKey =
    p.upc.startsWith('asin:') ||
    p.upc.startsWith('fnsku:') ||
    p.upc.startsWith('lpn:') ||
    p.upc.startsWith('mpn:') ||
    p.upc.startsWith('ebay:');

  return {
    title: p.title ?? '',
    brand: p.brand ?? '',
    model: p.model ?? '',
    upc: isSyntheticKey ? '' : p.upc,
    category,
    subcategory: '',          // Cache rows don't carry subcategory yet — backfill via mint
    packagingMsrp: null,      // Cache rows have no photo to read MSRP from
    condition: '' as const,   // Tier 1 doesn't infer condition — the operator picks
    description: p.description ?? '',
    searchQuery: [p.brand, p.model, p.title].filter(Boolean).join(' '),
    confidence: p.confidence === 'none' ? 'low' : p.confidence,
    notes: '',
    prices: p.prices.map((rp) => ({
      retailer: rp.retailer,
      price: rp.cents / 100,
      url: rp.url,
    })),
    stockPhotos: p.image_urls,
    msrp,
    avg,
    startBid,
    fullTitle: p.title ?? '',
    specs: p.specs ?? '',
    // Multi-identifier passthrough — only set when the product row has them.
    // The candidate card can display "Resolved via ASIN: B0DK7R7KWV" etc.
    ...(p.asin  != null ? { asin:  p.asin  } : {}),
    ...(p.fnsku != null ? { fnsku: p.fnsku } : {}),
    ...(p.lpn   != null ? { lpn:   p.lpn   } : {}),
    ...(p.mpn   != null ? { mpn:   p.mpn   } : {}),
  };
}
