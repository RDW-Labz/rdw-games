// image-enrichment-drain.ts
//
// Drains the image_enrichment_jobs queue and writes the resolved image back to
// the target row. The photo column differs by table: import_rows.photo_url
// (scalar TEXT) vs lots.photo_urls[] (TEXT[]; the inventory thumbnail reads
// photo_urls[0]). See the photo* helpers below.
//
// Triggered from /api/cron/image-enrichment-drain every minute.
// Producers:
//   • commitImport() (imports/actions.ts) — one 'pending' job per import_row,
//     inserted in the same transaction.
//   • trg_enqueue_lot_image_enrichment (mig 0197) — one job per photo-less,
//     identified lot, enqueued atomically AFTER INSERT on lots.
//
// Per-job decision tree (7 outcomes):
//
//   1. target row already has a valid photo_url
//      → status='skipped', error='already_has_photo'
//      No external API call. Covers the modern Wayfair path + defense guard.
//
//   2. No recognisable identifier (ASIN / UPC / ISBN) on the row
//      → status='skipped', error='no_identifier'
//
//   1.5 (inserted between 2 and 3) — catalog cross-reference:
//      Query product_lookups for a matching UPC or ASIN-prefixed row that
//      already carries a non-empty image_urls array. If found and the first
//      URL passes normalisePhotoUrl, copy it directly to the target row.
//      → status='succeeded', resolved_image_url=<url>
//      Zero external API calls, zero rate-limit risk. Falls through when:
//        • no catalog row matches
//        • catalog row has empty image_urls
//        • first image_urls entry is a placeholder ('NA', '', etc.)
//        • write to target row fails (transient — next tick retries via step 6)
//
//   3. Identifier found → dispatch to the matching module:
//        ASIN  → amazon-asin-image (HEAD probe)
//        UPC   → open-food-facts-image
//        ISBN  → open-library-image
//      (MusicBrainz wiring deferred per plan)
//
//   4. Module returns a URL → write photo_url back to target row
//      → status='succeeded', resolved_image_url=<url>
//
//   5. Module returns null (404 / placeholder / no cover) → not-found path
//      → status='skipped', error='upstream_not_found'
//
//   6. Network/5xx error:
//        attempts < 3  → status='pending' (next tick retries)
//        attempts >= 3 → status='failed', error=<message>
//
// Idempotency: UNIQUE (target_table, target_id) on image_enrichment_jobs
// means re-committing the same import is safe — ON CONFLICT DO NOTHING at
// the producer side, and the drain only processes 'pending' rows.

import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { normalisePhotoUrl } from '@/lib/imports/normalise-photo-url';
import { detectIdentifier } from '@auction-platform/image-enrichment';
import {
  probeAmazonAsinImage,
  fetchOpenFoodFactsImage,
  fetchOpenLibraryImage,
} from '@auction-platform/image-enrichment';
import {
  enrichImages,
  enrichWayfairImagesBySku,
  setLottingConfig,
} from '@auction-platform/domain-lotting';
import { verifyImagesMatchProduct } from '@auction-platform/domain-lotting/ai';
import { lottingFetchHtml, lottingMirrorImage } from '@/lib/lotting-egress';
import { upsertPhotoToCatalog } from '@/lib/catalog/upsert-photo-to-catalog';
import type { PhotoSource } from '@/lib/catalog/upsert-photo-to-catalog';

export const BATCH_SIZE = 25;
const MAX_ATTEMPTS = 3;

// ── Title-based paid tier (2026-07-10 stock-image overhaul) ─────────────────
// The identifier modules above are free but only cover rows with an
// ASIN/UPC/ISBN. BinGo's AI-lotted inventory mostly carries a title+brand
// and nothing else — those all dead-ended at 'no_identifier'. When a LOTS
// job has no identifier (or the free modules miss) and the lot has a usable
// title, fall through to domain-lotting's enrichImages(): URL-finder →
// egress page-fetch → allowlist/mirror → vision same-product verify.
// ~$0.04-0.06 per uncached lookup, so it's budget-capped per tick:
// 4/tick at a 1-minute cadence = ≤240/hour ≈ ≤$15/hour while a backlog
// drains, and $0 once the queue is empty. import_rows NEVER take this
// tier (229k rows would be a runaway bill) — identifier modules only.
const PAID_TITLE_LOOKUPS_PER_TICK = 4;
const MIN_TITLE_LENGTH = 8;

// ── Wayfair-SKU tier (2026-07-15 owner feedback) ────────────────────────────
// Wayfair returns carry an exact SKU (SiteSKU/ProductSKU) that resolves
// straight to the authoritative wayfair.com product page — no search-model
// guessing, which the title tier does poorly for ambiguous furniture titles.
// Cheaper than the title tier (one egress page-fetch + one vision call, no
// multi-finder URL search), so it gets a slightly larger per-tick budget. It
// runs BEFORE the title tier for no-identifier lots that carry a Wayfair SKU.
const WAYFAIR_SKU_LOOKUPS_PER_TICK = 6;

function titleTierConfigured(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

/** Staff camera captures live in lot-photos EXCEPT the /rehost/ subtree,
 *  which is where photo-rehost-drain parks re-hosted STOCK images. */
function isStaffCaptureUrl(url: string): boolean {
  return url.includes('/storage/v1/object/public/lot-photos/') && !url.includes('/rehost/');
}

/** True when the lot carries at least one staff photo: a camera capture or a
 *  stock image staff picked while lotting (both are stored in lot-photos,
 *  outside /rehost/). Enrichment never touches such a lot (owner 2026-10-30:
 *  AI images were pushed in front of correct staff photos). */
export function lotHasStaffPhoto(row: Pick<TargetRow, 'photo_urls'>): boolean {
  return (row.photo_urls ?? []).some(
    (u) => typeof u === 'string' && normalisePhotoUrl(u) !== null && isStaffCaptureUrl(u),
  );
}

/** True when the lot already carries at least one stock photo (any valid
 *  photo that isn't a staff camera capture). */
function lotHasStockPhoto(row: TargetRow): boolean {
  return (row.photo_urls ?? []).some(
    (u) => typeof u === 'string' && normalisePhotoUrl(u) !== null && !isStaffCaptureUrl(u),
  );
}

type JobStatus = 'pending' | 'in_progress' | 'succeeded' | 'failed' | 'skipped';

type EnrichmentJob = {
  id: string;
  operator_id: string;
  target_table: 'import_rows' | 'lots' | 'product_lookups';
  target_id: string;
  status: JobStatus;
  attempts: number;
  /** Producers can stamp a marker here on PENDING jobs. 'fuzzy_hero_repair'
   *  (mig 0260) means the lot's hero is a low-res rehosted copy that should
   *  be replaced even though it technically counts as a stock photo. */
  error: string | null;
};

// The minimal shape we need from import_rows or lots.
//
// PHOTO COLUMN DIFFERS BY TABLE:
//   • import_rows → scalar `photo_url` (TEXT)
//   • lots        → array  `photo_urls` (TEXT[]); the inventory thumbnail reads
//                   photo_urls[0] (task #139). There is NO lots.photo_url column —
//                   selecting it 400s. The drain therefore reads/writes whichever
//                   column the row's table actually has (see the photo* helpers).
// All identifier columns (asin/upc/fnsku/lpn/external_code) are identical across
// both tables.
type TargetRow = {
  id: string;
  photo_url?: string | null;
  photo_urls?: string[] | null;
  /** lots only — used by the paid title tier. */
  title?: string | null;
  brand?: string | null;
  /** lots only — passed to the color-aware same-product image gate. */
  description?: string | null;
  /** lots only — Wayfair SiteSKU / ProductSKU (mig 0188), used by the
   *  Wayfair-SKU tier. */
  site_sku?: string | null;
  product_sku?: string | null;
  asin: string | null;
  upc: string | null;
  fnsku: string | null;
  lpn: string | null;
  external_code: string | null;
};

export type ImageEnrichmentDrainResult = {
  processed: number;
  succeeded: number;
  failed: number;
  skipped: number;
};

// ── Per-table photo column mapping ──────────────────────────────────────────
// import_rows.photo_url (scalar TEXT) vs lots.photo_urls (TEXT[]). These three
// helpers are the ONLY place the difference matters; the rest of the drain is
// table-agnostic.
export type PhotoTable = 'import_rows' | 'lots';

export function photoSelectColumns(table: PhotoTable): string {
  // lots also carry title/brand/description for the paid title tier, plus the
  // Wayfair SKUs (mig 0188) for the Wayfair-SKU tier.
  const photoCol =
    table === 'lots'
      ? 'photo_urls, title, brand, description, site_sku, product_sku'
      : 'photo_url';
  return `id, ${photoCol}, asin, upc, fnsku, lpn, external_code`;
}

export function currentPhoto(table: PhotoTable, row: TargetRow): string | null {
  if (table === 'lots') {
    return Array.isArray(row.photo_urls) ? (row.photo_urls[0] ?? null) : null;
  }
  return row.photo_url ?? null;
}

export function photoUpdatePayload(
  table: PhotoTable,
  urls: string[],
  row?: TargetRow,
): Record<string, unknown> {
  // lots: PREPEND the resolved stock URLs and keep whatever the lot already
  // has (staff camera captures) behind them — "imported = primary" (tester
  // recap 2026-07-08). Pre-2026-07-10 this replaced the whole array, which
  // was only safe because the mig-0197 enqueue gate limited jobs to
  // photo-less lots; the stock-photo backfill (mig 0259) enqueues lots that
  // DO have staff photos, so replacement would now delete real captures.
  // The lots_filter_photo_urls BEFORE-UPDATE trigger re-validates hosts.
  if (table === 'lots') {
    const existing = (row?.photo_urls ?? []).filter((u) => !urls.includes(u));
    return { photo_urls: [...urls, ...existing] };
  }
  return { photo_url: urls[0] };
}

// Vision-gate an IDENTIFIER-tier image before it becomes a lot's hero
// (photoUpdatePayload prepends). The UPC/ASIN/ISBN match is high-confidence,
// so this fails OPEN — keep the image unless the same-product gate is
// CONFIDENT it's a different product (the misread-code case) — unlike the
// title tier, which fails closed because title search is unreliable. Lots only:
// import_rows aren't bidder-facing and carry no rich product text to compare.
// (2026-07-14 review: the identifier tier previously prepended with no gate.)
export async function identifierImageOkForLot(
  table: PhotoTable,
  row: TargetRow,
  url: string,
): Promise<boolean> {
  if (table !== 'lots') return true;
  const title = (row.title ?? '').trim();
  if (!title) return true; // nothing to compare against → keep (fail open)
  try {
    const verdicts = await verifyImagesMatchProduct(
      { title, brand: row.brand ?? null, description: row.description ?? null },
      [url],
    );
    return verdicts ? verdicts[0] !== false : true; // reject only a confident false
  } catch {
    return true;
  }
}

export async function runImageEnrichmentDrain(): Promise<ImageEnrichmentDrainResult> {
  const admin = getSupabaseAdmin();

  /** Write resolved stock URLs to a lot from a FRESH read of its photos, and
   *  only if no staff photo appeared since the batch read (a stale read would
   *  otherwise drop photos staff added in the meantime). */
  async function writeLotPhotos(
    row: TargetRow,
    urls: string[],
  ): Promise<{ ok: true } | { ok: false; staffPhoto: boolean; message: string }> {
    const { data: fresh, error: readErr } = await admin
      .from('lots')
      .select('id, photo_urls')
      .eq('id', row.id)
      .maybeSingle();
    if (readErr) return { ok: false, staffPhoto: false, message: readErr.message };
    const current = (fresh ?? { photo_urls: row.photo_urls ?? [] }) as Pick<TargetRow, 'photo_urls'>;
    if (lotHasStaffPhoto(current)) return { ok: false, staffPhoto: true, message: 'has_staff_photo' };
    const { error: writeErr } = await admin
      .from('lots')
      .update(photoUpdatePayload('lots', urls, { ...row, photo_urls: current.photo_urls ?? [] }))
      .eq('id', row.id);
    if (writeErr) return { ok: false, staffPhoto: false, message: writeErr.message };
    return { ok: true };
  }

  // Claim up to BATCH_SIZE pending jobs. We use a plain SELECT FOR UPDATE
  // SKIP LOCKED pattern via two steps because supabase-js can't issue
  // FOR UPDATE SKIP LOCKED directly. The two-step approach is safe at our
  // throughput (1 drain/min, 25 jobs/batch):
  //   Step A: SELECT the oldest pending jobs (race window is < 1ms at this scale)
  //   Step B: flip them to 'in_progress' + bump attempts in one UPDATE WHERE id IN
  // A double-claim from a concurrent drain tick would still produce correct
  // results (idempotent writes back to target row; UNIQUE constraint on jobs).

  // Step A: fetch candidates
  const { data: candidates, error: fetchErr } = await admin
    .from('image_enrichment_jobs')
    .select('id, operator_id, target_table, target_id, status, attempts, error')
    .in('status', ['pending', 'in_progress'])
    .order('enqueued_at', { ascending: true })
    .limit(BATCH_SIZE)
    .returns<EnrichmentJob[]>();

  if (fetchErr) {
    console.error('[image-enrichment-drain] fetch candidates failed:', fetchErr.message);
    return { processed: 0, succeeded: 0, failed: 0, skipped: 0 };
  }

  const jobs = candidates ?? [];
  if (jobs.length === 0) {
    return { processed: 0, succeeded: 0, failed: 0, skipped: 0 };
  }

  // Step B: atomically mark them in_progress + bump attempts
  const ids = jobs.map((j) => j.id);
  await admin
    .from('image_enrichment_jobs')
    .update({ status: 'in_progress' })
    .in('id', ids)
    .then(undefined, (err: unknown) => {
      console.warn('[image-enrichment-drain] in_progress mark failed:', (err as Error)?.message);
    });

  // Batch-fetch the target rows so we can check photo_url + identifiers.
  // All jobs in a batch MUST be from the same target_table type in a simple
  // query — but the queue can contain mixed target_tables. Group by table.
  const byTable = new Map<string, string[]>();
  for (const job of jobs) {
    const list = byTable.get(job.target_table) ?? [];
    list.push(job.target_id);
    byTable.set(job.target_table, list);
  }

  const rowsByTable = new Map<string, Map<string, TargetRow>>();
  for (const [table, rowIds] of byTable) {
    if (table === 'product_lookups') {
      // product_lookups rows are seeded by seedProductLookups — they may not
      // carry per-row identifiers in the same shape. Skip for this drain run.
      continue;
    }
    const { data: rows } = await admin
      .from(table as 'import_rows' | 'lots')
      .select(photoSelectColumns(table as PhotoTable))
      .in('id', rowIds)
      .returns<TargetRow[]>();

    const rowMap = new Map<string, TargetRow>();
    for (const row of rows ?? []) rowMap.set(row.id, row);
    rowsByTable.set(table, rowMap);
  }

  let succeeded = 0;
  let failed = 0;
  let skipped = 0;

  // ── Paid title tier setup ──────────────────────────────────────────────
  // Budgeted per tick; zero when OPENROUTER_API_KEY is absent (dev). The
  // lotting config wires the same egress + mirror chain the lottr routes
  // use, so drain lookups get Bright Data page-fetches and bucket-mirrored
  // images with the vision same-product gate.
  let paidTitleBudget = titleTierConfigured() ? PAID_TITLE_LOOKUPS_PER_TICK : 0;
  // The Wayfair-SKU tier shares the same egress + vision plumbing as the title
  // tier (fetchHtml → Web Unlocker, verify → OpenRouter), so it's gated on the
  // same config; it just draws from its own per-tick budget.
  let wayfairBudget = titleTierConfigured() ? WAYFAIR_SKU_LOOKUPS_PER_TICK : 0;
  if (paidTitleBudget > 0 || wayfairBudget > 0) {
    setLottingConfig({
      openrouterKey: process.env.OPENROUTER_API_KEY!,
      fetchHtml: lottingFetchHtml,
      mirrorImage: lottingMirrorImage,
    });
  }

  /** Wayfair-SKU lookup for a lots job that carries a SiteSKU/ProductSKU.
   *  Single-shot like the title tier: a genuine miss is terminal (retrying an
   *  unresolvable SKU just re-spends). 'budget_out' leaves the job pending
   *  WITHOUT burning an attempt so the next tick's fresh budget retries it. */
  async function tryWayfairTier(
    job: EnrichmentJob,
    row: TargetRow,
  ): Promise<'succeeded' | 'budget_out' | 'not_eligible' | 'miss' | 'staff_photo'> {
    if (job.target_table !== 'lots') return 'not_eligible';
    const siteSku = (row.site_sku ?? '').trim();
    const productSku = (row.product_sku ?? '').trim();
    if (!siteSku && !productSku) return 'not_eligible';
    if (wayfairBudget <= 0) return 'budget_out';
    wayfairBudget--;

    let stockUrls: string[] = [];
    try {
      stockUrls = await enrichWayfairImagesBySku({
        siteSku: siteSku || null,
        productSku: productSku || null,
        title: row.title ?? null,
        brand: row.brand ?? null,
        description: row.description ?? null,
        // Unattended path: attach ONLY a positively-verified image, nothing if
        // the vision gate can't run (same rationale as the title tier).
        strict: true,
      });
    } catch {
      stockUrls = [];
    }
    if (stockUrls.length === 0) return 'miss';

    const w = await writeLotPhotos(row, stockUrls);
    if (!w.ok) {
      if (w.staffPhoto) return 'staff_photo';
      console.warn('[image-enrichment-drain] wayfair tier write failed:', w.message);
      return 'miss';
    }

    await admin
      .from('image_enrichment_jobs')
      .update({
        status: 'succeeded' as JobStatus,
        attempts: job.attempts + 1,
        identifier_kind: 'wayfair_sku',
        identifier_value: (siteSku || productSku).slice(0, 120),
        resolved_image_url: stockUrls[0],
        error: null,
        processed_at: new Date().toISOString(),
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .eq('id', job.id as any);
    return 'succeeded';
  }

  /** Paid title-based lookup for a lots job. Single-shot: a genuine miss is
   *  marked terminal immediately (retrying an unfindable product just
   *  triples the spend). 'budget_out' leaves the job pending WITHOUT
   *  burning an attempt — the next tick has a fresh budget. */
  async function tryTitleTier(
    job: EnrichmentJob,
    row: TargetRow,
  ): Promise<'succeeded' | 'budget_out' | 'not_eligible' | 'miss' | 'staff_photo'> {
    if (job.target_table !== 'lots') return 'not_eligible';
    const title = (row.title ?? '').trim();
    if (title.length < MIN_TITLE_LENGTH) return 'not_eligible';
    if (paidTitleBudget <= 0) return 'budget_out';
    paidTitleBudget--;

    let stockUrls: string[] = [];
    try {
      stockUrls = await enrichImages({
        title,
        brand: row.brand ?? null,
        upc: row.upc ?? null,
        // Reject wrong-color stock images using the lot's description color
        // (2026-07-13) — so the per-minute drain doesn't swap in an off-color
        // hero a minute after lotting.
        description: row.description ?? null,
        // Unattended path: attach ONLY a positively-verified stock image, and
        // nothing if the vision gate can't run. This is what auto-becomes the
        // lot's hero (photoUpdatePayload prepends), and no human reviews it
        // before bidders see it — a fail-open verdict here is exactly how a
        // wrong image (AirPods on a Google Pixel) swapped into the front slot
        // a minute after lotting (2026-07-14). Correct stock still leads; an
        // unverifiable one is simply not attached, leaving the staff photos.
        strict: true,
      });
    } catch {
      stockUrls = [];
    }
    if (stockUrls.length === 0) return 'miss';

    const w = await writeLotPhotos(row, stockUrls);
    if (!w.ok) {
      if (w.staffPhoto) return 'staff_photo';
      console.warn('[image-enrichment-drain] title tier write failed:', w.message);
      return 'miss';
    }

    await admin
      .from('image_enrichment_jobs')
      .update({
        status: 'succeeded' as JobStatus,
        attempts: job.attempts + 1,
        identifier_kind: 'title',
        identifier_value: title.slice(0, 120),
        resolved_image_url: stockUrls[0],
        error: null,
        processed_at: new Date().toISOString(),
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .eq('id', job.id as any);
    return 'succeeded';
  }

  /** Put a budget-starved job back to pending without burning an attempt. */
  async function revertToPending(jobId: string): Promise<void> {
    await admin
      .from('image_enrichment_jobs')
      .update({ status: 'pending' as JobStatus })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .eq('id', jobId as any)
      .then(undefined, (err: unknown) => {
        console.warn('[image-enrichment-drain] revertToPending failed:', (err as Error)?.message);
      });
  }

  for (const job of jobs) {
    // product_lookups skipped in this drain (see above)
    if (job.target_table === 'product_lookups') {
      await markSkipped(job.id, 'product_lookups_not_supported');
      skipped++;
      continue;
    }

    const tableMap = rowsByTable.get(job.target_table);
    const row = tableMap?.get(job.target_id);

    if (!row) {
      // Row was deleted after the job was enqueued — nothing to enrich.
      await markSkipped(job.id, 'target_row_not_found');
      skipped++;
      continue;
    }

    // ── Step 1: already has a valid photo? (per-table column) ──────────────
    // lots: "has a photo" means "has a STOCK photo" — a staff camera capture
    // alone no longer short-circuits the job (2026-07-10 backfill, mig 0259).
    // import_rows keep the original scalar photo_url check.
    //
    // Fuzzy-hero repair jobs (mig 0260, error marker 'fuzzy_hero_repair'):
    // the lot's hero IS a stock photo, but it's a low-res rehosted thumbnail
    // — so the stock gate must not stop the job. Those are satisfied only
    // when the hero is no longer the rehosted copy (something better already
    // took the front slot); a fresh title-tier image PREPENDS and demotes
    // the fuzzy copy to a supplementary slot.
    // A lot with any staff photo is never touched — not even by a fuzzy-hero
    // repair job (owner 2026-10-30).
    if (job.target_table === 'lots' && lotHasStaffPhoto(row)) {
      await markSkipped(job.id, 'has_staff_photo');
      skipped++;
      continue;
    }

    const isFuzzyRepair =
      job.target_table === 'lots' && job.error === 'fuzzy_hero_repair';
    const alreadySatisfied =
      job.target_table === 'lots'
        ? isFuzzyRepair
          ? !(row.photo_urls?.[0] ?? '').includes('/rehost/')
          : lotHasStockPhoto(row)
        : normalisePhotoUrl(currentPhoto(job.target_table as PhotoTable, row)) !== null;
    if (alreadySatisfied) {
      await markSkipped(job.id, 'already_has_photo');
      skipped++;
      continue;
    }

    // ── Step 2: detect identifier ──────────────────────────────────────────
    const identifier = detectIdentifier({
      asin: row.asin,
      upc: row.upc,
      fnsku: row.fnsku,
      lpn: row.lpn,
      external_code: row.external_code,
    });

    if (identifier.kind === null) {
      // No ASIN/UPC/ISBN — the old dead-end for AI-lotted inventory.
      // Wayfair-SKU lots resolve straight from wayfair.com (most accurate for
      // furniture); everything else falls through to the paid title tier.
      const w = await tryWayfairTier(job, row);
      if (w === 'succeeded') {
        succeeded++;
        continue;
      }
      if (w === 'staff_photo') {
        await markSkipped(job.id, 'has_staff_photo');
        skipped++;
        continue;
      }
      if (w === 'budget_out') {
        await revertToPending(job.id);
        continue;
      }
      // w === 'not_eligible' (no Wayfair SKU) or 'miss' (SKU found nothing) →
      // try the generic title tier next.
      const t = await tryTitleTier(job, row);
      if (t === 'succeeded') {
        succeeded++;
        continue;
      }
      if (t === 'staff_photo') {
        await markSkipped(job.id, 'has_staff_photo');
        skipped++;
        continue;
      }
      if (t === 'budget_out') {
        await revertToPending(job.id);
        continue;
      }
      await markSkipped(job.id, t === 'miss' ? 'title_lookup_no_images' : 'no_identifier');
      skipped++;
      continue;
    }

    // ── Step 1.5: cross-reference platform catalog before any external API ──
    // product_lookups is the global catalog (every operator contributes).
    // If we've seen this UPC or ASIN before AND it has a cached image, copy
    // the first URL — zero external API calls, zero rate-limit risk.
    //
    // ASIN convention: catalog stores ASINs as upc='asin:B0XXXXXXXX' (with
    // the 'asin:' prefix) per existing convention. UPCs are stored as-is.
    {
      const catalogFilter =
        identifier.kind === 'asin'
          ? `upc.eq.asin:${identifier.value}`
          : `upc.eq.${identifier.value}`;

      const { data: catalogRow } = await admin
        .from('product_lookups')
        .select('upc, image_urls, confidence')
        .or(catalogFilter)
        .maybeSingle();

      if (catalogRow?.image_urls && catalogRow.image_urls.length > 0) {
        const normalized = normalisePhotoUrl(catalogRow.image_urls[0]);
        // Same-product gate (fail-open): skip a catalog image the vision gate
        // is confident is a different product (misread code) and fall through
        // to the external tiers instead of making it the hero.
        if (
          normalized &&
          (await identifierImageOkForLot(job.target_table as PhotoTable, row, normalized))
        ) {
          let writeErr15: { message: string } | null = null;
          if (job.target_table === 'lots') {
            const w = await writeLotPhotos(row, [normalized]);
            if (!w.ok && w.staffPhoto) {
              await markSkipped(job.id, 'has_staff_photo');
              skipped++;
              continue;
            }
            writeErr15 = w.ok ? null : { message: w.message };
          } else {
            const { error } = await admin
              .from('import_rows')
              .update(photoUpdatePayload('import_rows', [normalized], row))
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              .eq('id', job.target_id as any);
            writeErr15 = error;
          }

          if (!writeErr15) {
            await admin
              .from('image_enrichment_jobs')
              .update({
                status: 'succeeded' as JobStatus,
                attempts: job.attempts + 1,
                identifier_kind: identifier.kind,
                identifier_value: identifier.value,
                resolved_image_url: normalized,
                error: null,
                processed_at: new Date().toISOString(),
              })
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              .eq('id', job.id as any);
            succeeded++;
            continue;
          }
          // If the write to the target row failed, fall through to external APIs.
          // (Same retry logic as step 4 will handle it on the next pass if needed.)
          console.warn(
            '[image-enrichment-drain] step 1.5 write failed, falling through:',
            writeErr15?.message,
          );
        }
        // normalized was null (e.g. 'NA' shape) — fall through to external APIs
      }
      // catalog miss or empty image_urls — fall through to external APIs
    }

    // ── Step 3: dispatch to the correct enrichment module ─────────────────
    let resolvedUrl: string | null = null;
    let isTransientError = false;
    let errorMsg: string | undefined;

    try {
      if (identifier.kind === 'asin') {
        const result = await probeAmazonAsinImage(identifier.value);
        resolvedUrl = result?.url ?? null;
      } else if (identifier.kind === 'upc') {
        const result = await fetchOpenFoodFactsImage(identifier.value);
        resolvedUrl = result?.url ?? null;
      } else if (identifier.kind === 'isbn') {
        const result = await fetchOpenLibraryImage(identifier.value);
        resolvedUrl = result?.url ?? null;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      isTransientError = true;
      errorMsg = msg.slice(0, 500);
    }

    if (isTransientError) {
      // ── Step 6: transient error ────────────────────────────────────────
      const newAttempts = job.attempts + 1;
      if (newAttempts >= MAX_ATTEMPTS) {
        await admin
          .from('image_enrichment_jobs')
          .update({
            status: 'failed' as JobStatus,
            attempts: newAttempts,
            error: errorMsg ?? 'unknown_error',
            identifier_kind: identifier.kind,
            identifier_value: identifier.value,
            processed_at: new Date().toISOString(),
          })
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .eq('id', job.id as any);
      } else {
        // Revert to pending for the next tick retry
        await admin
          .from('image_enrichment_jobs')
          .update({
            status: 'pending' as JobStatus,
            attempts: newAttempts,
            error: errorMsg ?? 'unknown_error',
            identifier_kind: identifier.kind,
            identifier_value: identifier.value,
          })
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .eq('id', job.id as any);
      }
      failed++;
      continue;
    }

    if (resolvedUrl === null) {
      // ── Step 5: upstream returned null (404 / placeholder) ────────────
      // lots get one more chance via the paid title tier before giving up.
      const t = await tryTitleTier(job, row);
      if (t === 'succeeded') {
        succeeded++;
        continue;
      }
      if (t === 'staff_photo') {
        await markSkipped(job.id, 'has_staff_photo');
        skipped++;
        continue;
      }
      if (t === 'budget_out') {
        await revertToPending(job.id);
        continue;
      }
      await admin
        .from('image_enrichment_jobs')
        .update({
          status: 'skipped' as JobStatus,
          error: t === 'miss' ? 'title_lookup_no_images' : 'upstream_not_found',
          identifier_kind: identifier.kind,
          identifier_value: identifier.value,
          processed_at: new Date().toISOString(),
        })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .eq('id', job.id as any);
      skipped++;
      continue;
    }

    // Same-product gate (fail-open) before this identifier-resolved image
    // becomes the lot's hero: reject only when the vision gate is confident
    // it's a different product (misread UPC/ASIN → wrong catalog/probe image).
    // Fall back to the title tier, else skip — never hero an image the gate
    // rejected. (2026-07-14 review: the identifier tier had no gate.)
    if (!(await identifierImageOkForLot(job.target_table as PhotoTable, row, resolvedUrl))) {
      const t = await tryTitleTier(job, row);
      if (t === 'succeeded') {
        succeeded++;
        continue;
      }
      if (t === 'staff_photo') {
        await markSkipped(job.id, 'has_staff_photo');
        skipped++;
        continue;
      }
      if (t === 'budget_out') {
        await revertToPending(job.id);
        continue;
      }
      await admin
        .from('image_enrichment_jobs')
        .update({
          status: 'skipped' as JobStatus,
          error: 'identifier_image_unverified',
          identifier_kind: identifier.kind,
          identifier_value: identifier.value,
          processed_at: new Date().toISOString(),
        })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .eq('id', job.id as any);
      skipped++;
      continue;
    }

    // ── Step 4: write the resolved photo back to the target row ────────
    // Per-table column: import_rows.photo_url (scalar) vs lots.photo_urls (array).
    let writeErr: { message: string } | null = null;
    if (job.target_table === 'lots') {
      const w = await writeLotPhotos(row, [resolvedUrl]);
      if (!w.ok && w.staffPhoto) {
        await markSkipped(job.id, 'has_staff_photo');
        skipped++;
        continue;
      }
      writeErr = w.ok ? null : { message: w.message };
    } else {
      const { error } = await admin
        .from('import_rows')
        .update(photoUpdatePayload('import_rows', [resolvedUrl], row))
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .eq('id', job.target_id as any);
      writeErr = error;
    }

    if (writeErr) {
      // DB write failed — treat as transient
      const newAttempts = job.attempts + 1;
      const msg = writeErr.message.slice(0, 500);
      if (newAttempts >= MAX_ATTEMPTS) {
        await admin
          .from('image_enrichment_jobs')
          .update({
            status: 'failed' as JobStatus,
            attempts: newAttempts,
            error: msg,
            identifier_kind: identifier.kind,
            identifier_value: identifier.value,
            processed_at: new Date().toISOString(),
          })
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .eq('id', job.id as any);
      } else {
        await admin
          .from('image_enrichment_jobs')
          .update({
            status: 'pending' as JobStatus,
            attempts: newAttempts,
            error: msg,
            identifier_kind: identifier.kind,
            identifier_value: identifier.value,
          })
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          .eq('id', job.id as any);
      }
      failed++;
      continue;
    }

    // Mark succeeded
    await admin
      .from('image_enrichment_jobs')
      .update({
        status: 'succeeded' as JobStatus,
        attempts: job.attempts + 1,
        identifier_kind: identifier.kind,
        identifier_value: identifier.value,
        resolved_image_url: resolvedUrl,
        error: null,
        processed_at: new Date().toISOString(),
      })
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .eq('id', job.id as any);

    succeeded++;

    // ── Cross-operator catalog warming ────────────────────────────────────
    // Feed the resolved URL back into product_lookups so every operator
    // scanning the same identifier in the future gets this photo for free
    // (drain step 1.5 / catalog read-through). Failure here is non-fatal:
    // the import_row already got its photo_url — catalog enrichment is
    // best-effort.
    {
      const catalogSource: PhotoSource =
        identifier.kind === 'asin'
          ? 'enrichment_amazon'
          : identifier.kind === 'isbn'
            ? 'enrichment_openlibrary'
            : 'enrichment_openfoodfacts'; // 'upc' path

      upsertPhotoToCatalog({
        admin,
        identifierKind: identifier.kind,
        identifierValue: identifier.value,
        photoUrl: resolvedUrl,
        source: catalogSource,
        contributedByOperatorId: job.operator_id,
      }).catch((err: unknown) => {
        console.warn(
          '[image-enrichment-drain] catalog upsert failed (non-fatal):',
          (err as Error)?.message,
        );
      });
    }
  }

  return { processed: jobs.length, succeeded, failed, skipped };
}

// ── helpers ───────────────────────────────────────────────────────────────────

async function markSkipped(jobId: string, reason: string): Promise<void> {
  const admin = getSupabaseAdmin();
  await admin
    .from('image_enrichment_jobs')
    .update({
      status: 'skipped' as JobStatus,
      error: reason,
      processed_at: new Date().toISOString(),
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .eq('id', jobId as any)
    .then(undefined, (err: unknown) => {
      console.warn('[image-enrichment-drain] markSkipped failed:', (err as Error)?.message);
    });
}
