// Public API for @auction-platform/domain-lotting.
//
// Configuration:
//   import { setLottingConfig } from '@auction-platform/domain-lotting';
//   setLottingConfig({
//     anthropicKey: process.env.EXPO_PUBLIC_ANTHROPIC_KEY!,
//     allowDirectBrowserAccess: true, // for browser/RN direct calls
//   });
//
// AI lookups:
//   import { lookupCode, scanPhoto, identifyPhoto, fetchPrices }
//     from '@auction-platform/domain-lotting';
//
// Text helpers:
//   import { stripWarranty, shortenTitle, buildConditionDescription }
//     from '@auction-platform/domain-lotting';

export { CATEGORIES, CONDITIONS, CONFIDENCE_LEVELS } from './constants';
export type { Category, Condition, Confidence } from './constants';

export type {
  RetailerPrice,
  PriceData,
  Identification,
  LotCandidate,
  ConditionWorkflowData,
} from './types';

export {
  setLottingConfig,
  getLottingConfig,
  hasLottingConfig,
} from './config';
export type { LottingConfig } from './config';

export {
  scanPhoto,
  identifyPhoto,
  shelfScan,
  fetchPrices,
  lookupCode,
  fetchStockPhotos,
  enrichImages,
  enrichWayfairImagesBySku,
  wayfairPdpUrls,
  callAnthropic,
  parseJson,
  normalizeIdentification,
  normalizePriceData,
  // LLM telemetry hooks — used by server-side proxy routes for cost tracking.
  complete,
  setTelemetrySink,
  setCostEstimator,
} from './ai';
export type { ImageEnrichInput, WayfairImageInput } from './ai';
export type {
  AnthropicMessage,
  AnthropicMessageContent,
  AnthropicTool,
  AnthropicCallOptions,
  // LLM types needed by proxy routes
  LlmTask,
  LlmMessage,
  LlmTelemetryEvent,
  LlmTelemetrySink,
  LlmCostEstimator,
} from './ai';

export { stripWarranty, shortenTitle, buildConditionDescription } from './text';

export {
  createDraftLotFromCandidate,
  resolveCategoryId,
  setActiveLottingWorkerId,
  getActiveLottingWorkerId,
  setActiveLottingLoadId,
  getActiveLottingLoadId,
  isMissingLoadOverload,
} from './persistence';
export type {
  CreateDraftLotInput,
  CreateDraftLotResult,
  CreateDraftLotFailureCode,
} from './persistence';

// Tier 1 lookup — cache-first, multi-identifier, AI-free for cache hits.
//   lookupByCode  — primary API: resolves UPC, ASIN, FNSKU, LPN, MPN, external_codes
//   lookupByUpc   — deprecated alias for lookupByCode (backwards compat)
//   searchByKeyword — trigram + OpenRouter keyword search
export { lookupByCode, lookupByUpc, searchByKeyword } from './lookup';
export type { LookupOptions } from './lookup';
// Direct fetch primitives for server routes that drive the AI fallback path
// (paste-URL scraper). fetchOpenRouterLookup = Sonar URL-finder + url-fetch;
// fetchProductPage/fetchProductPages = parse a retailer product page.
export {
  fetchOpenRouterLookup,
  fetchProductPage,
  fetchProductPages,
  isHardBlockedHost,
} from './lookup';
// Stock-image mirroring — server routes wire this into
// LottingConfig.mirrorImage (see config.ts) so page-vouched enrichment
// images on non-allowlisted hosts land in the stock-images bucket.
export { mirrorImageToStorage, mirrorImagesToStorage } from './lookup/mirror-images';
export type { MirrorImageOptions } from './lookup/mirror-images';
export type { OpenRouterListing, OpenRouterSearchResult } from './lookup';
export type {
  ProductLookup,
  LookupResult,
  KeywordSearchHit,
  RetailerPricePoint,
  SoldComp,
  ProductConfidence,
  ProductLookupSource,
} from './lookup/types';
export {
  normalizeUpc,
  isPricesStale,
  readByCode,
  upsertLookup,
  PRICES_TTL_MS,
  NEGATIVE_TTL_MS,
} from './lookup/cache';
export { productToCandidate } from './lookup/to-candidate';
export { isSafeImageUrl, filterSafeImageUrls, extractAsinFromUrl } from './lookup/merge';

// ── Canonical normalizers ────────────────────────────────────────────────────
// Single source of truth for every ingestion path. Import from here rather
// than from individual sub-modules; the barrel keeps the public API stable.
//
// Note: isSafeImageUrl and filterSafeImageUrls are already exported above
// from ./lookup/merge (backwards-compat path). They are the same functions —
// lookup/merge re-exports from normalize/images.
// normalizeUpc is already exported above from ./lookup/cache (also delegates
// to normalize/upc internally). Use normalizeUpcStrict for the version that
// returns null on invalid lengths.
export {
  // UPC / ASIN
  normalizeUpc as normalizeUpcStrict,  // null on invalid length; distinct from cache.normalizeUpc
  normalizeAsin,
  isValidGtinCheckDigit,
  looksLikeCarrierBarcode,
  // Money
  parseCents,
  centsToDollars,
  safeParseFloat,
  // Text
  normalizeBrand,
  normalizeModel,
  normalizeTitle,
  normalizeHeader,
  // Images
  ALLOWED_IMAGE_HOSTS,
  // Condition
  normalizeCondition,
  // Category (async, needs supabase client)
  resolveCategoryAlias,
  resolveSingleCategory,
  // Stats
  mostCommon,
  median,
  average,
  // Brand extraction
  extractBrand,
  normalizeBrandFromInput,
} from './normalize';
export type { PlatformCondition } from './normalize';
