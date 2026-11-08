// POST /api/lottr/enrich-candidate  { candidate: LotCandidate }
//
// Lazy enrichment for AI-lotting Top-3 candidates. The photo scan returns a
// fully-enriched PRIMARY plus vision-only ALTERNATES (prices/stockPhotos/msrp
// blanked — see identification.ts). Eagerly enriching all three would ~3x the
// per-scan AI cost and slow the scan, so instead the staff app calls this
// endpoint ON DEMAND when a reviewer taps an alternate in the picker
// (2026-07-13 feedback: "the 2nd and 3rd matches are incomplete").
//
// Takes an in-memory LotCandidate (identity fields from vision) and returns it
// enriched with prices / msrp / avg / startBid / specs / stockPhotos, using the
// same building blocks as the primary path (lookupByUpc / searchByKeyword →
// productToCandidate, then enrichImages gap-fill). Identity fields from the
// live photo remain authoritative and are never overwritten by catalog data.
//
// This is enrich-lot/route.ts's internals with the input changed from an
// import_row id to a posted candidate.
//
// Auth: cookie session (desktop UI) OR Bearer token (field-mobile).

import { lottingFetchHtml, lottingMirrorImage } from '@/lib/lotting-egress';
import { NextResponse } from 'next/server';
import {
  lookupByUpc,
  searchByKeyword,
  productToCandidate,
  enrichImages,
  filterSafeImageUrls,
  setLottingConfig,
  hasLottingConfig,
  type LotCandidate,
} from '@auction-platform/domain-lotting';
import { verifyLottrAuth } from '@/lib/lottr-auth';
import { checkAiBudget } from '@/lib/ai-budget';

import { ensureCostEstimatorRegistered } from '@/lib/register-cost-estimator';
ensureCostEstimatorRegistered();

function ensureConfigured(): boolean {
  if (hasLottingConfig()) return true;
  const openrouterKey = process.env['OPENROUTER_API_KEY'];
  if (!openrouterKey) return false;
  // OpenRouter only — see enrich-lot/route.ts comment. Retailer page-fetches
  // (stock images + prices) route through the unblocked egress chain.
  setLottingConfig({ openrouterKey, fetchHtml: lottingFetchHtml, mirrorImage: lottingMirrorImage });
  return true;
}

export async function POST(req: Request) {
  if (!ensureConfigured()) {
    return NextResponse.json(
      { ok: false, error: 'OPENROUTER_API_KEY not configured on the server.' },
      { status: 503 },
    );
  }

  const caller = await verifyLottrAuth(req);
  if (!caller) {
    return NextResponse.json({ ok: false, error: 'not_authenticated' }, { status: 401 });
  }

  let body: { candidate?: LotCandidate };
  try {
    body = (await req.json()) as { candidate?: LotCandidate };
  } catch {
    return NextResponse.json({ ok: false, error: 'bad_json' }, { status: 400 });
  }
  const incoming = body.candidate;
  if (!incoming || typeof incoming !== 'object') {
    return NextResponse.json({ ok: false, error: 'candidate required' }, { status: 400 });
  }

  // A lookup handle is required: a UPC, or enough identity text to keyword-search.
  const upc = (incoming.upc ?? '').trim();
  const keywordQuery = [incoming.brand, incoming.model, incoming.title]
    .map((s) => (s ?? '').trim())
    .filter(Boolean)
    .join(' ')
    .trim();
  if (!/^\d{8,14}$/.test(upc) && !keywordQuery) {
    return NextResponse.json({ ok: false, error: 'no_lookup_handle' }, { status: 422 });
  }

  // ── Pre-call budget enforcement (mirrors enrich-lot / search-keyword) ──
  try {
    await checkAiBudget(caller.operatorId);
  } catch (err) {
    if ((err as Error).message === 'ai_budget_exceeded') {
      return NextResponse.json({ ok: false, error: 'ai_budget_exceeded' }, { status: 402 });
    }
    throw err;
  }

  try {
    let enriched: LotCandidate | null = null;
    let meta: Record<string, unknown> = {};

    if (/^\d{8,14}$/.test(upc)) {
      // SERVICE-ROLE INTENTIONAL: lookupByUpc → upsertLookup writes to
      // product_lookups on cache miss (RLS write policy dropped in 0028).
      const result = await lookupByUpc(caller.admin, upc, {
        hints: { title: incoming.title, brand: incoming.brand, model: incoming.model },
      });
      if (result && result.product.confidence !== 'none') {
        enriched = productToCandidate(result.product);
        meta = {
          fromCache: result.fromCache,
          stalePrices: result.stalePrices,
          sources: result.product.sources,
        };
      }
    }

    if (!enriched && keywordQuery) {
      // SERVICE-ROLE INTENTIONAL: searchByKeyword upserts on miss (same as above).
      const hits = await searchByKeyword(caller.admin, keywordQuery, { minHits: 1, limit: 1 });
      if (hits.length) {
        enriched = productToCandidate(hits[0]!.product);
        meta = { fromCache: hits[0]!.product.upc !== '', sources: hits[0]!.product.sources };
      }
    }

    // Merge: keep the vision identity (authoritative — the reviewer is looking
    // at the live photo), overlay price/image fields from enrichment. Mirrors
    // the primary merge in identification.ts:464-502.
    let candidate: LotCandidate = enriched
      ? {
          ...incoming,
          // identity stays from the incoming (vision) candidate
          upc: incoming.upc || enriched.upc,
          prices: enriched.prices,
          stockPhotos: enriched.stockPhotos,
          msrp: enriched.msrp,
          avg: enriched.avg,
          startBid: enriched.startBid,
          specs: enriched.specs,
          fullTitle: enriched.fullTitle || enriched.title || incoming.title,
          ...(enriched.asin ? { asin: enriched.asin } : {}),
          ...(enriched.fnsku ? { fnsku: enriched.fnsku } : {}),
          ...(enriched.lpn ? { lpn: enriched.lpn } : {}),
        }
      : { ...incoming };

    // Stock-photo gap fill — the catalog rows often carry no image_urls, so
    // productToCandidate returns stockPhotos=[]. Run enrichImages (Open Food
    // Facts first → $0 on UPC hit; Sonar fallback; never throws) and cache back.
    if (
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

    // Defense-in-depth: the candidate crossed the wire, so re-filter any image
    // URLs through the host allowlist before returning (mirror save-draft).
    candidate = { ...candidate, stockPhotos: filterSafeImageUrls(candidate.stockPhotos) };

    if (!enriched && candidate.stockPhotos.length === 0) {
      // Nothing found and no image — tell the client so it can leave the
      // candidate as-is rather than showing a spurious "enriched" state.
      return NextResponse.json({ ok: false, error: 'no_match', candidate }, { status: 404 });
    }

    return NextResponse.json({ ok: true, candidate, meta });
  } catch (err) {
    console.error('[enrich-candidate] AI provider error:', err);
    return NextResponse.json(
      { ok: false, error: 'lottr_enrich_failed', code: 'AI_PROVIDER_ERROR' },
      { status: 502 },
    );
  }
}
