// Register the cost estimator at server startup.
//
// Without this, telemetry events from `complete()` in domain-lotting/llm.ts
// emit `cost_estimate_usd: 0` because no estimator is installed. The mobile
// CostHud would always show $0 even on real AI calls.
//
// We mirror the pricing table from packages/domain-lotting/evals/pricing.ts
// (the source of truth for cost rates) but inline it here to avoid
// importing from an `evals/` path that's outside the package's normal
// public API. If the rates change, update both files.

import { setCostEstimator, type LlmCostEstimator } from '@auction-platform/domain-lotting';

type ModelPrice = {
  input_per_million: number;
  output_per_million: number;
  /** USD per 1,000 grounded-search calls (Sonar / GPT-4o-search). */
  search_per_thousand?: number;
};

const MODEL_PRICING: Record<string, ModelPrice> = {
  'google/gemini-2.5-flash':       { input_per_million: 0.075, output_per_million: 0.30 },
  'google/gemini-2.5-flash-lite':  { input_per_million: 0.04,  output_per_million: 0.10 },
  'anthropic/claude-haiku-4-5':    { input_per_million: 1.00,  output_per_million: 5.00 },
  'anthropic/claude-sonnet-4-6':   { input_per_million: 3.00,  output_per_million: 15.00 },
  'perplexity/sonar':              { input_per_million: 1.00,  output_per_million: 1.00,  search_per_thousand: 5.00 },
  'perplexity/sonar-pro':          { input_per_million: 3.00,  output_per_million: 15.00, search_per_thousand: 6.00 },
  // image_enrich uses sonar; same pricing as the main perplexity/sonar entry above.
  // Listed separately for clarity in case we swap the model later.
  'openai/gpt-4o-mini-search-preview': { input_per_million: 0.15, output_per_million: 0.60 },
  'openai/gpt-4o-search-preview':  { input_per_million: 2.50,  output_per_million: 10.00, search_per_thousand: 35.00 },
};

const estimator: LlmCostEstimator = (
  model: string,
  inputTokens: number,
  outputTokens: number,
): number | null => {
  const p = MODEL_PRICING[model];
  if (!p) return null;
  // We don't get search-call counts back from OpenRouter, so assume 1 search
  // call for any model that has a search_per_thousand fee. Conservative — over-
  // estimates when the model doesn't actually trigger search, but gives a
  // realistic per-request cost for the typical case.
  const searchCalls = p.search_per_thousand != null ? 1 : 0;
  return (
    (inputTokens / 1_000_000) * p.input_per_million +
    (outputTokens / 1_000_000) * p.output_per_million +
    (searchCalls / 1_000) * (p.search_per_thousand ?? 0)
  );
};

let registered = false;

/**
 * Idempotent — safe to call from every API route module load. Only registers
 * the estimator once per Node process.
 */
export function ensureCostEstimatorRegistered(): void {
  if (registered) return;
  setCostEstimator(estimator);
  registered = true;
}
