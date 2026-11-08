'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { getSupabaseServer } from '@/lib/supabase-server';
import { getSupabaseAdmin } from '@/lib/supabase-admin';
import { enqueueCacheWarm } from '@/lib/queue';
import { extractBrand, normalizeUpcStrict } from '@auction-platform/domain-lotting';
import { normalisePhotoUrl } from '@/lib/imports/normalise-photo-url';

// One row from the operator's manifest after column mapping. All
// fields optional except title — a row without a title can't even
// be presented as a draft lot, so we skip it during commit.
//
// Amazon-shaped manifests carry asin/fnsku/lpn — pickers scan these
// at the auction pickup center, so they must round-trip from import →
// lot via the lot_import_rows() RPC. Brand / model / pallet_id /
// quantity / cost give better filtering + margin tracking and propagate
// the same way.
const importRowSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().max(5000).nullable().optional(),
  brand: z.string().max(120).nullable().optional(),
  model: z.string().max(120).nullable().optional(),
  category_raw: z.string().max(200).nullable().optional(),
  sub_category_raw: z.string().max(200).nullable().optional(),
  sku: z.string().max(100).nullable().optional(),
  // Structured retailer SKU family (mig 0186). The wizard now maps the three
  // Wayfair SKU columns (+ Walmart/Lowe's/Amazon variants) to distinct fields
  // instead of collapsing them into `sku`. product_sku falls back to the
  // legacy `sku` for any caller still sending that.
  product_sku: z.string().max(64).nullable().optional(),
  site_sku: z.string().max(64).nullable().optional(),
  manufacture_sku: z.string().max(64).nullable().optional(),
  catalog_id: z.string().max(64).nullable().optional(),
  order_id: z.string().max(64).nullable().optional(),
  po_number: z.string().max(64).nullable().optional(),
  upc: z.string().max(32).nullable().optional(),
  asin: z.string().max(32).nullable().optional(),
  fnsku: z.string().max(32).nullable().optional(),
  lpn: z.string().max(64).nullable().optional(),
  // The operator's pre-existing identifier — supplier SKU, route stop,
  // pre-printed label code, whatever was already on the box.
  external_code: z.string().max(120).nullable().optional(),
  pallet_id: z.string().max(64).nullable().optional(),
  quantity: z.number().int().min(1).max(10_000).default(1),
  msrp_cents: z.number().int().nonnegative().nullable().optional(),
  cost_cents: z.number().int().nonnegative().nullable().optional(),
  starting_bid_cents: z.number().int().nonnegative().nullable().optional(),
  photo_url: z.string().url().nullable().optional(),
  condition: z
    .enum(['appears_new', 'open_box', 'good', 'as_is'])
    .nullable()
    .optional(),
  return_reason: z.string().max(200).nullable().optional(),
  // Wayfair per-box FedEx tracking. Already expanded client-side to one value
  // per row; capped at 64 chars (tracking numbers are ~12–22 digits).
  tracking_number: z.string().max(64).nullable().optional(),
  // Stable natural key for an UNTRACKED row, assigned by assignSourceKeys()
  // over the whole file before chunking — see lib/imports/source-key.ts. It
  // has to be computed client-side because the occurrence counter that
  // separates two identical units needs every row at once, and this action
  // only ever sees one 800-row chunk of the file.
  //
  // A caller that omits it gets NULL, which is exactly today's behaviour: no
  // conflict target can fire for an untracked row, so the rows insert. That
  // is the bug, not a safe default — any new caller sending untracked rows
  // should run them through assignSourceKeys first.
  source_key: z.string().max(200).nullable().optional(),
  // Verbatim source row (original manifest column names → values), preserved so
  // manifest-specific fields that don't have a dedicated import_rows column —
  // e.g. Wayfair's three SKUs (ProductSKU / SiteSKU / ManufactureSKU) — survive
  // to lotting where buildManifestCandidate (field-mobile) can surface them.
  // Stored in the existing import_rows.raw_data JSONB. No server path reads
  // specific keys; only the mobile manifest-prefill does.
  raw_data: z.record(z.string(), z.unknown()).nullable().optional(),
});

const commitSchema = z.object({
  filename: z.string().min(1).max(200),
  source_label: z.string().max(50).nullable().optional(),
  // Mapping is one source column → many internal fields, so a
  // manifest with a single "Description" column can populate both
  // title and description from it.
  mapping: z.record(z.string(), z.array(z.string())).optional(),
  // Optional warehouse — operators sometimes know which warehouse a
  // truck is destined for, sometimes don't. NULL is fine; intake
  // scanning is what assigns warehouse + bin authoritatively.
  warehouse_id: z.string().uuid().nullable().optional(),
  rows: z.array(importRowSchema).min(1).max(35_000),
  // Chunked upload: the first request omits importId and creates the imports
  // audit row; the server returns its id, which the client passes back on every
  // subsequent chunk so they all append to the SAME import (one import per
  // file) while each request stays well under the server-action body limit.
  // finalize=true on the last chunk rolls up row_count/classified_count and
  // flips the import to completed.
  importId: z.string().uuid().optional(),
  finalize: z.boolean().optional(),
});

export type CommitInput = z.infer<typeof commitSchema>;

export type CommitResult =
  | {
      ok: true;
      importId: string;
      created: number;
      classified: number;
      // B4 (2026-05-24 audit): when the category resolver RPC fails, the
      // import still completes but every row gets category_id=null. Surface
      // that as a non-fatal warning so the UI can tell the operator their
      // rows landed but need manual classification, instead of just showing
      // "classified: 0" with no diagnostic.
      categoryWarning?: string;
      // Re-import dedup: rows skipped because the row already existed (prior
      // import or within-batch repeat) — keyed on (operator_id,
      // tracking_number) for tracked boxes, (operator_id, source_key) for
      // untracked ones.
      duplicatesSkipped?: number;
      // Task #138: number of UPCs that contributed a row to product_lookups.
      // Only present when IMPORT_SEED_CATALOG=1 is set.
      catalogSeeded?: number;
    }
  | { ok: false; error: string };

// Auto-classify rows' categories via the SQL-side batch resolver
// (migration 0033's `resolve_category_ids_batch`). One round-trip
// classifies all 2000 rows of a max-sized import; previously we pulled
// the entire alias table per import + looped in JS per row.
//
// Returns an array aligned 1:1 with the input strings: position N in
// the output corresponds to position N in the input. Also returns a
// `failed` flag so the caller (B4 from 2026-05-24 audit) can propagate
// a categoryWarning to the UI instead of silently shipping classified=0.
type CategoryResolveResult = {
  ids: Array<string | null>;
  failed: boolean;
  errorMessage?: string;
};

async function resolveCategoryIdsBatch(
  admin: ReturnType<typeof getSupabaseAdmin>,
  texts: string[],
): Promise<CategoryResolveResult> {
  if (texts.length === 0) return { ids: [], failed: false };
  const { data, error } = await admin.rpc('resolve_category_ids_batch', {
    p_texts: texts,
  });
  if (error || !data) {
    console.warn('[commitImport] resolve_category_ids_batch failed:', error?.message);
    return {
      ids: texts.map(() => null),
      failed: true,
      errorMessage: error?.message,
    };
  }
  // The RPC returns rows of { input_idx: int (1-based), category_id: uuid|null }.
  const result: Array<string | null> = new Array(texts.length).fill(null);
  for (const row of data as Array<{ input_idx: number; category_id: string | null }>) {
    const idx = row.input_idx - 1;
    if (idx >= 0 && idx < result.length) result[idx] = row.category_id ?? null;
  }
  return { ids: result, failed: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// Task #138 — catalog warm-up: seed product_lookups from manifest rows.
//
// Gated behind IMPORT_SEED_CATALOG=1. Default OFF in production until
// validated in staging. Set the env var to enable.
//
// Rules (enforced here):
//   • high/medium existing rows: extend image_urls only, never overwrite identity.
//   • low/none/missing rows: upsert full identity at confidence='low'|'medium'.
//   • NEVER write prices / sold_comps / avg_asking_cents / median_sold_cents /
//     start_bid_cents / prices_refreshed_at — those are precious eBay data.
//   • Failures are non-fatal: import succeeds with a warning.
//   • Idempotent: re-running same manifest is safe.
// ─────────────────────────────────────────────────────────────────────────────

type SeedRow = {
  upc: string;
  title: string;
  brand: string | null;
  model: string | null;
  category_id: string | null;
  category_raw: string | null;
  msrp_cents: number | null;
  photo_url: string | null;
  description: string | null;
};

type CatalogSeedResult = {
  seeded: number;
  warning?: string;
};

async function seedProductLookups(
  admin: ReturnType<typeof getSupabaseAdmin>,
  rows: SeedRow[],
): Promise<CatalogSeedResult> {
  if (rows.length === 0) return { seeded: 0 };

  const CHUNK = 500;
  let seeded = 0;

  try {
    // Process in bounded parallel chunks to keep latency manageable on
    // large manifests (22k rows / 500 = 44 parallel-bounded round-trips).
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const upcs = chunk.map((r) => r.upc);

      // Fetch existing rows for this chunk in one SELECT.
      const { data: existing } = await admin
        .from('product_lookups')
        .select('upc, confidence, image_urls, sources')
        .in('upc', upcs);

      const existingMap = new Map<
        string,
        { confidence: string; image_urls: string[]; sources: string[] }
      >();
      for (const row of existing ?? []) {
        existingMap.set(row.upc as string, {
          confidence: row.confidence as string,
          image_urls: (row.image_urls as string[]) ?? [],
          sources: (row.sources as string[]) ?? [],
        });
      }

      // Build upserts and targeted image-extend updates separately.
      const toUpsert: Record<string, unknown>[] = [];
      const imageExtends: Array<{ upc: string; image_urls: string[]; sources: string[] }> = [];

      for (const row of chunk) {
        const ex = existingMap.get(row.upc);

        if (ex && (ex.confidence === 'high' || ex.confidence === 'medium')) {
          // Catalog already has good identity — only extend image_urls if
          // the manifest photo is new.
          if (row.photo_url && !ex.image_urls.includes(row.photo_url)) {
            imageExtends.push({
              upc: row.upc,
              image_urls: [...ex.image_urls, row.photo_url],
              sources: Array.from(new Set([...ex.sources, 'manifest_import'])),
            });
            seeded++;
          }
          continue;
        }

        // New row OR low/none confidence — seed full identity.
        const seedConfidence = row.photo_url ? 'medium' : 'low';
        const seedImages = row.photo_url ? [row.photo_url] : [];

        toUpsert.push({
          upc: row.upc,
          title: row.title,
          brand: row.brand,
          model: row.model,
          category_id: row.category_id,
          category_raw: row.category_raw,
          image_urls: seedImages,
          msrp_cents: row.msrp_cents,
          // NEVER set: prices, sold_comps, avg_asking_cents, median_sold_cents,
          // start_bid_cents, prices_refreshed_at — those are precious eBay data.
          description: row.description,
          confidence: seedConfidence,
          sources: ['manifest_import'],
          identity_refreshed_at: new Date().toISOString(),
        });
        seeded++;
      }

      // Fire upserts + image-extends in parallel for this chunk.
      // PromiseLike (not Promise) — Supabase PostgrestBuilder.then() returns PromiseLike;
      // Promise.all accepts both per TS lib types.
      const ops: PromiseLike<unknown>[] = [];

      if (toUpsert.length > 0) {
        ops.push(
          admin
            .from('product_lookups')
            .upsert(toUpsert, { onConflict: 'upc' })
            .then(({ error }) => {
              if (error) {
                console.warn('[catalog-seed] upsert chunk error:', error.message);
              }
            }),
        );
      }

      for (const ext of imageExtends) {
        ops.push(
          admin
            .from('product_lookups')
            .update({ image_urls: ext.image_urls, sources: ext.sources })
            .eq('upc', ext.upc)
            .then(({ error }) => {
              if (error) {
                console.warn('[catalog-seed] image-extend error:', ext.upc, error.message);
              }
            }),
        );
      }

      await Promise.all(ops);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[catalog-seed] unexpected error:', msg);
    return { seeded, warning: `Catalog seed partial failure: ${msg}` };
  }

  return { seeded };
}

export async function commitImport(input: CommitInput): Promise<CommitResult> {
  const parsed = commitSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid input' };
  }

  const supabase = await getSupabaseServer();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, error: 'Not authenticated' };

  const { data: staff } = await supabase
    .from('operator_users')
    .select('operator_id, role')
    .eq('user_id', user.id)
    .single();
  if (!staff) return { ok: false, error: 'Not an operator' };
  if (staff.role !== 'admin' && staff.role !== 'manager') {
    return { ok: false, error: 'Admins or managers only can import' };
  }
  const operatorId = staff.operator_id as string;

  const admin = getSupabaseAdmin();

  // If the operator passed a warehouse_id, cross-check it belongs to
  // them. NULL is fine — the manifest may pre-date a known warehouse.
  // Only on the first chunk (creation); later chunks reuse the import.
  if (!parsed.data.importId && parsed.data.warehouse_id) {
    const { data: whCheck } = await admin
      .from('warehouses')
      .select('id')
      .eq('id', parsed.data.warehouse_id)
      .eq('operator_id', operatorId)
      .single();
    if (!whCheck) return { ok: false, error: 'Warehouse not found' };
  }

  // Build classification inputs (one string per row, the same shape the
  // old JS resolver was matching against — category_raw + title joined).
  // Then batch-resolve via the SQL-side RPC.
  //
  // B7 (2026-05-24 audit): only rows with non-empty category_raw or
  // sub_category_raw need the RPC. Title-only rows always classify
  // null and just waste RPC payload bytes. We keep a parallel index map
  // so we can merge results back into the full-row array preserving
  // 1:1 alignment with parsed.data.rows.
  const classifyIndexes: number[] = [];
  const classifyInputs: string[] = [];
  for (let i = 0; i < parsed.data.rows.length; i++) {
    const row = parsed.data.rows[i]!;
    const cat = row.category_raw?.trim();
    const sub = row.sub_category_raw?.trim();
    if (!cat && !sub) continue;
    classifyIndexes.push(i);
    classifyInputs.push(
      `${row.category_raw ?? ''} ${row.sub_category_raw ?? ''} ${row.title}`.toLowerCase(),
    );
  }
  const categoryResolve = await resolveCategoryIdsBatch(admin, classifyInputs);
  // Reassemble full-length array (null for rows we skipped) so the
  // row-build loop below can index into it directly.
  const resolvedCategoryIds: Array<string | null> = new Array(parsed.data.rows.length).fill(null);
  for (let k = 0; k < classifyIndexes.length; k++) {
    resolvedCategoryIds[classifyIndexes[k]!] = categoryResolve.ids[k] ?? null;
  }
  const categoryWarning = categoryResolve.failed
    ? 'Category resolution failed — rows imported but need manual classification.'
    : undefined;

  // First chunk creates the import audit row; later chunks pass its id back and
  // append to it (so a multi-chunk upload is still ONE import). A passed
  // importId is validated against this operator before we append to it.
  let imp: { id: string };
  if (parsed.data.importId) {
    const { data: existing } = await admin
      .from('imports')
      .select('id')
      .eq('id', parsed.data.importId)
      .eq('operator_id', operatorId)
      .single();
    if (!existing) return { ok: false, error: 'Import not found' };
    imp = { id: existing.id as string };
  } else {
    const { data: created, error: impErr } = await admin
      .from('imports')
      .insert({
        operator_id: operatorId,
        filename: parsed.data.filename,
        source_label: parsed.data.source_label ?? null,
        mapping: parsed.data.mapping ?? {},
        created_by: user.id,
        // imports.status DEFAULTs to 'completed' — fine for the old single-call
        // path, but wrong here: the upload spans many chunked requests and only
        // finalize flips it to completed. Start 'processing' so an abandoned or
        // failed multi-chunk upload never reads as "completed / 0 rows" while
        // its boxes sit in the pool.
        status: 'processing',
      })
      .select('id')
      .single();
    if (impErr || !created) return { ok: false, error: impErr?.message ?? 'audit insert failed' };
    imp = { id: created.id as string };
  }

  // Build import_rows. Imports go into the manifest pool — they don't
  // become real lots until an operator (or LotTR) explicitly lots them.
  // No lot_code is minted here; codes only get burned at lotting time.
  const importRowsToInsert: Array<Record<string, unknown>> = [];
  let classified = 0;

  // Strip leading zero / non-digit chars for ID columns. Amazon manifests
  // sometimes ship UPC=`0` for books; prefer EAN as fallback if it's also
  // available via the wizard mapping (for now only one of them is mapped).
  const cleanDigits = (s: string | null | undefined, min = 8, max = 14) => {
    if (!s) return null;
    const d = String(s).replace(/[^0-9]/g, '');
    return d.length >= min && d.length <= max ? d : null;
  };

  for (let rowIdx = 0; rowIdx < parsed.data.rows.length; rowIdx++) {
    const row = parsed.data.rows[rowIdx]!;
    // Wayfair: per-box FedEx tracking. Already expanded client-side to one
    // value per row; dedup against prior imports happens at insert via
    // ON CONFLICT (operator_id, tracking_number) DO NOTHING.
    const tracking = (row.tracking_number ?? '').trim().slice(0, 64) || null;
    const categoryId = resolvedCategoryIds[rowIdx] ?? null;
    if (categoryId) classified++;

    // Normalize UPC: prefer the dedicated upc column, fall back to
    // external_code if it looks like a UPC.
    const upc = cleanDigits(row.upc) ?? cleanDigits(row.external_code);

    const title = row.title.trim().slice(0, 500);
    // Fall back to dictionary extraction when the manifest CSV has no brand
    // column or left it empty. This enriches the majority of scraper rows and
    // brand-less Amazon return manifests at zero extra cost.
    const brandRaw = row.brand?.trim().slice(0, 120) ?? null;
    const brand = brandRaw ?? (extractBrand(title)?.slice(0, 120) ?? null);

    importRowsToInsert.push({
      operator_id: operatorId,
      import_id: imp.id,
      // Prefer the verbatim source row (preserves all manifest columns, incl.
      // Wayfair's three SKUs) when the wizard supplied it; fall back to the
      // mapped row for any caller that doesn't.
      raw_data: row.raw_data ?? row,
      title,
      description: row.description?.slice(0, 5000) ?? null,
      brand,
      model: row.model?.trim().slice(0, 120) ?? null,
      category_raw: row.category_raw ?? null,
      sub_category_raw: row.sub_category_raw ?? null,
      category_id: categoryId,
      upc,
      asin: row.asin?.trim().slice(0, 32) ?? null,
      fnsku: row.fnsku?.trim().slice(0, 32) ?? null,
      lpn: row.lpn?.trim().slice(0, 64) ?? null,
      external_code: row.external_code?.trim().slice(0, 120) || null,
      pallet_id: row.pallet_id?.trim().slice(0, 64) ?? null,
      // Structured retailer SKU family (mig 0186). product_sku falls back to
      // the legacy single `sku` field for any caller still sending it.
      product_sku: (row.product_sku ?? row.sku)?.trim().slice(0, 64) ?? null,
      site_sku: row.site_sku?.trim().slice(0, 64) ?? null,
      manufacture_sku: row.manufacture_sku?.trim().slice(0, 64) ?? null,
      catalog_id: row.catalog_id?.trim().slice(0, 64) ?? null,
      order_id: row.order_id?.trim().slice(0, 64) ?? null,
      po_number: row.po_number?.trim().slice(0, 64) ?? null,
      quantity: row.quantity ?? 1,
      msrp_cents: row.msrp_cents ?? null,
      cost_cents: row.cost_cents ?? null,
      starting_bid_cents: row.starting_bid_cents ?? null,
      // normalisePhotoUrl strips NA / N/A / null / none / - / non-http(s) values
      // so placeholder strings from Wayfair/Amazon manifests never land in the DB.
      // Defense in depth: the drain also checks before any API call.
      photo_url: normalisePhotoUrl(row.photo_url),
      condition: row.condition ?? null,
      return_reason: row.return_reason?.trim().slice(0, 200) ?? null,
      tracking_number: tracking,
      // mig 0310 keeps source_key untracked-only, and enforces it with a
      // partial unique index that a tracked row carrying a key would join
      // for no reason. The invariant is asserted here rather than trusted
      // from the client: a caller that sets both gets the tracked keying,
      // which is the stronger of the two.
      source_key: tracking ? null : (row.source_key ?? null),
      warehouse_id: parsed.data.warehouse_id ?? null,
      status: 'pending',
    });
  }

  if (importRowsToInsert.length === 0) {
    await admin
      .from('imports')
      .update({ status: 'failed', error: 'No valid rows', row_count: 0 })
      .eq('id', imp.id);
    return { ok: false, error: 'No rows had a usable title' };
  }

  // Bulk insert in chunks.
  //
  // B1 (2026-05-24 audit): bumped from 200 to 2000. A 91k-lot BinGo
  // manifest at CHUNK=200 was doing 455 sequential round-trips to
  // `import_rows` (~9-15s of pure latency). Supabase payload limit is
  // 8MB; at the typical ~600-byte serialized row size, 2000 rows is
  // ~1.2MB — comfortably under the cap with headroom for fat rows.
  const CHUNK = 2000;
  let inserted = 0;
  // Re-import dedup: rows that already exist are skipped (ON CONFLICT DO
  // NOTHING) rather than failing the chunk, so a partial re-upload still
  // lands the new boxes.
  let duplicatesSkipped = 0;
  // Collect all newly-inserted import_row IDs so we can enqueue enrichment
  // jobs below (before seedProductLookups — compose order).
  const insertedRowIds: string[] = [];

  async function writeBatch(
    batch: Array<Record<string, unknown>>,
    onConflict: string | null,
  ): Promise<string | null> {
    for (let i = 0; i < batch.length; i += CHUNK) {
      const chunk = batch.slice(i, i + CHUNK);
      const table = admin.from('import_rows');
      const { data, error } = await (onConflict
        ? table.upsert(chunk, { onConflict, ignoreDuplicates: true })
        : table.insert(chunk)
      ).select('id');
      if (error) {
        // The per-chunk write is atomic — a failed chunk inserted NOTHING, so
        // there's no partial slice to clean. Under the chunked-append model,
        // earlier chunks committed in *prior requests* are valid inventory that
        // happen to share this import_id; the old single-call B3 cleanup
        // (`delete().eq('import_id', imp.id)`) would wipe those real boxes on a
        // transient blip. So we DON'T delete — just report and let the caller
        // mark the import failed, keeping what landed. Re-uploading is
        // dedup-safe for both keyed populations below.
        return error.message;
      }
      const chunkIds = (data ?? []).map((r) => (r as { id: string }).id);
      insertedRowIds.push(...chunkIds);
      inserted += chunkIds.length;
      duplicatesSkipped += chunk.length - chunkIds.length;
    }
    return null;
  }

  // ONE CONFLICT TARGET PER POPULATION — a single write can only name one,
  // and these have different keys. Splitting here mirrors what
  // scripts/import-d2l-manifest.mjs has done since mig 0310.
  //
  //   tracked   → (operator_id, tracking_number), import_rows_tracking_uniq.
  //               Never broken; the only target this action used to have.
  //   untracked → (operator_id, source_key), mig 0310's partial
  //               import_rows_source_key_uniq. Pointing untracked rows at the
  //               tracking target was the bug: tracking_number is NULL there,
  //               NULLs never conflict in a unique btree, so every re-upload
  //               re-inserted the whole untracked population. Same failure the
  //               daily D2L feed had (+812 rows/day until 0310).
  //   unkeyed   → plain insert. A caller that sent untracked rows without
  //               running assignSourceKeys still gets today's behaviour rather
  //               than an error; it just doesn't get dedup.
  const populations: Array<[Array<Record<string, unknown>>, string | null]> = [
    [importRowsToInsert.filter((r) => r.tracking_number !== null), 'operator_id,tracking_number'],
    [
      importRowsToInsert.filter((r) => r.tracking_number === null && r.source_key !== null),
      'operator_id,source_key',
    ],
    [
      importRowsToInsert.filter((r) => r.tracking_number === null && r.source_key === null),
      null,
    ],
  ];

  for (const [batch, onConflict] of populations) {
    if (batch.length === 0) continue;
    const failure = await writeBatch(batch, onConflict);
    if (failure) {
      await admin
        .from('imports')
        .update({
          status: 'failed',
          error: failure,
        })
        .eq('id', imp.id);
      return { ok: false, error: failure };
    }
  }

  // ── Image enrichment jobs — enqueue BEFORE seedProductLookups ───────────
  // One 'pending' job per newly-inserted import_row. The drain
  // (image-enrichment-drain.ts) handles all resolution asynchronously; the
  // import request does NOT wait. ON CONFLICT DO NOTHING is idempotent —
  // re-importing the same manifest (tracking dedup) won't double-enqueue.
  //
  // CRITICAL compose order: this must run BEFORE seedProductLookups below
  // so the catalog always sees the normalised photo_url (which we wrote to
  // import_rows above via normalisePhotoUrl). seedProductLookups reads
  // import_rows.photo_url; the enrichment jobs queue ensures any missing
  // images are filled in later without blocking the commit.
  if (insertedRowIds.length > 0) {
    const JOB_CHUNK = 2000;
    for (let i = 0; i < insertedRowIds.length; i += JOB_CHUNK) {
      const jobChunk = insertedRowIds.slice(i, i + JOB_CHUNK).map((rowId) => ({
        operator_id: operatorId,
        target_table: 'import_rows',
        target_id: rowId,
        status: 'pending',
      }));
      await admin
        .from('image_enrichment_jobs')
        .upsert(jobChunk, { onConflict: 'target_table,target_id', ignoreDuplicates: true })
        .then(undefined, (err: unknown) => {
          // Non-fatal: enrichment is best-effort. Import succeeds regardless.
          console.warn(
            '[commitImport] image_enrichment_jobs enqueue partial failure:',
            (err as Error)?.message,
          );
        });
    }
  }

  // ── Task #138: catalog warm-up ───────────────────────────────────────────
  // Seed product_lookups from manifest rows so the catalog has identity data
  // before any staff member scans these items at lotting time. Gated behind
  // IMPORT_SEED_CATALOG=1. Non-fatal: failure returns ok with a warning.
  let catalogSeeded: number | undefined;
  let catalogWarning: string | undefined;
  if (process.env['IMPORT_SEED_CATALOG'] === '1') {
    // Build seed rows from the parsed input, not importRowsToInsert, because
    // we need the resolvedCategoryIds array which aligns 1:1 with parsed.data.rows.
    const seedRows: SeedRow[] = [];
    for (let rowIdx = 0; rowIdx < parsed.data.rows.length; rowIdx++) {
      const row = parsed.data.rows[rowIdx]!;
      // Use normalizeUpcStrict here (not cleanDigits) so fake/bogus UPCs are
      // rejected and never poison the catalog.
      const upc = normalizeUpcStrict(row.upc) ?? normalizeUpcStrict(row.external_code);
      if (!upc) continue;

      const title = row.title.trim().slice(0, 500);
      const brandRaw = row.brand?.trim().slice(0, 120) ?? null;
      const brand = brandRaw ?? (extractBrand(title)?.slice(0, 120) ?? null);

      seedRows.push({
        upc,
        title,
        brand,
        model: row.model?.trim().slice(0, 120) ?? null,
        category_id: resolvedCategoryIds[rowIdx] ?? null,
        category_raw: row.category_raw ?? null,
        msrp_cents: row.msrp_cents ?? null,
        // Use normalisePhotoUrl here too so the catalog never receives
        // NA-shape strings. Consistent with the import_rows.photo_url write above.
        photo_url: normalisePhotoUrl(row.photo_url),
        description: row.description?.slice(0, 5000) ?? null,
      });
    }

    const seedResult = await seedProductLookups(admin, seedRows);
    catalogSeeded = seedResult.seeded;
    if (seedResult.warning) {
      catalogWarning = seedResult.warning;
      console.warn('[commitImport] catalog seed warning:', seedResult.warning);
    }
  }

  // Auto-warm the product cache for this chunk's UPCs. Fire-and-forget — the
  // BullMQ workers handle retries, the cache fills in the background, and the
  // operator doesn't wait. We pull UPCs from BOTH `upc` and `external_code`
  // because operators sometimes map their UPC column to one or the other.
  const upcs: string[] = [];
  for (const row of parsed.data.rows) {
    const candidates = [row.upc, row.external_code];
    for (const c of candidates) {
      if (c && /^\d{8,14}$/.test(c.trim())) {
        upcs.push(c.trim());
      }
    }
  }
  void enqueueCacheWarm(upcs, 'import').catch((err) => {
    console.warn('[cache-warm] import enqueue failed', err);
  });

  // Final chunk: roll up the TRUE totals from the table (each chunk only knows
  // its own slice — `inserted`/`classified` are per-chunk) and flip the import
  // to completed. Earlier chunks leave it non-completed so a mid-upload failure
  // stays visible. row_count tracks manifest rows landed in the pool, not lots.
  if (parsed.data.finalize) {
    const { count: rowCount } = await admin
      .from('import_rows')
      .select('id', { count: 'exact', head: true })
      .eq('import_id', imp.id);
    const { count: classifiedCount } = await admin
      .from('import_rows')
      .select('id', { count: 'exact', head: true })
      .eq('import_id', imp.id)
      .not('category_id', 'is', null);
    await admin
      .from('imports')
      .update({
        row_count: rowCount ?? inserted,
        classified_count: classifiedCount ?? classified,
        status: 'completed',
      })
      .eq('id', imp.id);
    revalidatePath('/imports');
    revalidatePath('/inventory');
  }

  // Merge category resolution warning and catalog seed warning — both are
  // non-fatal. If both fired, concatenate them with a separator.
  const combinedWarning =
    categoryWarning && catalogWarning
      ? `${categoryWarning} ${catalogWarning}`
      : (categoryWarning ?? catalogWarning);

  return {
    ok: true,
    importId: imp.id,
    created: inserted,
    classified,
    ...(combinedWarning ? { categoryWarning: combinedWarning } : {}),
    ...(duplicatesSkipped > 0 ? { duplicatesSkipped } : {}),
    ...(catalogSeeded !== undefined ? { catalogSeeded } : {}),
  };
}
