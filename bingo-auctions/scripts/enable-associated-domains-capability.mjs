#!/usr/bin/env node
// Enable ASSOCIATED_DOMAINS capability on the bidder app's App ID via
// ASC API. After this runs, the next EAS build will re-mint a
// provisioning profile that includes com.apple.developer.associated-domains
// and Universal Links archive step will pass.

import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const KEY_ID = '25M83P99J8';
const ISSUER_ID = 'df79d9d0-5f90-4a53-8e2f-4c16b3fafce9';
const KEY_PATH = join(REPO, '.secrets', `AuthKey_${KEY_ID}.p8`);
const BUNDLE = 'com.cluerholdings.auctionplatform';
const APPLE_INTERNAL_ID = 'RY2CGZK55D';

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
  try { return { ok: res.ok, status: res.status, body: JSON.parse(text) }; } catch { return { ok: res.ok, status: res.status, body: text }; }
}

(async () => {
  console.log(`Enabling ASSOCIATED_DOMAINS on bundle ${BUNDLE} (Apple internal ID ${APPLE_INTERNAL_ID})...`);
  const r = await asc('POST', '/bundleIdCapabilities', {
    data: {
      type: 'bundleIdCapabilities',
      attributes: { capabilityType: 'ASSOCIATED_DOMAINS' },
      relationships: { bundleId: { data: { type: 'bundleIds', id: APPLE_INTERNAL_ID } } },
    },
  });
  console.log(`POST /bundleIdCapabilities -> status ${r.status}`);
  if (!r.ok) {
    console.error('FAIL:', JSON.stringify(r.body, null, 2));
    process.exit(1);
  }
  console.log(`Created capability id ${r.body.data.id}`);
  console.log('');

  // Verify
  console.log('Verifying via GET /bundleIds?include=bundleIdCapabilities...');
  const verify = await asc('GET', `/bundleIds?filter[identifier]=${BUNDLE}&include=bundleIdCapabilities&limit=1`);
  const caps = (verify.body.included ?? []).filter(x => x.type === 'bundleIdCapabilities');
  console.log('Currently-enabled capabilities:');
  for (const c of caps) {
    console.log(`  - ${c.attributes.capabilityType}`);
  }
  const has = caps.some(c => c.attributes.capabilityType === 'ASSOCIATED_DOMAINS');
  console.log('');
  console.log(has ? 'OK -- ASSOCIATED_DOMAINS is now enabled.' : 'STILL MISSING -- enable did not stick.');
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
