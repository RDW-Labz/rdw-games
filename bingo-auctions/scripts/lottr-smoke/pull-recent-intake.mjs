#!/usr/bin/env node
// Pull the most recent intake photos from the live Supabase. We want a
// diverse set for prompt-AB testing:
//   - one with a clear manufacturer model (DeWalt-style)
//   - one with a real UPC barcode (12+ digits, no FNSKU)
//   - one with no useful text (bare item)
//   - one with an FNSKU (already have one)
//
// Strategy:
//   1. Fetch recent lots (created in last 7 days) with non-empty photo_urls.
//   2. Group by what their final identification ended up being:
//        - had upc?         → "upc" bucket
//        - had asin/fnsku?  → "amazon" bucket
//        - had brand only?  → "brand_only" bucket
//        - none?            → "no_id" bucket
//   3. Download up to 2 from each bucket into scripts/lottr-smoke/fixtures/intake/.
//
// Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from the shell,
// falling back to apps/operator-web/.env.local. The URL has no default: this
// repo was forked from the upstream platform, and a guessed URL pulls another company's
// intake photos. BinGo prod is https://npwseclcxcatjhgjrtwe.supabase.co.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const OUT_DIR = resolve(REPO_ROOT, 'scripts/lottr-smoke/fixtures/intake');

const envText = await readFile(resolve(REPO_ROOT, 'apps/operator-web/.env.local'), 'utf8').catch(() => '');
const fromFile = (k) =>
  envText.split(/\r?\n/).find(l => l.startsWith(`${k}=`))?.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');
// URL and key are read from the same places so they name the same project.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? fromFile('NEXT_PUBLIC_SUPABASE_URL');
const svc = process.env.SUPABASE_SERVICE_ROLE_KEY ?? fromFile('SUPABASE_SERVICE_ROLE_KEY');
if (!url || !svc) {
  console.error(
    '[pull-recent-intake] Supabase target is not fully set.\n\n' +
      `  NEXT_PUBLIC_SUPABASE_URL:  ${url || '(missing)'}\n` +
      `  SUPABASE_SERVICE_ROLE_KEY: ${svc ? '(set)' : '(missing)'}\n\n` +
      '  There is no default project. Set both in the shell or in\n' +
      '  apps/operator-web/.env.local. BinGo prod is npwseclcxcatjhgjrtwe.',
  );
  process.exit(2);
}
const H = { apikey: svc, Authorization: `Bearer ${svc}` };

await mkdir(OUT_DIR, { recursive: true });

// Fetch recent lots with photos
const sinceISO = new Date(Date.now() - 7 * 86400_000).toISOString();
// Note: lots table doesn't have a 'upc' column directly — UPC lives in
// product_lookups keyed by external_code. We pick using model+brand and
// asin/fnsku here to bucket. Photos live on lots.photo_urls.
const lotsUrl = `${url}/rest/v1/lots?select=id,lot_code,external_code,title,brand,model,asin,fnsku,photo_urls,created_at&created_at=gte.${encodeURIComponent(sinceISO)}&photo_urls=neq.{}&order=created_at.desc&limit=120`;
const lotsRes = await fetch(lotsUrl, { headers: H });
if (!lotsRes.ok) {
  console.error('Failed to fetch lots:', lotsRes.status, await lotsRes.text());
  process.exit(2);
}
const lots = await lotsRes.json();
console.error(`fetched ${lots.length} recent lots with photos`);

// Bucket. external_code is the UPC if it's all digits; asin:/fnsku: prefixes
// indicate amazon identifiers; brand+model with no code is the "brand only"
// bucket; nothing is "no_id".
const buckets = { upc: [], amazon: [], brand_model: [], brand_only: [], no_id: [] };
for (const lot of lots) {
  const ec = typeof lot.external_code === 'string' ? lot.external_code : '';
  if (/^\d{8,14}$/.test(ec))                  buckets.upc.push(lot);
  else if (lot.asin || lot.fnsku || ec.startsWith('asin:') || ec.startsWith('fnsku:'))
                                              buckets.amazon.push(lot);
  else if (lot.brand && lot.model)            buckets.brand_model.push(lot);
  else if (lot.brand)                         buckets.brand_only.push(lot);
  else                                        buckets.no_id.push(lot);
}
for (const [k, v] of Object.entries(buckets)) {
  console.error(`  bucket ${k}: ${v.length} lots`);
}

// Pick up to 5 per bucket for larger sample
const picks = [];
for (const [k, v] of Object.entries(buckets)) {
  for (const lot of v.slice(0, 5)) picks.push({ bucket: k, lot });
}
console.error(`\npicking ${picks.length} lots to download`);

// Download first photo from each
const manifest = { generated_at: new Date().toISOString(), cases: [] };
for (const { bucket, lot } of picks) {
  const photos = Array.isArray(lot.photo_urls) ? lot.photo_urls : [];
  const first = photos[0];
  if (!first) continue;
  // photo_urls are Supabase storage paths like 'intake-photos/...' OR signed/public URLs.
  // Try as a signed download from the lot-photos / intake-photos bucket.
  let imgUrl = first;
  if (!/^https?:\/\//.test(first)) {
    // Treat as storage path. Try a signed URL from the storage api.
    // Bucket can vary; try lot-photos first then intake-photos.
    for (const bkt of ['lot-photos', 'intake-photos']) {
      const r = await fetch(`${url}/storage/v1/object/sign/${bkt}/${encodeURIComponent(first)}`, {
        method: 'POST',
        headers: { ...H, 'Content-Type': 'application/json' },
        body: JSON.stringify({ expiresIn: 300 }),
      });
      if (r.ok) {
        const j = await r.json();
        imgUrl = `${url}/storage/v1${j.signedURL ?? j.signedUrl}`;
        break;
      }
    }
  }
  // Fetch the image bytes
  const imgRes = await fetch(imgUrl, imgUrl.includes('/sign/') ? { headers: H } : {});
  if (!imgRes.ok) {
    console.error(`  [${bucket}] ${lot.lot_code}: image fetch failed (${imgRes.status}) — ${first.slice(0,80)}`);
    continue;
  }
  const buf = Buffer.from(await imgRes.arrayBuffer());
  const ct = imgRes.headers.get('content-type') ?? 'image/jpeg';
  const ext = ct.includes('png') ? 'png' : 'jpeg';
  const outName = `${bucket}-${(lot.lot_code || lot.id).toString().replace(/[^A-Za-z0-9._-]+/g, '_')}.${ext}`;
  const outPath = resolve(OUT_DIR, outName);
  await writeFile(outPath, buf);
  console.error(`  [${bucket}] ${lot.lot_code}: wrote ${outName} (${buf.length} bytes)`);
  manifest.cases.push({
    bucket,
    lot_code: lot.lot_code,
    lot_id: lot.id,
    title: lot.title,
    brand: lot.brand,
    model: lot.model,
    external_code: lot.external_code,
    asin: lot.asin,
    fnsku: lot.fnsku,
    fixture: `intake/${outName}`,
  });
}

await writeFile(resolve(OUT_DIR, '_manifest.json'), JSON.stringify(manifest, null, 2));
console.error(`\nwrote manifest with ${manifest.cases.length} cases → ${resolve(OUT_DIR, '_manifest.json')}`);
