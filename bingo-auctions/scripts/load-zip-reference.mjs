#!/usr/bin/env node
// scripts/load-zip-reference.mjs — fill public.zip_reference (mig 0438) from
// GeoNames' US postal code dump.
//
// SOURCE AND LICENCE
//   https://download.geonames.org/export/zip/US.zip   (US.txt + readme.txt)
//   GeoNames postal code data, licensed Creative Commons Attribution 4.0
//   (https://creativecommons.org/licenses/by/4.0/). Credit GeoNames with a
//   link to https://www.geonames.org wherever the data is shown; the console
//   does this under the Bidders by ZIP report and in its CSV. Data is "as is".
//   About 41.5k rows, one primary place per ZIP, incl. PO-box ZIPs.
//
// DRY RUN by default: downloads (or reads --file), parses and prints counts
// and a sample. Writes nothing. --live upserts in batches of 2,000 with the
// service role (ON CONFLICT (postal_code) DO UPDATE). It never deletes: a ZIP
// GeoNames drops keeps its row (and its old loaded_at), and the run reports
// how many rows it did not refresh.
//
// Usage:
//   node scripts/load-zip-reference.mjs                      # dry run, downloads US.zip
//   node scripts/load-zip-reference.mjs --file ./US.zip      # dry run on a local copy (.zip or .txt)
//   node scripts/load-zip-reference.mjs --live               # write
// Env for --live (read from .env.local / .env.migrations.local if unset):
//   NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL)
//   SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_SERVICE_KEY)

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';

export const GEONAMES_US_URL = 'https://download.geonames.org/export/zip/US.zip';
export const ATTRIBUTION = 'ZIP places © GeoNames (geonames.org), CC BY 4.0';
export const BATCH_SIZE = 2000;

// ── Zip (no dependency): read one stored or deflated entry ────────────────
export function extractZipEntry(buf, name) {
  // End of central directory: signature 0x06054b50, within the last 64 KiB.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file (no end of central directory)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip central directory');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const entry = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (entry === name) {
      if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('bad zip local header');
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + csize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      throw new Error(`unsupported zip method ${method}`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`${name} not found in zip`);
}

// ── Parser ────────────────────────────────────────────────────────────────
// GeoNames postal code columns (tab separated, see readme.txt):
//   0 country code, 1 postal code, 2 place name, 3 admin name1 (state),
//   4 admin code1 (state code), 5 admin name2 (county), 6 admin code2,
//   7 admin name3, 8 admin code3, 9 latitude, 10 longitude, 11 accuracy
const MILITARY = /^(?:APO|FPO|DPO) (AA|AE|AP)$/;

const coord = (s, max) => {
  if (s == null || s.trim() === '') return null;
  const n = Number(s);
  if (!Number.isFinite(n) || Math.abs(n) > max) return null;
  return Math.round(n * 10000) / 10000;
};

/**
 * US.txt text → { rows, skipped, duplicates }. One row per 5-digit ZIP.
 * A row needs a place name and a 2-letter state: GeoNames' admin code1, or
 * for APO/FPO/DPO ZIPs the AA/AE/AP in the place name. When a ZIP appears
 * twice, the row with a real admin code1 wins, else the first.
 */
export function parseGeoNamesUS(text) {
  const byZip = new Map();
  let skipped = 0;
  let duplicates = 0;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const f = raw.split('\t');
    const [country, zip, place, , adminCode1, county] = f;
    const city = (place ?? '').trim();
    if (country !== 'US' || !/^\d{5}$/.test(zip ?? '') || !city || city.length > 100) { skipped++; continue; }
    const code = (adminCode1 ?? '').trim().toUpperCase();
    const military = city.match(MILITARY);
    const state = /^[A-Z]{2}$/.test(code) ? code : military ? military[1] : null;
    if (!state) { skipped++; continue; }
    const row = {
      postal_code: zip,
      city,
      state,
      county: (county ?? '').trim() || null,
      lat: coord(f[9], 90),
      lon: coord(f[10], 180),
      source: 'geonames',
    };
    const prev = byZip.get(zip);
    if (prev) {
      duplicates++;
      if (!prev.hasAdmin && /^[A-Z]{2}$/.test(code)) byZip.set(zip, { ...row, hasAdmin: true });
      continue;
    }
    byZip.set(zip, { ...row, hasAdmin: /^[A-Z]{2}$/.test(code) });
  }
  const rows = [...byZip.values()]
    .map(({ hasAdmin, ...r }) => r)
    .sort((a, b) => (a.postal_code < b.postal_code ? -1 : 1));
  return { rows, skipped, duplicates };
}

export function toBatches(rows, size = BATCH_SIZE) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

export function parseArgs(argv) {
  const live = argv.includes('--live');
  const i = argv.indexOf('--file');
  const file = i >= 0 ? argv[i + 1] : null;
  if (i >= 0 && !file) throw new Error('--file needs a path');
  const unknown = argv.filter((a, k) => a.startsWith('--') && !['--live', '--file'].includes(a) && argv[k - 1] !== '--file');
  if (unknown.length) throw new Error(`unknown option(s): ${unknown.join(' ')}`);
  return { live, file };
}

// ── IO ────────────────────────────────────────────────────────────────────
function loadEnv(file) {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    for (const line of readFileSync(resolve(here, '..', file), 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq < 0) continue;
      const k = t.slice(0, eq).trim();
      if (!process.env[k]) process.env[k] = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    }
  } catch {
    // optional file
  }
}

async function readSource(file) {
  if (file) {
    const buf = readFileSync(file);
    return file.toLowerCase().endsWith('.zip') ? extractZipEntry(buf, 'US.txt').toString('utf8') : buf.toString('utf8');
  }
  const res = await fetch(GEONAMES_US_URL);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${GEONAMES_US_URL}`);
  return extractZipEntry(Buffer.from(await res.arrayBuffer()), 'US.txt').toString('utf8');
}

async function upsertAll(rows, { url, key, loadedAt }) {
  const endpoint = `${url.replace(/\/$/, '')}/rest/v1/zip_reference?on_conflict=postal_code`;
  const headers = {
    apikey: key,
    authorization: `Bearer ${key}`,
    'content-type': 'application/json',
    prefer: 'resolution=merge-duplicates,return=minimal',
  };
  let done = 0;
  for (const batch of toBatches(rows)) {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(batch.map((r) => ({ ...r, loaded_at: loadedAt }))),
    });
    if (!res.ok) throw new Error(`upsert failed after ${done} rows: ${res.status} ${await res.text()}`);
    done += batch.length;
    console.log(`  upserted ${done} / ${rows.length}`);
  }
  // Rows this run did not refresh (GeoNames dropped them). Kept, never deleted.
  const stale = await fetch(
    `${url.replace(/\/$/, '')}/rest/v1/zip_reference?select=postal_code&loaded_at=lt.${encodeURIComponent(loadedAt)}`,
    { method: 'HEAD', headers: { ...headers, prefer: 'count=exact' } },
  );
  const range = stale.headers.get('content-range') ?? '';
  return { upserted: done, notRefreshed: Number(range.split('/')[1] ?? NaN) };
}

async function main() {
  const { live, file } = parseArgs(process.argv.slice(2));
  console.log(`[zip-reference] ${live ? 'LIVE' : 'DRY RUN'}; source ${file ?? GEONAMES_US_URL}`);
  console.log(`[zip-reference] licence: GeoNames, CC BY 4.0 — credit "${ATTRIBUTION}"`);
  const { rows, skipped, duplicates } = parseGeoNamesUS(await readSource(file));
  const states = new Set(rows.map((r) => r.state));
  console.log(`[zip-reference] ${rows.length} ZIPs, ${states.size} state codes, ${skipped} lines skipped, ${duplicates} duplicate ZIP lines`);
  for (const r of rows.filter((x) => ['72764', '72765', '72601', '09001'].includes(x.postal_code))) {
    console.log(`  ${r.postal_code} ${r.city}, ${r.state} (${r.county ?? '-'}) ${r.lat},${r.lon}`);
  }
  if (rows.length < 40000) throw new Error(`only ${rows.length} rows parsed; expected about 41.5k, refusing`);
  if (!live) {
    console.log(`[zip-reference] dry run: nothing written. ${toBatches(rows).length} batches of up to ${BATCH_SIZE} with --live.`);
    return;
  }
  loadEnv('.env.local');
  loadEnv('.env.migrations.local');
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('--live needs NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY');
  const r = await upsertAll(rows, { url, key, loadedAt: new Date().toISOString() });
  console.log(`[zip-reference] done: ${r.upserted} upserted; ${Number.isFinite(r.notRefreshed) ? r.notRefreshed : '?'} older rows kept (not in this file)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error(`[zip-reference] ${e.message}`);
    process.exit(1);
  });
}
