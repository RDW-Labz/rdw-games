#!/usr/bin/env node
// =============================================================================
// scripts/push-play-assets.mjs
//
// Headlessly fill a Play production DRAFT with the graphic assets + country
// targeting + release notes that the console UI left blank — the part the
// browser flow choked on. Does NOT send for review (commit uses
// changesNotSentForReview=true); the console-only "App content" forms +
// "Send for review" remain a human step.
//
// DRY-RUN by default: uploads images into a throwaway edit, sets the track,
// runs edits.validate, then ABANDONS the edit (nothing persists). Pass --live
// to commit instead.
//
// Per app it: uploads icon (512) + featureGraphic (1024x500) + every phone
// screenshot in the screenshots dir, sets production release countryTargeting
// = US + en-US release notes (preserving the existing versionCodes), validates,
// and (with --live) commits with changesNotSentForReview=true.
//
// Usage:
//   node scripts/push-play-assets.mjs --app staff            # dry-run
//   node scripts/push-play-assets.mjs --app staff --live      # commit
//   node scripts/push-play-assets.mjs --app bidder --live
// =============================================================================

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SA = JSON.parse(readFileSync(join(REPO, '.secrets/google-play-service-account.json'), 'utf8'));

const APPS = {
  bidder: {
    pkg: 'com.cluerholdings.auctionplatform',
    icon: 'docs/screenshots/play-assets/clovrbid-icon-512.png',
    feature: 'docs/screenshots/play-assets/clovrbid-feature-1024x500.png',
    screenshotsDir: 'docs/screenshots/bidder-asc',
    notes: 'First public release of ClovrBid.',
  },
  staff: {
    pkg: 'com.cluerholdings.bidwizops',
    icon: 'docs/screenshots/play-assets/clovrbid-staff-icon-512.png',
    feature: 'docs/screenshots/play-assets/clovrbid-staff-feature-1024x500.png',
    screenshotsDir: 'docs/screenshots/staff-resized',
    notes: 'First public release of ClovrBid Staff.',
  },
};
const LANG = 'en-US';
const BASE = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const UPLOAD = 'https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications';

const args = process.argv.slice(2);
const appKey = args[args.indexOf('--app') + 1];
const LIVE = args.includes('--live');
if (!APPS[appKey]) {
  console.error('Usage: node scripts/push-play-assets.mjs --app <bidder|staff> [--live]');
  process.exit(1);
}
const APP = APPS[appKey];

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function makeJwt(scope) {
  const now = Math.floor(Date.now() / 1000);
  const toSign = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({ iss: SA.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }))}`;
  const s = createSign('RSA-SHA256');
  s.update(toSign);
  return `${toSign}.${b64url(s.sign(SA.private_key))}`;
}
async function getToken() {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: makeJwt('https://www.googleapis.com/auth/androidpublisher') }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`token ${r.status}: ${JSON.stringify(j)}`);
  return j.access_token;
}
async function api(token, method, path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : method === 'POST' ? { body: '{}' } : {}),
  });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${JSON.stringify(j).slice(0, 400)}`);
  return j;
}
async function uploadImage(token, pkg, editId, imageType, filePath) {
  const abs = join(REPO, filePath);
  if (!existsSync(abs)) throw new Error(`missing asset: ${filePath}`);
  const r = await fetch(`${UPLOAD}/${pkg}/edits/${editId}/listings/${LANG}/${imageType}?uploadType=media`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/png' },
    body: readFileSync(abs),
  });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(`upload ${imageType} (${filePath}) -> ${r.status}: ${JSON.stringify(j).slice(0, 300)}`);
  return j.image ?? j;
}

(async () => {
  console.log(`App: ${appKey} [${APP.pkg}]  mode: ${LIVE ? 'LIVE (commit)' : 'DRY-RUN (validate + abandon)'}`);
  const token = await getToken();

  const shots = existsSync(join(REPO, APP.screenshotsDir))
    ? readdirSync(join(REPO, APP.screenshotsDir)).filter((f) => /\.png$/i.test(f)).sort()
    : [];
  console.log(`Assets: icon=${APP.icon ? 'yes' : 'no'} feature=${APP.feature ? 'yes' : 'no'} screenshots=${shots.length} (${APP.screenshotsDir})`);
  if (shots.length < 2) {
    console.log(`⚠ Play requires >= 2 phone screenshots to publish; found ${shots.length}. Continuing (icon/feature/track still useful).`);
  }

  const edit = await api(token, 'POST', `/${APP.pkg}/edits`);
  const editId = edit.id;
  console.log(`edit ${editId} opened`);
  let committed = false;
  try {
    // Clear any existing images of each type first so re-runs are idempotent.
    for (const t of ['icon', 'featureGraphic', 'phoneScreenshots']) {
      await api(token, 'DELETE', `/${APP.pkg}/edits/${editId}/listings/${LANG}/${t}`);
    }
    await uploadImage(token, APP.pkg, editId, 'icon', APP.icon);
    console.log('  icon uploaded');
    await uploadImage(token, APP.pkg, editId, 'featureGraphic', APP.feature);
    console.log('  featureGraphic uploaded');
    for (const f of shots) {
      await uploadImage(token, APP.pkg, editId, 'phoneScreenshots', join(APP.screenshotsDir, f));
      console.log(`  phoneScreenshot uploaded: ${f}`);
    }

    // Preserve the existing production release (versionCodes), add US + notes.
    const tr = await api(token, 'GET', `/${APP.pkg}/edits/${editId}/tracks/production`);
    const release = (tr.releases && tr.releases[0]) || {};
    // NOTE: countryTargeting is rejected on a `draft` release ("only supported
    // for staged releases"). Country/region (US) is chosen in the console at
    // send-for-review time. Here we only stage the release notes.
    const newRelease = {
      ...release,
      status: 'draft',
      releaseNotes: [{ language: LANG, text: APP.notes }],
    };
    await api(token, 'PUT', `/${APP.pkg}/edits/${editId}/tracks/production`, { track: 'production', releases: [newRelease] });
    console.log(`  production track set: versionCodes=[${(newRelease.versionCodes || []).join(',')}] notes set (country=US is a console step for draft releases)`);

    const val = await api(token, 'POST', `/${APP.pkg}/edits/${editId}:validate`);
    console.log(`  validate OK (edit ${val.id})`);

    if (LIVE) {
      // changesNotSentForReview is invalid for a not-yet-published app (Play
      // rejects it). A plain commit persists the listing/asset/draft-release
      // changes; the app still can't reach review until the console-only App
      // content forms + country selection are completed, so this does not
      // submit the app.
      await api(token, 'POST', `/${APP.pkg}/edits/${editId}:commit`);
      committed = true;
      console.log('  COMMITTED — assets + release notes saved to the production draft (app not submitted; App content + country still pending in console)');
    }
  } finally {
    if (!committed) {
      await fetch(`${BASE}/${APP.pkg}/edits/${editId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      console.log(`  edit ${editId} abandoned (${LIVE ? 'commit failed' : 'dry-run'})`);
    }
  }
  console.log(LIVE ? 'DONE (live).' : 'DONE (dry-run — nothing persisted). Re-run with --live to commit.');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
