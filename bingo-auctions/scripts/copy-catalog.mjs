#!/usr/bin/env node
// =============================================================================
// scripts/copy-catalog.mjs
//
// Copy the platform-global product catalog (product_lookups) from the old
// ClovrBid Supabase project into BinGo's. The BinGo fork brought the code but
// not the data — BinGo prod has ~5 catalog rows, ClovrBid has ~187k — so every
// barcode/UPC scan misses and QuickLot falls through to a bare lot (owner
// report 2026-07-08).
//
// Cross-project transfer with ONE credential: SUPABASE_ACCESS_TOKEN is an
// ACCOUNT-level Supabase PAT (same token apply-migration.yml uses), so the
// Management API `/v1/projects/{ref}/database/query` endpoint reaches BOTH
// projects — no ClovrBid-specific service key needed, as long as both
// projects live under the same Supabase account.
//
// Strategy:
//   • keyset-paginate the source by upc (PK) — stable, no OFFSET drift
//   • skip confidence='none' negative-cache rows (7d TTL, re-derivable)
//   • ferry each batch as JSON and INSERT on the dest via json_to_recordset
//     (no per-value SQL escaping — the JSON literal is dollar-quoted)
//   • ON CONFLICT (upc) DO NOTHING — safe to re-run, never clobbers a row
//     BinGo already curated
//   • category_id is NOT copied (it FKs ClovrBid's categories UUIDs, which
//     don't exist in BinGo); category_raw text is preserved so lots still
//     carry the source category string and can be re-resolved later
//   • prices / sold_comps JSONB forensics are NOT copied (large, re-fetchable);
//     the denormalized signals that lotting actually reads — msrp_cents,
//     median_sold_cents, start_bid_cents, avg_asking_cents — ARE copied
//
// Usage:
//   node scripts/copy-catalog.mjs                 # DRY RUN — counts only
//   node scripts/copy-catalog.mjs --apply         # actually copy
// Env:
//   SUPABASE_ACCESS_TOKEN   account PAT (sbp_…)
//   SOURCE_REF              default xgsujdzicnjenhqihovk (ClovrBid)
//   DEST_REF               default npwseclcxcatjhgjrtwe (BinGo prod)
//   BATCH                   rows per round-trip (default 500)
// =============================================================================

const PAT = process.env.SUPABASE_ACCESS_TOKEN;
if (!PAT) {
  console.error('FATAL: SUPABASE_ACCESS_TOKEN missing');
  process.exit(1);
}
const SOURCE_REF = process.env.SOURCE_REF || 'xgsujdzicnjenhqihovk';
const DEST_REF = process.env.DEST_REF || 'npwseclcxcatjhgjrtwe';
const BATCH = Math.max(50, Math.min(2000, Number.parseInt(process.env.BATCH || '500', 10)));
const APPLY = process.argv.includes('--apply');

// Columns copied, in order. Arrays are pulled as jsonb (to_jsonb) so they
// serialize as JSON arrays regardless of how the Management API renders a
// Postgres text[]; rebuilt into text[] on the dest side.
const SELECT_COLS = `
  upc, title, brand, model, category_raw,
  to_jsonb(image_urls) AS image_urls,
  msrp_cents, avg_asking_cents, median_sold_cents, start_bid_cents,
  description, specs, confidence,
  to_jsonb(sources) AS sources,
  identity_refreshed_at, prices_refreshed_at, created_at, updated_at`;

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

const num = (r, k) => Number((r && r[0] && r[0][k]) ?? 0);

(async () => {
  console.log(`Source (ClovrBid): ${SOURCE_REF}`);
  console.log(`Dest   (BinGo):    ${DEST_REF}`);

  // ── Reachability + counts ────────────────────────────────────────────────
  let srcTotal, srcReal, destBefore;
  try {
    const s = await query(
      SOURCE_REF,
      `select count(*) as total, count(*) filter (where confidence <> 'none') as real from product_lookups`,
    );
    srcTotal = num(s, 'total');
    srcReal = num(s, 'real');
  } catch (e) {
    console.error('\nFATAL: could not read the ClovrBid project.');
    console.error(e.message);
    console.error(
      '\nMost likely the SUPABASE_ACCESS_TOKEN PAT is not on the same Supabase\n' +
        'account/org as the ClovrBid project. Fix: generate a PAT from the account\n' +
        'that owns ' + SOURCE_REF + ' at https://supabase.com/dashboard/account/tokens\n' +
        'and set it as the SUPABASE_ACCESS_TOKEN repo secret (or pass a different SOURCE_REF).',
    );
    process.exit(1);
  }
  destBefore = num(await query(DEST_REF, `select count(*) as total from product_lookups`), 'total');

  console.log(`\nClovrBid product_lookups: ${srcTotal} total, ${srcReal} real (confidence<>none)`);
  console.log(`BinGo product_lookups (before): ${destBefore}`);

  if (!APPLY) {
    console.log(`\nDRY RUN — would copy up to ${srcReal} rows in batches of ${BATCH}.`);
    console.log('Re-run with --apply to perform the copy.');
    return;
  }

  // ── Copy loop (keyset by upc) ────────────────────────────────────────────
  let last = '';
  let sent = 0;
  let batches = 0;
  for (;;) {
    const rows = await query(
      SOURCE_REF,
      `select ${SELECT_COLS}
         from product_lookups
        where confidence <> 'none' and upc > ${sqlLit(last)}
        order by upc
        limit ${BATCH}`,
    );
    if (!Array.isArray(rows) || rows.length === 0) break;

    const json = JSON.stringify(rows);
    // Dollar-quote tag chosen to never collide with catalog text.
    const tag = '$catjson$';
    await query(
      DEST_REF,
      `insert into product_lookups
         (upc, title, brand, model, category_raw, image_urls, msrp_cents,
          avg_asking_cents, median_sold_cents, start_bid_cents, description,
          specs, confidence, sources, identity_refreshed_at, prices_refreshed_at,
          created_at, updated_at)
       select
         x.upc, x.title, x.brand, x.model, x.category_raw,
         coalesce(array(select jsonb_array_elements_text(x.image_urls)), '{}'),
         x.msrp_cents, x.avg_asking_cents, x.median_sold_cents, x.start_bid_cents,
         x.description, x.specs, coalesce(x.confidence, 'medium'),
         coalesce(array(select jsonb_array_elements_text(x.sources)), '{}'),
         coalesce(x.identity_refreshed_at, now()), x.prices_refreshed_at,
         coalesce(x.created_at, now()), coalesce(x.updated_at, now())
       from json_to_recordset(${tag}${json}${tag}) as x(
         upc text, title text, brand text, model text, category_raw text,
         image_urls jsonb, msrp_cents bigint, avg_asking_cents bigint,
         median_sold_cents bigint, start_bid_cents bigint, description text,
         specs text, confidence text, sources jsonb,
         identity_refreshed_at timestamptz, prices_refreshed_at timestamptz,
         created_at timestamptz, updated_at timestamptz)
       on conflict (upc) do nothing`,
    );

    sent += rows.length;
    batches += 1;
    last = rows[rows.length - 1].upc;
    if (batches % 10 === 0 || rows.length < BATCH) {
      console.log(`  … ${sent}/${srcReal} rows sent (${batches} batches)`);
    }
    if (rows.length < BATCH) break;
  }

  const destAfter = num(await query(DEST_REF, `select count(*) as total from product_lookups`), 'total');
  console.log('\n=== catalog copy complete ===');
  console.log(`rows sent:        ${sent}`);
  console.log(`BinGo before:     ${destBefore}`);
  console.log(`BinGo after:      ${destAfter}`);
  console.log(`net new inserted: ${destAfter - destBefore}`);
})().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});

// Single-quote SQL string literal (used only for the keyset cursor, which is a
// digits-only upc — this is belt-and-braces).
function sqlLit(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}
