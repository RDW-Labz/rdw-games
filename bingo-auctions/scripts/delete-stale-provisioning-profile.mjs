#!/usr/bin/env node
// Delete the stale bidder iOS provisioning profile via Apple ASC API.
// EAS Cloud keeps reusing the cached profile from 2026-05-13 which was
// minted BEFORE ASSOCIATED_DOMAINS was enabled on the App ID. Deleting
// it forces EAS to mint a fresh profile that includes the entitlement.

import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const KEY_ID = '25M83P99J8';
const ISSUER_ID = 'df79d9d0-5f90-4a53-8e2f-4c16b3fafce9';
const KEY_PATH = join(REPO, '.secrets', `AuthKey_${KEY_ID}.p8`);
const BUNDLE = 'com.cluerholdings.auctionplatform';

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function mintJwt() {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'ES256', kid: KEY_ID, typ: 'JWT' };
  const claim = { iss: ISSUER_ID, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' };
  const toSign = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claim))}`;
  const signer = createSign('SHA256');
  signer.update(toSign);
  const der = signer.sign({ key: readFileSync(KEY_PATH, 'utf8'), dsaEncoding: 'ieee-p1363' });
  return `${toSign}.${b64url(der)}`;
}

async function asc(method, path, body) {
  const res = await fetch(`https://api.appstoreconnect.apple.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${mintJwt()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!text) return { ok: res.ok, status: res.status, body: null };
  try { return { ok: res.ok, status: res.status, body: JSON.parse(text) }; } catch { return { ok: res.ok, status: res.status, body: text }; }
}

(async () => {
  console.log(`Listing all provisioning profiles for bundle ${BUNDLE}...`);
  const list = await asc('GET', '/profiles?include=bundleId&limit=200');
  if (!list.ok) {
    console.error('FAIL listing:', list.status, JSON.stringify(list.body).slice(0, 400));
    process.exit(1);
  }
  const bundleResp = await asc('GET', `/bundleIds?filter[identifier]=${BUNDLE}&limit=1`);
  const bundleAppleId = bundleResp.body?.data?.[0]?.id;
  if (!bundleAppleId) {
    console.error('Could not resolve bundle Apple ID');
    process.exit(1);
  }
  console.log(`Bundle Apple internal ID: ${bundleAppleId}`);
  console.log('');

  const matchingProfiles = list.body.data.filter(p => {
    const rels = p.relationships?.bundleId?.data;
    return rels?.id === bundleAppleId;
  });

  console.log(`Found ${matchingProfiles.length} profile(s) for this bundle:`);
  for (const p of matchingProfiles) {
    console.log(`  - id=${p.id}  name=${p.attributes.name}  type=${p.attributes.profileType}  state=${p.attributes.profileState}  uuid=${p.attributes.uuid}`);
  }
  console.log('');

  const toDelete = matchingProfiles.filter(p =>
    p.attributes.name.includes('[expo]') && p.attributes.profileType === 'IOS_APP_STORE'
  );
  console.log(`Will delete ${toDelete.length} stale *[expo]* AppStore profile(s):`);
  for (const p of toDelete) {
    console.log(`  - ${p.attributes.name}`);
  }
  console.log('');

  for (const p of toDelete) {
    console.log(`DELETE /profiles/${p.id} (${p.attributes.name})...`);
    const r = await asc('DELETE', `/profiles/${p.id}`);
    console.log(`  status ${r.status}${r.body ? ' body=' + JSON.stringify(r.body).slice(0, 200) : ''}`);
    if (!r.ok && r.status !== 204) {
      console.error('  FAIL');
    }
  }

  console.log('');
  console.log('Done. Next EAS Build will detect missing profile and mint a fresh one with ASSOCIATED_DOMAINS.');
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
