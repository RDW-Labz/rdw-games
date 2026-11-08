#!/usr/bin/env node
// =============================================================================
// scripts/swap-asc-build.mjs
//
// Swaps the build attached to the v1.0 App Store Connect version (per app) to
// the most-recent VALID build, WITHOUT changing the version state.
//
// USE CASE
//   EAS uploads a new IPA, Apple processes it into a VALID TestFlight build.
//   The v1.0 App Store version (WAITING_FOR_REVIEW) is still attached to the
//   PREVIOUS build (which had a static-analysis blocker, e.g. ITMS-90683). We
//   want the queue position preserved, but the new binary's analysis to run.
//
//   PATCH /v1/appStoreVersions/{id} with the new build relationship is the
//   documented + tested swap path. Apple's review queue position is preserved
//   in most states; if Apple flips the version state back to
//   PREPARE_FOR_SUBMISSION we LOG that — no auto-resubmit.
//
// Prerequisites:
//   - .secrets/AuthKey_25M83P99J8.p8 exists (ASC API key)
//   - v1.0 appStoreVersion exists (any state)
//   - At least one VALID build uploaded
//
// Usage:
//   # Dry-run, BOTH apps (default):
//   node scripts/swap-asc-build.mjs
//
//   # Dry-run, single app:
//   node scripts/swap-asc-build.mjs --app=bidder
//   node scripts/swap-asc-build.mjs --app=staff
//
//   # Actually PATCH:
//   node scripts/swap-asc-build.mjs --app=both --live
//
// Flags:
//   --app=bidder|staff|both    (default: both)
//   --live                     (default: false — dry-run otherwise)
//   --verbose                  (full API responses)
//
// Exit codes:
//   0  — all apps either swapped or were already up-to-date
//   1  — auth / config / unrecoverable error
//   2  — at least one app had no candidate VALID build (still processing)
// =============================================================================

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createSign } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// ─────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────

const CONFIG = {
  bidder: {
    appId: '6767012532',
    bundle: 'com.cluerholdings.auctionplatform',
    name: 'ClovrBid Bidder',
  },
  staff: {
    appId: '6767026881',
    bundle: 'com.cluerholdings.bidwizops',
    name: 'ClovrBid Staff',
  },
};

const TARGET_VERSION = '1.0';
const ASC_KEY_ID = '25M83P99J8';
const ASC_ISSUER_ID = 'df79d9d0-5f90-4a53-8e2f-4c16b3fafce9';
const ASC_BASE_URL = 'https://api.appstoreconnect.apple.com/v1';

function findKeyPath() {
  const candidates = [
    join(REPO_ROOT, '.secrets', 'AuthKey_25M83P99J8.p8'),
    // Worktree case: walk up to main repo root.
    join(REPO_ROOT, '..', '..', '..', '.secrets', 'AuthKey_25M83P99J8.p8'),
    join(REPO_ROOT, '..', '..', '..', '..', '.secrets', 'AuthKey_25M83P99J8.p8'),
    'C:\\Users\\jmacl\\Projects\\auction-platform\\.secrets\\AuthKey_25M83P99J8.p8',
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

const ASC_KEY_PATH = findKeyPath();

// ─────────────────────────────────────────────────────────────────────────
// CLI FLAGS
// ─────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flags = {
  app: 'both',
  live: false,
  verbose: false,
};

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  // Support both --app=bidder and --app bidder
  if (arg.startsWith('--app=')) flags.app = arg.split('=')[1];
  else if (arg === '--app') flags.app = args[++i];
  else if (arg === '--live') flags.live = true;
  else if (arg === '--verbose') flags.verbose = true;
  else if (arg === '--help' || arg === '-h') {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 50).join('\n'));
    process.exit(0);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// AUTH (mirrors submit-ios-app-store.mjs / clear-asc-submission-blockers.mjs)
// ─────────────────────────────────────────────────────────────────────────

function makeJwt() {
  if (!ASC_KEY_PATH || !existsSync(ASC_KEY_PATH)) {
    throw new Error('ASC key not found. Searched .secrets/ and worktree parents for AuthKey_25M83P99J8.p8');
  }
  const key = readFileSync(ASC_KEY_PATH, 'utf8');
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'ES256', kid: ASC_KEY_ID, typ: 'JWT' };
  const payload = { iss: ASC_ISSUER_ID, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' };
  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const message = `${headerB64}.${payloadB64}`;

  // CRITICAL: raw r||s sig (IEEE-P1363), NOT DER. Without this, every request 401s.
  const signer = createSign('SHA256');
  signer.update(message);
  const signature = signer.sign({ key, dsaEncoding: 'ieee-p1363' }, 'base64url');
  return `${message}.${signature}`;
}

// ─────────────────────────────────────────────────────────────────────────
// ASC FETCH (with one-shot 401 re-mint, matching clear-asc-submission-blockers)
// ─────────────────────────────────────────────────────────────────────────

const TOKEN_STATE = { jwt: null };

async function ascRaw(method, path, body) {
  const url = `${ASC_BASE_URL}${path}`;
  const headers = { Authorization: `Bearer ${TOKEN_STATE.jwt}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const init = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);

  const res = await fetch(url, init);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, ok: res.ok, data };
}

async function asc(method, path, body) {
  let attempt = await ascRaw(method, path, body);

  // Apple sometimes 401s a freshly-minted JWT (issuer rate limit ~5s after mint). Re-mint + retry once.
  if (attempt.status === 401) {
    if (flags.verbose) console.error(`[ASC] 401 on ${method} ${path} — re-minting JWT and retrying once`);
    TOKEN_STATE.jwt = makeJwt();
    attempt = await ascRaw(method, path, body);
  }

  if (flags.verbose) {
    console.log(`[ASC] ${method} ${path} -> ${attempt.status}`);
    if (attempt.data) console.log(JSON.stringify(attempt.data, null, 2).split('\n').slice(0, 30).join('\n'));
  }

  if (!attempt.ok) {
    const data = attempt.data;
    const detail = data?.errors?.[0]?.detail
      || data?.errors?.[0]?.title
      || (typeof data === 'string' ? data : JSON.stringify(data));
    const err = new Error(`ASC ${attempt.status} on ${method} ${path}: ${detail}`);
    err.status = attempt.status;
    err.body = data;
    throw err;
  }
  return attempt.data;
}

function logDryRun(method, path, body) {
  console.log(`    [DRY-RUN] ${method} ${ASC_BASE_URL}${path}`);
  if (body) {
    const out = JSON.stringify(body, null, 2).split('\n').map((l) => '      ' + l).join('\n');
    console.log(out);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// CORE STEPS
// ─────────────────────────────────────────────────────────────────────────

async function listRecentValidBuilds(appId) {
  // Top-level /builds endpoint accepts filter[app], filter[processingState], and sort=-uploadedDate
  // (the /apps/{id}/builds relationship endpoint does NOT — same pattern as submit-ios-app-store.mjs).
  const resp = await asc(
    'GET',
    `/builds?filter[app]=${appId}&filter[processingState]=VALID&sort=-uploadedDate&limit=5`
  );
  return resp?.data || [];
}

async function findTargetVersion(appId) {
  // include=build so we get the currently-attached build relationship + its ID inline.
  const resp = await asc(
    'GET',
    `/apps/${appId}/appStoreVersions?filter[platform]=IOS&filter[versionString]=${TARGET_VERSION}&include=build&limit=1`
  );
  const version = resp?.data?.[0];
  if (!version) return { version: null, attachedBuildId: null };

  const attachedBuildId = version.relationships?.build?.data?.id || null;
  return { version, attachedBuildId };
}

async function refetchVersionState(appId, versionId) {
  // Re-fetch just attributes to confirm whether the state changed after PATCH.
  try {
    const resp = await asc('GET', `/appStoreVersions/${versionId}`);
    return resp?.data?.attributes?.appStoreState || null;
  } catch (e) {
    if (flags.verbose) console.error(`    [ASC] refetch ${versionId} failed: ${e.message}`);
    return null;
  }
}

async function patchBuildOnVersion(versionId, newBuildId, newBuildNum) {
  // PATCH /v1/appStoreVersions/{id} with the build relationship in the body.
  // This is the documented + working path. The /relationships/build subresource
  // variant works too but the relationships-in-body PATCH is what Apple's
  // own developer docs show, and it returns the full updated resource in one
  // round-trip (so we can sanity-check the response).
  const body = {
    data: {
      type: 'appStoreVersions',
      id: versionId,
      relationships: {
        build: { data: { type: 'builds', id: newBuildId } },
      },
    },
  };

  if (!flags.live) {
    logDryRun('PATCH', `/appStoreVersions/${versionId}`, body);
    console.log(`    [DRY-RUN] would attach build #${newBuildNum} (id ${newBuildId}) to version ${versionId}`);
    return { ok: true, dryRun: true };
  }

  try {
    const resp = await asc('PATCH', `/appStoreVersions/${versionId}`, body);
    return { ok: true, dryRun: false, response: resp };
  } catch (e) {
    return { ok: false, dryRun: false, error: e };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// PER-APP SWAP
// ─────────────────────────────────────────────────────────────────────────

/**
 * Outcomes:
 *   'SWAPPED'         — PATCH succeeded (live mode)
 *   'DRY_RUN_OK'      — dry-run, would have swapped
 *   'ALREADY_LATEST'  — newest VALID build is already attached
 *   'NO_CANDIDATE'    — no VALID build found (still processing)
 *   'NO_VERSION'      — v1.0 appStoreVersion doesn't exist
 *   'ERROR'           — auth / API / config error
 */
async function swapApp(appKey) {
  const cfg = CONFIG[appKey];
  console.log(`\n════════════════════════════════════════════════════`);
  console.log(`  ${cfg.name} (App ID: ${cfg.appId})`);
  console.log(`════════════════════════════════════════════════════`);

  // 1. List recent VALID builds.
  let builds;
  try {
    builds = await listRecentValidBuilds(cfg.appId);
  } catch (e) {
    console.log(`  ✗ Failed to list builds: ${e.message}`);
    if (e.status === 401 || e.status === 403) {
      console.log(`    JWT expired or wrong key — exit 1`);
      return { app: appKey, outcome: 'ERROR', fatal: true, error: e.message };
    }
    return { app: appKey, outcome: 'ERROR', error: e.message };
  }

  if (builds.length === 0) {
    console.log(`  ✗ No VALID builds found — Apple is still processing.`);
    console.log(`    Wait longer and retry; nothing to swap.`);
    return { app: appKey, outcome: 'NO_CANDIDATE' };
  }

  console.log(`  Found ${builds.length} recent VALID build(s) (newest first):`);
  for (const b of builds) {
    const num = b.attributes?.version;
    const up = b.attributes?.uploadedDate;
    console.log(`    - #${num}  id=${b.id}  uploaded=${up}`);
  }

  // 2. Find v1.0 version + currently-attached build.
  let version, attachedBuildId;
  try {
    ({ version, attachedBuildId } = await findTargetVersion(cfg.appId));
  } catch (e) {
    console.log(`  ✗ Failed to fetch v${TARGET_VERSION} version: ${e.message}`);
    if (e.status === 401 || e.status === 403) {
      return { app: appKey, outcome: 'ERROR', fatal: true, error: e.message };
    }
    return { app: appKey, outcome: 'ERROR', error: e.message };
  }

  if (!version) {
    console.log(`  ✗ v${TARGET_VERSION} appStoreVersion does not exist for this app.`);
    console.log(`    Something is very wrong — exit 1.`);
    return { app: appKey, outcome: 'NO_VERSION', fatal: true };
  }

  const versionId = version.id;
  const versionState = version.attributes?.appStoreState;
  const versionStr = version.attributes?.versionString;
  console.log(`  Found v${versionStr} appStoreVersion ${versionId} state=${versionState}`);

  // Resolve attached build's version number for nice logging (best-effort).
  let attachedBuildNum = '(unknown)';
  if (attachedBuildId) {
    const match = builds.find((b) => b.id === attachedBuildId);
    if (match) {
      attachedBuildNum = `#${match.attributes?.version}`;
    } else {
      // The currently-attached build may be older than our limit=5 cap.
      try {
        const r = await asc('GET', `/builds/${attachedBuildId}`);
        attachedBuildNum = `#${r?.data?.attributes?.version ?? '?'}`;
      } catch {}
    }
    console.log(`  Currently attached build: ${attachedBuildNum}  id=${attachedBuildId}`);
  } else {
    console.log(`  Currently attached build: (none)`);
  }

  // 3. Pick the swap target: newest VALID build that ISN'T the attached one.
  const newest = builds[0];
  const newestId = newest.id;
  const newestNum = newest.attributes?.version;

  if (newestId === attachedBuildId) {
    console.log(`  ✓ Newest VALID build (#${newestNum}) is already attached — no swap needed.`);
    return { app: appKey, outcome: 'ALREADY_LATEST' };
  }

  const candidate = newest;
  const candidateId = candidate.id;
  const candidateNum = candidate.attributes?.version;

  console.log(`\n  Swap plan:`);
  console.log(`    from build: ${attachedBuildNum} (id ${attachedBuildId || 'none'})`);
  console.log(`    to   build: #${candidateNum} (id ${candidateId})`);
  console.log(`    version:    ${versionId} (state ${versionState} — should remain after PATCH)`);

  // 4. PATCH (dry-run or live).
  const patchResult = await patchBuildOnVersion(versionId, candidateId, candidateNum);
  if (!patchResult.ok) {
    const e = patchResult.error;
    console.log(`  ✗ PATCH failed: ${e?.message}`);
    if (e?.status === 409 || e?.status === 422) {
      console.log(`    Apple rejected the swap because the version state doesn't allow it.`);
      console.log(`    Check ASC web UI: https://appstoreconnect.apple.com/apps/${cfg.appId}/distribution`);
    } else if (e?.status === 401 || e?.status === 403) {
      console.log(`    JWT expired or wrong key — exit 1`);
      return { app: appKey, outcome: 'ERROR', fatal: true, error: e.message };
    }
    if (e?.body) {
      console.log(`    body: ${JSON.stringify(e.body).slice(0, 600)}`);
    }
    return { app: appKey, outcome: 'ERROR', error: e?.message };
  }

  if (patchResult.dryRun) {
    return { app: appKey, outcome: 'DRY_RUN_OK', fromBuild: attachedBuildNum, toBuild: `#${candidateNum}` };
  }

  console.log(`  ✓ PATCH accepted — build #${candidateNum} now attached to v${versionStr}`);

  // 5. Re-fetch version state and log if it changed.
  const newState = await refetchVersionState(cfg.appId, versionId);
  if (newState && newState !== versionState) {
    console.log(`  ⚠ Version state changed: ${versionState} → ${newState}`);
    if (newState === 'PREPARE_FOR_SUBMISSION' && versionState === 'WAITING_FOR_REVIEW') {
      console.log(`    Apple flipped the version out of the review queue.`);
      console.log(`    Re-run submit-ios-app-store.mjs --auto-submit --live to re-queue.`);
    }
  } else if (newState) {
    console.log(`  ✓ Version state preserved: ${newState}`);
  }

  return {
    app: appKey,
    outcome: 'SWAPPED',
    fromBuild: attachedBuildNum,
    toBuild: `#${candidateNum}`,
    versionStateBefore: versionState,
    versionStateAfter: newState,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║  ASC Build Swap Tool — preserves review queue position    ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');

  if (!flags.live) {
    console.log('\n  [DRY-RUN MODE] — no PATCHes will be sent. Add --live to apply.');
  }

  if (!['bidder', 'staff', 'both'].includes(flags.app)) {
    console.error(`\n  ✗ Invalid --app value: ${flags.app} (use: bidder, staff, or both)`);
    process.exit(1);
  }

  if (!ASC_KEY_PATH || !existsSync(ASC_KEY_PATH)) {
    console.error('\n  ✗ ASC API key not found. Searched:');
    console.error(`     - ${join(REPO_ROOT, '.secrets', 'AuthKey_25M83P99J8.p8')}`);
    console.error('     - ../../../.secrets/AuthKey_25M83P99J8.p8 (worktree case)');
    console.error('     - C:\\Users\\jmacl\\Projects\\auction-platform\\.secrets\\AuthKey_25M83P99J8.p8');
    process.exit(1);
  }
  console.log(`\n  Using ASC key: ${ASC_KEY_PATH}`);

  try {
    TOKEN_STATE.jwt = makeJwt();
    console.log('  ✓ JWT minted (ES256, raw r||s)');
  } catch (e) {
    console.error(`\n  ✗ Failed to mint JWT: ${e.message}`);
    process.exit(1);
  }

  const appsToSwap = flags.app === 'both' ? ['bidder', 'staff'] : [flags.app];
  const results = [];
  let fatalSeen = false;

  for (const appKey of appsToSwap) {
    try {
      const r = await swapApp(appKey);
      results.push(r);
      if (r.fatal) fatalSeen = true;
    } catch (e) {
      console.error(`\n  ✗ ${appKey} failed: ${e.message}`);
      if (flags.verbose) console.error(e.stack);
      results.push({ app: appKey, outcome: 'ERROR', error: e.message });
    }
  }

  // Summary
  console.log(`\n\n════════════════════════════════════════════════════`);
  console.log(`  SUMMARY`);
  console.log(`════════════════════════════════════════════════════`);

  let swapped = 0;
  let skipped = 0;
  let errors = 0;
  let noCandidate = 0;

  for (const r of results) {
    const cfg = CONFIG[r.app];
    let line = `  ${cfg?.name ?? r.app}: `;
    switch (r.outcome) {
      case 'SWAPPED':
        line += `✓ SWAPPED  ${r.fromBuild} → ${r.toBuild}  (state ${r.versionStateBefore}${
          r.versionStateAfter && r.versionStateAfter !== r.versionStateBefore ? ` → ${r.versionStateAfter}` : ''
        })`;
        swapped += 1;
        break;
      case 'DRY_RUN_OK':
        line += `[DRY-RUN] would swap ${r.fromBuild} → ${r.toBuild}`;
        swapped += 1;
        break;
      case 'ALREADY_LATEST':
        line += `✓ already latest — no swap needed`;
        skipped += 1;
        break;
      case 'NO_CANDIDATE':
        line += `⏳ no new VALID build (still processing)`;
        noCandidate += 1;
        break;
      case 'NO_VERSION':
        line += `✗ no v${TARGET_VERSION} version exists`;
        errors += 1;
        break;
      case 'ERROR':
      default:
        line += `✗ ERROR — ${r.error || 'unknown'}`;
        errors += 1;
        break;
    }
    console.log(line);
  }

  console.log('');
  console.log(`✓ swap-asc-build.mjs done — ${swapped} apps swapped, ${skipped} skipped, ${errors} errors`);

  if (!flags.live && swapped > 0) {
    console.log('\n  This was a DRY-RUN. To apply, re-run with --live.');
  }
  console.log('');

  // Exit codes:
  //   1 = fatal (auth, missing version, etc.)
  //   2 = at least one app had no candidate (cron caller signal to retry)
  //   0 = success
  if (fatalSeen || errors > 0) process.exit(1);
  if (noCandidate > 0) process.exit(2);
  process.exit(0);
}

main().catch((e) => {
  console.error(`\n  ✗ Fatal: ${e.message}`);
  if (flags.verbose) console.error(e.stack);
  process.exit(1);
});
