// UPC / ASIN lookup runner.
//
// Calls `lookupCode(code)` for each fixture and scores the returned product
// info against the labeled ground truth. Fake-UPC fixtures (those whose
// expected brand/title are empty) are scored on the "no hallucination"
// invariant: a model that returns a confident wrong answer fails this case.

import type { LabeledUpcLookup } from '../types';
import { titleSimilarity, exactStringMatch, legacyCategoryScore } from '../metrics';
import { priceBand } from '../metrics/price-band';
import {
  loadFixtures,
  timed,
  consumeTelemetry,
  installEvalTelemetry,
  newRunId,
  summarizeTasks,
  writeReport,
  type CombinedTask,
} from './shared';

export type UpcRunOptions = {
  limit?: number;
  modelOverride?: string | null;
};

export async function runUpcLookup(opts: UpcRunOptions = {}): Promise<string> {
  await installEvalTelemetry();
  const { lookupCode } = await import('../../src/ai/pricing');

  const all = loadFixtures<LabeledUpcLookup>('upc_lookups');
  const fixtures = opts.limit ? all.slice(0, opts.limit) : all;
  const startedAt = new Date().toISOString();
  const tasks: CombinedTask[] = [];

  for (const fx of fixtures) {
    let ok = true;
    let error: string | undefined;

    const { result, ms } = await timed(async () => {
      try {
        return await lookupCode(fx.code);
      } catch (e) {
        ok = false;
        error = e instanceof Error ? e.message : String(e);
        return null;
      }
    });

    const actualTitle = result?.title ?? '';
    const actualBrand = result?.brand ?? '';
    const actualModel = result?.model ?? '';
    const actualCategoryLegacy = result?.category ?? '';
    const actualMsrpCents = Math.round((result?.msrp ?? 0) * 100);

    // Special case: fake UPC. If expected.title is empty, score is
    // 1 only if the model returned nothing (or essentially nothing).
    const isNegative = !fx.expected.title;
    const tel = consumeTelemetry();
    const band = priceBand(actualMsrpCents, fx.expected.msrp_cents);

    if (isNegative && result) {
      const looksHallucinated =
        actualTitle.length > 0 || actualBrand.length > 0 || actualModel.length > 0;
      if (looksHallucinated) {
        ok = false;
        error = 'model hallucinated a product for a known-bad code';
      }
    }

    tasks.push({
      fixture_id: fx.id,
      model_id: tel.modelId,
      latency_ms: ms,
      input_tokens: tel.inputTokens,
      output_tokens: tel.outputTokens,
      cost_usd: tel.costUsd,
      ok,
      error,
      expected: fx.expected,
      actual: {
        title: actualTitle,
        brand: actualBrand,
        model: actualModel,
        category_legacy: actualCategoryLegacy as never,
        msrp_cents: actualMsrpCents,
      },
      metrics: {
        title_similarity: titleSimilarity(actualTitle, fx.expected.title),
        brand_match: exactStringMatch(actualBrand, fx.expected.brand),
        model_match: exactStringMatch(actualModel, fx.expected.model),
        category_score: legacyCategoryScore(actualCategoryLegacy, fx.expected.category_slug),
        price_within_band: band.within_band,
        price_mae_cents: band.mae_cents,
      },
    });
  }

  const finishedAt = new Date().toISOString();
  const { json } = writeReport({
    suite: 'upc-lookup',
    run_id: newRunId(),
    started_at: startedAt,
    finished_at: finishedAt,
    requested_model: opts.modelOverride ?? null,
    fixture_count: tasks.length,
    aggregates: summarizeTasks(tasks),
    tasks,
  });
  return json;
}
