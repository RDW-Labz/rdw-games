#!/usr/bin/env node
// Pull TestFlight tester feedback from App Store Connect for the
// bidwizops-field iOS app. Filters to recent submissions and prints
// a digestible summary.
//
// What it pulls:
//   - betaFeedbackScreenshotSubmissions (feedback with screenshot + comment)
//   - betaFeedbackCrashSubmissions (crashes with attached logs)
//
// Auth: ES256 JWT signed with the .p8 private key in .secrets/.
// Reuses the same key EAS uses for auto-submit.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import jwt from 'jsonwebtoken';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const ASC_APP_ID  = '6767026881';
const KEY_ID      = '25M83P99J8';
const ISSUER_ID   = 'df79d9d0-5f90-4a53-8e2f-4c16b3fafce9';
const KEY_PATH    = resolve(REPO_ROOT, '.secrets/AuthKey_25M83P99J8.p8');
const OUT_DIR     = resolve(REPO_ROOT, 'scripts/.testflight-feedback');

async function makeJwt() {
  const key = await readFile(KEY_PATH, 'utf8');
  return jwt.sign(
    {
      iss: ISSUER_ID,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 1200, // 20 min
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

async function ascGet(path, token) {
  const u = path.startsWith('http') ? path : `https://api.appstoreconnect.apple.com${path}`;
  const res = await fetch(u, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ASC ${res.status} ${res.statusText} ${u} — ${body.slice(0, 400)}`);
  }
  return res.json();
}

function fmtDate(s) {
  if (!s) return '';
  return new Date(s).toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

async function main() {
  const token = await makeJwt();
  await mkdir(OUT_DIR, { recursive: true });

  console.log('═══ TestFlight feedback for app', ASC_APP_ID, '═══');

  // ── Screenshot feedback submissions ────────────────────────────────────
  console.log('\n── Screenshot feedback (comments + screenshots) ──');
  // ASC API forbids GET_COLLECTION on the bare /v1/betaFeedback* paths —
  // we must navigate via the app: /v1/apps/{id}/betaFeedbackScreenshotSubmissions.
  const ssUrl =
    `/v1/apps/${ASC_APP_ID}/betaFeedbackScreenshotSubmissions` +
    `?sort=-createdDate&limit=50` +
    `&include=tester,build`;
  let ss;
  try {
    ss = await ascGet(ssUrl, token);
  } catch (e) {
    console.error('Screenshot fetch error:', e.message);
    ss = { data: [], included: [] };
  }
  console.log('Total screenshot submissions:', ss.data?.length ?? 0);

  // Build lookup maps from included testers/builds
  const testers = new Map();
  const builds = new Map();
  const screenshots = new Map();
  for (const it of ss.included ?? []) {
    if (it.type === 'betaTesters') testers.set(it.id, it.attributes);
    else if (it.type === 'builds') builds.set(it.id, it.attributes);
    else if (it.type === 'betaFeedbackScreenshotImages' || it.type === 'betaFeedbackScreenshots') {
      screenshots.set(it.id, it.attributes);
    }
  }

  let i = 0;
  for (const item of ss.data ?? []) {
    i++;
    const a = item.attributes ?? {};
    const tester = item.relationships?.tester?.data?.id;
    const build = item.relationships?.build?.data?.id;
    const tInfo = tester ? testers.get(tester) : null;
    const bInfo = build ? builds.get(build) : null;
    const ssData = item.relationships?.screenshots?.data ?? [];

    console.log(`\n[${i}] ${fmtDate(a.createdDate)}`);
    console.log(`    Tester: ${tInfo ? `${tInfo.firstName ?? ''} ${tInfo.lastName ?? ''} <${tInfo.email ?? '?'}>` : '?'}`);
    console.log(`    Build:  ${bInfo ? `v${bInfo.version ?? '?'} build ${bInfo.uploadedDate ? fmtDate(bInfo.uploadedDate) : '?'}` : '?'}`);
    console.log(`    Device: ${a.deviceModel ?? '?'} on iOS ${a.osVersion ?? '?'} (${a.architecture ?? '?'})`);
    console.log(`    Locale: ${a.locale ?? '?'} | Network: ${a.networkType ?? '?'} | Battery: ${a.batteryPercentage ?? '?'}%`);
    if (a.comment) {
      console.log(`    Comment:`);
      for (const line of String(a.comment).split('\n')) console.log(`      > ${line}`);
    }
    console.log(`    Screenshots: ${ssData.length}`);
    for (const ref of ssData) {
      const s = screenshots.get(ref.id);
      const url = s?.imageAssets?.[0]?.url ?? s?.url ?? null;
      if (url) console.log(`      ${url}`);
    }
  }

  // ── Crash feedback submissions ─────────────────────────────────────────
  console.log('\n\n── Crash feedback ──');
  const crUrl =
    `/v1/apps/${ASC_APP_ID}/betaFeedbackCrashSubmissions` +
    `?sort=-createdDate&limit=50` +
    `&include=tester,build`;
  let cr;
  try {
    cr = await ascGet(crUrl, token);
  } catch (e) {
    console.error('Crash fetch error:', e.message);
    cr = { data: [], included: [] };
  }
  console.log('Total crash submissions:', cr.data?.length ?? 0);

  for (const it of cr.included ?? []) {
    if (it.type === 'betaTesters') testers.set(it.id, it.attributes);
    else if (it.type === 'builds') builds.set(it.id, it.attributes);
  }

  i = 0;
  for (const item of cr.data ?? []) {
    i++;
    const a = item.attributes ?? {};
    const tester = item.relationships?.tester?.data?.id;
    const build = item.relationships?.build?.data?.id;
    const tInfo = tester ? testers.get(tester) : null;
    const bInfo = build ? builds.get(build) : null;
    const crLogs = item.relationships?.crashLogs?.data ?? [];

    console.log(`\n[${i}] ${fmtDate(a.createdDate)}`);
    console.log(`    Tester: ${tInfo ? `${tInfo.firstName ?? ''} ${tInfo.lastName ?? ''} <${tInfo.email ?? '?'}>` : '?'}`);
    console.log(`    Build:  ${bInfo ? `v${bInfo.version ?? '?'}` : '?'}`);
    console.log(`    Device: ${a.deviceModel ?? '?'} on iOS ${a.osVersion ?? '?'}`);
    if (a.comment) {
      console.log(`    Comment:`);
      for (const line of String(a.comment).split('\n')) console.log(`      > ${line}`);
    }
    console.log(`    Crash logs: ${crLogs.length}`);
  }

  // Save raw JSON for follow-up inspection
  await writeFile(resolve(OUT_DIR, 'screenshot-submissions.json'), JSON.stringify(ss, null, 2));
  await writeFile(resolve(OUT_DIR, 'crash-submissions.json'), JSON.stringify(cr, null, 2));
  console.log(`\nRaw data saved to ${OUT_DIR}/`);
}

main().catch(e => { console.error(e); process.exit(1); });
