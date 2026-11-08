#!/usr/bin/env node
// =============================================================================
// scripts/resubmit-asc-with-new-build.mjs
//
// Full withdraw + attach + resubmit cycle for an ASC v1.0 version that is
// stuck in WAITING_FOR_REVIEW attached to an older build.
//
// WHY THIS EXISTS
//   `swap-asc-build.mjs` tries to PATCH /appStoreVersions/{id} with a new
//   build relationship while the version is WAITING_FOR_REVIEW. Apple rejects
//   with HTTP 409:
//     ENTITY_ERROR.RELATIONSHIP.INVALID.INVALID_STATE
//     "The specified pre-release build could not be added."
//   i.e. Apple does NOT allow build swap on a submitted version.
//
//   The real flow Apple wants is:
//     1. Withdraw the active reviewSubmission (DELETE) — version state drops
//        out of WAITING_FOR_REVIEW back to READY_FOR_SUBMISSION / PREPARE_FOR_SUBMISSION.
//     2. PATCH the version with the new build relationship.
//     3. Create a NEW reviewSubmission + reviewSubmissionItem and PATCH
//        submitted=true (the same modern flow submit-ios-app-store.mjs uses).
//
// This script does all three IN ORDER, fatal-on-error, with the existing
// JWT helpers + ASC fetch wrapper + 401 re-mint patterns from sibling scripts.
//
// Prerequisites:
//   - .secrets/AuthKey_25M83P99J8.p8 exists (ASC API key)
//   - v1.0 appStoreVersion exists in WAITING_FOR_REVIEW (or PREPARE_FOR_SUBMISSION)
//   - At least one NEWER VALID build than the one currently attached
//
// Usage:
//   # Dry-run, BOTH apps (default):
//   node scripts/resubmit-asc-with-new-build.mjs
//
//   # Dry-run, single app:
//   node scripts/resubmit-asc-with-new-build.mjs --app=bidder
//   node scripts/resubmit-asc-with-new-build.mjs --app=staff
//
//   # Actually withdraw + attach + resubmit:
//   node scripts/resubmit-asc-with-new-build.mjs --app=both --live
//
// Flags:
//   --app=bidder|staff|both    (default: both)
//   --live                     (default: false — dry-run otherwise)
//   --verbose                  (full API responses)
//
// Exit codes:
//   0  — all apps resubmitted (or already up-to-date / dry-run OK)
//   1  — auth / config / unrecoverable error
//   2  — at least one app had no candidate VALID build (still processing).
//        NOTHING WITHDRAWN — caller (cron) should retry later.
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

// States where the version is "in review" and cannot accept a build swap.
const REVIEW_LOCKED_STATES = new Set([
  'WAITING_FOR_REVIEW',
  'IN_REVIEW',
  'PENDING_APPLE_RELEASE',
]);

// States where the version is editable (PATCH build relationship is allowed).
const EDITABLE_STATES = new Set([
  'PREPARE_FOR_SUBMISSION',
  'READY_FOR_SUBMISSION',
  'DEVELOPER_REJECTED',
  'REJECTED',
  'METADATA_REJECTED',
  'INVALID_BINARY',
]);

// States indicating a reviewSubmission is no longer cancellable.
const TERMINAL_SUBMISSION_STATES = new Set([
  'COMPLETED',
  'CANCELED',
  'CANCELLED', // Apple's spelling varies in different docs; tolerate both.
]);

// Poll interval and timeout for post-withdraw state transition.
const STATE_POLL_INTERVAL_MS = 5_000;
const STATE_POLL_TIMEOUT_MS = 60_000;

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
  if (arg.startsWith('--app=')) flags.app = arg.split('=')[1];
  else if (arg === '--app') flags.app = args[++i];
  else if (arg === '--live') flags.live = true;
  else if (arg === '--verbose') flags.verbose = true;
  else if (arg === '--help' || arg === '-h') {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 60).join('\n'));
    process.exit(0);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// AUTH — mirrors swap-asc-build.mjs / clear-asc-submission-blockers.mjs
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
// ASC FETCH (with one-shot 401 re-mint)
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

  // Apple sometimes 401s a freshly-minted JWT (issuer rate limit). Re-mint + retry once.
  // Also covers the case where the JWT expired mid-run between apps.
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
// STEP A — Find latest VALID build
// ─────────────────────────────────────────────────────────────────────────

async function listRecentValidBuilds(appId) {
  // Same pattern as swap-asc-build.mjs. Top-level /builds endpoint supports
  // filter[app] + filter[processingState] + sort=-uploadedDate.
  const resp = await asc(
    'GET',
    `/builds?filter[app]=${appId}&filter[processingState]=VALID&sort=-uploadedDate&limit=10`,
  );
  return resp?.data || [];
}

// ─────────────────────────────────────────────────────────────────────────
// STEP B — Find active reviewSubmission
// ─────────────────────────────────────────────────────────────────────────

async function findActiveReviewSubmission(appId) {
  // ASC's /reviewSubmissions does NOT accept `sort`. We filter directly on
  // the states we care about (matching the submit-ios-app-store.mjs pattern)
  // and accept whatever order Apple returns. If multiple match we pick the
  // newest by createdDate locally.
  //
  // Active-but-cancellable states are: READY_FOR_REVIEW, WAITING_FOR_REVIEW,
  // IN_REVIEW. (UNRESOLVED_ISSUES is also non-terminal but Apple won't let
  // us cancel from it — it requires fixing the issue first; surface clearly
  // if we see it.)
  const resp = await asc(
    'GET',
    `/reviewSubmissions?filter[app]=${appId}&filter[state]=READY_FOR_REVIEW,WAITING_FOR_REVIEW,IN_REVIEW&include=items&limit=10`,
  );
  const subs = resp?.data || [];
  if (subs.length === 0) return null;

  // Local sort: newest createdDate first. (`createdDate` is an ISO 8601 string;
  // lexicographic compare works.)
  subs.sort((a, b) => {
    const da = a.attributes?.createdDate || '';
    const db = b.attributes?.createdDate || '';
    return db.localeCompare(da);
  });

  for (const sub of subs) {
    const state = sub.attributes?.state;
    if (!TERMINAL_SUBMISSION_STATES.has(state)) {
      return sub;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// STEP C — Withdraw the review submission
// ─────────────────────────────────────────────────────────────────────────

async function withdrawReviewSubmission(submissionId) {
  // ASC supports cancelling a submission by setting `canceled: true` via PATCH.
  // Some clients use DELETE — but DELETE on /reviewSubmissions/{id} returns
  // 405 Method Not Allowed in current Apple docs. We try PATCH first
  // (the documented path), then fall back to DELETE if Apple ever flips it.
  //
  // Per ASC API docs (ReviewSubmission.Attributes):
  //   canceled (Boolean) - "Set to true to cancel a submission that's been submitted."
  // This is the same shape as `submitted: true` used to finalize.
  const body = {
    data: {
      type: 'reviewSubmissions',
      id: submissionId,
      attributes: { canceled: true },
    },
  };

  if (!flags.live) {
    logDryRun('PATCH', `/reviewSubmissions/${submissionId}`, body);
    console.log(`    [DRY-RUN] would cancel reviewSubmissions/${submissionId}`);
    return { ok: true, dryRun: true, method: 'PATCH' };
  }

  try {
    await asc('PATCH', `/reviewSubmissions/${submissionId}`, body);
    return { ok: true, dryRun: false, method: 'PATCH' };
  } catch (e) {
    // If PATCH fails for any reason, try DELETE as a fallback (some accounts
    // and some submission states accept DELETE only).
    if (e.status === 404) {
      console.log(`    ℹ submission already gone (404) — treating as cancelled`);
      return { ok: true, dryRun: false, alreadyGone: true, method: 'PATCH' };
    }
    if (e.status === 405 || e.status === 409) {
      console.log(`    ℹ PATCH canceled=true returned ${e.status}, falling back to DELETE`);
      try {
        await asc('DELETE', `/reviewSubmissions/${submissionId}`);
        return { ok: true, dryRun: false, method: 'DELETE' };
      } catch (e2) {
        if (e2.status === 404) {
          console.log(`    ℹ submission already gone (404 on DELETE) — treating as cancelled`);
          return { ok: true, dryRun: false, alreadyGone: true, method: 'DELETE' };
        }
        return { ok: false, error: e2, method: 'DELETE' };
      }
    }
    return { ok: false, error: e, method: 'PATCH' };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// STEP D — Wait + verify version state
// ─────────────────────────────────────────────────────────────────────────

async function fetchVersionState(versionId) {
  const resp = await asc('GET', `/appStoreVersions/${versionId}`);
  return resp?.data?.attributes?.appStoreState || null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForVersionEditable(versionId, initialState) {
  // Poll until the version is no longer in a review-locked state.
  // Apple typically drops the version back to PREPARE_FOR_SUBMISSION or
  // READY_FOR_SUBMISSION within a few seconds of cancellation.
  const start = Date.now();
  let lastState = initialState;

  while (Date.now() - start < STATE_POLL_TIMEOUT_MS) {
    const state = await fetchVersionState(versionId);
    if (state !== lastState) {
      console.log(`    version state: ${lastState} -> ${state}`);
      lastState = state;
    }
    if (state && !REVIEW_LOCKED_STATES.has(state)) {
      return { ok: true, finalState: state };
    }
    await sleep(STATE_POLL_INTERVAL_MS);
  }

  return { ok: false, finalState: lastState, timedOut: true };
}

// ─────────────────────────────────────────────────────────────────────────
// STEP E — PATCH new build relationship (copied from swap-asc-build.mjs)
// ─────────────────────────────────────────────────────────────────────────

async function patchBuildOnVersion(versionId, newBuildId, newBuildNum) {
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
// STEP F — Create new reviewSubmission + item + submit
// (copied verbatim from submit-ios-app-store.mjs's modern flow)
// ─────────────────────────────────────────────────────────────────────────

async function createReviewSubmission(appId) {
  const body = {
    data: {
      type: 'reviewSubmissions',
      attributes: { platform: 'IOS' },
      relationships: {
        app: { data: { type: 'apps', id: appId } },
      },
    },
  };
  if (!flags.live) {
    logDryRun('POST', `/reviewSubmissions`, body);
    return { id: '<dry-run-submission-id>' };
  }
  const res = await asc('POST', `/reviewSubmissions`, body);
  return res?.data;
}

async function addVersionToReviewSubmission(submissionId, versionId) {
  const body = {
    data: {
      type: 'reviewSubmissionItems',
      relationships: {
        reviewSubmission: { data: { type: 'reviewSubmissions', id: submissionId } },
        appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } },
      },
    },
  };
  if (!flags.live) {
    logDryRun('POST', `/reviewSubmissionItems`, body);
    return { id: '<dry-run-item-id>' };
  }
  const res = await asc('POST', `/reviewSubmissionItems`, body);
  return res?.data;
}

async function finalizeReviewSubmission(submissionId) {
  const body = {
    data: {
      type: 'reviewSubmissions',
      id: submissionId,
      attributes: { submitted: true },
    },
  };
  if (!flags.live) {
    logDryRun('PATCH', `/reviewSubmissions/${submissionId}`, body);
    return true;
  }
  await asc('PATCH', `/reviewSubmissions/${submissionId}`, body);
  return true;
}

// ─────────────────────────────────────────────────────────────────────────
// STEP G — Verify final state
// ─────────────────────────────────────────────────────────────────────────

async function fetchAttachedBuildId(versionId) {
  try {
    const resp = await asc('GET', `/appStoreVersions/${versionId}/build`);
    return resp?.data?.id || null;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// PER-APP RUN
// ─────────────────────────────────────────────────────────────────────────

/**
 * Outcomes:
 *   'RESUBMITTED'    — full cycle completed successfully (live mode)
 *   'DRY_RUN_OK'     — dry-run, plan looks valid
 *   'ALREADY_LATEST' — newest VALID build already attached, no work needed
 *   'NO_CANDIDATE'   — no VALID build found — DID NOT TOUCH SUBMISSION (cron retry signal)
 *   'NO_VERSION'     — v1.0 appStoreVersion doesn't exist
 *   'ERROR'          — auth / API / state error
 */
async function resubmitApp(appKey) {
  const cfg = CONFIG[appKey];
  console.log(`\n════════════════════════════════════════════════════`);
  console.log(`  ${cfg.name} (App ID: ${cfg.appId})`);
  console.log(`════════════════════════════════════════════════════`);

  // ── Step A — Find latest VALID build ─────────────────────────────────
  console.log(`\n  [A] Find latest VALID build`);
  let builds;
  try {
    builds = await listRecentValidBuilds(cfg.appId);
  } catch (e) {
    console.log(`    ✗ Failed to list builds: ${e.message}`);
    return { app: appKey, outcome: 'ERROR', fatal: e.status === 401 || e.status === 403, error: e.message };
  }

  if (builds.length === 0) {
    console.log(`    ✗ No VALID builds — Apple is still processing.`);
    console.log(`    DO NOT WITHDRAW the current submission. Cron should retry.`);
    return { app: appKey, outcome: 'NO_CANDIDATE' };
  }

  console.log(`    Found ${builds.length} recent VALID build(s) (newest first):`);
  for (const b of builds.slice(0, 5)) {
    console.log(`      - #${b.attributes?.version}  id=${b.id}  uploaded=${b.attributes?.uploadedDate}`);
  }

  // ── Find v1.0 version + currently-attached build ──────────────────────
  const verResp = await asc(
    'GET',
    `/apps/${cfg.appId}/appStoreVersions?filter[platform]=IOS&filter[versionString]=${TARGET_VERSION}&include=build&limit=1`,
  );
  const version = verResp?.data?.[0];
  if (!version) {
    console.log(`    ✗ v${TARGET_VERSION} appStoreVersion does not exist.`);
    return { app: appKey, outcome: 'NO_VERSION', fatal: true };
  }
  const versionId = version.id;
  let versionState = version.attributes?.appStoreState;
  const attachedBuildId = version.relationships?.build?.data?.id || null;
  console.log(`    Found v${TARGET_VERSION} version ${versionId} state=${versionState}`);

  let attachedBuildNum = '(none)';
  if (attachedBuildId) {
    const match = builds.find((b) => b.id === attachedBuildId);
    if (match) {
      attachedBuildNum = `#${match.attributes?.version}`;
    } else {
      try {
        const r = await asc('GET', `/builds/${attachedBuildId}`);
        attachedBuildNum = `#${r?.data?.attributes?.version ?? '?'}`;
      } catch {}
    }
    console.log(`    Currently attached: ${attachedBuildNum}  id=${attachedBuildId}`);
  } else {
    console.log(`    Currently attached: (none)`);
  }

  // Pick the newest VALID that isn't already attached.
  const newest = builds[0];
  if (newest.id === attachedBuildId) {
    console.log(`    ✓ Newest VALID build (#${newest.attributes?.version}) is already attached — no resubmit needed.`);
    return { app: appKey, outcome: 'ALREADY_LATEST' };
  }
  const candidate = newest;
  const candidateId = candidate.id;
  const candidateNum = candidate.attributes?.version;

  console.log(`\n  Plan:`);
  console.log(`    from build:    ${attachedBuildNum} (id ${attachedBuildId || 'none'})`);
  console.log(`    to   build:    #${candidateNum} (id ${candidateId})`);
  console.log(`    version:       ${versionId} (state ${versionState})`);

  // ── Step B — Find active reviewSubmission ─────────────────────────────
  console.log(`\n  [B] Find active reviewSubmission`);
  let activeSubmission = null;
  try {
    activeSubmission = await findActiveReviewSubmission(cfg.appId);
  } catch (e) {
    console.log(`    ✗ Failed to list reviewSubmissions: ${e.message}`);
    return { app: appKey, outcome: 'ERROR', fatal: e.status === 401 || e.status === 403, error: e.message };
  }

  if (activeSubmission) {
    const subState = activeSubmission.attributes?.state;
    console.log(`    Found active submission ${activeSubmission.id} state=${subState}`);
  } else {
    console.log(`    No active submission found.`);
    if (REVIEW_LOCKED_STATES.has(versionState)) {
      console.log(`    ⚠ Version is ${versionState} but no submission exists — anomaly, attempting PATCH anyway.`);
    } else {
      console.log(`    Version is already ${versionState} — skipping withdraw.`);
    }
  }

  // ── Step C — Withdraw if needed ───────────────────────────────────────
  let withdrew = false;
  if (activeSubmission) {
    console.log(`\n  [C] Withdraw reviewSubmission ${activeSubmission.id}`);
    const w = await withdrawReviewSubmission(activeSubmission.id);
    if (!w.ok) {
      const e = w.error;
      console.log(`    ✗ Withdraw failed: ${e?.message}`);
      if (e?.body) console.log(`    body: ${JSON.stringify(e.body).slice(0, 600)}`);
      console.log(`    Manually intervene at ASC web UI: https://appstoreconnect.apple.com/apps/${cfg.appId}/distribution`);
      return { app: appKey, outcome: 'ERROR', error: e?.message };
    }
    if (w.dryRun) {
      console.log(`    [DRY-RUN] would withdraw submission ${activeSubmission.id}`);
    } else if (w.alreadyGone) {
      console.log(`    ✓ Submission ${activeSubmission.id} already gone (no-op)`);
    } else {
      console.log(`    ✓ Submission ${activeSubmission.id} withdrawn (${w.method})`);
    }
    withdrew = true;
  } else {
    console.log(`\n  [C] (skipped — no active submission to withdraw)`);
  }

  // ── Step D — Wait for version to become editable ──────────────────────
  console.log(`\n  [D] Wait for version to become editable`);
  if (!flags.live) {
    console.log(`    [DRY-RUN] would poll GET /appStoreVersions/${versionId} every ${STATE_POLL_INTERVAL_MS / 1000}s up to ${STATE_POLL_TIMEOUT_MS / 1000}s`);
  } else if (withdrew && REVIEW_LOCKED_STATES.has(versionState)) {
    const w = await waitForVersionEditable(versionId, versionState);
    if (!w.ok) {
      console.log(`    ✗ Version stayed in ${w.finalState} after ${STATE_POLL_TIMEOUT_MS / 1000}s — Apple did not release it.`);
      console.log(`    Manually intervene at ASC web UI: https://appstoreconnect.apple.com/apps/${cfg.appId}/distribution`);
      return { app: appKey, outcome: 'ERROR', error: `version stuck in ${w.finalState}` };
    }
    versionState = w.finalState;
    console.log(`    ✓ Version is editable (state=${versionState})`);
  } else {
    const liveState = await fetchVersionState(versionId);
    console.log(`    ✓ Version state confirmed: ${liveState}`);
    versionState = liveState;
  }

  // ── Step E — PATCH new build relationship ─────────────────────────────
  console.log(`\n  [E] Attach build #${candidateNum} to version ${versionId}`);
  const patchResult = await patchBuildOnVersion(versionId, candidateId, candidateNum);
  if (!patchResult.ok) {
    const e = patchResult.error;
    console.log(`    ✗ PATCH failed: ${e?.message}`);
    if (e?.status === 409 || e?.status === 422) {
      console.log(`    Apple still rejecting the swap — version state may not have settled.`);
      console.log(`    Manually intervene at ASC web UI: https://appstoreconnect.apple.com/apps/${cfg.appId}/distribution`);
    }
    if (e?.body) console.log(`    body: ${JSON.stringify(e.body).slice(0, 600)}`);
    return { app: appKey, outcome: 'ERROR', error: e?.message };
  }
  if (!patchResult.dryRun) console.log(`    ✓ Build #${candidateNum} attached to v${TARGET_VERSION}`);

  // ── Step F — Create new reviewSubmission + item + submit ──────────────
  console.log(`\n  [F] Create new reviewSubmission + add item + submit`);
  let newSubmissionId;
  try {
    const sub = await createReviewSubmission(cfg.appId);
    newSubmissionId = sub.id;
    console.log(`    ✓ Created reviewSubmissions/${sub.id}`);

    const item = await addVersionToReviewSubmission(newSubmissionId, versionId);
    console.log(`    ✓ Added reviewSubmissionItems/${item.id}`);

    await finalizeReviewSubmission(newSubmissionId);
    console.log(`    ✓ Submission finalized (submitted=true)`);
  } catch (e) {
    console.log(`    ✗ Resubmit failed: ${e.message}`);
    if (e.body?.errors?.[0]?.meta?.associatedErrors) {
      console.log(`    Associated errors from Apple:`);
      for (const [path, errs] of Object.entries(e.body.errors[0].meta.associatedErrors)) {
        for (const err of errs) {
          console.log(`      ${path} :: ${err.code} :: ${err.detail || err.title}`);
        }
      }
    } else if (e.body) {
      console.log(`    body: ${JSON.stringify(e.body).slice(0, 600)}`);
    }
    console.log(`    Build #${candidateNum} IS attached but submission did NOT complete.`);
    console.log(`    Manually intervene at ASC web UI: https://appstoreconnect.apple.com/apps/${cfg.appId}/distribution`);
    return { app: appKey, outcome: 'ERROR', error: e.message };
  }

  // ── Step G — Verify final state ───────────────────────────────────────
  if (!flags.live) {
    console.log(`\n  [G] (skipped — dry-run)`);
    return {
      app: appKey,
      outcome: 'DRY_RUN_OK',
      fromBuild: attachedBuildNum,
      toBuild: `#${candidateNum}`,
      withdrewSubmissionId: activeSubmission?.id || null,
    };
  }

  console.log(`\n  [G] Verify final state`);
  const finalState = await fetchVersionState(versionId);
  const finalBuildId = await fetchAttachedBuildId(versionId);
  const finalBuildOk = finalBuildId === candidateId;
  const finalStateOk = finalState === 'WAITING_FOR_REVIEW';

  console.log(`    appStoreState: ${finalState}  ${finalStateOk ? '✓' : '⚠'}`);
  console.log(`    attached build: ${finalBuildId === candidateId ? '#' + candidateNum + ' ✓' : `${finalBuildId} (expected ${candidateId}) ⚠`}`);

  if (!finalStateOk || !finalBuildOk) {
    console.log(`    ⚠ Final state did not match expectations. Submission may still be processing on Apple's side.`);
  } else {
    console.log(`    ✓ Resubmit complete — v${TARGET_VERSION} now WAITING_FOR_REVIEW with build #${candidateNum}`);
  }

  return {
    app: appKey,
    outcome: 'RESUBMITTED',
    fromBuild: attachedBuildNum,
    toBuild: `#${candidateNum}`,
    withdrewSubmissionId: activeSubmission?.id || null,
    newSubmissionId,
    finalState,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔═══════════════════════════════════════════════════════════╗');
  console.log('║  ASC Withdraw + Attach + Resubmit Tool                    ║');
  console.log('║  Handles HTTP 409 INVALID_STATE on direct build swap.     ║');
  console.log('╚═══════════════════════════════════════════════════════════╝');

  if (!flags.live) {
    console.log('\n  [DRY-RUN MODE] — no withdraws / PATCHes / POSTs will be sent.');
    console.log('  Add --live to perform the actual withdraw + attach + resubmit cycle.');
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

  const appsToRun = flags.app === 'both' ? ['bidder', 'staff'] : [flags.app];
  const results = [];
  let fatalSeen = false;

  for (const appKey of appsToRun) {
    try {
      const r = await resubmitApp(appKey);
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

  let done = 0;
  let skipped = 0;
  let errors = 0;
  let noCandidate = 0;

  for (const r of results) {
    const cfg = CONFIG[r.app];
    let line = `  ${cfg?.name ?? r.app}: `;
    switch (r.outcome) {
      case 'RESUBMITTED':
        line += `✓ RESUBMITTED  ${r.fromBuild} → ${r.toBuild}  (state ${r.finalState})  withdrew=${r.withdrewSubmissionId || '(none)'}  new=${r.newSubmissionId}`;
        done += 1;
        break;
      case 'DRY_RUN_OK':
        line += `[DRY-RUN] would withdraw ${r.withdrewSubmissionId || '(none)'}, attach ${r.toBuild}, resubmit`;
        done += 1;
        break;
      case 'ALREADY_LATEST':
        line += `✓ already latest — no resubmit needed`;
        skipped += 1;
        break;
      case 'NO_CANDIDATE':
        line += `⏳ no new VALID build (still processing) — submission untouched`;
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
  console.log(`✓ resubmit-asc-with-new-build.mjs done — ${done} resubmitted, ${skipped} skipped, ${errors} errors`);

  if (!flags.live && done > 0) {
    console.log('\n  This was a DRY-RUN. To apply, re-run with --live.');
  }
  console.log('');

  // Exit codes:
  //   1 = fatal (auth, missing version, withdraw/attach/resubmit failure)
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
