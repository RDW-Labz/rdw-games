// Photo identification runner.
//
// Reads packages/domain-lotting/evals/fixtures/photos/*.json, calls
// `scanPhoto` on each (or `identifyPhoto` if EVAL_PHOTO_FAST=1), scores
// the result, and writes the report.
//
// Skips fixtures whose image file is missing — the JSON sidecars are in
// version control but the JPGs/PNGs are not.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { LabeledPhoto } from '../types';
import { titleSimilarity, descriptionSimilarity, exactStringMatch, legacyCategoryScore } from '../metrics';
import { priceBand } from '../metrics/price-band';
import {
  FIXTURES_ROOT,
  loadFixtures,
  timed,
  consumeTelemetry,
  installEvalTelemetry,
  newRunId,
  summarizeTasks,
  writeReport,
  type CombinedTask,
} from './shared';

export type PhotoRunOptions = {
  limit?: number;
  /** Pass-through; the LLM client reads it from EVAL_MODEL_ID. */
  modelOverride?: string | null;
  /** If true, calls identifyPhoto (vision-only, faster, no price). */
  fastMode?: boolean;
};

export async function runPhotoId(opts: PhotoRunOptions = {}): Promise<string> {
  await installEvalTelemetry();
  const { scanPhoto, identifyPhoto } = await import('../../src/ai/identification');

  const all = loadFixtures<LabeledPhoto>('photos');
  const fixtures = opts.limit ? all.slice(0, opts.limit) : all;
  const startedAt = new Date().toISOString();
  const tasks: CombinedTask[] = [];

  for (const fx of fixtures) {
    const imagePath = join(FIXTURES_ROOT, 'photos', fx.image_path);
    if (!existsSync(imagePath)) {
      // eslint-disable-next-line no-console
      console.warn(`[photo-id] skipping ${fx.id}: image file missing at ${imagePath}`);
      continue;
    }
    const base64 = readFileSync(imagePath).toString('base64');
    // scanPhoto now requires opts.supabase since the legacy Anthropic
    // path was deleted. The eval harness doesn't have a real auth user,
    // but the cheap two-step pipeline only USES supabase for the
    // catalog lookup (product_lookups) and the image-enrich cache
    // write — both of which gracefully no-op on RLS denial. Providing
    // a service-role admin client here is harmless and lets the eval
    // exercise the same code path operator-web serves.
    let evalSupabase: SupabaseClient | null = null;
    if (!opts.fastMode) {
      const { createClient } = await import('@supabase/supabase-js');
      const url = process.env['SUPABASE_URL'] ?? process.env['NEXT_PUBLIC_SUPABASE_URL'];
      const key =
        process.env['SUPABASE_SERVICE_ROLE_KEY'] ??
        process.env['SUPABASE_ANON_KEY'] ??
        process.env['NEXT_PUBLIC_SUPABASE_ANON_KEY'];
      if (url && key) evalSupabase = createClient(url, key);
    }

    let ok = true;
    let error: string | undefined;
    let actualTitle = '';
    let actualBrand = '';
    let actualModel = '';
    let actualCategoryLegacy = '';
    let actualCondition = '';
    let actualDescription = '';
    let actualMsrpCents = 0;

    const { result, ms } = await timed(async () => {
      try {
        if (opts.fastMode) {
          return await identifyPhoto(base64, fx.media_type);
        }
        if (!evalSupabase) {
          throw new Error(
            'Eval scanPhoto requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (or ANON_KEY) in env. Set them or run with EVAL_PHOTO_FAST=1.',
          );
        }
        return await scanPhoto(base64, fx.media_type, { supabase: evalSupabase });
      } catch (e) {
        ok = false;
        error = e instanceof Error ? e.message : String(e);
        return null;
      }
    });

    if (result) {
      actualTitle = result.title;
      actualBrand = result.brand;
      actualModel = result.model;
      actualCategoryLegacy = result.category;
      actualCondition = result.condition;
      actualDescription = result.description;
      // scanPhoto returns LotCandidate (with msrp); identifyPhoto returns Identification (no msrp).
      const msrp = (result as { msrp?: number | null }).msrp ?? 0;
      actualMsrpCents = Math.round((msrp ?? 0) * 100);
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
        category_slug: '', // legacy enum; mapped via legacyCategoryScore below
        category_legacy: actualCategoryLegacy as never,
        condition: actualCondition as never,
        msrp_cents: actualMsrpCents,
      },
      metrics: {
        title_similarity: titleSimilarity(actualTitle, fx.expected.title),
        description_similarity: descriptionSimilarity(actualDescription, fx.expected.title),
        brand_match: exactStringMatch(actualBrand, fx.expected.brand),
        model_match: exactStringMatch(actualModel, fx.expected.model),
        category_score: legacyCategoryScore(actualCategoryLegacy, fx.expected.category_slug),
        condition_match: exactStringMatch(actualCondition, fx.expected.condition),
        price_within_band: opts.fastMode ? undefined : band.within_band,
        price_mae_cents: opts.fastMode ? undefined : band.mae_cents,
      },
    });
  }

  const finishedAt = new Date().toISOString();
  const { json } = writeReport({
    suite: 'photo-id',
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
