// POST /api/lottr/shelf-scan  { base64: string, mediaType: string }
//
// Mobile AI proxy — multi-SKU shelf detection (Sonnet 4.6 vision).
// The mobile bundle never holds AI keys; this route holds them server-side
// and verifies the caller's Supabase JWT before forwarding to domain-lotting.
//
// Returns: LotCandidate[] (1-20 distinct SKUs detected on the shelf/pallet).
//
// Auth: Bearer <supabase_access_token> in the Authorization header.

import { lottingFetchHtml, lottingMirrorImage } from '@/lib/lotting-egress';
import { NextResponse } from 'next/server';
import {
  shelfScan,
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

const BASELINE_SINK: LlmTelemetrySink = () => { /* no-op */ };

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

  // 0061: previously this route installed NO telemetry sink, so every
  // shelf_scan Sonnet call ($0.025-0.060/scan) was silently dropped
  // from cost reporting. Now wired identically to the other lottr
  // routes — cost goes into ai_calls and meta.cost_usd is surfaced
  // to the mobile client for the CostHud.
  const capture = startAiCallCapture();
  setTelemetrySink(capture.sink);

  try {
    const candidates = await shelfScan(base64, mediaType);
    if (!candidates || candidates.length === 0) {
      return NextResponse.json(
        { ok: false, error: 'no_skus_detected' },
        { status: 422 },
      );
    }
    return NextResponse.json({
      ok: true,
      data: candidates,
      meta: { cost_usd: capture.totalCostUsd() },
    });
  } catch (err) {
    console.error('[shelf-scan] error', (err as Error).message);
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 502 },
    );
  } finally {
    setTelemetrySink(BASELINE_SINK);
    // AWAIT — see comment in scan-photo/route.ts. Cloudflare Workers
    // kill the isolate at response time; unresolved I/O is lost.
    await capture.persist({ operatorId: caller.operatorId, userId: caller.userId });
  }
}
