#!/usr/bin/env node
// =============================================================================
// scripts/pull-asc-screenshots.mjs
//
// READ-ONLY downloader: pulls an app's existing App Store Connect screenshots
// (rendered PNGs) to a local directory, so they can be re-used for the Google
// Play listing. Same .p8 ES256 JWT auth as upload-asc-screenshots.mjs, but it
// only GETs from ASC and writes local files — it never modifies ASC.
//
// Flow: app -> most-recent appStoreVersion -> en-US localization ->
// appScreenshotSets (pick the requested display type) -> appScreenshots ->
// download each via attributes.imageAsset.templateUrl at native width/height.
//
// Usage:
//   node scripts/pull-asc-screenshots.mjs --app bidder --out docs/screenshots/bidder-asc
//   node scripts/pull-asc-screenshots.mjs --app bidder --display APP_IPHONE_67 --out <dir>
// =============================================================================

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createSign } from 'node:crypto';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const CONFIG = {
  bidder: { appId: '6767012532', name: 'ClovrBid Bidder' },
  staff: { appId: '6767026881', name: 'ClovrBid Staff' },
};
const ASC_KEY_ID = '25M83P99J8';
const ASC_ISSUER_ID = 'df79d9d0-5f90-4a53-8e2f-4c16b3fafce9';
const ASC_BASE = 'https://api.appstoreconnect.apple.com/v1';
const LOCALE = 'en-US';

const args = process.argv.slice(2);
const get = (k, d) => (args.indexOf(k) >= 0 ? args[args.indexOf(k) + 1] : d);
const appKey = get('--app', 'bidder');
const display = get('--display', 'APP_IPHONE_67');
const outDir = resolve(REPO, get('--out', 'docs/screenshots/bidder-asc'));
if (!CONFIG[appKey]) { console.error('Use --app bidder|staff'); process.exit(1); }

function keyPath() {
  const p = join(REPO, '.secrets', `AuthKey_${ASC_KEY_ID}.p8`);
  if (!existsSync(p)) throw new Error(`ASC key not found: ${p}`);
  return p;
}
function makeJwt() {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'ES256', kid: ASC_KEY_ID, typ: 'JWT' };
  const payload = { iss: ASC_ISSUER_ID, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' };
  const msg = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
  const signer = createSign('SHA256');
  signer.update(msg);
  // Apple requires raw r||s (IEEE P1363), not DER.
  return `${msg}.${signer.sign({ key: readFileSync(keyPath(), 'utf8'), dsaEncoding: 'ieee-p1363' }, 'base64url')}`;
}
async function ascGet(token, path) {
  const r = await fetch(path.startsWith('http') ? path : `${ASC_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(`ASC GET ${path} -> ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return j;
}

(async () => {
  const app = CONFIG[appKey];
  console.log(`Pull ASC screenshots: ${app.name} (${app.appId}) display=${display} -> ${outDir}`);
  const token = makeJwt();

  const versions = (await ascGet(token, `/apps/${app.appId}/appStoreVersions?limit=5`)).data ?? [];
  if (versions.length === 0) throw new Error('no appStoreVersions');
  const version = versions[0];
  console.log(`  version ${version.id} (v${version.attributes?.versionString} ${version.attributes?.appStoreState})`);

  const locs = (await ascGet(token, `/appStoreVersions/${version.id}/appStoreVersionLocalizations?limit=200`)).data ?? [];
  const loc = locs.find((l) => l.attributes?.locale === LOCALE);
  if (!loc) throw new Error(`no ${LOCALE} localization`);

  const sets = (await ascGet(token, `/appStoreVersionLocalizations/${loc.id}/appScreenshotSets?limit=200`)).data ?? [];
  const set = sets.find((s) => s.attributes?.screenshotDisplayType === display);
  if (!set) throw new Error(`no ${display} screenshot set (have: ${sets.map((s) => s.attributes?.screenshotDisplayType).join(', ')})`);

  const shots = (await ascGet(token, `/appScreenshotSets/${set.id}/appScreenshots?limit=200`)).data ?? [];
  console.log(`  ${shots.length} screenshot(s) in ${display} set`);
  if (shots.length === 0) throw new Error('set is empty');

  mkdirSync(outDir, { recursive: true });
  let i = 0;
  for (const s of shots) {
    i++;
    const a = s.attributes ?? {};
    const asset = a.imageAsset;
    if (!asset?.templateUrl) { console.log(`  ! [${i}] ${a.fileName} has no imageAsset (state=${a.assetDeliveryState?.state}) — skip`); continue; }
    const url = asset.templateUrl
      .replace('{w}', asset.width)
      .replace('{h}', asset.height)
      .replace('{c}', 'bb')
      .replace('{f}', 'png');
    const r = await fetch(url);
    if (!r.ok) { console.log(`  ! [${i}] download failed ${r.status} for ${a.fileName}`); continue; }
    const buf = Buffer.from(await r.arrayBuffer());
    const name = `${String(i).padStart(2, '0')}-${(a.fileName || 'shot').replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    const outName = name.toLowerCase().endsWith('.png') ? name : `${name}.png`;
    writeFileSync(join(outDir, outName), buf);
    console.log(`  ok [${i}] ${outName} (${asset.width}x${asset.height}, ${buf.length.toLocaleString()} bytes)`);
  }
  console.log(`Done -> ${outDir}`);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
