// Manifest-row classifier runner.
//
// Strategy: a manifest row is text only — no photo, no UPC scan. We feed
// the raw description through `lookupCode` if a UPC is present, and fall
// back to a synthesized "best query" path that the LLM can resolve via
// web search. (Either way we're calling the same domain function the
// LotTR pipeline will call.)
//
// We score: brand match, model match, category, title similarity, and
// price band. Condition isn't scored on this suite — manifests rarely
// reveal it reliably.

import type { LabeledManifestRow } from '../types';
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

export type ManifestRunOptions = {
  limit?: number;
  modelOverride?: string | null;
};

export async function runManifestClassify(opts: ManifestRunOptions = {}): Promise<string> {
  await installEvalTelemetry();
  const { lookupCode, fetchPrices } = await import('../../src/ai/pricing');

  const all = loadFixtures<LabeledManifestRow>('manifest_rows');
  const fixtures = opts.limit ? all.slice(0, opts.limit) : all;
  const startedAt = new Date().toISOString();
  const tasks: CombinedTask[] = [];

  for (const fx of fixtures) {
    let ok = true;
    let error: string | undefined;
    let actualTitle = '';
    let actualBrand = '';
    let actualModel = '';
    let actualCategoryLegacy = '';
    let actualMsrpCents = 0;

    const { result, ms } = await timed(async () => {
      try {
        if (fx.raw.upc) {
          return await lookupCode(fx.raw.upc);
        }
        // No UPC — synthesize a query from the manifest description and
        // ask fetchPrices to do its thing. We don't get brand/model out
        // of fetchPrices, but we do get title + msrp, which is enough
        // for the score.
        const query = [fx.expected.brand, fx.expected.model, fx.raw.description]
          .filter(Boolean)
          .join(' ')
          .slice(0, 240);
        const price = await fetchPrices(query);
        return price ? { ...price, brand: '', model: '', category: 'Other' } : null;
      } catch (e) {
        ok = false;
        error = e instanceof Error ? e.message : String(e);
        return null;
      }
    });

    if (result) {
      const r = result as Partial<{
        title: string;
        brand: string;
        model: string;
        category: string;
        msrp: number | null;
        fullTitle: string;
      }>;
      actualTitle = r.title ?? r.fullTitle ?? '';
      actualBrand = r.brand ?? '';
      actualModel = r.model ?? '';
      actualCategoryLegacy = r.category ?? '';
      actualMsrpCents = Math.round((r.msrp ?? 0) * 100);
    } else if (ok) {
      ok = false;
      error = error ?? 'null result';
    }

    const tel = consumeTelemetry();
    const band = priceBand(actualMsrpCents, fx.expected.msrp_cents);

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
    suite: 'manifest-classify',
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
