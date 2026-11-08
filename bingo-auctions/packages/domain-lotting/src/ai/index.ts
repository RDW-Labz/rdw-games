export { scanPhoto, identifyPhoto } from './identification';
export { shelfScan } from './shelf-scan';
export { fetchPrices, lookupCode, fetchStockPhotos } from './pricing';
export { enrichImages } from './image-enrich';
export type { ImageEnrichInput } from './image-enrich';
export { enrichWayfairImagesBySku, wayfairPdpUrls } from './image-enrich-wayfair';
export type { WayfairImageInput } from './image-enrich-wayfair';
export { verifyImagesMatchProduct } from './image-verify';
export type { ImageVerifyProduct } from './image-verify';
export { callAnthropic, parseJson } from './anthropic';
export type {
  AnthropicMessage,
  AnthropicMessageContent,
  AnthropicTool,
  AnthropicCallOptions,
} from './anthropic';
export { normalizeIdentification, normalizePriceData } from './normalize';

// LLM client (OpenRouter) — escalation routing + telemetry hook.
export { complete, setTelemetrySink, setCostEstimator } from './llm';
export type {
  LlmTask,
  LlmMessage,
  LlmMessageContent,
  LlmTextContent,
  LlmImageContent,
  LlmTelemetryEvent,
  LlmTelemetrySink,
  LlmCostEstimator,
  CompleteOptions,
} from './llm';
// Eval-friendly aliases — the harness imports these names.
export type { LlmTelemetryEvent as TelemetryEvent } from './llm';
