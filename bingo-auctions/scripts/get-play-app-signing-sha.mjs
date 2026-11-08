#!/usr/bin/env node
// =============================================================================
// scripts/get-play-app-signing-sha.mjs
//
// READ-ONLY: prints the Google Play *App Signing* key SHA-256 certificate
// fingerprint for a BinGo app, formatted for Android App Links
// (.well-known/assetlinks.json — colon-delimited uppercase hex).
//
// Why: EAS Build manages the *upload* key; Google Play re-signs releases with
// the Google-managed *app-signing* key. assetlinks.json must list the
// app-signing key's SHA-256. That value is retrievable headlessly via the
// Play Developer API generatedApks endpoint (no Console trip needed) once an
// AAB has been uploaded + processed for at least one track.
//
// It mints an androidpublisher OAuth token, opens a THROWAWAY edit to read the
// version codes on every track, then calls generatedApks.list for the newest
// processed version code and prints each signing key's certificateSha256Hash.
// The edit is always abandoned; nothing is committed/published. The cert
// fingerprint it prints is PUBLIC (it ends up in assetlinks.json on the web).
//
// Service-account key path: env GP_SA_PATH, else <repo>/.secrets/google-play-service-account.json
// Package:                  env GP_PKG,     else com.bingoauctions.bidder (bidder)
//
// Usage (from a checkout that has .secrets/, e.g. the main checkout):
//   node scripts/get-play-app-signing-sha.mjs
// Usage (from a worktree without .secrets/, point at the main checkout's key):
//   $env:GP_SA_PATH='C:\Users\jmacl\Projects\auction-platform\.secrets\google-play-service-account.json'
//   node scripts/get-play-app-signing-sha.mjs
// =============================================================================

import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SA_PATH = process.env.GP_SA_PATH || join(REPO, '.secrets/google-play-service-account.json');
// Default corrected 2026-08-07: com.cluerholdings.auctionplatform was never
// published to Play, so the old default returned a fingerprint for an app
// that does not exist — which is how the wrong value reached assetlinks.json.
const PKG = process.env.GP_PKG || 'com.bingoauctions.bidder';
const SA = JSON.parse(readFileSync(SA_PATH, 'utf8'));
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
async function req(token, method, path) {
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

// Normalize whatever certificateSha256Hash format the API returns into
// colon-delimited uppercase hex (the form Digital Asset Links expects).
function toColonHex(raw) {
  const s = String(raw ?? '').trim();
  const hexOnly = s.replace(/:/g, '');
  if (/^[0-9a-fA-F]{64}$/.test(hexOnly)) {
    return hexOnly.toUpperCase().match(/.{2}/g).join(':');
  }
  try {
    const b = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (b.length === 32) return b.toString('hex').toUpperCase().match(/.{2}/g).join(':');
  } catch { /* fall through */ }
  return `UNRECOGNIZED_FORMAT(${s})`;
}

(async () => {
  const token = await getToken();
  console.log(`androidpublisher token minted. pkg=${PKG}`);

  // 1) Gather version codes from all tracks (throwaway edit).
  const ins = await req(token, 'POST', `/${PKG}/edits`);
  if (ins.status !== 200) throw new Error(`edits.insert ${ins.status}: ${JSON.stringify(ins.body).slice(0, 300)}`);
  const editId = ins.body.id;
  let vcs = [];
  try {
    const tracks = await req(token, 'GET', `/${PKG}/edits/${editId}/tracks`);
    for (const tr of (tracks.body?.tracks ?? [])) {
      for (const rel of (tr.releases ?? [])) {
        for (const vc of (rel.versionCodes ?? [])) vcs.push(Number(vc));
      }
    }
  } finally {
    await req(token, 'DELETE', `/${PKG}/edits/${editId}`);
  }
  vcs = [...new Set(vcs)].sort((a, b) => b - a);
  console.log(`versionCodes (newest first): ${vcs.join(', ') || '(none)'}`);
  if (!vcs.length) throw new Error('no versionCodes found on any track — has an AAB been uploaded?');

  // 2) For the newest version code with generated APKs, print the signing cert(s).
  for (const vc of vcs) {
    const g = await req(token, 'GET', `/${PKG}/generatedApks/${vc}`);
    if (g.status !== 200) { console.log(`  vc ${vc}: generatedApks -> ${g.status}`); continue; }
    const keys = g.body?.generatedApks ?? [];
    if (!keys.length) { console.log(`  vc ${vc}: no generatedApks entries (not processed yet?)`); continue; }
    console.log(`\n=== versionCode ${vc}: ${keys.length} signing key(s) ===`);
    for (const k of keys) {
      console.log(`  certificateSha256Hash (raw): ${k.certificateSha256Hash}`);
      console.log(`  SHA-256 for assetlinks.json: ${toColonHex(k.certificateSha256Hash)}`);
    }
    console.log('\nSet the app-signing key SHA-256 above as ANDROID_APP_SIGNING_SHA256');
    console.log('in apps/operator-web/wrangler.jsonc (vars), then redeploy. The route');
    console.log('reads it at request time — no code change needed to rotate it.');
    return;
  }
  throw new Error('no processed generatedApks found for any version code yet');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
