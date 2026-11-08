#!/usr/bin/env node
// Probe the App Store Connect API to check which capabilities are enabled
// on the App ID for com.cluerholdings.auctionplatform. If Associated Domains
// is missing, EAS's provisioning profile can't include the entitlement and
// the bidder iOS archive step fails.

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

async function asc(path) {
  const res = await fetch(`https://api.appstoreconnect.apple.com/v1${path}`, {
    headers: { Authorization: `Bearer ${mintJwt()}` },
  });
  const body = await res.text();
  try { return { ok: res.ok, status: res.status, body: JSON.parse(body) }; } catch { return { ok: res.ok, status: res.status, body }; }
}

(async () => {
  console.log(`Looking up bundleId for ${BUNDLE}...`);
  const list = await asc(`/bundleIds?filter[identifier]=${BUNDLE}&include=bundleIdCapabilities&limit=1`);
  if (!list.ok) {
    console.error('Failed:', list.status, JSON.stringify(list.body).slice(0, 400));
    process.exit(1);
  }
  const bundle = list.body.data?.[0];
  if (!bundle) {
    console.error('No bundle found with identifier', BUNDLE);
    process.exit(1);
  }
  console.log(`Bundle ID: ${bundle.id}  name=${bundle.attributes.name}`);
  console.log('');
  console.log('Currently-enabled capabilities:');
  const caps = (list.body.included ?? []).filter(x => x.type === 'bundleIdCapabilities');
  if (caps.length === 0) {
    console.log('  (none reported via this endpoint)');
  } else {
    for (const c of caps) {
      console.log(`  - ${c.attributes.capabilityType}`);
    }
  }
  console.log('');
  const hasAssocDomains = caps.some(c => c.attributes.capabilityType === 'ASSOCIATED_DOMAINS');
  if (hasAssocDomains) {
    console.log('OK -- ASSOCIATED_DOMAINS is enabled on the bundle.');
    console.log('Build failure is likely a stale EAS provisioning-profile cache. Need to delete the cached profile and let EAS re-mint.');
  } else {
    console.log('MISSING -- ASSOCIATED_DOMAINS is NOT enabled. Need to add it.');
    console.log('');
    console.log('To enable via ASC API, POST /v1/bundleIdCapabilities:');
    console.log(JSON.stringify({
      data: {
        type: 'bundleIdCapabilities',
        attributes: { capabilityType: 'ASSOCIATED_DOMAINS' },
        relationships: { bundleId: { data: { type: 'bundleIds', id: bundle.id } } },
      },
    }, null, 2));
  }
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
