// scripts/mega-sim/lib/cost.js
//
// Cost tracking for AI calls. Mirrors the pricing table in
// apps/operator-web/src/lib/register-cost-estimator.ts (kept duplicated
// per the comment there — both files must stay in sync).
//
// Wiring: call attachToDomainLotting() once at sim startup. It installs
// both setCostEstimator() and setTelemetrySink() on the domain-lotting
// LLM client. Every call to complete() in `domain-lotting/src/ai/llm.ts`
// will then push an event to the in-memory ring buffer that the
// reporter reads at end-of-run.

'use strict';

const MODEL_PRICING = {
  'google/gemini-2.5-flash':           { in: 0.075, out: 0.30 },
  'google/gemini-2.5-flash-lite':      { in: 0.04,  out: 0.10 },
  'anthropic/claude-haiku-4-5':        { in: 1.00,  out: 5.00 },
  'anthropic/claude-sonnet-4-6':       { in: 3.00,  out: 15.00 },
  'perplexity/sonar':                  { in: 1.00,  out: 1.00,  search_per_thousand: 5.00 },
  'perplexity/sonar-pro':              { in: 3.00,  out: 15.00, search_per_thousand: 6.00 },
  'openai/gpt-4o-mini-search-preview': { in: 0.15,  out: 0.60 },
  'openai/gpt-4o-search-preview':      { in: 2.50,  out: 10.00, search_per_thousand: 35.00 },
};

function estimate(model, inputTokens, outputTokens) {
  const p = MODEL_PRICING[model];
  if (!p) return null;
  const searchCalls = p.search_per_thousand != null ? 1 : 0;
  return (
    (inputTokens / 1_000_000) * p.in +
    (outputTokens / 1_000_000) * p.out +
    (searchCalls / 1_000) * (p.search_per_thousand || 0)
  );
}

// ── Event buffer ──────────────────────────────────────────────────────────
//
// Every LlmTelemetryEvent the domain-lotting client emits ends up here.
// Reporter consumes at the end of the run. We also keep a tag (the
// current persona/step) so cost can be sliced by phase.

const _events = [];
let _currentTag = null;

function pushTag(tag) {
  _currentTag = tag;
}

function getEvents() {
  return _events.slice();
}

function clearEvents() {
  _events.length = 0;
}

// ── Wire up to domain-lotting ─────────────────────────────────────────────

let _attached = false;

function attachToDomainLotting() {
  if (_attached) return;
  _attached = true;
  // Lazy-require so the sim can run without the workspace built (e.g.
  // --no-ai mode that never touches AI). domain-lotting needs to be
  // resolvable from the repo root as a workspace package.
  try {
    const dl = require('@auction-platform/domain-lotting');
    if (typeof dl.setCostEstimator === 'function') {
      dl.setCostEstimator(estimate);
    }
    if (typeof dl.setTelemetrySink === 'function') {
      dl.setTelemetrySink((event) => {
        _events.push({ ...event, tag: _currentTag, ts: Date.now() });
      });
    }
  } catch (e) {
    console.warn(
      '[cost] could not attach to domain-lotting (' +
        e.message +
        '). Cost tracking disabled. Run pnpm install / npm install at repo root.',
    );
  }
}

// ── Aggregation helpers (consumed by reporter) ────────────────────────────

function summarize(events) {
  const total = events.reduce((s, e) => s + (e.cost_estimate_usd || 0), 0);
  const byTask = {};
  const byTag = {};
  const byModel = {};
  for (const e of events) {
    if (!byTask[e.task]) byTask[e.task] = { calls: 0, cost: 0, latencyMs: 0 };
    byTask[e.task].calls += 1;
    byTask[e.task].cost += e.cost_estimate_usd || 0;
    byTask[e.task].latencyMs += e.latency_ms || 0;

    const tag = e.tag || '(untagged)';
    if (!byTag[tag]) byTag[tag] = { calls: 0, cost: 0 };
    byTag[tag].calls += 1;
    byTag[tag].cost += e.cost_estimate_usd || 0;

    if (!byModel[e.model]) byModel[e.model] = { calls: 0, cost: 0, inputTokens: 0, outputTokens: 0 };
    byModel[e.model].calls += 1;
    byModel[e.model].cost += e.cost_estimate_usd || 0;
    byModel[e.model].inputTokens += e.input_tokens || 0;
    byModel[e.model].outputTokens += e.output_tokens || 0;
  }
  return { total, calls: events.length, byTask, byTag, byModel };
}

module.exports = {
  MODEL_PRICING,
  estimate,
  attachToDomainLotting,
  pushTag,
  getEvents,
  clearEvents,
  summarize,
};
