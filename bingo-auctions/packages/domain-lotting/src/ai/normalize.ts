// ai/normalize.ts — thin wrapper for backwards compatibility.
//
// The canonical implementations have moved to normalize/identification.ts,
// which uses the atomic helpers from normalize/ (normalizeBrand, normalizeUpc,
// filterSafeImageUrls, etc.).
//
// This file re-exports from the canonical location so any code that imports
// from '@auction-platform/domain-lotting/ai' or directly from this path
// continues to work without changes.

export {
  normalizeIdentification,
  normalizePriceData,
} from '../normalize/identification';
