// POST /api/lottr/lookup-code  { code: string }
//
// Tier 1 server-side lookup. Reads product_lookups; on miss, fetches
// from OpenRouter web-search models (Perplexity Sonar) and upserts.
// AI-free from the caller's perspective — the LLM call is encapsulated
// inside domain-lotting/lookup/index.ts.
//
// Returns the same { ok, candidate, meta } shape callers expect.
// `candidate` is mapped from ProductLookup via productToCandidate().
// `meta.cost_usd` is 0 on cache hits (no AI call); non-zero on misses.
//
// Auth: cookie session (desktop UI) OR Bearer token (field-mobile).
// See lib/lottr-auth.ts for details.
//
// Cost tracking: same sink-stack approach as scan-photo. For lookup-code
// the telemetry event only fires on cache MISS (when the Perplexity Sonar
// web-search model runs). Cache hits return cost_usd: 0 and fromCache: true
// — the mobile client's HUD can distinguish the two.

import { lottingFetchHtml, lottingMirrorImage } from '@/lib/lotting-egress';
import { NextResponse } from 'next/server';
import {
  lookupByCode,
  searchByKeyword,
  productToCandidate,
  setLottingConfig,
  hasLottingConfig,
  isValidGtinCheckDigit,
} from '@auction-platform/domain-lotting';
import { resolveAsinIntoCatalog, isAsinCode } from '@/lib/catalog/resolve-asin';
import { setTelemetrySink } from '@auction-platform/domain-lotting/ai';
import { startAiCallCapture } from '@/lib/ai-call-log';
import type { LlmTelemetrySink } from '@auction-platform/domain-lotting/ai';
import { verifyLottrAuth } from '@/lib/lottr-auth';
import { checkAiBudget } from '@/lib/ai-budget';
import { catalogRefusal } from '@/lib/catalog-refusal';

import { ensureCostEstimatorRegistered } from '@/lib/register-cost-estimator';
ensureCostEstimatorRegistered();

function ensureConfigured(): boolean {
  if (hasLottingConfig()) return true;
  const openrouterKey = process.env['OPENROUTER_API_KEY'];
  if (!openrouterKey) return false;

  // OpenRouter only — see enrich-lot/route.ts comment. The "Tier 2
  // AI fallback" the old comment referenced was the legacy
  // callAnthropic() path which no active route uses.
  // 2026-07-10: route retailer page-fetches (stock images + prices)
  // through the unblocked egress chain — see lib/lotting-egress.ts.
  setLottingConfig({ openrouterKey, fetchHtml: lottingFetchHtml, mirrorImage: lottingMirrorImage });
  return true;
}

const BASELINE_SINK: LlmTelemetrySink = () => {
  /* no-op */
};

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

  let body: { code?: string; fast?: boolean };
  try {
    body = (await req.json()) as { code?: string; fast?: boolean };
  } catch {
    return NextResponse.json({ ok: false, error: 'bad_json' }, { status: 400 });
  }
  const code = String(body.code ?? '').trim();
  // fast (2026-08-07): the interactive Quick Lot scan wants a cache-only
  // answer so staff aren't held at the "Looking up…" overlay for a live web
  // lookup. scan-photo has done this since 2026-07-13 via `fastScan`, and
  // `LookupOptions.cacheOnly` documents the contract — "the miss is enriched
  // in the background afterward" — but the BARCODE route never opted in, so
  // every catalog miss paid Sonar (p50 2.6 s / p95 6.1 s) plus the Bright
  // Data escalation inline. OPT-IN, not the default: the operator-web batch
  // classifier (lottr/batch/BatchUpcClassifier.tsx) posts here too and does
  // want the slow, thorough path.
  const fast = body.fast === true;
  if (!code) {
    return NextResponse.json({ ok: false, error: 'code required' }, { status: 400 });
  }

  // ── FNSKU short-circuit — server-side kill for the 2026-09-21 misfire ──────
  // An Amazon FNSKU (X0 + 8 alphanumerics, e.g. X004Z9D5K5) is an internal
  // license-plate label with no public product page and no catalog identity.
  // Looking one up here invents an unrelated product: on 2026-09-21 the FNSKU
  // X004Z9D5K5 (a handheld fan) returned "New Balance 574, $99.99" via the
  // keyword rung and auto-created on the floor. `isAsinCode` matches only
  // B0-ASINs, so FNSKUs slipped past every existing guard.
  //
  // A legitimate FNSKU scan is resolved against the manifest by
  // find_import_row_by_scan, never through this catalog route — so refusing it
  // here removes nothing real. Returning no_match WITHOUT `cacheMiss` also
  // stops the client's background enrichment pass, and short-circuiting BEFORE
  // the cache read means a previously poisoned product_lookups row can't be
  // served either. This is the server-side twin of the field-app guard (#353):
  // it protects every phone at once, including those that have not yet taken
  // that OTA. Typed keywords/models never match this shape; real ASIN and UPC
  // scans are unaffected.
  if (/^X0[0-9A-Z]{8}$/i.test(code)) {
    return NextResponse.json(
      { ok: false, error: 'no_match', options: ['url_import', 'photo', 'manual'] },
      { status: 404 },
    );
  }

  // ── Carrier-label short-circuit — server-side kill, 2026-09-24 ────────────
  // A FedEx 12-digit tracking number is UPC-A length, and lookupByCode's UPC
  // test is length-only, so a tracking-number scan that missed the manifest
  // went to Sonar and got an invented product cached for it (16 such rows in
  // product_lookups; "Doritos" for a Roman shade). The non-GTIN guard further
  // down ran only after lookupByCode. See lib/catalog-refusal.ts.
  //
  // Same contract as the FNSKU kill above: BEFORE the cache read (so a poisoned
  // row can't be served), no_match WITHOUT `cacheMiss` (so the client's
  // background enrichment doesn't retry it), and for every phone at once. The
  // manifest check runs as the caller (import_rows_staff_read, own operator)
  // on the tracking_number index.
  const refusal = await catalogRefusal(code, async (c) => {
    const { data, error } = await caller.scopedClient
      .from('import_rows')
      .select('id')
      .eq('tracking_number', c)
      .limit(1);
    if (error) throw error;
    return (data?.length ?? 0) > 0;
  });
  if (refusal) {
    return NextResponse.json(
      {
        ok: false,
        error: 'no_match',
        reason: refusal,
        options: ['url_import', 'photo', 'manual'],
      },
      { status: 404 },
    );
  }

  // ── 0085: Pre-call budget enforcement ────────────────────────────────────
  // lookup-code may hit cache (free) or OpenRouter (billed). We check
  // budget optimistically before dispatching; cache hits won't spend the
  // anticipated 50¢ but it's better to be conservative.
  try {
    await checkAiBudget(caller.operatorId);
  } catch (err) {
    if ((err as Error).message === 'ai_budget_exceeded') {
      return NextResponse.json({ ok: false, error: 'ai_budget_exceeded' }, { status: 402 });
    }
    throw err;
  }

  // ── Per-request cost capture (0061: persisted to ai_calls) ───────────────
  // On a cache hit, capture.events stays empty and we record a single
  // cached=true row. On a cache miss, the Sonar web-search model
  // emits a real event and we batch-insert.
  const capture = startAiCallCapture();
  setTelemetrySink(capture.sink);

  let wasFromCache = false;
  try {
    // SERVICE-ROLE INTENTIONAL: lookupByCode writes to product_lookups on
    // cache miss. 0028_security_fixes.sql dropped product_lookups_staff_write
    // to prevent any operator's staff (including pickers) from poisoning the
    // platform-shared cache. All writes must go through the admin client.
    // Reads via the scoped client would also work (product_lookups_authed_read
    // covers any authed user), but the cache-miss upsert needs admin.
    let result = await lookupByCode(caller.admin, code, { cacheOnly: fast });

    // ── Miss escalation: Bright Data before giving up ──────────────────────
    // A non-UPC miss (ASIN/FNSKU/LPN/model) used to dead-end here. Now an ASIN
    // is fetched straight from its Amazon page via the Web Unlocker, and a UPC /
    // model / keyword runs SERP (Google Shopping) + Sonar. Each resolved miss is
    // written to the catalog, so it's a one-time cost per item. FNSKU/LPN have
    // no public page — they fall through to the manual options below.
    // Guard against non-product barcodes (2026-07-08 incident): a bare numeric
    // string that is NOT a valid GTIN (fails the GS1 check digit) is almost
    // certainly a carrier/shipping barcode — a FedEx tracking number, an SSCC,
    // an internal label — not a UPC. Free-text/AI-searching it returns arbitrary
    // catalog products (a FedEx label pulled up "Beats"). Skip every escalation
    // for such codes and return no_match so staff fall back to manual entry.
    // Real retail scans (valid GTIN) and typed keywords/models (contain
    // non-digits) still escalate as before.
    const isBareNumeric = /^\d+$/.test(code);
    const isNonProductBarcode = isBareNumeric && !isValidGtinCheckDigit(code);

    if ((!result || result.product.confidence === 'none') && !isNonProductBarcode && !fast) {
      if (isAsinCode(code)) {
        if (await resolveAsinIntoCatalog(caller.admin, code)) {
          result = await lookupByCode(caller.admin, code);
        }
      } else {
        const hits = await searchByKeyword(caller.admin, code, { minHits: 1, limit: 3 });
        const best = hits.find((h) => h.product.title && h.product.confidence !== 'none');
        if (best) {
          return NextResponse.json({
            ok: true,
            candidate: productToCandidate(best.product),
            meta: {
              fromCache: false,
              stalePrices: false,
              sources: best.product.sources,
              cost_usd: capture.totalCostUsd(),
              matchedIdentifiers: {
                upc: best.product.upc,
                asin: best.product.asin ?? undefined,
              },
            },
          });
        }
      }
    }

    if (!result || result.product.confidence === 'none') {
      // Every automatic rung missed. The client surfaces these manual paths:
      // paste a product URL (cached scraper), photo-identify, or hand-enter.
      // On the fast path this is a CACHE miss, not a definitive no-match — the
      // web rungs were skipped, not tried — so tell the client, which then
      // enriches in the background instead of dead-ending the operator.
      return NextResponse.json(
        {
          ok: false,
          error: 'no_match',
          options: ['url_import', 'photo', 'manual'],
          ...(fast ? { cacheMiss: true } : {}),
        },
        { status: 404 },
      );
    }
    wasFromCache = !!result.fromCache;
    return NextResponse.json({
      ok: true,
      candidate: productToCandidate(result.product),
      meta: {
        fromCache: result.fromCache,
        stalePrices: result.stalePrices,
        sources: result.product.sources,
        cost_usd: capture.totalCostUsd(),
        // Surface which identifier type matched so the UI can display context.
        matchedIdentifiers: {
          upc: result.product.upc,
          asin: result.product.asin ?? undefined,
          fnsku: result.product.fnsku ?? undefined,
          lpn: result.product.lpn ?? undefined,
          mpn: result.product.mpn ?? undefined,
        },
      },
    });
  } catch (err) {
    console.error('[lookup-code] AI provider error:', err);
    return NextResponse.json(
      { ok: false, error: 'lottr_lookup_failed', code: 'AI_PROVIDER_ERROR' },
      { status: 502 },
    );
  } finally {
    setTelemetrySink(BASELINE_SINK);
    // AWAIT — see comment in scan-photo/route.ts. Cloudflare Workers
    // kill the isolate at response time; unresolved I/O is lost.
    await capture.persist({
      operatorId: caller.operatorId,
      userId: caller.userId,
      cached: wasFromCache,
    });
  }
}
