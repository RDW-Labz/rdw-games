// POST /api/lottr/scan-photo  { base64: string, mediaType: string }
//
// Mobile AI proxy — vision + web-search scan. The mobile bundle never
// holds AI keys; this route holds them server-side and verifies the
// caller's Supabase JWT before forwarding to domain-lotting.
//
// Auth: Bearer <supabase_access_token> in the Authorization header.
// The token is verified via the admin client (getUser(token)), which
// does a live Supabase auth check without cookie state.
//
// Cost tracking approach — sink stack:
//   Before the AI call we install a per-request sink that captures cost in a
//   local variable. We save the *previous* sink and call it too (so concurrent
//   requests chain correctly). After the call (try/finally) we restore the
//   previous sink. Each request accumulates its own cost independently.
//   This is safe for the actual usage pattern: the AI call inside domain-lotting
//   is sequential (no parallelism within a single request), so the installed
//   sink is only called by that request's call stack.

import { lottingFetchHtml, lottingMirrorImage } from '@/lib/lotting-egress';
import { NextResponse } from 'next/server';
import {
  scanPhoto,
  lookupByCode,
  productToCandidate,
  setLottingConfig,
  hasLottingConfig,
} from '@auction-platform/domain-lotting';
import { resolveAsinIntoCatalog, isAsinCode } from '@/lib/catalog/resolve-asin';
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

// Module-level "previous sink" tracker. In a single-process serverless
// environment Next.js routes are isolated per invocation, but the module
// singleton persists across warm invocations. We track the baseline sink
// (the no-op installed at module load) and restore to it after each request.
// Concurrent warm requests will both install their own sink; each saves what
// it found and restores it in finally — the chain composes naturally.
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

  type IncomingBody = {
    base64?: string;
    mediaType?: string;
    images?: Array<{ base64: string; mediaType: string }>;
  };
  let body: IncomingBody;
  try {
    body = (await req.json()) as IncomingBody;
  } catch {
    return NextResponse.json({ ok: false, error: 'bad_json' }, { status: 400 });
  }

  // Accept either:
  //   { base64, mediaType }                — legacy single-image clients
  //   { images: [{base64,mediaType}, ...] } — new multi-angle clients
  // Cap to 3 here AND in domain-lotting's complete() — defense in depth.
  let images: Array<{ base64: string; mediaType: string }> = [];
  if (Array.isArray(body.images) && body.images.length > 0) {
    images = body.images
      .filter((i) => typeof i?.base64 === 'string' && i.base64.trim().length > 0)
      .map((i) => ({
        base64: i.base64.trim(),
        mediaType: (i.mediaType ?? 'image/jpeg').trim(),
      }))
      .slice(0, 3);
  } else if (typeof body.base64 === 'string' && body.base64.trim().length > 0) {
    images = [{
      base64: body.base64.trim(),
      mediaType: (body.mediaType ?? 'image/jpeg').trim(),
    }];
  }

  if (images.length === 0) {
    return NextResponse.json(
      { ok: false, error: 'base64 (single) or images[] (array) required' },
      { status: 400 },
    );
  }
  for (const img of images) {
    if (!img.mediaType.startsWith('image/')) {
      return NextResponse.json(
        { ok: false, error: 'mediaType must be an image/* MIME type' },
        { status: 400 },
      );
    }
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

  // ── Per-request cost capture ──────────────────────────────────────────────
  // 0061: capture every event (not just cost total) so each call is
  // persisted into ai_calls for cost reporting.
  const capture = startAiCallCapture();
  setTelemetrySink(capture.sink);

  try {
    // SERVICE-ROLE INTENTIONAL: scanPhoto calls into lookupByCode →
    // upsertLookup, which writes to product_lookups. RLS write policy
    // was dropped for that table in 0028_security_fixes.sql; admin is
    // the only path that can populate the platform-shared cache.
    // fastScan (2026-07-13): defer the slow Sonar price/image web passes so the
    // scan returns in ~vision-ID time (~5-8s) instead of ~60-90s on a cache
    // miss. The client fills prices/photos afterward via /enrich-candidate, and
    // the per-minute image drain backfills photos. Cache hits still return full
    // detail inline.
    let result = await scanPhoto(images, { supabase: caller.admin, fastScan: true });
    if (!result) {
      return NextResponse.json(
        { ok: false, error: 'no_identification' },
        { status: 422 },
      );
    }

    // ── Photo→ASIN enrichment ───────────────────────────────────────────────
    // When vision reads an ASIN (e.g. an Amazon return label) but the internal
    // lookup couldn't enrich it (no catalog/UPC hit → msrp still null), fetch
    // the Amazon page via the Web Unlocker and merge the richer data in —
    // mirroring the lookup-code route's ASIN escalation so photo == barcode.
    // Vision-only signals (condition, price-tag MSRP, captured photos) are kept.
    if (result.asin && isAsinCode(result.asin) && result.msrp == null) {
      const scraped = await resolveAsinIntoCatalog(caller.admin, result.asin);
      if (scraped) {
        const enriched = await lookupByCode(caller.admin, result.asin);
        if (enriched && enriched.product.confidence !== 'none') {
          const cat = productToCandidate(enriched.product);
          result = {
            ...cat,
            condition: result.condition || cat.condition,
            packagingMsrp: result.packagingMsrp ?? cat.packagingMsrp,
            stockPhotos: [
              ...new Set([...(cat.stockPhotos ?? []), ...(result.stockPhotos ?? [])]),
            ],
            description: cat.description || result.description,
            // Alternate identifications (2026-07-07) ride along — this merge
            // rebuilds the candidate from the catalog and would drop them.
            ...(result.alternates ? { alternates: result.alternates } : {}),
          };
        }
      }
    }

    return NextResponse.json({
      ok: true,
      data: result,
      meta: { cost_usd: capture.totalCostUsd() },
    });
  } catch (err) {
    console.error('[scan-photo] AI provider error:', err);
    return NextResponse.json(
      { ok: false, error: 'lottr_scan_failed', code: 'AI_PROVIDER_ERROR' },
      { status: 502 },
    );
  } finally {
    setTelemetrySink(BASELINE_SINK);
    // Must AWAIT inside finally — on Cloudflare Workers the isolate
    // is torn down as soon as the response is returned to the client,
    // killing any unresolved async work. JS spec guarantees this await
    // completes BEFORE the function actually returns the response, so
    // it's safe to block on this. Audit on 2026-05-13 found zero rows
    // in ai_calls after Worker cutover (2026-05-11) precisely because
    // the prior `void capture.persist(...)` raced the isolate teardown.
    await capture.persist({ operatorId: caller.operatorId, userId: caller.userId });
  }
}
