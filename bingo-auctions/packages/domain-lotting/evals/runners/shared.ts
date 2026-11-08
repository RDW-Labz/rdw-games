// Shared helpers for runners: fixture loading, telemetry collection,
// report writing.
//
// IMPORTANT: this file does NOT import from `../../src/ai` at top-level.
// We do dynamic imports from inside the runner functions so that loading
// a fixture / parsing CLI args doesn't trip the LLM client's "missing API
// key" guard. The CLI's pre-flight check decides whether to actually run.

import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EvalReport, TaskTelemetry, TaskScore } from '../types';
import { estimateCostUsd, searchCallsForTask } from '../pricing';

const HERE = dirname(fileURLToPath(import.meta.url));
export const EVALS_ROOT = resolve(HERE, '..');
export const FIXTURES_ROOT = resolve(EVALS_ROOT, 'fixtures');
export const REPORTS_ROOT = resolve(EVALS_ROOT, 'reports');

export function loadFixtures<T>(subdir: string): T[] {
  const dir = join(FIXTURES_ROOT, subdir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as T);
}

export type Telemetry = {
  modelId: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd: number | null;
};

/**
 * Per-fixture telemetry buffer. The LLM client emits one event per provider
 * call (one tier, one HTTP request). A single fixture may produce multiple
 * events when escalation kicks in — we aggregate them in `consumeTelemetry`
 * so the report still has one row per fixture, with sums for tokens + cost
 * and the *final* model id (the tier that produced the answer).
 *
 * Use `installEvalTelemetry()` once at runner startup; it imports the LLM
 * client lazily so we don't trip the missing-API-key guard during fixture
 * loading.
 */
type RawTelemetryEvent = {
  task: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_estimate_usd: number;
  latency_ms: number;
  escalation_tier: number;
};

const _eventBuffer: RawTelemetryEvent[] = [];
let _telemetryInstalled = false;

/**
 * Install the LLM client telemetry sink — call once before the first
 * runner invocation. Idempotent.
 */
export async function installEvalTelemetry(): Promise<void> {
  if (_telemetryInstalled) return;
  try {
    // Lazy-import: importing llm.ts at module load triggers the config
    // path that reads OPENROUTER_API_KEY. The CLI's pre-flight already
    // checked we have one when this is called.
    const { setTelemetrySink, setCostEstimator } = await import('../../src/ai/llm');
    const { costEstimatorForLlmClient } = await import('../pricing');
    setCostEstimator(costEstimatorForLlmClient);
    setTelemetrySink((event: unknown) => {
      // Defensive: the sink is provider-agnostic; coerce to our local shape.
      if (typeof event !== 'object' || event === null) return;
      _eventBuffer.push(event as RawTelemetryEvent);
    });
    _telemetryInstalled = true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('[evals] could not install telemetry sink:', err);
  }
}

/**
 * Drain all events captured since the last call and aggregate them into a
 * single per-fixture telemetry record. Token counts and cost are summed,
 * the final tier's model id is reported, and the latency is the sum
 * (matches what the caller actually waited for, including escalation).
 *
 * If no events were captured (e.g. the call short-circuited before
 * reaching the LLM), returns a sentinel record with the env-var hint so
 * the report still labels the row.
 */
export function consumeTelemetry(): Telemetry {
  if (_eventBuffer.length === 0) {
    return {
      modelId: process.env['EVAL_MODEL_ID'] ?? 'unknown',
      costUsd: null,
    };
  }

  const events = _eventBuffer.splice(0, _eventBuffer.length);
  const last = events[events.length - 1]!;

  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let costKnown = false;
  for (const e of events) {
    inputTokens += e.input_tokens || 0;
    outputTokens += e.output_tokens || 0;
    // Recompute with task-aware search-call attribution. The client passes
    // 0 search calls; we fold the task default in here. If the model isn't
    // in the table, estimateCostUsd returns null and we leave costUsd as
    // whatever the client estimated (often 0).
    const recomputed = estimateCostUsd(
      e.model,
      e.input_tokens || 0,
      e.output_tokens || 0,
      searchCallsForTask(e.task),
    );
    if (recomputed !== null) {
      costUsd += recomputed;
      costKnown = true;
    } else if (typeof e.cost_estimate_usd === 'number') {
      costUsd += e.cost_estimate_usd;
    }
  }

  return {
    modelId: last.model,
    inputTokens,
    outputTokens,
    costUsd: costKnown ? costUsd : null,
  };
}

export async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const t0 = Date.now();
  const result = await fn();
  return { result, ms: Date.now() - t0 };
}

export function p95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
  return sorted[idx] ?? 0;
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function ensureReportsDir(): void {
  if (!existsSync(REPORTS_ROOT)) mkdirSync(REPORTS_ROOT, { recursive: true });
}

export function timestampSlug(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, '-');
}

export function writeReport(report: EvalReport): { json: string; md: string } {
  ensureReportsDir();
  const stamp = timestampSlug(new Date(report.finished_at));
  const baseName = `${report.suite}-${stamp}`;
  const jsonPath = join(REPORTS_ROOT, `${baseName}.json`);
  const mdPath = join(REPORTS_ROOT, `${baseName}.md`);
  writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8');
  writeFileSync(mdPath, renderMarkdown(report), 'utf8');
  return { json: jsonPath, md: mdPath };
}

function pct(n: number | undefined): string {
  if (n === undefined || Number.isNaN(n)) return 'n/a';
  return `${(n * 100).toFixed(1)}%`;
}

function renderMarkdown(report: EvalReport): string {
  const a = report.aggregates;
  const lines: string[] = [
    `# Eval report — ${report.suite}`,
    '',
    `- run_id: \`${report.run_id}\``,
    `- requested_model: \`${report.requested_model ?? '(default)'}\``,
    `- started_at: ${report.started_at}`,
    `- finished_at: ${report.finished_at}`,
    `- fixtures: ${report.fixture_count}`,
    `- error_rate: ${pct(a.error_rate)}`,
    '',
    '## Aggregates',
    '',
    '| metric | value |',
    '| --- | --- |',
    `| mean title similarity | ${a.mean_title_similarity?.toFixed(3) ?? 'n/a'} |`,
    `| mean description similarity | ${a.mean_description_similarity?.toFixed(3) ?? 'n/a'} |`,
    `| brand match rate | ${pct(a.brand_match_rate)} |`,
    `| model match rate | ${pct(a.model_match_rate)} |`,
    `| mean category score | ${a.mean_category_score?.toFixed(3) ?? 'n/a'} |`,
    `| condition match rate | ${pct(a.condition_match_rate)} |`,
    `| price within +/-25% | ${pct(a.price_within_band_rate)} |`,
    `| mean price MAE (cents) | ${a.mean_price_mae_cents ?? 'n/a'} |`,
    `| mean latency (ms) | ${a.mean_latency_ms.toFixed(0)} |`,
    `| p95 latency (ms) | ${a.p95_latency_ms.toFixed(0)} |`,
    `| total cost (USD) | ${a.total_cost_usd.toFixed(4)} |`,
    '',
    '## Per-task',
    '',
    '| fixture | model | latency | ok | title sim | brand | model | category | price band |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const t of report.tasks) {
    lines.push(
      `| ${t.fixture_id} | ${t.model_id} | ${t.latency_ms}ms | ${t.ok ? 'yes' : 'no'} | ` +
        `${t.metrics.title_similarity?.toFixed(2) ?? '-'} | ` +
        `${t.metrics.brand_match ?? '-'} | ` +
        `${t.metrics.model_match ?? '-'} | ` +
        `${t.metrics.category_score?.toFixed(2) ?? '-'} | ` +
        `${t.metrics.price_within_band ?? '-'} |`,
    );
  }
  return lines.join('\n') + '\n';
}

export type CombinedTask = TaskTelemetry & TaskScore;

export function summarizeTasks(tasks: CombinedTask[]): EvalReport['aggregates'] {
  const ok = tasks.filter((t) => t.ok);
  const errs = tasks.length === 0 ? 0 : (tasks.length - ok.length) / tasks.length;
  const titleSim = ok.map((t) => t.metrics.title_similarity).filter((v): v is number => typeof v === 'number');
  const descSim = ok.map((t) => t.metrics.description_similarity).filter((v): v is number => typeof v === 'number');
  const brand = ok.map((t) => t.metrics.brand_match).filter((v): v is 0 | 1 => v !== undefined);
  const model = ok.map((t) => t.metrics.model_match).filter((v): v is 0 | 1 => v !== undefined);
  const cat = ok.map((t) => t.metrics.category_score).filter((v): v is number => typeof v === 'number');
  const cond = ok.map((t) => t.metrics.condition_match).filter((v): v is 0 | 1 => v !== undefined);
  const band = ok.map((t) => t.metrics.price_within_band).filter((v): v is 0 | 1 => v !== undefined);
  const mae = ok.map((t) => t.metrics.price_mae_cents).filter((v): v is number => typeof v === 'number');
  const lat = ok.map((t) => t.latency_ms);
  const cost = ok.map((t) => t.cost_usd ?? 0);
  return {
    mean_title_similarity: titleSim.length ? mean(titleSim) : undefined,
    mean_description_similarity: descSim.length ? mean(descSim) : undefined,
    brand_match_rate: brand.length ? mean(brand) : undefined,
    model_match_rate: model.length ? mean(model) : undefined,
    mean_category_score: cat.length ? mean(cat) : undefined,
    condition_match_rate: cond.length ? mean(cond) : undefined,
    price_within_band_rate: band.length ? mean(band) : undefined,
    mean_price_mae_cents: mae.length ? Math.round(mean(mae)) : undefined,
    mean_latency_ms: mean(lat),
    p95_latency_ms: p95(lat),
    total_cost_usd: cost.reduce((a, b) => a + b, 0),
    error_rate: errs,
  };
}

export function newRunId(): string {
  return `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
