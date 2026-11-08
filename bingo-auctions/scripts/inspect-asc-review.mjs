#!/usr/bin/env node
// =============================================================================
// scripts/inspect-asc-review.mjs
//
// READ-ONLY. Pulls the current App Store review state + the demo-account
// "App Review Information" we submitted for each app, so we can diagnose an
// Apple rejection ("demo login was missing something", 2026-06-02) against
// ground truth instead of guessing. The reviewer's free-text message lives in
// Resolution Center (web only, not in the API) — but this surfaces the
// version state + the exact demo creds/notes Apple was handed, which is what
// "missing something" almost always comes down to.
//
// Usage:
//   node scripts/inspect-asc-review.mjs            # both apps
//   node scripts/inspect-asc-review.mjs --app bidder
//   node scripts/inspect-asc-review.mjs --verbose  # dump raw review-detail
//
// No flags mutate anything.
// =============================================================================

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createSign } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const CONFIG = {
  bidder: { appId: '6767012532', bundle: 'com.cluerholdings.auctionplatform', name: 'ClovrBid Bidder' },
  staff: { appId: '6767026881', bundle: 'com.cluerholdings.bidwizops', name: 'ClovrBid Staff' },
};

const ASC_KEY_ID = '25M83P99J8';
const ASC_ISSUER_ID = 'df79d9d0-5f90-4a53-8e2f-4c16b3fafce9';
const ASC_BASE_URL = 'https://api.appstoreconnect.apple.com/v1';

function findKeyPath() {
  const candidates = [
    join(REPO_ROOT, '.secrets', 'AuthKey_25M83P99J8.p8'),
    'C:\\Users\\jmacl\\Projects\\auction-platform\\.secrets\\AuthKey_25M83P99J8.p8',
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

const args = process.argv.slice(2);
const flags = { app: 'both', verbose: false };
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--app') flags.app = args[++i];
  else if (args[i] === '--verbose') flags.verbose = true;
}

function makeJwt() {
  const keyPath = findKeyPath();
  if (!keyPath) throw new Error('ASC key not found in .secrets/AuthKey_25M83P99J8.p8');
  const key = readFileSync(keyPath, 'utf8');
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'ES256', kid: ASC_KEY_ID, typ: 'JWT' };
  const payload = { iss: ASC_ISSUER_ID, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' };
  const h = Buffer.from(JSON.stringify(header)).toString('base64url');
  const p = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const message = `${h}.${p}`;
  const signer = createSign('SHA256');
  signer.update(message);
  // ieee-p1363 raw r||s sig — DER 401s (see submit-ios-app-store.mjs).
  const sig = signer.sign({ key, dsaEncoding: 'ieee-p1363' }, 'base64url');
  return `${message}.${sig}`;
}

async function ascFetch(token, path) {
  const res = await fetch(`${ASC_BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) {
    const detail = body?.errors?.[0]?.detail || text;
    throw new Error(`ASC ${res.status} on ${path}: ${detail}`);
  }
  return body;
}

function mask(s) {
  if (!s) return '<empty>';
  if (s.length <= 3) return '***';
  return `${s.slice(0, 2)}***${s.slice(-1)} (len ${s.length})`;
}

async function inspectApp(token, key) {
  const app = CONFIG[key];
  console.log(`\n========================================================`);
  console.log(`  ${app.name}  (appId ${app.appId} · ${app.bundle})`);
  console.log(`========================================================`);

  // Latest 3 versions + their review detail.
  const verResp = await ascFetch(
    token,
    `/apps/${app.appId}/appStoreVersions?limit=3` +
      `&fields[appStoreVersions]=versionString,appStoreState,createdDate,reviewType` +
      `&include=appStoreReviewDetail` +
      `&fields[appStoreReviewDetails]=contactFirstName,contactLastName,contactEmail,contactPhone,demoAccountName,demoAccountPassword,demoAccountRequired,notes`,
  );

  const included = verResp.included ?? [];
  const reviewDetailById = new Map(included.map((r) => [r.id, r]));

  for (const v of verResp.data ?? []) {
    const a = v.attributes ?? {};
    console.log(`\n  • v${a.versionString}  state=${a.appStoreState}  created=${a.createdDate}`);
    let rd = null;
    const rdRef = v.relationships?.appStoreReviewDetail?.data;
    if (rdRef) rd = reviewDetailById.get(rdRef.id);
    // Authoritative: hit the 1:1 relationship endpoint directly. A 404 here
    // means the App Review Information (demo account) was NEVER set on this
    // version — the canonical "we couldn't sign in" rejection cause.
    if (!rd) {
      try {
        const direct = await ascFetch(token, `/appStoreVersions/${v.id}/appStoreReviewDetail`);
        rd = direct?.data ?? null;
      } catch (e) {
        console.log(`      App Review Information: ABSENT (direct fetch → ${e.message})`);
        continue;
      }
    }
    if (!rd) {
      console.log(`      App Review Information: ABSENT (no demo account attached)`);
      continue;
    }
    const r = rd.attributes ?? {};
    console.log(`      demoAccountRequired : ${r.demoAccountRequired}`);
    console.log(`      demoAccountName     : ${r.demoAccountName ?? '<empty>'}`);
    console.log(`      demoAccountPassword : ${mask(r.demoAccountPassword)}`);
    console.log(`      contact             : ${r.contactFirstName ?? ''} ${r.contactLastName ?? ''} <${r.contactEmail ?? '<none>'}> ${r.contactPhone ?? ''}`);
    console.log(`      notes               : ${r.notes ? JSON.stringify(r.notes) : '<empty>'}`);
    if (flags.verbose) console.log(`      RAW: ${JSON.stringify(r)}`);
  }
}

(async () => {
  const token = makeJwt();
  // Sanity ping.
  const me = await ascFetch(token, '/apps?limit=1');
  if (!me) throw new Error('ASC auth failed');
  const keys = flags.app === 'both' ? ['bidder', 'staff'] : [flags.app];
  for (const k of keys) {
    if (!CONFIG[k]) { console.error(`unknown app: ${k}`); continue; }
    try {
      await inspectApp(token, k);
    } catch (e) {
      console.error(`\n  [${k}] FAILED: ${e.message}`);
    }
  }
  console.log('\nNote: the reviewer\'s free-text rejection message is in Resolution Center');
  console.log('(App Store Connect web UI) — not exposed by the API. Compare the demo');
  console.log('creds/notes above against the screenshot Apple provided.');
})().catch((e) => { console.error('uncaught:', e.message); process.exit(1); });
