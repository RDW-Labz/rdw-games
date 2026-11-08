// Photo-based product identification.
//
//   scanPhoto(base64, mediaType, opts?)
//     Two-step pipeline: cheap vision identification via OpenRouter (Gemini
//     Flash → Haiku 4.5 → Sonnet 4.6 escalation), then cache + Sonar price
//     enrichment. Callers without opts.supabase fall back to the legacy
//     single-call Anthropic web-search path.
//
//     Cost model:
//       Gemini Flash vision:    ~$0.001
//       Haiku 4.5 escalation:   ~$0.005 (only if confidence < 0.65)
//       Sonnet 4.6 escalation:  ~$0.015 (rarely)
//       Cache hit on UPC:       $0
//       Sonar fallback:         ~$0.006-0.013
//       Avg cost:               ~$0.005-0.015 per scan
//
//   identifyPhoto(base64, mediaType)
//     Vision-only primitive. No prices, no enrichment. Uses the photo_identify
//     task (Gemini Flash by default, escalates on low confidence). Callable
//     standalone when you will batch-fetch prices later by UPC.

import type { SupabaseClient } from '@supabase/supabase-js';
import { CONDITIONS } from '../constants';
import type { Identification, LotCandidate } from '../types';
import { complete } from './llm';
import { normalizeIdentification } from './normalize';
import { lookupByUpc, searchByKeyword } from '../lookup';
import { productToCandidate } from '../lookup/to-candidate';
import { normalizeUpc } from '../normalize/upc';
import { enrichImages } from './image-enrich';

// ---------------------------------------------------------------------------
// Vision-only identification prompt
// ---------------------------------------------------------------------------
//
// Stripped of all web-search/pricing references. The prompt preserves
// the OCR-first emphasis from the original scanPhoto because the user
// confirmed that quality is good — only cost needs to drop.

// (Subcategory tree removed from the vision prompt 2026-05-14 — the AI
// now returns a free-form category guess, and the normalizer maps it to
// our taxonomy via INVENTED_CATEGORY_REMAP. Saves ~130 lines of prompt
// bulk that was hurting JSON discipline on smaller models.)
//
// 2026-05-15: VISION_PROMPT cut from 95 lines → ~28 lines after the
// prompt-A/B smoke matrix (scripts/lottr-smoke/prompt-ab.mjs) measured:
//
//   - 4 separate hallucinations on the 95-line "Production" prompt
//     across 4 real intake images. Three of the four were the "model"
//     field filled with batch/lot codes (MOFDBT559, etc.) when no real
//     manufacturer model was visible. The "MANUFACTURER MODEL — THIS
//     IS WHAT WE NEED MOST" emphasis was actively pushing the model
//     to invent values.
//   - The "(Pricing is handled in a later pipeline step — DO NOT try
//     to read or guess a price)" prohibition was throwing signal away.
//     Real test: a candle with a visible "$26.95" sticker yielded
//     msrp_guess_cents: 2695 on 5/6 cells with the cut prompt, 0/3
//     with the old prompt.
//   - Qwen 3.6 Plus (a reasoning model) burned 2,035 reasoning tokens
//     just satisfying the old prompt's constraint cascade — 4× more
//     than the cut prompt — and still mis-placed the model field.
//   - The cut prompt holds across 4 vision models tested (Gemini 3.1
//     Flash Lite, Gemini 3 Flash, Qwen 3.6 Plus, Claude Haiku 4.5).
//
// Surface changes from the old prompt → new:
//   - Dropped `model` field (the hallucination magnet — observed on
//     every prompt that exposed it). Real manufacturer models still
//     land in the title because the prompt asks for "brand + product
//     name + variant". The downstream normalizer's MODEL_TOKEN_RE
//     in merge.ts already extracts SKU-shaped tokens from titles.
//   - Added `msrp_guess_cents` for visibly-printed prices (MSRP
//     stickers, "List $X", retailer price tags). null when not
//     printed. Merges in as Tier 0 MSRP signal.
//   - Dropped `subcategory`, dropped dual `confidence` + `confidence_score`
//     (kept score only; normalizer accepts both for back-compat).
//   - Removed retailer-by-retailer model examples, screaming
//     ALL-CAPS rules, and the GOOD/BAD example block — none of them
//     improved measured outputs and they materially increase
//     reasoning-token consumption on Qwen-class models.

const VISION_PROMPT = `You are a product identification expert for a liquidation auction house.
You may receive 1-3 photos of the same product. Use ALL of them to read
text and identify the item.

Read every visible string on labels, packaging, and the product itself.
Pay attention to:
- Brand names and full product names as printed
- Manufacturer model / SKU / part numbers (nameplates, spec labels, near the barcode)
- Amazon FNSKU: X + digit + 8 alphanum (e.g. X0046QHSX7) — on FBA labels
- Amazon ASIN: B + digit + 8 alphanum (e.g. B0DK7R7KWV)
- UPC/EAN barcodes: 8, 12, 13, or 14 digits
- Specs (voltage, capacity, dimensions, count)

If no useful text is visible, identify the product from visual features
(shape, color, recognizable brand styling).

Return ONLY this JSON object — no prose, no markdown fences:
{
  "visibleText": ["every readable string from the image"],
  "title": "Brand + Full Product Name + Key Variant",
  "brand": "Brand name, or empty string",
  "model": "Manufacturer model / SKU / part number EXACTLY as printed (e.g. 'DCD771C2', 'Item # 1234567'), else empty string. NEVER an ASIN/FNSKU/UPC or a lot/batch code.",
  "upc": "12-14 digit UPC/EAN if visibly read, else empty string",
  "asin": "Amazon ASIN if visibly read, else empty string",
  "fnsku": "Amazon FNSKU if visibly read, else empty string",
  "category": "Free-form product type (e.g. 'Party Supplies', 'Power Tools')",
  "condition": "EXACTLY one of: ${CONDITIONS.join(', ')}",
  "description": "2-3 sentence auction listing summary",
  "confidence_score": 0.0,
  "notes": "Damage, missing parts, partial labels, etc.",
  "alternates": [
    {"title": "Brand + Product Name + Variant", "brand": "", "model": "Manufacturer model / SKU / part number EXACTLY as printed, else empty string. NEVER an ASIN/FNSKU/UPC.", "upc": "", "category": "", "condition": "EXACTLY one of: ${CONDITIONS.join(', ')}", "msrp_guess_cents": 0, "description": "2-3 sentence auction listing summary", "confidence_score": 0.0}
  ]
}

alternates: list up to 4 OTHER plausible identifications, best first, each
meaningfully different from the main answer (different product/variant, not
a reworded title). ALWAYS provide at least 2 alternates unless
confidence_score >= 0.9 AND you literally read an exact identifier (UPC/
model number) in the image — warehouse staff pick from this list when the
main answer is wrong, so a missing list means a wrong answer costs a relist.
Return [] only for that certain-identifier case. Do NOT invent filler that
is just a reworded main answer.

Hard rule: upc/asin/fnsku must be values you LITERALLY READ in the image.
Empty string is correct when not visible. Never guess these from memory.

Pricing: do NOT extract any price from the photo. MSRP and asking prices
come from a separate retailer-lookup step downstream. ~90% of intake
items have no visible price tag anyway; trying to surface one here
either fabricates a guess (bad) or wastes a JSON field (also bad).`;

// ---------------------------------------------------------------------------
// identifyPhoto — vision-only primitive (no prices)
// ---------------------------------------------------------------------------

/**
 * Vision-only identification. Accepts either a single base64 image or an
 * array of 1-3 angles of the same product. complete() builds one multimodal
 * user message with all images attached; the prompt is unchanged because
 * the AI naturally reads multi-image input as "different views of the same
 * thing" and aggregates the visible text across all of them.
 */
export async function identifyPhoto(
  base64OrImages: string | Array<{ base64: string; mediaType: string }>,
  mediaType?: string,
): Promise<Identification | null> {
  const images: Array<{ base64: string; mediaType: string }> =
    typeof base64OrImages === 'string'
      ? [{ base64: base64OrImages, mediaType: mediaType ?? 'image/jpeg' }]
      : base64OrImages;

  const parsed = await complete({
    task: 'photo_identify',
    schema: 'json',
    images,
    messages: [{ role: 'user', content: VISION_PROMPT }],
  });

  return normalizeIdentification(parsed);
}

// ---------------------------------------------------------------------------
// scanPhoto — two-step pipeline
// ---------------------------------------------------------------------------

export async function scanPhoto(
  base64OrImages: string | Array<{ base64: string; mediaType: string }>,
  mediaTypeOrOpts: string | { supabase: SupabaseClient; fastScan?: boolean },
  maybeOpts?: { supabase: SupabaseClient; fastScan?: boolean },
): Promise<LotCandidate | null> {
  // Track A #4 cleanup: legacyScanPhoto (Anthropic direct + web_search,
  // ~$0.017 per call, bypassed every cost gate in this file) was removed
  // along with this function's no-supabase fallback path. opts.supabase
  // is now TS-required so the eval harness / future call sites can't
  // accidentally fall into the legacy expensive path. To run against
  // a service-role client in scripts, pass getSupabaseAdmin() from
  // operator-web's lib, or instantiate one directly from the
  // @supabase/supabase-js package.

  // Backwards-compatible signature: old callers pass (base64, mediaType,
  // {supabase}); new callers pass (images[], {supabase}).
  const images: Array<{ base64: string; mediaType: string }> =
    typeof base64OrImages === 'string'
      ? [{
          base64: base64OrImages,
          mediaType: typeof mediaTypeOrOpts === 'string' ? mediaTypeOrOpts : 'image/jpeg',
        }]
      : base64OrImages;
  const opts =
    typeof mediaTypeOrOpts === 'string'
      ? (maybeOpts as { supabase: SupabaseClient; fastScan?: boolean })
      : mediaTypeOrOpts;
  const { supabase } = opts;
  // fastScan (2026-07-13): the interactive scan defers the slow web passes
  // (Sonar price lookup on cache miss + the URL-Finder image pass) so the
  // review card appears in ~vision-ID time. Cache hits still return full
  // detail inline; misses are enriched in the background afterward.
  const fastScan = Boolean(opts.fastScan);

  // ── Step 1: Vision identification ────────────────────────────────────────
  // Multi-angle vision: complete() attaches each image as its own
  // image_url content part, capped at 3 inside complete(). Operators
  // shooting a hero + condition shots get richer OCR coverage in one
  // call (label closeups + front-of-box etc.). Single-image callers
  // pass a string; complete() handles both shapes.
  const visionRaw = await complete({
    task: 'photo_identify',
    schema: 'json',
    images,
    messages: [{ role: 'user', content: VISION_PROMPT }],
  });

  if (!visionRaw) return null;

  const identification = normalizeIdentification(visionRaw);
  if (!identification) return null;

  const visibleText: string[] = Array.isArray(visionRaw['visibleText'])
    ? (visionRaw['visibleText'] as unknown[]).map(String)
    : [];

  // ── Alternate identifications (Jared recap 2026-07-07) ────────────────
  // The prompt asks for up to 4 other plausible products when the photo is
  // ambiguous. Normalize each through the same pipeline as the primary
  // (category remap, condition validation) and carry them as vision-only
  // LotCandidates — NO enrichment (cost: the primary's enrichment already
  // runs; the operator's pick can be enriched via the existing lookup
  // paths). Alternates whose title matches the primary are dropped.
  const alternates: LotCandidate[] = [];
  if (Array.isArray(visionRaw['alternates'])) {
    for (const raw of (visionRaw['alternates'] as unknown[]).slice(0, 4)) {
      if (!raw || typeof raw !== 'object') continue;
      const norm = normalizeIdentification(raw as Record<string, unknown>);
      if (!norm || !norm.title) continue;
      if (norm.title.trim().toLowerCase() === (identification.title ?? '').trim().toLowerCase()) {
        continue;
      }
      alternates.push({
        ...norm,
        prices: [],
        stockPhotos: [],
        msrp: null,
        avg: null,
        startBid: null,
        fullTitle: norm.title,
        specs: '',
      });
    }
  }
  const alternatesProp = alternates.length > 0 ? { alternates } : {};

  // ── Extract structured codes ──────────────────────────────────────────
  // Two paths, in priority order:
  //   1. The vision prompt asks the AI for asin / fnsku fields with format
  //      guidance. When the AI answers them correctly, we use those values
  //      directly — no regex needed; the prompt's format rules already
  //      validated them.
  //   2. Fallback: scan visibleText for asin / fnsku patterns. Catches
  //      cases where the AI saw the code, listed it in visibleText, but
  //      didn't fill the dedicated field.
  //
  // LPN is intentionally NOT extracted by AI scan. LPNs are per-physical-
  // unit return labels that operators upload via QuickLot manifest scan,
  // not photo identification — including them in the AI flow led to the
  // model inventing LPN-shaped strings out of arbitrary OCR fragments
  // (observed 2026-05-13). LPN stays in the LotCandidate type, just
  // empty after AI scans.

  // Path 1: explicit AI-extracted identifiers
  const asinFromAi = typeof visionRaw['asin'] === 'string'
    ? visionRaw['asin'].trim().toUpperCase()
    : '';
  const fnskuFromAi = typeof visionRaw['fnsku'] === 'string'
    ? visionRaw['fnsku'].trim().toUpperCase()
    : '';

  // Validate the AI's answers against their declared format.
  const ASIN_RE = /^B[0-9][A-Z0-9]{8}$/;
  const FNSKU_RE = /^X[0-9][A-Z0-9]{8}$/;
  let extractedAsin: string | null = ASIN_RE.test(asinFromAi) ? asinFromAi : null;
  let extractedFnsku: string | null = FNSKU_RE.test(fnskuFromAi) ? fnskuFromAi : null;

  // Path 2: visibleText regex fallback when path 1 didn't produce a hit.
  if (!extractedAsin || !extractedFnsku) {
    for (const raw of visibleText) {
      const s = raw.trim().toUpperCase();
      if (!extractedAsin && ASIN_RE.test(s)) extractedAsin = s;
      if (!extractedFnsku && FNSKU_RE.test(s)) extractedFnsku = s;
      if (extractedAsin && extractedFnsku) break;
    }
  }

  // ── Cost gate: bail out only when there's NOTHING to look up with ─────
  // Original gate (2026-05-10) skipped all enrichment whenever vision
  // confidence was "low" or "none", to avoid the $0.017 McDonald's-Sprite
  // scenario. That was too aggressive: a blurry shot of a real product
  // can return low vision-confidence but still expose a UPC/ASIN/FNSKU
  // in the OCR or a brand+model in the title — all of which can hit the
  // cache for $0 OR drive a Sonar lookup that returns MSRP + retail
  // pricing. Skipping enrichment on those threw away the most valuable
  // data points the operator needs (per user feedback 2026-05-13).
  //
  // New rule: only short-circuit when BOTH vision confidence is low/none
  // AND there's no actionable identifier — no UPC, no ASIN/FNSKU from
  // OCR, no brand+model in identification. That preserves the original
  // McDonald's-cup savings (cup has no UPC, no model, vague brand) while
  // letting a low-confidence DeWalt scan still get enriched if "DCD771C2"
  // appeared in visibleText.
  //
  // Cost envelope unchanged for the cup case (~$0.0003); restored for
  // actionable-but-blurry items (~$0.006-0.013 with Sonar hit).
  const rawConfidence = (identification as { confidence?: string }).confidence ?? '';
  const lowConfidence = rawConfidence === 'low' || rawConfidence === 'none' || rawConfidence === '';
  const hasActionableId =
    Boolean(normalizeUpc(identification.upc)) ||
    Boolean(extractedAsin) ||
    Boolean(extractedFnsku) ||
    (Boolean(identification.brand) && Boolean(identification.model));
  if (lowConfidence && !hasActionableId) {
    return {
      ...identification,
      visibleText,
      prices: [],
      stockPhotos: [],
      msrp: null,
      avg: null,
      startBid: null,
      fullTitle: identification.title,
      specs: '',
      ...alternatesProp,
    };
  }

  // ── Step 2: Price + image enrichment ─────────────────────────────────────
  // UPC path is $0 on cache hit. Sonar is only called on cache miss.
  // Keyword path is also cache-first via trigram search.
  let enriched: LotCandidate | null = null;

  const validUpc = normalizeUpc(identification.upc);
  if (validUpc) {
    // UPC found — direct lookup. Pass the vision-extracted title/brand/
    // model as hints so a cache-miss Sonar query gets a richer string
    // than the bare 12-digit UPC. Sonar performs much better on
    // "DeWalt DCD771C2 20V drill, UPC 885911540858" than on
    // "885911540858" alone. Cache hits ignore hints (the cached row
    // already has richer data).
    const lookupResult = await lookupByUpc(supabase, validUpc, {
      cacheOnly: fastScan,
      hints: {
        title: identification.title || undefined,
        brand: identification.brand || undefined,
        model: identification.model || undefined,
      },
    }).catch(() => null);
    if (lookupResult?.product) {
      enriched = productToCandidate(lookupResult.product);
    }
  } else if (identification.title) {
    // No UPC but the vision step is at least medium-confidence — try
    // the keyword search. searchByKeyword is cache-first; only calls
    // AI when trgm returns fewer than minHits matches. Bumped minHits
    // to 3 (from 1) so even a single fuzzy local hit defers the AI
    // fallback — we want medium-confidence items to lean on cache,
    // not pay $0.006 for a Sonar call that might not return better
    // data than what trgm already has.
    const query = [identification.brand, identification.model, identification.title]
      .filter(Boolean)
      .join(' ')
      .trim();
    if (query) {
      const hits = await searchByKeyword(supabase, query, {
        minHits: 3,
        limit: 3,
        cacheOnly: fastScan,
      }).catch(() => [] as Awaited<ReturnType<typeof searchByKeyword>>);
      if (hits.length > 0 && hits[0]?.product) {
        enriched = productToCandidate(hits[0].product);
      }
    }
  }

  // ── Step 2.5: Image enrichment (C2) ───────────────────────────────────────
  // The catalog scrape captured 0 image_urls across 187k rows, so enriched
  // candidates very often come back with stockPhotos=[]. Sonar's price
  // search also rarely returns image URLs. Make ONE small, dedicated Sonar
  // call here when stockPhotos is empty AND we have enough identity to
  // search effectively (brand/model/title or UPC). Already gated on
  // `lowConfidence` above (we return early before reaching this code),
  // so by here we're at medium or high — both worth the ~$0.006 Sonar
  // image search since the identification is plausible.
  let extraStockPhotos: string[] = [];
  // Always try enrichment when we don't already have stock photos, as
  // long as we have SOMETHING to query with. Open Food Facts is free
  // and instant (UPC lookup → JSON), so the worst case for a UPC scan
  // is $0. Sonar fallback (~$0.006) only fires on OFF miss + non-empty
  // query — and per user feedback (2026-05-13) we'd rather pay for the
  // image search than ship lots with no stock photo. The previous gate
  // required brand+model OR brand+title; relaxed here so a title-only
  // identification (no brand in dictionary, no model in title) still
  // gets a Sonar attempt.
  const needImages =
    (!enriched || enriched.stockPhotos.length === 0) &&
    (Boolean(identification.upc) ||
      Boolean(identification.brand) ||
      Boolean(identification.title));
  if (needImages) {
    extraStockPhotos = await enrichImages({
      brand: identification.brand,
      model: identification.model,
      title: identification.title,
      upc: identification.upc || enriched?.upc || null,
      // The vision description names the true color; pass it so the same-product
      // gate rejects wrong-color stock images (2026-07-13).
      description: identification.description,
      // fastScan: OFF-only inline; defer the slow URL-Finder pass to background.
      skipWebSearch: fastScan,
    }).catch(() => []);

    // Best-effort cache: if we have a UPC and got non-empty images, persist
    // to product_lookups.image_urls so the next lookup is $0. Only update
    // when image_urls is currently empty to avoid clobbering hand-curated
    // images. RPC pattern would be cleaner but a direct UPDATE is fine —
    // RLS for product_lookups allows authenticated read+write under the
    // operator's session.
    const cacheUpc = normalizeUpc(identification.upc || enriched?.upc || '');
    if (cacheUpc && extraStockPhotos.length > 0) {
      // PERF-7 (2026-05-24 audit): combine the two sequential cache-update
      // queries into one using .or() with a PostgREST filter string.
      // This covers both the IS NULL case and the empty-array '{}' case in a
      // single round-trip, halving latency on this hot path (~2× per scan).
      await supabase
        .from('product_lookups')
        .update({ image_urls: extraStockPhotos })
        .eq('upc', cacheUpc)
        .or('image_urls.is.null,image_urls.eq.{}')
        .then(undefined, () => undefined);
    }
  }

  // ── Step 3: Merge ─────────────────────────────────────────────────────────
  // Identity fields (title, brand, model, upc, category, condition,
  // description, notes) come from the vision step — the live photo is the
  // ground truth and must not be overwritten by stale catalog data.
  //
  // Price/image fields (prices, msrp, avg, startBid, stockPhotos, specs)
  // come from enrichment. fullTitle uses the enrichment catalog title when
  // available (usually longer/SEO-richer), but falls back to identification.
  if (!enriched) {
    // No catalog enrichment — but we may still have images from step 2.5.
    return {
      ...identification,
      visibleText,
      prices: [],
      stockPhotos: extraStockPhotos,
      msrp: null,
      avg: null,
      startBid: null,
      fullTitle: identification.title,
      specs: '',
      // 0070-companion: surface OCR-extracted Amazon identifiers so the
      // mobile mint path can write them onto the lot. Without these the
      // ASIN literally appears in the title ("Konsait X0046QHSX7 …")
      // and lots end up with asin=null even though the AI saw it.
      ...(extractedAsin ? { asin: extractedAsin } : {}),
      ...(extractedFnsku ? { fnsku: extractedFnsku } : {}),
      // LPN intentionally not extracted from AI photo scan — see comment
      // above (handled via QuickLot manifest workflow instead).
      ...alternatesProp,
    };
  }

  // Prefer catalog images when present; fall back to step-2.5 enrichment.
  const finalStockPhotos =
    enriched.stockPhotos.length > 0 ? enriched.stockPhotos : extraStockPhotos;

  return {
    // Identity from vision (authoritative)
    title: identification.title,
    brand: identification.brand,
    model: identification.model,
    upc: identification.upc || enriched.upc,
    category: identification.category,
    subcategory: identification.subcategory,
    packagingMsrp: identification.packagingMsrp,
    condition: identification.condition,
    description: identification.description,
    searchQuery: identification.searchQuery,
    confidence: identification.confidence,
    notes: identification.notes,
    visibleText,
    // Prices/images from enrichment (authoritative)
    prices: enriched.prices,
    stockPhotos: finalStockPhotos,
    msrp: enriched.msrp,
    avg: enriched.avg,
    startBid: enriched.startBid,
    specs: enriched.specs,
    // fullTitle: prefer the catalog title (richer); fall back to vision title.
    fullTitle: enriched.fullTitle || enriched.title || identification.title,
    // 0070-companion: structured Amazon codes. Prefer the catalog's
    // value when it has one (it survived a previous AI confirmation);
    // fall back to OCR extraction so brand-new items still get them.
    ...(enriched.asin || extractedAsin
      ? { asin: enriched.asin || extractedAsin! }
      : {}),
    ...(enriched.fnsku || extractedFnsku
      ? { fnsku: enriched.fnsku || extractedFnsku! }
      : {}),
    // LPN: only inherit from the catalog (enriched.lpn) — AI scan no
    // longer extracts LPN to avoid the model fabricating LPN-shaped
    // strings from arbitrary OCR text.
    ...(enriched.lpn ? { lpn: enriched.lpn } : {}),
    ...alternatesProp,
  };
}
