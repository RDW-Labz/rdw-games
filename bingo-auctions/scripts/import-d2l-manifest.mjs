#!/usr/bin/env node
// =============================================================================
// scripts/import-d2l-manifest.mjs
//
// Imports a D2L Wayfair-returns manifest JSON (the owner's "d2l fetch" app
// drops these in the shared Drive folder "D2L manifests" as
// Harrison_ir_<date>.json) into the standard manifest pool:
// one `imports` audit row + `import_rows` (status=pending), one row per
// physical box (FedEx tracking token), deduped via ON CONFLICT DO NOTHING.
//
// Two populations, two conflict targets:
//   tracked   → (operator_id, tracking_number). Never broken; unchanged.
//   untracked → (operator_id, source_key), mig 0310. source_key keys on UNIT
//               IDENTITY: 'u:<unit_id>' when the producer supplies one, else
//               'nk:<ItemNumber>:<0..ReturnedQuantity-1>'.
// source_key exists because the older (operator_id, tracking_number) target
// silently did nothing for untracked boxes — NULLs are distinct in a UNIQUE
// btree — so the daily import-d2l-folder workflow re-inserted every untracked
// box on every run (18,297 rows for 923 real units before the cleanup).
// It is deliberately NULL on tracked rows; see mig 0310.
//
// The two untracked branches exist because the two manifest shapes fail
// differently: the snake_case export re-inserts whole (its unit_id is already
// unique per run), while the PascalCase export fans ONE unit out into one
// entry per UPC/catalog-photo variant — 500 entries for a single
// ReturnedQuantity="1" item in the worst prod case.
//
// From there the EXISTING pipeline takes over: staff scan any barcode on the
// FedEx return label (mig 0163 normalizes the 34-digit composite down to the
// 12-digit tracking) and intake_lot_to_bin mints the lot.
//
// D2L item shape (observed 2026-07-07):
//   { OrderID, PONumber, ItemNumber, OrderQuantity, ReturnedQuantity,
//     ReturnReason, ProductSKU, SiteSKU, ManufactureSKU, CatalogID,
//     SKUActive, ProductName, UPC, ReturnCarrier, ReturnInitiatedDate,
//     ReturnTrackingNumber ("797959221068, 797959221079"), DeliveryNote,
//     EstReturnDeliveryDate, ReturnDeliveryDate, Filtered_SKU,
//     RetailPrice_avg ("49.99"), ImageURL (url | "NA") }
//
// Duplicate catalog variants (same order + tracking repeated with different
// UPCs) collapse naturally: the first entry claims the tracking tokens, the
// repeats hit the dedupe conflict.
//
// Usage:
//   node scripts/import-d2l-manifest.mjs --file /tmp/manifest.json --filename Harrison_ir_2026-07-06.json
// Env: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
// =============================================================================

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Only run main() and its CLI/env checks when invoked directly, so the unit
// test can import the exported helpers without a manifest or credentials.
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

const args = process.argv.slice(2);
const flags = { file: null, filename: 'd2l-manifest.json' };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--file') flags.file = args[++i];
  else if (args[i] === '--filename') flags.filename = args[++i];
}
if (invokedDirectly && !flags.file) {
  console.error('usage: import-d2l-manifest.mjs --file <path> [--filename <label>]');
  process.exit(1);
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (invokedDirectly && (!SUPABASE_URL || !SERVICE_KEY)) {
  console.error('FATAL: NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');
  process.exit(1);
}

const HEADERS = {
  apikey: SERVICE_KEY,
  Authorization: `Bearer ${SERVICE_KEY}`,
  'Content-Type': 'application/json',
};

async function rest(path, init = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: { ...HEADERS, ...(init.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

// Same semantics as lib/imports/expand-tracking.ts (web wizard), plus ';'
// (lotting_export.json joins multi-box tracking with "; ").
const TRACKING_SPLIT_RE = /[\s,;]+/;
const TRACKING_TOKEN_RE = /^\d{12,14}$/;
function trackingTokens(raw) {
  if (!raw) return [];
  return String(raw)
    .split(TRACKING_SPLIT_RE)
    .map((t) => t.trim())
    .filter((t) => TRACKING_TOKEN_RE.test(t));
}

const digitsOnly = (s) => (s ? String(s).replace(/\D/g, '') : '');

// Two known manifest shapes from the owner's d2l fetch tool:
//   Harrison_ir_*.json   — PascalCase (ProductName, ReturnTrackingNumber, …)
//   lotting_export.json  — snake_case (product_name, tracking_numbers, …)
// Normalize either into one internal shape. First non-empty field wins.
const pick = (it, ...keys) => {
  for (const k of keys) {
    const v = it[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return null;
};
function normalizeEntry(it) {
  return {
    productName: pick(it, 'ProductName', 'product_name'),
    retailPrice: pick(it, 'RetailPrice_avg', 'retail_price'),
    upc: pick(it, 'UPC', 'upcs'),
    siteSku: pick(it, 'SiteSKU', 'filtered_sku'),
    productSku: pick(it, 'ProductSKU', 'product_sku'),
    manufactureSku: pick(it, 'ManufactureSKU', 'manufacture_sku'),
    returnReason: pick(it, 'ReturnReason', 'return_reason'),
    tracking: pick(it, 'ReturnTrackingNumber', 'tracking_numbers'),
    imageUrl: pick(it, 'ImageURL', 'image_url'),
    orderId: pick(it, 'OrderID', 'order_id'),
    poNumber: pick(it, 'PONumber', 'po_number'),
    // Unit identity (mig 0310). unit_id is the snake_case export's own
    // per-physical-unit id — the strongest key available. The PascalCase
    // export has no equivalent; there, ItemNumber names the return LINE and
    // ReturnedQuantity says how many units are behind it.
    unitId: pick(it, 'unit_id'),
    itemNumber: pick(it, 'ItemNumber', 'item_number'),
    returnedQty: pick(it, 'ReturnedQuantity', 'returned_quantity'),
  };
}

// ReturnedQuantity arrives as a string ("1", "9"). Anything non-numeric or
// absent means one unit — never zero, or the line would vanish from the pool.
const unitCount = (v) => {
  const n = Number.parseInt(String(v ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
};

// Empty-import load (#533). The imports INSERT fires mig 0148's
// auto_create_load_from_import, which mints one auto-import load per import
// (loads_import_unique_idx keeps it 1:1). Most daily files dedupe to 0 new
// rows, which left an empty load in the staff picker every morning. Archive,
// never delete: the load and the import stay as the audit trail of the run.
// Pure so the test can check it without network.
export function emptyImportLoadPatch(inserted, importId, nowIso) {
  if (inserted !== 0) return null;
  return {
    path: `loads?import_id=eq.${importId}&type=eq.auto-import&archived_at=is.null`,
    body: { archived_at: nowIso },
  };
}

// Non-fatal by design: the rows (none) are already in, so a failed archive
// just leaves the old empty load behind — a warning, not a failed import.
export async function archiveEmptyImportLoad(inserted, importId, restFn, nowIso = new Date().toISOString()) {
  const patch = emptyImportLoadPatch(inserted, importId, nowIso);
  if (!patch) return 'skipped';
  try {
    await restFn(patch.path, { method: 'PATCH', body: JSON.stringify(patch.body) });
    console.log('empty import: load archived');
    return 'archived';
  } catch (e) {
    console.warn(`WARN: empty import, load archive failed (left in picker): ${e.message}`);
    return 'failed';
  }
}

async function main() {
  const items = JSON.parse(readFileSync(flags.file, 'utf8'));
  if (!Array.isArray(items) || items.length === 0) {
    console.error('FATAL: manifest is not a non-empty JSON array');
    process.exit(1);
  }
  console.log(`Parsed ${items.length} manifest entries from ${flags.filename}`);

  // Single-operator platform: the one non-demo operator is BinGo.
  const ops = await rest('operators?select=id,business_name&is_demo=eq.false&limit=1');
  if (!ops?.length) throw new Error('no non-demo operator found');
  const operatorId = ops[0].id;
  console.log(`Operator: ${ops[0].business_name} (${operatorId})`);

  // Audit row.
  const [imp] = await rest('imports', {
    method: 'POST',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify({
      operator_id: operatorId,
      filename: flags.filename,
      source_label: 'wayfair-d2l',
      mapping: { source: 'd2l-manifest-json', imported_via: 'scripts/import-d2l-manifest.mjs' },
      status: 'completed',
    }),
  });

  // Item numbers already represented by unit_id-keyed rows. The two exports
  // overlap — 115 of 226 legacy item numbers on prod also arrive in the
  // snake_case export — and the snake_case one is authoritative because it
  // carries real per-unit identity. Without this set, a PascalCase re-import
  // would re-add an 'nk:<ItemNumber>:0' row beside the 'u:<unit_id>' rows for
  // the same physical unit: different keys, so the unique index cannot catch
  // it. mig 0310 deletes that overlap once; this keeps it from coming back.
  const modernItemNumbers = new Set();
  try {
    for (let offset = 0; ; offset += 1000) {
      const page = await rest(
        // Aliased so the response key is 'item_number' regardless of how
        // PostgREST would otherwise name a JSON-path projection.
        'import_rows?select=item_number:raw_data->>item_number' +
          '&tracking_number=is.null&raw_data->>unit_id=not.is.null' +
          `&limit=1000&offset=${offset}`,
      );
      if (!page?.length) break;
      for (const r of page) if (r.item_number) modernItemNumbers.add(String(r.item_number));
      if (page.length < 1000) break;
    }
    console.log(`${modernItemNumbers.size} item numbers already keyed by unit_id`);
  } catch (e) {
    // Non-fatal: worst case is the pre-0310 overlap behaviour, not a failed
    // import. Loud, because it silently reintroduces duplicates.
    console.warn(`WARN: unit_id overlap check failed, importing without it: ${e.message}`);
  }

  // Map D2L entries → import_rows, one per tracking token.
  const rows = [];
  const seenTracking = new Set(); // within-batch dedupe
  const seenUnitId = new Set(); // within-batch dedupe on unit_id
  const seenItemNumber = new Set(); // collapses the PascalCase UPC fan-out
  const untrackedOccurrence = new Map(); // (order_id|product_sku) → next index
  let noTracking = 0;
  let fanoutCollapsed = 0;
  let supersededByUnitId = 0;
  for (const it of items) {
    const n = normalizeEntry(it);
    const title = (n.productName ?? '').toString().trim().slice(0, 500);
    if (!title) continue;
    const msrp = Number.parseFloat(n.retailPrice ?? '');
    const photo =
      n.imageUrl && n.imageUrl !== 'NA' && /^https?:\/\//.test(n.imageUrl)
        ? n.imageUrl
        : null;
    const upcDigits = digitsOnly(n.upc);
    const base = {
      import_id: imp.id,
      operator_id: operatorId,
      raw_data: it,
      title,
      upc: upcDigits.length >= 11 && upcDigits.length <= 14 ? upcDigits : null,
      // SiteSKU (W-number) is printed on Wayfair box labels — staff can type
      // or scan it as a fallback identifier.
      external_code: n.siteSku ? String(n.siteSku).slice(0, 64) : null,
      product_sku: n.productSku ? String(n.productSku).slice(0, 64) : null,
      site_sku: n.siteSku ? String(n.siteSku).slice(0, 64) : null,
      manufacture_sku: n.manufactureSku ? String(n.manufactureSku).slice(0, 64) : null,
      order_id: n.orderId ? String(n.orderId).slice(0, 64) : null,
      po_number: n.poNumber ? String(n.poNumber).slice(0, 64) : null,
      msrp_cents: Number.isFinite(msrp) ? Math.round(msrp * 100) : null,
      photo_url: photo,
      // Wayfair customer returns: damaged/defective reads as-is; everything
      // else is an open-box return.
      condition: n.returnReason === 'DamagedOrDefective' ? 'as_is' : 'open_box',
      status: 'pending',
    };
    const tokens = trackingTokens(n.tracking);
    if (tokens.length === 0) {
      noTracking += 1;
      // No tracking number means ON CONFLICT (operator_id, tracking_number)
      // can never fire for this row — Postgres treats NULLs as distinct, so
      // pre-0310 every untracked box was re-inserted on every daily run
      // (18,297 rows for 923 real units). Give it the stable natural key
      // mig 0310 enforces instead. Two producers, two shapes:

      // (a) snake_case export: unit_id IS the physical unit. One row each.
      //     Re-running the same file reproduces the identical keys and
      //     collides, which is what stops the +812/day growth.
      if (n.unitId) {
        const key = `u:${n.unitId}`;
        if (seenUnitId.has(key)) continue;
        seenUnitId.add(key);
        rows.push({ ...base, tracking_number: null, source_key: key });
        continue;
      }

      // (b) PascalCase export: no unit_id. One entry per UPC/catalog-photo
      //     variant of the SAME unit — prod's worst case is 500 entries for
      //     one ReturnedQuantity="1" item. Emit ReturnedQuantity rows on first
      //     sight of an ItemNumber and skip every later variant of it; the
      //     quantity, not the entry count, is the unit count.
      if (n.itemNumber) {
        const itemKey = String(n.itemNumber);
        if (seenItemNumber.has(itemKey)) {
          fanoutCollapsed += 1;
          continue;
        }
        // Already covered by unit_id-keyed rows — the authoritative shape.
        if (modernItemNumbers.has(itemKey)) {
          supersededByUnitId += 1;
          seenItemNumber.add(itemKey);
          continue;
        }
        seenItemNumber.add(itemKey);
        for (let u = 0; u < unitCount(n.returnedQty); u++) {
          rows.push({ ...base, tracking_number: null, source_key: `nk:${itemKey}:${u}` });
        }
        continue;
      }

      // (c) Neither key. Not observed on prod — every untracked row carries
      //     one or the other — but a row with no derivable identity still
      //     needs a distinct key rather than colliding with its neighbours.
      //     Partition EXACTLY as mig 0310's fallback does: (order_id,
      //     product_sku), title excluded. Prod has one group carrying two
      //     distinct titles under one (order_id, product_sku); including title
      //     here would hand both occurrence 0 and collide them.
      const gk = `${base.order_id ?? ''}|${base.product_sku ?? ''}`;
      const idx = untrackedOccurrence.get(gk) ?? 0;
      untrackedOccurrence.set(gk, idx + 1);
      rows.push({
        ...base,
        tracking_number: null,
        source_key: `nk:o:${base.order_id ?? ''}:${base.product_sku ?? ''}:${idx}`,
      });
      continue;
    }
    for (const t of tokens) {
      if (seenTracking.has(t)) continue;
      seenTracking.add(t);
      // source_key stays NULL on tracked rows: import_rows_tracking_uniq
      // already keys them and always has. These post under their own conflict
      // target below. See mig 0310's "WHY source_key IS UNTRACKED-ONLY".
      rows.push({ ...base, tracking_number: t, source_key: null });
    }
  }
  console.log(
    `Prepared ${rows.length} rows (${seenTracking.size} tracked boxes, ` +
      `${noTracking} entries without tracking → ${seenUnitId.size} by unit_id + ` +
      `${seenItemNumber.size - supersededByUnitId} by item number, ` +
      `${fanoutCollapsed} UPC variants collapsed, ` +
      `${supersededByUnitId} superseded by unit_id rows)`,
  );

  // Auto-classify categories in one RPC round-trip (same as the web wizard).
  try {
    const ids = await rest('rpc/resolve_category_ids_batch', {
      method: 'POST',
      body: JSON.stringify({ p_texts: rows.map((r) => r.title) }),
    });
    if (Array.isArray(ids)) {
      let classified = 0;
      rows.forEach((r, i) => {
        const id = ids[i]?.category_id ?? ids[i];
        if (id && typeof id === 'string') {
          r.category_id = id;
          classified += 1;
        }
      });
      console.log(`Auto-classified ${classified}/${rows.length} rows`);
    }
  } catch (e) {
    console.warn(`category resolve skipped: ${e.message}`);
  }

  // Chunked upsert, ONE CONFLICT TARGET PER POPULATION — they have different
  // keys and a single POST can only name one target.
  //
  //   tracked   → (operator_id, tracking_number), import_rows_tracking_uniq.
  //               Never broken; unchanged since before mig 0309.
  //   untracked → (operator_id, source_key), mig 0310's partial
  //               import_rows_source_key_uniq. The old code pointed BOTH at
  //               (operator_id, tracking_number), which is NULL here — and
  //               NULLs never conflict in a plain UNIQUE btree, so the daily
  //               workflow re-inserted every untracked box forever.
  //
  // Splitting also keeps tracked rows out of the partial index entirely, which
  // is what lets mig 0310 skip a 233,800-row backfill.
  async function upsert(batch, conflictTarget) {
    let n = 0;
    for (let i = 0; i < batch.length; i += 500) {
      const res = await rest(`import_rows?on_conflict=${conflictTarget}`, {
        method: 'POST',
        headers: { Prefer: 'return=representation,resolution=ignore-duplicates' },
        body: JSON.stringify(batch.slice(i, i + 500)),
      });
      n += Array.isArray(res) ? res.length : 0;
    }
    return n;
  }

  const trackedRows = rows.filter((r) => r.tracking_number !== null);
  const untrackedRows = rows.filter((r) => r.tracking_number === null);
  const inserted =
    (await upsert(trackedRows, 'operator_id,tracking_number')) +
    (await upsert(untrackedRows, 'operator_id,source_key'));
  const skipped = rows.length - inserted;

  await rest(`imports?id=eq.${imp.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ row_count: inserted }),
  });

  await archiveEmptyImportLoad(inserted, imp.id, rest);

  console.log('=== D2L import complete ===');
  console.log(`inserted: ${inserted}`);
  console.log(`duplicates skipped: ${skipped}`);
  console.log(`import id: ${imp.id}`);
}

if (invokedDirectly) {
  main().catch((e) => {
    console.error('FATAL:', e.message);
    process.exit(1);
  });
}
