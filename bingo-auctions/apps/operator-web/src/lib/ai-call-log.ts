// Shared helper for /api/lottr/* routes: capture every LlmTelemetryEvent
// the request emits and persist them to the ai_calls table at the end
// of the request lifecycle.
//
// Usage:
//   const capture = startAiCallCapture();
//   setTelemetrySink(capture.sink);
//   try {
//     const result = await scanPhoto(...);
//     // ...
//   } finally {
//     setTelemetrySink(BASELINE_SINK);
//     await capture.persist({ operatorId, userId, lotId, cached });
//   }
//
// The capture object accumulates the full LlmTelemetryEvent list (model,
// tokens, latency, tier, cost) — not just the running cost total — so
// the persisted rows can answer "how much of this operator's spend was
// Sonnet escalations" without re-running the AI.
//
// Persist is best-effort: log + swallow on failure. We never want a
// telemetry write to break the operator-facing AI flow.

import type { LlmTelemetryEvent, LlmTelemetrySink } from '@auction-platform/domain-lotting/ai';
import { getSupabaseAdmin } from './supabase-admin';

export type AiCallCapture = {
  sink: LlmTelemetrySink;
  events: LlmTelemetryEvent[];
  totalCostUsd: () => number;
  persist: (ctx: {
    operatorId: string;
    userId: string;
    lotId?: string | null;
    cached?: boolean;
  }) => Promise<void>;
};

export function startAiCallCapture(): AiCallCapture {
  const events: LlmTelemetryEvent[] = [];

  const sink: LlmTelemetrySink = (event) => {
    events.push(event);
  };

  function totalCostUsd(): number {
    return events.reduce((s, e) => s + (e.cost_estimate_usd ?? 0), 0);
  }

  async function persist(ctx: {
    operatorId: string;
    userId: string;
    lotId?: string | null;
    cached?: boolean;
  }): Promise<void> {
    if (events.length === 0) {
      // Cache-hit path with no AI call. Still record a row marked
      // cached=true so we can report cache-hit rate per operator/task.
      // But ONLY when the caller has signalled cached=true — otherwise
      // it's a no-op call that doesn't deserve a row (e.g. a 422 early-
      // return path with no AI work done).
      if (!ctx.cached) return;
      try {
        await getSupabaseAdmin()
          .from('ai_calls')
          .insert({
            operator_id: ctx.operatorId,
            user_id: ctx.userId,
            task: 'cached',
            model: null,
            input_tokens: 0,
            output_tokens: 0,
            cost_cents: 0,
            latency_ms: 0,
            cached: true,
            escalation_tier: 0,
            lot_id: ctx.lotId ?? null,
          });
      } catch (err) {
        console.warn('[ai-call-log] cached-row insert failed:', (err as Error).message);
      }
      return;
    }

    // Batch-INSERT every event. cost_estimate_usd → cost_cents
    // (round() to nearest cent — Postgres BIGINT for safety).
    const rows = events.map((e) => ({
      operator_id: ctx.operatorId,
      user_id: ctx.userId,
      task: e.task,
      model: e.model || null,
      input_tokens: e.input_tokens ?? 0,
      output_tokens: e.output_tokens ?? 0,
      // Audit F-05 (2026-05-18): previous formula `Math.round(usd*10000)/100`
      // produced non-integer cents (e.g. $0.012 → 1.2) which a BIGINT
      // column silently truncates or rejects, undercounting AI spend by
      // 20-50% on cheap calls. Convert USD → cents = usd × 100, rounded
      // to integer. Sub-cent costs round to 0 or 1 — acceptable.
      cost_cents: Math.round((e.cost_estimate_usd ?? 0) * 100),
      latency_ms: e.latency_ms ?? 0,
      cached: false,
      escalation_tier: e.escalation_tier ?? 0,
      lot_id: ctx.lotId ?? null,
    }));

    try {
      const { error } = await getSupabaseAdmin().from('ai_calls').insert(rows);
      if (error) {
        console.warn('[ai-call-log] batch insert failed:', error.message);
      }
    } catch (err) {
      console.warn('[ai-call-log] batch insert threw:', (err as Error).message);
    }
  }

  return { sink, events, totalCostUsd, persist };
}
