#!/usr/bin/env node
// scripts/asc-rename-apps.mjs
//
// Renames the two App Store Connect apps so TestFlight + App Store stop
// showing the legacy "bidwizops" branding. Uses the same .p8 key we
// already use for EAS auto-submit + the crash-log fetcher.
//
// What it does:
//   - For app `6767026881` (field-mobile / Staff): sets the AppInfo
//     en-US name to "BinGo Staff"
//   - For app `6767012532` (bidder-app / Consumer): sets the AppInfo
//     en-US name to "BinGo"
//
// The "name" shown in TestFlight + App Store is the
// AppInfoLocalization.name field for the primary locale, not the
// CFBundleDisplayName from the IPA. So we don't need a new build.
//
// Idempotent: re-running just confirms the names are already set.

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const KEY_ID    = '25M83P99J8';
const ISSUER_ID = 'df79d9d0-5f90-4a53-8e2f-4c16b3fafce9';
const KEY_PATH  = resolve(REPO_ROOT, '.secrets/AuthKey_25M83P99J8.p8');

const RENAMES = [
  { appId: '6767026881', newName: 'ClovrBid Staff' },
  { appId: '6767012532', newName: 'ClovrBid' },
];

async function makeJwt() {
  const key = await readFile(KEY_PATH, 'utf8');
  return jwt.sign(
    {
      iss: ISSUER_ID,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 1200,
      aud: 'appstoreconnect-v1',
    },
    key,
    {
      algorithm: 'ES256',
      keyid: KEY_ID,
      header: { alg: 'ES256', kid: KEY_ID, typ: 'JWT' },
    },
  );
}

async function ascFetch(token, path, init = {}) {
  const res = await fetch(`https://api.appstoreconnect.apple.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
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

async function renameApp(token, appId, newName) {
  console.log(`\n── App ${appId} → "${newName}" ──`);

  // 1. Look up the app + its appInfos.
  const app = await ascFetch(token, `/v1/apps/${appId}?include=appInfos`);
  const current = app?.data?.attributes;
  console.log(`  current app-record name: "${current?.name}"  bundle=${current?.bundleId}`);

  const appInfos = (app?.included ?? []).filter((r) => r.type === 'appInfos');
  // Pick the most recent appInfo (state is the cleanest selector but appInfos
  // generally only have 1-2: one for the live store version, one for the next).
  // We patch ALL of them so both the live App Store name and the next-version
  // name update — TestFlight shows whichever AppInfo is currently "PREPARE_FOR_SUBMISSION".
  if (appInfos.length === 0) {
    console.log('  ⚠ no appInfos returned — skipping');
    return;
  }
  console.log(`  found ${appInfos.length} appInfo(s)`);

  for (const ai of appInfos) {
    console.log(`  ── appInfo ${ai.id} (state=${ai.attributes?.appStoreState ?? 'unknown'}) ──`);

    // 2. List localizations for this appInfo.
    const locs = await ascFetch(
      token,
      `/v1/appInfos/${ai.id}/appInfoLocalizations`,
    );
    const enUS = (locs?.data ?? []).find(
      (l) => l.attributes?.locale === 'en-US',
    );
    if (!enUS) {
      console.log('    ⚠ no en-US localization — skipping appInfo');
      continue;
    }
    console.log(`    en-US localization id=${enUS.id} currentName="${enUS.attributes?.name}"`);

    if (enUS.attributes?.name === newName) {
      console.log('    ✓ already named correctly — nothing to do');
      continue;
    }

    // 3. PATCH the en-US localization with the new name.
    await ascFetch(
      token,
      `/v1/appInfoLocalizations/${enUS.id}`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          data: {
            type: 'appInfoLocalizations',
            id: enUS.id,
            attributes: { name: newName },
          },
        }),
      },
    );
    console.log(`    ✓ updated to "${newName}"`);
  }
}

const token = await makeJwt();
for (const r of RENAMES) {
  await renameApp(token, r.appId, r.newName);
}
console.log('\nDone.');
