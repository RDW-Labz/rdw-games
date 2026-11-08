#!/usr/bin/env node
// =============================================================================
// scripts/copy-manifests.mjs
//
// Copy the PENDING manifest pool (imports + import_rows) from the old ClovrBid
// Supabase project into BinGo's. The catalog copy (copy-catalog.mjs) brought
// product_lookups, but the manifest pool — the tracking-number → item mapping
// that Quick Lot's FedEx-label scan probes via find_import_row_by_scan — never
// came over, so every Wayfair return-label scan misses (owner report
// 2026-07-09: "the FedEx Wayfair return labels they are trying to lot are not
// pulling up").
//
// Same one-credential Management-API approach as copy-catalog.mjs: the
// account-level SUPABASE_ACCESS_TOKEN PAT reaches both projects.
//
// Strategy:
//   • dest operator: the single BinGo operator (fails loudly if != 1 and no
//     --dest-operator). Source operator: auto when exactly one ClovrBid
//     operator owns pending rows, else requires SOURCE_OPERATOR.
//   • copies only status='pending' rows — lotted/dropped rows are ClovrBid
//     history; the scan probe only ever matches pending rows anyway.
//   • preserves row UUIDs and imports-header UUIDs, so re-runs are fully
//     idempotent via ON CONFLICT DO NOTHING (id PK + the 0153
//     (operator_id, tracking_number) unique index both dedupe).
//   • imports headers referenced by copied rows are created first (FK), with
//     operator_id remapped and filename/source_label preserved.
//   • column list = intersection of a wishlist with information_schema on
//     BOTH sides, so it tolerates schema drift between the two projects.
//     Per-project FKs (category_id, warehouse_id, lot_id, dropped_by,
//     created_by) are never copied.
//
// Usage:
//   node scripts/copy-manifests.mjs                 # DRY RUN — counts only
//   node scripts/copy-manifests.mjs --apply         # actually copy
// Env:
//   SUPABASE_ACCESS_TOKEN   account PAT (sbp_…)
//   SOURCE_REF              default xgsujdzicnjenhqihovk (ClovrBid)
//   DEST_REF                default npwseclcxcatjhgjrtwe (BinGo prod)
//   SOURCE_OPERATOR         source operator UUID (optional when unambiguous)
//   DEST_OPERATOR           dest operator UUID (optional when exactly one)
//   BATCH                   rows per round-trip (default 400)
// =============================================================================

const PAT = process.env.SUPABASE_ACCESS_TOKEN;
if (!PAT) {
  console.error('FATAL: SUPABASE_ACCESS_TOKEN missing');
  process.exit(1);
}
const SOURCE_REF = process.env.SOURCE_REF || 'xgsujdzicnjenhqihovk';
const DEST_REF = process.env.DEST_REF || 'npwseclcxcatjhgjrtwe';
const BATCH = Math.max(50, Math.min(1000, Number.parseInt(process.env.BATCH || '400', 10)));
const APPLY = process.argv.includes('--apply');

// Wishlist of import_rows columns worth ferrying. Filtered to the columns
// that actually exist on BOTH projects at runtime. `id`, `import_id`,
// `operator_id`, `status` are handled explicitly and must exist.
const ROW_COL_WISHLIST = [
  'raw_data', 'title', 'description', 'category_raw', 'sub_category_raw',
  'upc', 'asin', 'fnsku', 'lpn', 'external_code', 'pallet_id',
  'tracking_number', 'brand', 'model', 'quantity', 'cost_cents',
  'msrp_cents', 'starting_bid_cents', 'photo_url', 'condition',
  'return_reason', 'product_sku', 'site_sku', 'manufacture_sku',
  'catalog_id', 'sku_active', 'order_id', 'po_number', 'return_carrier',
  'return_initiated_at', 'created_at', 'updated_at',
];
// Postgres types for the json_to_recordset() column definition list.
const COL_TYPES = {
  raw_data: 'jsonb', quantity: 'integer', cost_cents: 'bigint',
  msrp_cents: 'bigint', starting_bid_cents: 'bigint', sku_active: 'boolean',
  return_initiated_at: 'timestamptz', created_at: 'timestamptz',
  updated_at: 'timestamptz',
};

async function query(ref, sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: { authorization: `Bearer ${PAT}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query: sql }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`[${ref}] ${res.status}: ${text.slice(0, 400)}`);
  }
  return text ? JSON.parse(text) : null;
}

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

async function columnsOf(ref, table) {
  const rows = await query(
    ref,
    `select column_name from information_schema.columns
      where table_schema = 'public' and table_name = ${lit(table)}`,
  );
  return new Set((rows ?? []).map((r) => r.column_name));
}

(async () => {
  console.log(`Source (ClovrBid): ${SOURCE_REF}`);
  console.log(`Dest   (BinGo):    ${DEST_REF}`);

  // ── Resolve operators ────────────────────────────────────────────────────
  let destOp = process.env.DEST_OPERATOR || '';
  if (!destOp) {
    const ops = await query(DEST_REF, `select id, business_name from operators`);
    if (!Array.isArray(ops) || ops.length !== 1) {
      console.error(`FATAL: dest has ${ops?.length ?? 0} operators — set DEST_OPERATOR.`);
      console.error(JSON.stringify(ops, null, 2));
      process.exit(1);
    }
    destOp = ops[0].id;
    console.log(`Dest operator: ${ops[0].business_name} (${destOp})`);
  }

  const srcOps = await query(
    SOURCE_REF,
    `select o.id, o.business_name,
            count(*) filter (where ir.status = 'pending') as pending,
            count(*) filter (where ir.status = 'pending' and ir.tracking_number is not null) as pending_tracked
       from operators o join import_rows ir on ir.operator_id = o.id
      group by o.id, o.business_name order by pending desc`,
  );
  console.log('\nClovrBid operators with manifest rows:');
  for (const o of srcOps ?? []) {
    console.log(`  ${o.business_name} (${o.id}): ${o.pending} pending, ${o.pending_tracked} with tracking`);
  }
  let srcOp = process.env.SOURCE_OPERATOR || '';
  if (!srcOp) {
    const withPending = (srcOps ?? []).filter((o) => Number(o.pending) > 0);
    if (withPending.length !== 1) {
      console.error(`FATAL: ${withPending.length} source operators have pending rows — set SOURCE_OPERATOR.`);
      process.exit(1);
    }
    srcOp = withPending[0].id;
  }
  console.log(`Source operator: ${srcOp}`);

  // ── Column intersection ──────────────────────────────────────────────────
  const [srcCols, destCols] = await Promise.all([
    columnsOf(SOURCE_REF, 'import_rows'),
    columnsOf(DEST_REF, 'import_rows'),
  ]);
  const cols = ROW_COL_WISHLIST.filter((c) => srcCols.has(c) && destCols.has(c));
  const skipped = ROW_COL_WISHLIST.filter((c) => !srcCols.has(c) || !destCols.has(c));
  if (skipped.length) console.log(`\nColumns skipped (missing on one side): ${skipped.join(', ')}`);
  console.log(`Columns copied: id, import_id, operator_id, status + ${cols.join(', ')}`);

  // ── Counts ───────────────────────────────────────────────────────────────
  const srcCount = Number(
    (await query(
      SOURCE_REF,
      `select count(*) as n from import_rows where operator_id = ${lit(srcOp)} and status = 'pending'`,
    ))[0].n,
  );
  const destBefore = Number(
    (await query(DEST_REF, `select count(*) as n from import_rows`))[0].n,
  );
  console.log(`\nClovrBid pending rows to copy: ${srcCount}`);
  console.log(`BinGo import_rows (before): ${destBefore}`);

  if (!APPLY) {
    console.log(`\nDRY RUN — would copy ${srcCount} rows in batches of ${BATCH}.`);
    console.log('Re-run with --apply to perform the copy.');
    return;
  }

  // ── Copy imports headers referenced by the pending rows ─────────────────
  const headers = await query(
    SOURCE_REF,
    `select distinct i.id, i.filename, i.source_label, i.row_count, i.created_at
       from imports i
       join import_rows ir on ir.import_id = i.id
      where ir.operator_id = ${lit(srcOp)} and ir.status = 'pending'`,
  );
  console.log(`\nImports headers to ferry: ${headers.length}`);
  if (headers.length) {
    const tag = '$maniheader$';
    const json = JSON.stringify(headers);
    await query(
      DEST_REF,
      `insert into imports (id, operator_id, filename, source_label, row_count, status, created_at)
       select x.id, ${lit(destOp)}, coalesce(x.filename, 'clovrbid-manifest'),
              x.source_label, coalesce(x.row_count, 0), 'completed',
              coalesce(x.created_at, now())
         from json_to_recordset(${tag}${json}${tag}) as x(
           id uuid, filename text, source_label text, row_count integer,
           created_at timestamptz)
       on conflict (id) do nothing`,
    );
  }

  // ── Copy loop (keyset by id) ─────────────────────────────────────────────
  const selectList = cols
    .map((c) => (c === 'raw_data' ? 'raw_data' : c))
    .join(', ');
  const recordDefs = ['id uuid', 'import_id uuid']
    .concat(cols.map((c) => `${c} ${COL_TYPES[c] ?? 'text'}`))
    .join(', ');
  const insertCols = ['id', 'import_id', 'operator_id', 'status'].concat(cols).join(', ');
  const selectExprs = ['x.id', 'x.import_id', lit(destOp), `'pending'`]
    .concat(cols.map((c) => (c === 'quantity' ? 'coalesce(x.quantity, 1)' : c === 'raw_data' ? `coalesce(x.raw_data, '{}'::jsonb)` : `x.${c}`)))
    .join(', ');

  let last = '00000000-0000-0000-0000-000000000000';
  let sent = 0;
  let batches = 0;
  for (;;) {
    const rows = await query(
      SOURCE_REF,
      `select id, import_id, ${selectList}
         from import_rows
        where operator_id = ${lit(srcOp)} and status = 'pending' and id > ${lit(last)}
        order by id
        limit ${BATCH}`,
    );
    if (!Array.isArray(rows) || rows.length === 0) break;

    const tag = '$manijson$';
    const json = JSON.stringify(rows).replace(/\$manijson\$/g, '');
    await query(
      DEST_REF,
      `insert into import_rows (${insertCols})
       select ${selectExprs}
         from json_to_recordset(${tag}${json}${tag}) as x(${recordDefs})
       on conflict do nothing`,
    );

    sent += rows.length;
    batches += 1;
    last = rows[rows.length - 1].id;
    if (batches % 5 === 0 || rows.length < BATCH) {
      console.log(`  … ${sent}/${srcCount} rows sent (${batches} batches)`);
    }
    if (rows.length < BATCH) break;
  }

  const destAfter = Number(
    (await query(DEST_REF, `select count(*) as n from import_rows`))[0].n,
  );
  const destTracked = Number(
    (await query(
      DEST_REF,
      `select count(*) as n from import_rows where status = 'pending' and tracking_number is not null`,
    ))[0].n,
  );
  console.log('\n=== manifest copy complete ===');
  console.log(`rows sent:            ${sent}`);
  console.log(`BinGo before:         ${destBefore}`);
  console.log(`BinGo after:          ${destAfter}`);
  console.log(`net new inserted:     ${destAfter - destBefore}`);
  console.log(`pending w/ tracking:  ${destTracked}`);
})().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
