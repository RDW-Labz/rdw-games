// Token-pricing table for cost estimation in eval reports.
//
// Numbers are USD per *million* input/output tokens, plus an optional
// per-thousand search-call fee (Perplexity Sonar + GPT-4o-search-preview
// charge separately for grounded web search on top of token usage).
//
// Source: OpenRouter "model" pages, retrieved 2026-04 / 2026-05. Anthropic
// publishes their own pricing on docs.anthropic.com; the OpenRouter
// pass-through tracks the underlying provider with a small markup. The
// numbers here are conservative ("list price"); the actual invoice is
// usually a few percent lower because OpenRouter aggregates spend across
// providers. If you re-run after a provider price change, update this
// file and add a test fixture so a future audit can spot drift.
//
// FLAGGED FOR HUMAN VERIFICATION:
//   - perplexity/sonar search_per_thousand: $5.00 — Perplexity restructured
//     their pricing in early 2026; confirm against the current rate card.
//   - openai/gpt-4o-search-preview search_per_thousand: $35.00 — this was
//     unusually high at preview launch; double-check against the current
//     openai.com/api/pricing page before publishing a cost-comparison.
//   - anthropic/claude-sonnet-4-6: per-million rates assume Sonnet 4.6 list
//     pricing; the model id in OpenRouter's catalog may differ if Anthropic
//     re-tags the version (e.g. claude-sonnet-4-7). Fall back to a "tier"
//     mapping if the exact id is missing.

import { setCostEstimator, type LlmCostEstimator } from '../src/ai/llm';

export type ModelPrice = {
  /** USD per 1,000,000 input tokens. */
  input_per_million: number;
  /** USD per 1,000,000 output tokens. */
  output_per_million: number;
  /** USD per 1,000 grounded-web-search calls, when the model performs them. */
  search_per_thousand?: number;
};

export const MODEL_PRICING: Record<string, ModelPrice> = {
  // Google Gemini — the current cost leader for vision + JSON.
  'google/gemini-2.5-flash': { input_per_million: 0.075, output_per_million: 0.3 },
  'google/gemini-2.5-flash-lite': { input_per_million: 0.04, output_per_million: 0.1 },

  // Anthropic — Haiku 4.5 is the value tier; Sonnet is the accuracy ceiling.
  'anthropic/claude-haiku-4-5': { input_per_million: 1.0, output_per_million: 5.0 },
  'anthropic/claude-sonnet-4-6': { input_per_million: 3.0, output_per_million: 15.0 },

  // Perplexity Sonar — bundles live web search; per-1k-search fee on top.
  'perplexity/sonar': {
    input_per_million: 1.0,
    output_per_million: 1.0,
    search_per_thousand: 5.0,
  },
  'perplexity/sonar-pro': {
    input_per_million: 3.0,
    output_per_million: 15.0,
    search_per_thousand: 6.0,
  },

  // OpenAI search-preview models — also bundle live web search.
  'openai/gpt-4o-mini-search-preview': {
    input_per_million: 0.15,
    output_per_million: 0.6,
  },
  'openai/gpt-4o-search-preview': {
    input_per_million: 2.5,
    output_per_million: 10.0,
    search_per_thousand: 35.0,
  },
};

/**
 * Estimate USD cost for a single LLM call.
 *
 * `searchCalls` is the number of grounded-web-search invocations the model
 * made. We don't currently get this back from OpenRouter's response (the
 * API doesn't surface it as a discrete counter), so the LLM client passes
 * 0 by default and the eval harness can pass a fixed assumption per task
 * (e.g. 1 for `web_search_lookup`, 0 for `code_lookup`).
 *
 * Returns `null` when the model isn't in the pricing table — callers should
 * treat null as "unknown" and skip cost aggregation rather than charge $0.
 */
export function estimateCostUsd(
  model: string,
  inputTokens: number,
  outputTokens: number,
  searchCalls = 0,
): number | null {
  const p = MODEL_PRICING[model];
  if (!p) return null;
  const inputCost = (inputTokens / 1_000_000) * p.input_per_million;
  const outputCost = (outputTokens / 1_000_000) * p.output_per_million;
  const searchCost = (searchCalls / 1_000) * (p.search_per_thousand ?? 0);
  return inputCost + outputCost + searchCost;
}

/**
 * Per-task default for grounded-web-search counts. Tasks that explicitly
 * use a search-capable model invoke search ~1x per call in the typical
 * path; tasks that don't, count 0.
 */
const SEARCH_CALLS_BY_TASK_PREFIX: Record<string, number> = {
  web_search_lookup: 1,
  shelf_scan: 0,
  photo_identify: 0,
  code_lookup: 0,
  keyword_search: 0,
  description_generate: 0,
};

export function searchCallsForTask(task: string): number {
  return SEARCH_CALLS_BY_TASK_PREFIX[task] ?? 0;
}

/**
 * Bound estimator suitable for `setCostEstimator()`. It assumes 0 search
 * calls per invocation — the eval-side telemetry sink can re-compute with
 * a task-aware count if it wants finer-grained search-fee attribution.
 */
export const costEstimatorForLlmClient: LlmCostEstimator = (model, inputTokens, outputTokens) => {
  return estimateCostUsd(model, inputTokens, outputTokens, 0);
};

/** Convenience: install the default estimator into the LLM client. */
export function installDefaultCostEstimator(): void {
  setCostEstimator(costEstimatorForLlmClient);
}
