// POST /api/lottr/search-keyword  { query: string }
//
// Tier 1 keyword search. Hits product_lookups via trigram fuzzy match,
// falls through to OpenRouter web-search models if not enough warm hits.
// Returns up to 8 candidates with images + sold/asking prices, in
// LotCandidate shape so the existing save-draft endpoint works unchanged.
//
// Auth: cookie session (desktop UI) OR Bearer token (field-mobile).
// See lib/lottr-auth.ts for details.

import { lottingFetchHtml, lottingMirrorImage } from '@/lib/lotting-egress';
import { NextResponse } from 'next/server';
import {
  searchByKeyword,
  productToCandidate,
  setLottingConfig,
  hasLottingConfig,
} from '@auction-platform/domain-lotting';
import { verifyLottrAuth } from '@/lib/lottr-auth';
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

export async function POST(req: Request) {
  if (!ensureConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        error: 'OPENROUTER_API_KEY not configured on the server.',
      },
      { status: 503 },
    );
  }

  const caller = await verifyLottrAuth(req);
  if (!caller) {
    return NextResponse.json({ ok: false, error: 'not_authenticated' }, { status: 401 });
  }

  let body: { query?: string };
  try {
    body = (await req.json()) as { query?: string };
  } catch {
    return NextResponse.json({ ok: false, error: 'bad_json' }, { status: 400 });
  }
  const query = String(body.query ?? '').trim();
  if (!query) {
    return NextResponse.json({ ok: false, error: 'query required' }, { status: 400 });
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

  try {
    // SERVICE-ROLE INTENTIONAL: searchByKeyword can upsert to product_lookups
    // when warm-cache hits fall below minHits and OpenRouter is consulted.
    // RLS write policy was dropped for product_lookups in 0028_security_fixes.sql;
    // admin is the only path that can populate the platform-shared cache.
    const hits = await searchByKeyword(caller.admin, query, { minHits: 3, limit: 8 });
    return NextResponse.json({
      ok: true,
      hits: hits.map((h) => ({
        candidate: productToCandidate(h.product),
        upc: h.product.upc,
        sources: h.product.sources,
        cached: !!h.product.upc && !h.product.upc.startsWith('mpn:') && !h.product.upc.startsWith('ebay:'),
      })),
    });
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: (err as Error).message },
      { status: 502 },
    );
  }
}
