// Persist a LotCandidate (the AI lookup result) into the platform's
// `lots` table as a fresh pending_intake draft. The lot becomes part
// of the operator's inventory pool until the Auction Builder pulls it
// into a specific auction.
//
// This module deliberately keeps Supabase as a parameter rather than
// importing a singleton — both field-mobile (Expo Supabase client) and
// operator-web (Next.js SSR-aware client) need to call it with their
// own authenticated client. Pure functional layering.

import type { SupabaseClient } from '@supabase/supabase-js';
import type { LotCandidate } from './types';
import { normalizeCondition } from './normalize';
import { filterSafeImageUrls } from './normalize/images';
import { normalizeUpc } from './normalize/upc';
import { upsertLookup } from './lookup/cache';
import { mirrorImageToStorage } from './lookup/mirror-images';
import type { ProductLookup, ProductLookupSource } from './lookup/types';

export type CreateDraftLotInput = {
  candidate: LotCandidate;
  /** The operator the lot belongs to — typically pulled from useOperatorRole().operatorId. */
  operatorId: string;
  /** Optional photo URLs to seed lot.photo_urls with. Stock photos
   *  from the AI scan can land here directly. */
  photoUrls?: string[];
  /**
   * Optional free-form source/truck/program label (migration 0055).
   * When set, persisted to lots.source so profitability reports can
   * group by where the inventory came from. Trimmed + capped at 120
   * chars; empty string normalizes to null.
   *
   * Semantic (post 2026-05-27 source/vendor split, migration 0154):
   * `source` = VRID / Load ID / origin facility (e.g. "lex1", "btr1",
   * "Lowe's Returns GA"). For the supplier, use `vendor`.
   */
  source?: string | null;
  /**
   * Optional supplier label (migration 0154). Independent axis from
   * `source` — `vendor` answers "who supplied this product?" (Amazon,
   * Lowe's, Wayfair) while `source` answers "which load / facility did
   * it come from?". Persisted to lots.vendor. Trimmed + capped at 120
   * chars; empty string normalizes to null.
   */
  vendor?: string | null;
  /**
   * Optional client idempotency token (migration 0272). One stable UUID per
   * INTENDED lot: a retried or double-fired save reuses the same token so the
   * second create_draft_lot call returns the first lot instead of minting a
   * duplicate. Distinct items get distinct tokens (0058's "identical items are
   * two legit lots" invariant is preserved — the token keys the ACTION, not the
   * item). Omit/null → no dedup (prior behavior).
   */
  clientToken?: string | null;
  /**
   * Optional manifest import_row id (migration 0269). When this lot is being
   * created from a Wayfair/D2L manifest match, pass the matched import_row's
   * id so create_draft_lot can (a) be idempotent on it — a second call for the
   * same box returns the existing lot instead of a duplicate — and (b) flip the
   * row pending->lotted atomically in the same transaction. This REPLACES the
   * old fire-and-forget mark_import_row_lotted call that raced and left orphan
   * twins. Omit / null for non-manifest lotting (AI scan / catalog / manual).
   */
  importRowId?: string | null;
};

/**
 * Discriminated failure code so callers can present actionable messages
 * instead of opaque Postgres errors:
 *   - duplicate_external_code  → operator already has a lot with this UPC.
 *                                 Trips lots_external_code_per_operator (UNIQUE).
 *   - rpc_failed               → next_lot_code RPC threw (operator missing,
 *                                 RLS denied, etc).
 *   - insert_failed            → INSERT threw for any other reason
 *                                 (FK violation, NOT NULL, RLS, network).
 *
 * `reason` keeps the raw Postgres message verbatim for logging/debugging;
 * UI code should branch on `code` and produce its own user-facing copy.
 */
export type CreateDraftLotFailureCode =
  | 'duplicate_external_code'
  | 'rpc_failed'
  | 'insert_failed';

export type CreateDraftLotResult =
  | {
      ok: true;
      lotId: string;
      lotCode: string;
      /**
       * Fire-and-forget background enrichment thunk.
       * Mirrors retailer-CDN stock photos into Supabase Storage and writes
       * the product_lookups cache row. Both are best-effort and idempotent.
       *
       * Mobile callers should `void enrich()` so the UI navigates instantly
       * after the RPC commits — the lot already exists in Postgres with its
       * original CDN URLs; the mirror/cache fills in over the next 1–3s.
       *
       * Cloudflare Worker callers must NOT use `void enrich()` because the
       * request context kills pending promises when the response is sent.
       * Either `await enrich()` (preserves pre-2026-05-21 behavior) or
       * `ctx.waitUntil(enrich())` (Workers' request-lifetime extension).
       */
      enrich: () => Promise<void>;
    }
  | { ok: false; code: CreateDraftLotFailureCode; reason: string };

// LotTR's category strings (Electronics / Tools & Hardware / etc.) map
// onto the platform's category taxonomy via category_aliases. This
// helper does the lookup with a lowercased match. Returns null when no
// alias exists; the caller can still create the lot with category_id
// null and rely on later manual classification.
export async function resolveCategoryId(
  supabase: SupabaseClient,
  rawCategory: string | null | undefined,
): Promise<string | null> {
  if (!rawCategory) return null;
  const raw = rawCategory.trim().toLowerCase();
  if (!raw) return null;
  const { data } = await supabase
    .from('category_aliases')
    .select('category_id')
    .eq('raw', raw)
    .maybeSingle();
  return ((data?.['category_id'] as string | undefined) ?? null) || null;
}

// #2 phase 2b — clocked-in worker attribution (shared-device PIN identity).
// The field app's WorkerContext registers the active worker id here on
// clock-in/out; module-level so the create paths stamp lots.lotted_by_worker
// without threading it through every caller. Null on operator-web (no PIN) and
// before anyone clocks in — in which case attribution is skipped.
let _activeWorkerId: string | null = null;
export function setActiveLottingWorkerId(id: string | null): void {
  _activeWorkerId = id && id.trim() ? id : null;
}
/** The clocked-in worker, for create paths that call an RPC directly rather
 *  than going through createDraftLotFromCandidate — notably the two relist
 *  screens, which mint ~48% of daily lot volume and carried no attribution at
 *  all before mig 0321. */
export function getActiveLottingWorkerId(): string | null {
  return _activeWorkerId;
}

// Mig 0428 — the load picked for the shift (field app SessionContext
// defaultLoadId). Module-level like the worker above, so every create path
// stamps lots.load_id without threading it through callers. Null = no load
// picked → the /23 call exactly as before.
let _activeLoadId: string | null = null;
export function setActiveLottingLoadId(id: string | null): void {
  _activeLoadId = id && id.trim() ? id : null;
}
export function getActiveLottingLoadId(): string | null {
  return _activeLoadId;
}

/** PostgREST could not find create_draft_lot with p_load_id (0428 not applied
 *  yet, or rolled back). Safe to retry without it: no lot was created. */
export function isMissingLoadOverload(error: { code?: string; message?: string } | null): boolean {
  if (!error) return false;
  return error.code === 'PGRST202' || /p_load_id/.test(error.message ?? '');
}

export async function createDraftLotFromCandidate(
  supabase: SupabaseClient,
  input: CreateDraftLotInput,
): Promise<CreateDraftLotResult> {
  const { candidate, operatorId, photoUrls, source, vendor, clientToken, importRowId } = input;
  // Normalize the source: trim + cap at 120 chars (matches migration
  // 0055's CHECK constraint). Empty string → null so we don't index
  // empties.
  const normalizedSource = (() => {
    if (typeof source !== 'string') return null;
    const trimmed = source.trim();
    if (trimmed.length === 0) return null;
    return trimmed.slice(0, 120);
  })();
  // Normalize the vendor (mig 0154). Same shape as source: trim + cap
  // at 120 chars; empty / non-string → null. Vendor is the supplier
  // (Amazon, Lowe's, Wayfair) — independent axis from `source`, which
  // is the VRID / Load ID / origin facility.
  const normalizedVendor = (() => {
    if (typeof vendor !== 'string') return null;
    const trimmed = vendor.trim();
    if (trimmed.length === 0) return null;
    return trimmed.slice(0, 120);
  })();

  // 1. Resolve category alias. Best-effort — null is fine.
  const categoryId = await resolveCategoryId(supabase, candidate.category);

  // 3. Map dollars (LotTR) → cents (platform). msrp / start come back
  // from the AI as floats; we round to cents to avoid 0.00499→0 loss.
  //
  // R4.2: clamp into JS-safe-integer range BEFORE the multiply-by-100,
  // not after. JavaScript's Number is IEEE-754 double — at values above
  // ~90 trillion, multiplying by 100 silently loses precision and stores
  // a wrong-but-still-valid bigint, leading to silent corruption. The
  // mirror DB CHECK in migration 0046 catches any path that bypasses
  // this guard. Practical caps:
  //   msrp:        $90,000,000,000  (90B; no real product is this expensive)
  //   starting_bid: $1,000,000,000  (1B; absurd starting bid)
  // Anything above the cap is treated as null/default, the same as
  // negative or NaN inputs.
  const MAX_MSRP_DOLLARS = 90_000_000_000;
  const MAX_BID_DOLLARS = 1_000_000_000;
  // MSRP cascade for the persisted lot:
  //   Tier 1 (preferred): candidate.msrp — comes from enrichment
  //     (catalog cache / Sonar URL-finder + url-fetcher JSON-LD/og:image
  //     listPrice / max-asking-cents / Sonar-context). Already in dollars.
  //   Tier 0 (vision fallback): candidate.packagingMsrp — comes from
  //     the photo_identify call when the operator's photo shows a
  //     visible price tag, MSRP sticker, or "Was $X" retailer label.
  //     Captured by the OCR-First VISION_PROMPT's msrp_guess_cents
  //     field (post 2026-05-15). Used ONLY when enrichment didn't
  //     resolve an MSRP — production data shows ~30% of UPC scans hit
  //     this case (cache rows with no listPrice; retailer pages that
  //     bot-block our fetcher).
  // Honoring Tier 0 means a candle with a "$26.95" sticker gets the
  // MSRP onto its listing even when Sonar found no JSON-LD listPrice.
  const msrpDollarCandidate =
    candidate.msrp != null && Number.isFinite(candidate.msrp) && candidate.msrp > 0
      ? candidate.msrp
      : candidate.packagingMsrp != null && Number.isFinite(candidate.packagingMsrp) && candidate.packagingMsrp > 0
        ? candidate.packagingMsrp
        : null;
  const msrpCents =
    msrpDollarCandidate !== null && msrpDollarCandidate < MAX_MSRP_DOLLARS
      ? Math.round(msrpDollarCandidate * 100)
      : null;
  const startingBidCents =
    candidate.startBid != null &&
    Number.isFinite(candidate.startBid) &&
    candidate.startBid > 0 &&
    candidate.startBid < MAX_BID_DOLLARS
      ? Math.round(candidate.startBid * 100)
      : 100; // platform default — matches the manifest importer's $1 floor.

  // 3. Atomic seq-increment + INSERT via the RPC introduced in 0047.
  // The RPC is SECURITY DEFINER (so it can write operators.next_lot_seq
  // which the user doesn't own directly) and enforces an
  // operator-id-must-match-caller guard inside. On any failure path
  // (duplicate external_code, FK, RLS) the seq increment rolls back —
  // no phantom gap in the {operator.code}-NNNNNN sequence.
  const condition: 'appears_new' | 'open_box' | 'good' | 'as_is' =
    normalizeCondition(candidate.condition) ?? 'good';
  const photoUrlsSafe = filterSafeImageUrls(photoUrls ?? candidate.stockPhotos ?? []);

  // Defensive truncation. The DB CHECKs from migration 0050 enforce
  //   lots.title length 1..500
  //   lots.description length ≤ 10000
  // AI scan results (especially from the legacy Anthropic + web_search
  // path) routinely exceed these — Amazon product titles can be 250+
  // chars and the AI's description merges specs blurbs that get long.
  // Trimming here avoids the user-facing 23514 CHECK violation while
  // preserving meaningful content. Operators can edit titles further
  // in the Inventory edit screen.
  const rawTitle = candidate.title || candidate.fullTitle || 'Untitled lot';
  const safeTitle = rawTitle.slice(0, 500) || 'Untitled lot';
  const rawDescription = candidate.description || candidate.specs || null;
  const safeDescription = rawDescription
    ? rawDescription.slice(0, 10000)
    : null;
  // Category is a free-form string used for display (different column
  // from category_id which is FK). Cap at 100 chars to match the
  // platform's UI assumptions even though no DB CHECK exists yet.
  const safeCategory = candidate.category ? candidate.category.slice(0, 100) : null;

  // 0070: pass brand/model/asin/fnsku/lpn through. Before 0070 the RPC
  // didn't accept these args at all — Quick Lot mints had AI-extracted
  // brand sitting in candidate.brand but landing on the lot as null,
  // because they were silently dropped at the RPC boundary. The lots
  // columns themselves have existed since migration 0032; just the
  // ingress path was missing.
  //
  // Truncation matches the lot_text_length CHECKs we expect to add
  // (no DB CHECK exists today for these specific columns, but the
  // import_rows shape uses these caps consistently).
  const trim120 = (v: unknown): string | null => {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    return t.length === 0 ? null : t.slice(0, 120);
  };
  const trim64 = (v: unknown): string | null => {
    if (typeof v !== 'string') return null;
    const t = v.trim();
    return t.length === 0 ? null : t.slice(0, 64);
  };

  // ── Pass raw photo URLs through to the RPC ────────────────────────────
  // PERF (2026-05-21): the mirror-images loop that used to run here was
  // adding 1-3 seconds to every Quick Lot / UPC scan save (it fetched each
  // retailer CDN URL and re-uploaded the bytes to the stock-images bucket).
  // The mobile UX hung on that wall time before any UI feedback could fire.
  //
  // The loop was moved into the `enrich()` thunk on the result so callers
  // can run it after the lot is already committed (and the UI has already
  // navigated). Mirror remains idempotent — the next time anyone hits a
  // CDN URL on this lot we'll re-mirror it transparently. See
  // `mirrorAndCacheLot()` below.
  const initialPhotoUrls = photoUrlsSafe;

  const draftArgs = {
      p_operator_id: operatorId,
      p_title: safeTitle,
      p_description: safeDescription,
      p_category: safeCategory,
      p_category_id: categoryId,
      p_condition: condition,
      p_msrp_cents: msrpCents,
      p_starting_bid_cents: startingBidCents,
      p_photo_urls: initialPhotoUrls,
      p_external_code: candidate.upc || null,
      p_source: normalizedSource,
      // 0070: identity fields, previously dropped at the RPC boundary.
      p_brand: trim120(candidate.brand),
      p_model: trim120(candidate.model),
      p_asin: trim64(candidate.asin),
      p_fnsku: trim64(candidate.fnsku),
      p_lpn: trim64(candidate.lpn),
      // 0154: supplier label, distinct from source (VRID/load/facility).
      p_vendor: normalizedVendor,
      // 0188: structured vendor SKUs (Wayfair ProductSKU/SiteSKU/ManufactureSKU),
      // round-tripped from the manifest row's raw_data onto the lot so the
      // bidder Identifiers UI can show them. Same null/trim treatment as the
      // asin/fnsku/lpn identity fields above; the RPC NULLIF/TRIMs again.
      p_product_sku: trim64(candidate.productSku),
      p_site_sku: trim64(candidate.siteSku),
      p_manufacture_sku: trim64(candidate.manufactureSku),
      // 0272: per-action idempotency token. NULL when the caller doesn't
      // supply one (the RPC's DEFAULT NULL keeps the arg optional, so callers
      // that predate this — or run against a pre-0272 DB — are unaffected).
      p_client_token: clientToken ?? null,
      // 0321: attribute the lot to the clocked-in PIN worker AT INSERT. Was a
      // fire-and-forget follow-up UPDATE below, which swallowed its own failures
      // and reached 44% coverage on prod. Validated server-side against this
      // operator; an unknown id is ignored rather than failing the create.
      p_lotted_by_worker: _activeWorkerId,
      // 0269: manifest provenance. When set, the RPC is idempotent on this row
      // (returns the existing lot for a re-fired call) and flips the import_row
      // pending->lotted atomically — no more fire-and-forget race / orphan twin.
      p_import_row_id: importRowId ?? null,
  };
  // 0428: send the shift's load only when one is picked (→ /24). On "function
  // not found" (0428 not applied / rolled back) retry the /23 call once —
  // nothing was created, so lotting never breaks over deploy order.
  const loadId = _activeLoadId;
  let { data, error } = await supabase
    .rpc('create_draft_lot', (loadId ? { ...draftArgs, p_load_id: loadId } : draftArgs) as typeof draftArgs)
    .single();
  if (error && loadId && isMissingLoadOverload(error)) {
    ({ data, error } = await supabase.rpc('create_draft_lot', draftArgs).single());
  }

  if (error || !data) {
    // Migration 0058 dropped the (operator_id, external_code) UNIQUE
    // index. Two physical units of the same product (same UPC) now
    // legitimately become two separate lots with distinct lot_codes
    // — the canonical unique ID is the operator-prefixed lot_code,
    // not the supplier's UPC. So `duplicate_external_code` should
    // never fire from this code path anymore.
    //
    // We keep the discriminated `code` field on the result for
    // backward compat with existing callers that switch on it, but
    // the only 23505 we'd hit now is a lot_code race (vanishingly
    // rare due to the SECURITY DEFINER RPC's row-locked seq increment).
    // That's an "insert_failed" — operator should retry.
    const pgCode = (error as { code?: string } | null)?.code;
    const pgMessage = error?.message ?? '';
    const isDuplicateExternalCode = false; // 0058: never true on this path

    // Distinguish RPC-internal failures (auth/operator-not-found) from
    // INSERT failures so the discriminated code stays accurate. The RPC
    // raises 28000 (auth missing) or 42501 (operator mismatch) or 02000
    // (operator not found in seq update); everything else from INSERT
    // is mapped to insert_failed/duplicate_external_code.
    const isRpcFailure =
      pgCode === '28000' || pgCode === '42501' || pgCode === '02000';

    // Surface a clearer reason on CHECK violations (0046 msrp/bid bounds,
    // 0050 title/description length). The defensive truncation above
    // should keep 23514 from firing for typical AI-scan input, but
    // operator-pasted extreme values (or future migrations adding new
    // CHECKs) could still trigger it. The reason gets surfaced via
    // LotCreateError.userMessage in the mobile hook so the operator
    // gets context, not a raw Postgres line.
    const isCheckViolation = pgCode === '23514';
    const checkContext = isCheckViolation
      ? pgMessage.includes('title_length')
        ? 'Title is too long or empty.'
        : pgMessage.includes('description_length')
          ? 'Description is too long.'
          : pgMessage.includes('msrp_cents')
            ? 'MSRP is out of range.'
            : pgMessage.includes('starting_bid_cents')
              ? 'Starting bid is out of range.'
              : 'A field is out of allowed range.'
      : null;

    return {
      ok: false,
      code: isDuplicateExternalCode
        ? 'duplicate_external_code'
        : isRpcFailure
          ? 'rpc_failed'
          : 'insert_failed',
      reason: checkContext
        ? `create_draft_lot: ${checkContext} (${error?.message ?? 'CHECK violation'})`
        : `create_draft_lot: ${error?.message ?? 'unknown error'}`,
    };
  }

  // The RPC returns a single row { out_id, out_lot_code } — column names
  // are renamed in migration 0048 to avoid ambiguity with the INSERT's
  // RETURNING clause inside the function. .single() unwraps the array so
  // `data` is the object directly.
  const row = data as { out_id: string; out_lot_code: string };

  // ── Build the enrich() thunk ────────────────────────────────────────────
  // Background work: mirror retailer-CDN photos into our stock-images
  // bucket, then write through to product_lookups so future scans of the
  // same code hit the cache. Both are idempotent and best-effort; failures
  // are swallowed so the already-committed lot is never affected.
  //
  // Captured-by-closure inputs are intentionally narrow — only what the
  // background work actually reads — so the thunk doesn't pin the whole
  // candidate/operator scope.
  const normalizedUpc = normalizeUpc(candidate.upc);
  const asinClean = trim64(candidate.asin);
  const fnskuClean = trim64(candidate.fnsku);
  const lpnClean = trim64(candidate.lpn);
  const modelClean = trim120(candidate.model);
  const brandClean = trim120(candidate.brand);
  const candidateTitle = candidate.title;
  const candidateAvg = candidate.avg;
  const lotId = row.out_id;
  const lotCode = row.out_lot_code;

  const enrich = async (): Promise<void> => {
    // ── 1. Mirror retailer CDN photos into stock-images bucket ──────────
    // Bounded concurrency: 4 in flight. Same pattern as the pre-2026-05-21
    // synchronous loop, just moved off the critical path.
    let finalPhotoUrls: string[] = initialPhotoUrls;
    if (initialPhotoUrls.length > 0) {
      // SEQUENTIAL, and a tighter per-image cap than the server default.
      //
      // This thunk is fire-and-forget: it runs AFTER the lot is committed,
      // while the lotter has already moved on to the next item. On mobile that
      // means it competes with a live camera session and a page of decoded
      // photos, in the background, which is where iOS looks first when it needs
      // memory back.
      //
      // Four in flight, each holding a whole image as an ArrayBuffer (the
      // Storage client has no streaming upload), was up to 40 MB of peak heap
      // for a background nicety. Staff reported the consequence for weeks —
      // "app crashes when trying to download a stock photo", "makes me start
      // the listing over" (staff reports, 2026-08-19/20; "crashed a million
      // times") — and every crash the watchdog caught in 21 days was a process
      // kill, not a JS error: 123 of them, none fatal, i.e. the OS took us.
      //
      // One at a time bounds peak heap to a single image. Nothing waits on this
      // work, so the wall-clock cost is invisible; being killed is not.
      const CONCURRENCY = 1;
      // Product photos are ~100-800 KB. 4 MB is generous for a real one and
      // still refuses a pathological CDN response.
      const MIRROR_MAX_BYTES = 4 * 1024 * 1024;
      const slots: (string | null)[] = new Array(initialPhotoUrls.length).fill(null);
      let cursor = 0;
      async function mirrorWorker(): Promise<void> {
        while (true) {
          const i = cursor++;
          if (i >= initialPhotoUrls.length) return;
          const src = initialPhotoUrls[i];
          if (!src) continue;
          slots[i] =
            (await mirrorImageToStorage(supabase, src, {
              maxBytes: MIRROR_MAX_BYTES,
            }).catch(() => null)) ?? src;
        }
      }
      try {
        await Promise.all(
          Array.from(
            { length: Math.min(CONCURRENCY, initialPhotoUrls.length) },
            () => mirrorWorker(),
          ),
        );
      } catch {
        // bounded workers swallow per-URL failures; this catch is for the
        // outer Promise.all (which only rejects if a worker itself throws
        // unexpectedly — workers never throw, but defensive).
      }
      const mirrored: string[] = [];
      for (const u of slots) if (u) mirrored.push(u);
      finalPhotoUrls = mirrored;

      // Persist the mirrored URLs back onto the lot ONLY if anything
      // actually changed. Re-mirroring an already-mirrored URL returns
      // the same canonical URL, so the equality check avoids a no-op
      // UPDATE round-trip.
      const anyChanged = finalPhotoUrls.some((u, i) => u !== initialPhotoUrls[i]);
      if (anyChanged) {
        try {
          await supabase
            .from('lots')
            .update({ photo_urls: finalPhotoUrls })
            .eq('id', lotId);
        } catch {
          // best-effort — lot is already saved with the original CDN URLs
        }
      }
    }

    // ── 2. Catalog write-through ────────────────────────────────────────
    // User reported (2026-05-13): "once something is lotted it should be in
    // the catalog at that point so anyone can scan it." Previously, creating
    // a lot from an AI scan inserted into `lots` but never touched
    // `product_lookups`, so a barcode rescan of the same item returned
    // no_match.
    //
    // ASIN-only and FNSKU-only items use a synthetic `asin:<ASIN>` /
    // `fnsku:<FNSKU>` primary key (the convention documented on
    // ProductLookup.upc), with the real identifier also populated in its
    // dedicated column so the RPC's per-column search still hits.
    //
    // upsertLookup() does a non-destructive merge — keeps richer cached
    // values, only fills nulls. Best-effort: failures don't abort anything
    // (the lot is already committed).
    const primaryKey =
      normalizedUpc ||
      (asinClean ? `asin:${asinClean.toUpperCase()}` : null) ||
      (fnskuClean ? `fnsku:${fnskuClean.toUpperCase()}` : null) ||
      (lpnClean ? `lpn:${lpnClean.toUpperCase()}` : null);

    if (
      primaryKey &&
      (candidateTitle || brandClean || msrpCents || finalPhotoUrls.length > 0)
    ) {
      const now = new Date().toISOString();
      const avgAskingCents =
        candidateAvg != null && Number.isFinite(candidateAvg) && candidateAvg > 0
          ? Math.round(candidateAvg * 100)
          : null;
      const cataloged: ProductLookup = {
        upc: primaryKey,
        title: candidateTitle || null,
        brand: brandClean,
        model: modelClean,
        category_id: categoryId,
        category_raw: safeCategory,
        image_urls: finalPhotoUrls,
        asin: asinClean,
        fnsku: fnskuClean,
        lpn: lpnClean,
        mpn: modelClean,
        external_codes: [],
        msrp_cents: msrpCents,
        avg_asking_cents: avgAskingCents,
        median_sold_cents: null,
        start_bid_cents: startingBidCents,
        prices: [],
        sold_comps: [],
        description: safeDescription,
        specs: null,
        confidence: 'high', // operator-confirmed
        sources: ['manual' as ProductLookupSource],
        identity_refreshed_at: now,
        prices_refreshed_at: avgAskingCents != null ? now : null,
        created_at: now,
        updated_at: now,
      };
      try {
        await upsertLookup(supabase, cataloged);
      } catch {
        // best-effort — lot is saved either way
      }
    }
  };

  return {
    ok: true,
    lotId,
    lotCode,
    enrich,
  };
}
