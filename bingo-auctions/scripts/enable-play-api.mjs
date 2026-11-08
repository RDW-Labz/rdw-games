#!/usr/bin/env node
// One-shot: enable androidpublisher.googleapis.com on GCP project 379983272685
// via the Service Usage REST API using the service-account JWT flow.
//
// If the SA lacks serviceusage.services.enable, the call returns 403 and we
// print the URL the user must click.

import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SA = JSON.parse(readFileSync(join(REPO, '.secrets/google-play-service-account.json'), 'utf8'));
const PROJECT_NUM = '379983272685';
const API = 'androidpublisher.googleapis.com';
const PACKAGE = 'com.cluerholdings.auctionplatform';

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function makeJwt(scope) {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claim = {
    iss: SA.client_email,
    scope,
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const headerB64 = b64url(JSON.stringify(header));
  const claimB64 = b64url(JSON.stringify(claim));
  const toSign = `${headerB64}.${claimB64}`;
  const signer = createSign('RSA-SHA256');
  signer.update(toSign);
  const sig = signer.sign(SA.private_key);
  return `${toSign}.${b64url(sig)}`;
}

async function getToken(scope) {
  const jwt = makeJwt(scope);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  const j = await res.json();
  if (!res.ok) {
    throw new Error(`Token mint failed (${res.status}): ${JSON.stringify(j)}`);
  }
  return j.access_token;
}

async function enableApi() {
  console.log('[1/3] Minting OAuth token (scope=cloud-platform)...');
  const token = await getToken('https://www.googleapis.com/auth/cloud-platform');
  console.log('       got token ok');

  console.log(`[2/3] POST serviceusage:enable for ${API}...`);
  const url = `https://serviceusage.googleapis.com/v1/projects/${PROJECT_NUM}/services/${API}:enable`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  const body = await res.text();
  let parsed;
  try { parsed = JSON.parse(body); } catch { parsed = body; }
  console.log(`       status ${res.status}`);
  console.log(`       body ${JSON.stringify(parsed).slice(0, 500)}`);

  if (!res.ok) {
    console.log('');
    console.log('=== HEADLESS ENABLE FAILED ===');
    console.log('User must click:');
    console.log(`  https://console.developers.google.com/apis/api/${API}/overview?project=${PROJECT_NUM}`);
    return { enabled: false, reason: parsed };
  }

  console.log('       enable accepted');
  return { enabled: true, op: parsed };
}

async function verifyEdits() {
  console.log('[3/3] Verify by minting androidpublisher token + creating an edit...');
  const token = await getToken('https://www.googleapis.com/auth/androidpublisher');
  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}/edits`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  const body = await res.text();
  let parsed;
  try { parsed = JSON.parse(body); } catch { parsed = body; }
  console.log(`       status ${res.status}`);
  console.log(`       body ${JSON.stringify(parsed).slice(0, 500)}`);
  if (!res.ok) {
    return { ok: false, body: parsed };
  }
  const editId = parsed.id;
  console.log(`       edit id ${editId} — abandoning to leave no dangling edit`);
  const del = await fetch(`${url}/${editId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  console.log(`       abandon status ${del.status}`);
  return { ok: true, editId };
}

(async () => {
  const r = await enableApi();
  if (!r.enabled) {
    console.log('');
    console.log('SUMMARY: Play API enabled headlessly: NO');
    console.log(`URL to click: https://console.developers.google.com/apis/api/${API}/overview?project=${PROJECT_NUM}`);
    process.exit(2);
  }
  // Brief delay to let the enable propagate
  await new Promise((r) => setTimeout(r, 4000));
  const v = await verifyEdits();
  console.log('');
  if (v.ok) {
    console.log('SUMMARY: Play API enabled headlessly: YES');
    console.log(`Verify: /edits returned id ${v.editId} and was abandoned cleanly.`);
  } else {
    console.log('SUMMARY: Play API enabled headlessly: YES (enable returned ok) but verify failed.');
    console.log('Likely cause: propagation delay OR the SA is not linked to the package in Play Console.');
    console.log(JSON.stringify(v.body, null, 2));
  }
})().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
