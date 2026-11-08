#!/usr/bin/env node
// =============================================================================
// scripts/inspect-play-submission.mjs
//
// READ-ONLY Google Play submission-status probe for BOTH BinGo apps.
//
// Mints an androidpublisher OAuth token, opens a THROWAWAY edit per app (which
// reflects the current committed console state), and reports: default
// language + contact details, store listings (title/desc lengths), graphic
// assets (icon / feature graphic / phone screenshots counts), and every
// track's releases (versionCodes, status, release notes, country targeting).
// Each edit is ABANDONED (deleted) — nothing is ever committed/published.
//
// CANNOT read (console-only, no API): content rating (IARC), data safety,
// target audience, and the App-content policy declarations. Check those in
// Play Console -> App content manually.
//
// Usage: node scripts/inspect-play-submission.mjs
// =============================================================================

import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SA = JSON.parse(readFileSync(join(REPO, '.secrets/google-play-service-account.json'), 'utf8'));

const APPS = [
  { name: 'Bidder — ClovrBid', pkg: 'com.cluerholdings.auctionplatform' },
  { name: 'Staff — ClovrBid Staff', pkg: 'com.cluerholdings.bidwizops' },
];
const BASE = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function makeJwt(scope) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = { iss: SA.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 };
  const toSign = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claim))}`;
  const s = createSign('RSA-SHA256');
  s.update(toSign);
  return `${toSign}.${b64url(s.sign(SA.private_key))}`;
}
async function getToken() {
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: makeJwt('https://www.googleapis.com/auth/androidpublisher'),
    }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`token ${r.status}: ${JSON.stringify(j)}`);
  return j.access_token;
}
async function api(token, method, path) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(method === 'POST' ? { body: '{}' } : {}),
  });
  const t = await r.text();
  let j;
  try { j = JSON.parse(t); } catch { j = t; }
  return { status: r.status, body: j };
}

async function probe(token, app) {
  console.log(`\n===== ${app.name}  [${app.pkg}] =====`);
  const ins = await api(token, 'POST', `/${app.pkg}/edits`);
  if (ins.status !== 200) {
    console.log(`  edits.insert -> ${ins.status}: ${JSON.stringify(ins.body).slice(0, 300)}`);
    if (ins.status === 404) console.log('  ⚠ App not found — package not registered, or the service account lacks access.');
    return;
  }
  const editId = ins.body.id;
  try {
    const details = await api(token, 'GET', `/${app.pkg}/edits/${editId}/details`);
    console.log(`  details: lang=${details.body?.defaultLanguage ?? '?'} contact=${details.body?.contactEmail ?? '-'} site=${details.body?.contactWebsite ?? '-'}`);

    const lang = details.body?.defaultLanguage ?? 'en-US';
    const listings = await api(token, 'GET', `/${app.pkg}/edits/${editId}/listings`);
    const ls = listings.body?.listings ?? [];
    console.log(`  Store listing: ${ls.length} language(s)`);
    for (const l of ls) {
      console.log(`    [${l.language}] title="${l.title ?? ''}" short=${(l.shortDescription || '').length}c full=${(l.fullDescription || '').length}c`);
    }

    console.log(`  Graphic assets (${lang}):`);
    for (const t of ['icon', 'featureGraphic', 'phoneScreenshots', 'sevenInchScreenshots']) {
      const img = await api(token, 'GET', `/${app.pkg}/edits/${editId}/listings/${lang}/${t}`);
      const n = img.body?.images?.length ?? 0;
      console.log(`    ${t}: ${n}`);
    }

    const tracks = await api(token, 'GET', `/${app.pkg}/edits/${editId}/tracks`);
    const ts = tracks.body?.tracks ?? [];
    console.log(`  Tracks: ${ts.length}`);
    for (const tr of ts) {
      const rels = tr.releases ?? [];
      if (rels.length === 0) { console.log(`    ${tr.track}: (no releases)`); continue; }
      for (const r of rels) {
        const vcs = (r.versionCodes || []).join(',');
        const ct = r.countryTargeting?.countries ? r.countryTargeting.countries.join(',') : 'none';
        const notes = (r.releaseNotes || []).map((n) => n.language).join(',') || 'none';
        console.log(`    ${tr.track}: status=${r.status} name="${r.name ?? ''}" vc=[${vcs}] countries=${ct} notes=[${notes}]`);
      }
    }
  } finally {
    await api(token, 'DELETE', `/${app.pkg}/edits/${editId}`);
    console.log(`  (edit ${editId} abandoned — nothing committed)`);
  }
}

(async () => {
  const token = await getToken();
  console.log('androidpublisher token minted.');
  for (const app of APPS) {
    try { await probe(token, app); } catch (e) { console.log(`  ERROR ${app.pkg}: ${e.message}`); }
  }
  console.log('\nNOTE: content rating (IARC), data safety, target audience, and the App-content');
  console.log('policy declarations are console-only — no API. Verify those in Play Console -> App content.');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
