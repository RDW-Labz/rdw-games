// POST /api/lottr/enrich-lot  { importRowId: string }
//
// Look up a pending import_row and return a candidate enrichment
// WITHOUT saving. The operator reviews the result on the queue page and
// decides whether to apply it.
//
// Tier 1 strategy:
//   1. If the row has a UPC → lookupByUpc (cache → OpenRouter on miss).
//   2. Otherwise fall back to searchByKeyword(row.title) and return the
//      top hit (or null if no hits).
//
// AI fallback (lookupCode/fetchPrices) is intentionally not invoked
// here — Tier 2 is opt-in from the UI, not automatic, to keep cost
// predictable.
//
// Auth: cookie session (desktop UI) OR Bearer token (field-mobile).

import { lottingFetchHtml, lottingMirrorImage } from '@/lib/lotting-egress';
import { NextResponse } from 'next/server';
import {
  lookupByUpc,
  searchByKeyword,
  productToCandidate,
  enrichImages,
  setLottingConfig,
  hasLottingConfig,
  type LotCandidate,
} from '@auction-platform/domain-lotting';
import { verifyLottrAuth } from '@/lib/lottr-auth';
import { checkAiBudget } from '@/lib/ai-budget';

function ensureConfigured(): boolean {
  if (hasLottingConfig()) return true;
  const openrouterKey = process.env['OPENROUTER_API_KEY'];
  if (!openrouterKey) return false;

  // OpenRouter only. The legacy direct-Anthropic path (callAnthropic
  // in packages/domain-lotting/src/ai/pricing.ts) is unreachable from
  // any active route; setting anthropicKey here was a config-write
  // nothing read. Dropped 2026-05-11 alongside the Cloudflare cutover.
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

  let body: { importRowId?: string };
  try {
    body = (await req.json()) as { importRowId?: string };
  } catch {
    return NextResponse.json({ ok: false, error: 'bad_json' }, { status: 400 });
  }
  if (!body.importRowId) {
    return NextResponse.json({ ok: false, error: 'importRowId required' }, { status: 400 });
  }

  // RLS-scoped read: import_rows has staff-scoped policies, so the scoped
  // client only returns rows for caller.operatorId. The redundant .eq() on
  // operator_id was kept pre-§1.8 as defense-in-depth when this route used
  // the admin client (RLS-bypassing). With RLS now enforced, we drop the
  // redundant filter — it was wasteful and obscured intent.
  const { data: row, error: rowErr } = await caller.scopedClient
    .from('import_rows')
    .select('id, title, upc, external_code, status')
    .eq('id', body.importRowId)
    .maybeSingle();
  if (rowErr || !row) {
    return NextResponse.json({ ok: false, error: 'import_row_not_found' }, { status: 404 });
  }
  if (row['status'] !== 'pending') {
    return NextResponse.json(
      { ok: false, error: `cannot_enrich_${row['status']}` },
      { status: 409 },
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

  try {
    let candidate: LotCandidate | null = null;
    let meta: Record<string, unknown> = {};

    const code = ((row['upc'] as string | null) ?? (row['external_code'] as string | null) ?? '').trim();
    if (code && /^\d{8,14}$/.test(code)) {
      // SERVICE-ROLE INTENTIONAL: lookupByUpc → upsertLookup writes to
      // product_lookups on cache miss. RLS write policy is dropped; admin
      // is the only path that can populate the platform-shared cache.
      // See 0028_security_fixes.sql comments on product_lookups_staff_write.
      const result = await lookupByUpc(caller.admin, code);
      if (result && result.product.confidence !== 'none') {
        candidate = productToCandidate(result.product);
        meta = {
          fromCache: result.fromCache,
          stalePrices: result.stalePrices,
          sources: result.product.sources,
        };
      }
    }

    if (!candidate) {
      const title = (row['title'] as string | null)?.trim() ?? '';
      if (!title) {
        return NextResponse.json(
          { ok: false, error: 'no_lookup_handle' },
          { status: 422 },
        );
      }
      // SERVICE-ROLE INTENTIONAL: searchByKeyword on miss falls through
      // to OpenRouter web-search and upserts to product_lookups. Same
      // service-role rationale as the lookupByUpc branch above.
      const hits = await searchByKeyword(caller.admin, title, { minHits: 1, limit: 1 });
      if (!hits.length) {
        return NextResponse.json({ ok: false, error: 'no_match' }, { status: 404 });
      }
      candidate = productToCandidate(hits[0]!.product);
      meta = { fromCache: hits[0]!.product.upc !== '', sources: hits[0]!.product.sources };
    }

    // Stock-photo gap fill (June-4 P3). The web-lookup path (lookupByUpc /
    // searchByKeyword → productToCandidate) frequently returns stockPhotos=[]
    // because the cached catalog rows have no image_urls, so apply-enrichment
    // never writes a lot photo and the operator sees a photoless candidate.
    // Mirror the scanPhoto path (identification.ts): when we have a query
    // handle, run enrichImages (Open Food Facts first → $0 on UPC hit; Sonar
    // fallback; never throws) and merge before returning.
    if (
      candidate &&
      candidate.stockPhotos.length === 0 &&
      (candidate.upc || candidate.brand || candidate.title)
    ) {
      const extraPhotos = await enrichImages({
        brand: candidate.brand,
        model: candidate.model,
        title: candidate.title,
        upc: candidate.upc,
      }).catch(() => [] as string[]);
      if (extraPhotos.length > 0) {
        candidate = { ...candidate, stockPhotos: extraPhotos };
        meta = { ...meta, imagesEnriched: true };
        // Cache to the shared catalog so repeat lookups of this UPC are $0
        // (mirror identification.ts). Never clobber existing images.
        const cacheUpc = candidate.upc.trim();
        if (/^\d{8,14}$/.test(cacheUpc)) {
          await caller.admin
            .from('product_lookups')
            .update({ image_urls: extraPhotos })
            .eq('upc', cacheUpc)
            .or('image_urls.is.null,image_urls.eq.{}')
            .then(undefined, () => undefined);
        }
      }
    }

    return NextResponse.json({ ok: true, candidate, meta });
  } catch (err) {
    console.error('[enrich-lot] AI provider error:', err);
    return NextResponse.json(
      { ok: false, error: 'lottr_enrich_failed', code: 'AI_PROVIDER_ERROR' },
      { status: 502 },
    );
  }
}
