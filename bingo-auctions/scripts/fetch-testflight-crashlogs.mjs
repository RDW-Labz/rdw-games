#!/usr/bin/env node
// Pull the actual .crash log file for each TestFlight crash submission
// listed in scripts/.testflight-feedback/crash-submissions.json. Then
// print the relevant chunks (Crashed Thread + Exception Type/Subtype +
// Termination Description + first ~30 frames).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const KEY_ID    = '25M83P99J8';
const ISSUER_ID = 'df79d9d0-5f90-4a53-8e2f-4c16b3fafce9';
const KEY_PATH  = resolve(REPO_ROOT, '.secrets/AuthKey_25M83P99J8.p8');
const SRC       = resolve(REPO_ROOT, 'scripts/.testflight-feedback/crash-submissions.json');
const OUT_DIR   = resolve(REPO_ROOT, 'scripts/.testflight-feedback/logs');

async function makeJwt() {
  const key = await readFile(KEY_PATH, 'utf8');
  return jwt.sign(
    { iss: ISSUER_ID, iat: Math.floor(Date.now()/1000), exp: Math.floor(Date.now()/1000) + 1200, aud: 'appstoreconnect-v1' },
    key,
    { algorithm: 'ES256', header: { alg: 'ES256', kid: KEY_ID, typ: 'JWT' } }
  );
}

async function ascGet(url, token, raw = false) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, redirect: 'follow' });
  if (!res.ok) {
    const body = await res.text().catch(()=>'');
    throw new Error(`ASC ${res.status} ${res.statusText} ${url} — ${body.slice(0,400)}`);
  }
  return raw ? res.text() : res.json();
}

async function main() {
  const token = await makeJwt();
  await mkdir(OUT_DIR, { recursive: true });
  const submissions = JSON.parse(await readFile(SRC, 'utf8'));

  console.log('═══ Pulling crash logs for', submissions.data.length, 'submissions ═══\n');

  for (const sub of submissions.data) {
    const attrs = sub.attributes;
    console.log(`── [${sub.id}] ${attrs.email} • ${attrs.deviceModel} iOS ${attrs.osVersion} • ${attrs.createdDate}`);
    console.log(`   comment: ${JSON.stringify(attrs.comment)}`);

    // Get the crashLog metadata first
    let meta;
    try {
      meta = await ascGet(`https://api.appstoreconnect.apple.com/v1/betaFeedbackCrashSubmissions/${sub.id}/crashLog`, token);
    } catch (e) {
      console.log('   crashLog meta error:', e.message);
      continue;
    }

    // Crash log content is embedded directly in attributes.logText.
    const logText = meta?.data?.attributes?.logText;
    if (!logText) {
      console.log('   no logText in crashLog meta. keys:', Object.keys(meta?.data?.attributes || {}));
      await writeFile(resolve(OUT_DIR, sub.id + '-meta.json'), JSON.stringify(meta, null, 2));
      continue;
    }
    await writeFile(resolve(OUT_DIR, sub.id + '.crash'), logText);
    console.log(`   saved log (${logText.length} bytes)`);

    // Print the diagnostic header (first 80 lines is usually enough to see
    // the exception + crashed thread).
    const header = logText.split('\n').slice(0, 80).join('\n');
    console.log('   ─── log header ───');
    for (const line of header.split('\n')) console.log('   |', line);
    console.log('   ──────────────────\n');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
