#!/usr/bin/env node
// Verify-only: assumes androidpublisher.googleapis.com is already enabled
// in GCP project 379983272685. Mints an OAuth token with the androidpublisher
// scope and tries POST /edits to confirm end-to-end access. If 200, deletes
// the edit so we don't leave a dangling one.

import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const SA = JSON.parse(readFileSync(join(REPO, '.secrets/google-play-service-account.json'), 'utf8'));
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
  if (!res.ok) throw new Error(`Token mint failed (${res.status}): ${JSON.stringify(j)}`);
  return j.access_token;
}

(async () => {
  const token = await getToken('https://www.googleapis.com/auth/androidpublisher');
  console.log('OAuth token minted (androidpublisher scope) ok');

  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${PACKAGE}/edits`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  const body = await res.text();
  let parsed;
  try { parsed = JSON.parse(body); } catch { parsed = body; }
  console.log(`POST /edits -> status ${res.status}`);
  console.log(`body: ${JSON.stringify(parsed).slice(0, 500)}`);

  if (!res.ok) {
    console.log('');
    console.log('VERIFY FAIL - API still not callable. Common causes:');
    console.log('  1. Enable not yet propagated (wait 30s and retry)');
    console.log('  2. Service account not linked to the app in Play Console > Users & Permissions');
    console.log('  3. Service account missing role: Release Manager / Service Account User');
    process.exit(2);
  }

  const editId = parsed.id;
  console.log(`Edit id ${editId} created - abandoning...`);
  const del = await fetch(`${url}/${editId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  console.log(`DELETE /edits/${editId} -> status ${del.status}`);

  console.log('');
  console.log('VERIFY PASS - Play Developer API is enabled and callable.');
})().catch((e) => {
  console.error('FAIL:', e.message);
  process.exit(1);
});
