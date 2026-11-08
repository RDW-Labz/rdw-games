// POST /api/lottr/identify-photo  { base64: string, mediaType: string }
//
// Mobile AI proxy — fast vision-only identification (no web-search,
// no price lookup). Returns Identification shape. Use when you plan to
// batch-fetch prices separately (e.g. by UPC after identify finds one).
//
// Auth: Bearer <supabase_access_token> in the Authorization header.
//
// Cost tracking: same sink-stack approach as scan-photo. See that file
// for the concurrency discussion.

import { lottingFetchHtml, lottingMirrorImage } from '@/lib/lotting-egress';
import { NextResponse } from 'next/server';
import {
  identifyPhoto,
  setLottingConfig,
  hasLottingConfig,
} from '@auction-platform/domain-lotting';
import { setTelemetrySink } from '@auction-platform/domain-lotting/ai';
import type { LlmTelemetrySink } from '@auction-platform/domain-lotting/ai';
import { verifyLottrAuth } from '@/lib/lottr-auth';
import { startAiCallCapture } from '@/lib/ai-call-log';
import { checkAiBudget } from '@/lib/ai-budget';

import { ensureCostEstimatorRegistered } from '@/lib/register-cost-estimator';
ensureCostEstimatorRegistered();

function ensureConfigured(): boolean {
  if (hasLottingConfig()) return true;
  const openrouterKey = process.env['OPENROUTER_API_KEY'];
  if (!openrouterKey) return false;
  // OpenRouter only — see enrich-lot/route.ts comment.
  // 2026-07-10: route retailer page-fetches (stock images + prices)
  // through the unblocked egress chain — see lib/lotting-egress.ts.
  setLottingConfig({ openrouterKey, fetchHtml: lottingFetchHtml, mirrorImage: lottingMirrorImage });
  return true;
}

// Auth lives in lib/lottr-auth.ts — the local verifyMobileAuth was a
// duplicate of verifyLottrAuth's bearer branch. Folded into the shared
// helper so all lottr routes share the scoping rules in lib/lottr-auth.ts.

const BASELINE_SINK: LlmTelemetrySink = () => { /* no-op */ };

export async function POST(req: Request) {
  if (!ensureConfigured()) {
    return NextResponse.json(
      { ok: false, error: 'OPENROUTER_API_KEY not configured on the server.' },
      { status: 503 },
    );
  }

  const caller = await verifyLottrAuth(req);
  if (!caller) {
    return NextResponse.json(
      { ok: false, error: 'not_authenticated' },
      { status: 401 },
    );
  }

  let body: { base64?: string; mediaType?: string };
  try {
    body = (await req.json()) as { base64?: string; mediaType?: string };
  } catch {
    return NextResponse.json({ ok: false, error: 'bad_json' }, { status: 400 });
  }

  const base64 = String(body.base64 ?? '').trim();
  const mediaType = String(body.mediaType ?? 'image/jpeg').trim();

  if (!base64) {
    return NextResponse.json(
      { ok: false, error: 'base64 required' },
      { status: 400 },
    );
  }
  if (!mediaType.startsWith('image/')) {
    return NextResponse.json(
      { ok: false, error: 'mediaType must be an image/* MIME type' },
      { status: 400 },
    );
  }

  // ── 0085: Pre-call budget enforcement ────────────────────────────────────
  try {
    await checkAiBudget(caller.operatorId);
  } catch (err) {
    if ((err as Error).message === 'ai_budget_exceeded') {
      return NextResponse.json(
        { ok: false, error: 'ai_budget_exceeded' },
        { status: 402 },
      );
    }
    throw err;
  }

  // ── Per-request cost capture (0061: persisted to ai_calls) ───────────────
  const capture = startAiCallCapture();
  setTelemetrySink(capture.sink);

  try {
    const result = await identifyPhoto(base64, mediaType);
    if (!result) {
      return NextResponse.json(
        { ok: false, error: 'no_identification' },
        { status: 422 },
      );
    }
    return NextResponse.json({
      ok: true,
      data: result,
      meta: { cost_usd: capture.totalCostUsd() },
    });
  } catch (err) {
    console.error('[identify-photo] error', (err as Error).message);
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 502 },
    );
  } finally {
    setTelemetrySink(BASELINE_SINK);
    // AWAIT — see comment in scan-photo/route.ts. Cloudflare Workers
    // kill the isolate at response time; unresolved I/O is lost.
    //
    // SERVICE-ROLE INTENTIONAL: ai_calls is written by every authenticated
    // staff member for cost tracking; the table doesn't have a staff-write
    // RLS policy so we use admin. The persist call internally scopes by
    // operatorId + userId from the verified caller — no cross-tenant leak.
    await capture.persist({ operatorId: caller.operatorId, userId: caller.userId });
  }
}
