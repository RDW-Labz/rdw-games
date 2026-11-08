// Canonical normalization barrel.
//
// Every ingestion path on the platform imports from this module (or from
// @auction-platform/domain-lotting which re-exports everything here).
// There is exactly ONE implementation of each normalization rule — in the
// specific sub-module below. No other file in the monorepo should define
// its own parseCents, normalizeUpc, isSafeImageUrl, etc.
//
// Sub-module → responsibility:
//   upc.ts             normalizeUpc, normalizeAsin
//   money.ts           parseCents, centsToDollars, safeParseFloat
//   text.ts            normalizeBrand, normalizeModel, normalizeTitle, normalizeHeader
//   images.ts          ALLOWED_IMAGE_HOSTS, isSafeImageUrl, filterSafeImageUrls
//   condition.ts       normalizeCondition, PlatformCondition
//   category.ts        resolveCategoryAlias, resolveSingleCategory
//   identification.ts  normalizeIdentification, normalizePriceData
//   stats.ts           mostCommon, median, average
//   brand.ts           extractBrand

export {
  normalizeUpc,
  normalizeAsin,
  isValidGtinCheckDigit,
  looksLikeCarrierBarcode,
} from './upc';

export { parseCents, centsToDollars, safeParseFloat } from './money';

export {
  normalizeBrand,
  normalizeModel,
  normalizeTitle,
  normalizeHeader,
} from './text';

export {
  ALLOWED_IMAGE_HOSTS,
  isSafeImageUrl,
  filterSafeImageUrls,
} from './images';

export { normalizeCondition } from './condition';
export type { PlatformCondition } from './condition';

export { resolveCategoryAlias, resolveSingleCategory } from './category';

export { normalizeIdentification, normalizePriceData } from './identification';

export { mostCommon, median, average } from './stats';

export { extractBrand, normalizeBrandFromInput } from './brand';
