#!/usr/bin/env node
// =============================================================================
// scripts/submit-ios-app-store.mjs
//
// Submits the BinGo bidder or staff app to Apple App Store for review.
// Uses App Store Connect (ASC) API with JWT auth via the .p8 key.
//
// Prerequisites:
//   - .secrets/AuthKey_25M83P99J8.p8 exists (ASC API key)
//   - TestFlight build already built + processed by Apple
//   - v1.0 PREPARE_FOR_SUBMISSION version record exists in ASC
//
// Usage:
//   # Dry-run (shows what would happen):
//   node scripts/submit-ios-app-store.mjs --app both
//
//   # Actually attach latest build and submit for review:
//   node scripts/submit-ios-app-store.mjs --app both --auto-submit --live
//
//   # Attach a specific build number:
//   node scripts/submit-ios-app-store.mjs --app bidder --build 42 --live
//
// Flags:
//   --app bidder|staff|both    (default: both)
//   --build NN                 (default: latest available)
//   --auto-submit              (default: false — just attach unless set)
//   --live                     (default: false — dry-run otherwise)
//   --verbose                  (show full API responses)
//
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

const ASC_KEY_ID = '25M83P99J8';
const ASC_ISSUER_ID = 'df79d9d0-5f90-4a53-8e2f-4c16b3fafce9';
const ASC_BASE_URL = 'https://api.appstoreconnect.apple.com/v1';

// Resolve the .p8 key from a few likely locations (worktrees do not contain .secrets/).
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
  build: null,
  autoSubmit: false,
  live: false,
  verbose: false,
};

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--app') flags.app = args[++i];
  else if (arg === '--build') flags.build = parseInt(args[++i], 10);
  else if (arg === '--auto-submit') flags.autoSubmit = true;
  else if (arg === '--live') flags.live = true;
  else if (arg === '--verbose') flags.verbose = true;
}

// ─────────────────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────────────────

function log(...args) {
  console.log(...args);
}

function err(...args) {
  console.error(...args);
}

function makeJwt() {
  if (!ASC_KEY_PATH || !existsSync(ASC_KEY_PATH)) {
    throw new Error(`ASC key not found. Searched repo .secrets/ and worktree parents for AuthKey_25M83P99J8.p8`);
  }

  const key = readFileSync(ASC_KEY_PATH, 'utf8');
  const now = Math.floor(Date.now() / 1000);

  const header = {
    alg: 'ES256',
    kid: ASC_KEY_ID,
    typ: 'JWT',
  };

  const payload = {
    iss: ASC_ISSUER_ID,
    iat: now,
    exp: now + 1200, // 20 minutes
    aud: 'appstoreconnect-v1',
  };

  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const message = `${headerB64}.${payloadB64}`;

  // CRITICAL: Apple requires the JWT-standard raw r||s signature (P1363 / IEEE 1363),
  // NOT the DER-encoded signature that Node's default produces. Without `dsaEncoding`,
  // every request returns 401 NOT_AUTHORIZED — see PR #9 / push-asc-metadata.mjs for the
  // canonical pattern.
  const signer = createSign('SHA256');
  signer.update(message);
  const signature = signer.sign({ key, dsaEncoding: 'ieee-p1363' }, 'base64url');

  return `${message}.${signature}`;
}

async function ascFetch(token, path, init = {}) {
  const url = `${ASC_BASE_URL}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });

  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {}

  if (!res.ok) {
    const detail = body?.errors?.[0]?.detail || text;
    throw new Error(`ASC ${res.status} on ${path}: ${detail}`);
  }

  return body;
}

function logDryRun(method, path, body) {
  log(`  [DRY-RUN] ${method} ${ASC_BASE_URL}${path}`);
  if (body) {
    const redacted = JSON.stringify(body, null, 2).replace(
      /("data":|"token":).+/g,
      '$1 "[redacted]"'
    );
    log(`  Payload:\n${redacted.split('\n').map(l => '    ' + l).join('\n')}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// MAIN LOGIC
// ─────────────────────────────────────────────────────────────────────────

async function findLatestBuild(token, appId) {
  log(`  Looking for latest TestFlight build for app ${appId}...`);

  try {
    // /apps/{id}/builds is a JSONAPI relationship endpoint and does NOT accept sort or
    // filter[processingState]. Use the top-level /builds endpoint, scoped via filter[app],
    // which supports both. Bug in the pre-PR-9 script that was masked by the JWT 401.
    const res = await ascFetch(
      token,
      `/builds?filter[app]=${appId}&filter[processingState]=VALID&sort=-uploadedDate&limit=1`
    );
    const builds = res?.data || [];

    if (builds.length === 0) {
      log(`  ✗ No VALID (processed) builds found for app ${appId}`);
      log(`    Either no builds uploaded yet, or all are still PROCESSING / INVALID.`);
      return null;
    }

    const build = builds[0];
    const buildNum = build?.attributes?.version;
    const expDate = build?.attributes?.expirationDate;
    const procState = build?.attributes?.processingState;

    if (expDate && new Date(expDate) < new Date()) {
      log(`  ✗ Latest VALID build (${buildNum}) has expired: ${expDate}`);
      return null;
    }

    log(`  ✓ Found build #${buildNum} (${procState}, uploaded ${build?.attributes?.uploadedDate})`);
    return build;
  } catch (e) {
    log(`  ✗ Error fetching builds: ${e.message}`);
    return null;
  }
}

async function findPrepareForSubmissionVersion(token, appId) {
  log(`  Looking for PREPARE_FOR_SUBMISSION version...`);

  try {
    const res = await ascFetch(
      token,
      `/apps/${appId}/appStoreVersions?filter[appStoreState]=PREPARE_FOR_SUBMISSION&limit=1`
    );
    const versions = res?.data || [];

    if (versions.length === 0) {
      log(`  ✗ No PREPARE_FOR_SUBMISSION version found (need to create in ASC first)`);
      return null;
    }

    const version = versions[0];
    const versionNum = version?.attributes?.versionString;

    log(`  ✓ Found version ${versionNum} in PREPARE_FOR_SUBMISSION state`);
    return version;
  } catch (e) {
    log(`  ✗ Error fetching versions: ${e.message}`);
    return null;
  }
}

async function getBuildRelationship(token, appId, buildNum) {
  log(`  Fetching build relationship for build #${buildNum}...`);

  try {
    // Top-level /builds endpoint accepts both filter[app] and filter[version].
    const res = await ascFetch(
      token,
      `/builds?filter[app]=${appId}&filter[version]=${buildNum}&limit=1`
    );
    const builds = res?.data || [];

    if (builds.length === 0) {
      log(`  ✗ Build #${buildNum} not found`);
      return null;
    }

    return builds[0];
  } catch (e) {
    log(`  ✗ Error fetching build: ${e.message}`);
    return null;
  }
}

async function getCurrentlyAttachedBuild(token, versionId) {
  try {
    const res = await ascFetch(token, `/appStoreVersions/${versionId}/build`);
    return res?.data || null;
  } catch (e) {
    // 404 / no build attached yet — treat as none.
    return null;
  }
}

async function attachBuildToVersion(token, appId, versionId, buildId, buildNum) {
  // Audit fix: detect re-attach vs first-attach so the log is honest and the
  // PATCH is skipped if the version already references this exact build.
  const current = await getCurrentlyAttachedBuild(token, versionId);
  if (current?.id === buildId) {
    log(`  ✓ Build #${buildNum} already attached to this version (no-op)`);
    return true;
  }
  if (current?.id) {
    log(`  ℹ Version currently has a different build attached (${current.id}); will replace with #${buildNum}`);
  } else {
    log(`  Attaching build #${buildNum} to version...`);
  }

  const body = {
    data: {
      type: 'builds',
      id: buildId,
    },
  };

  if (!flags.live) {
    logDryRun('PATCH', `/appStoreVersions/${versionId}/relationships/build`, body);
    log(`  [DRY-RUN] Would attach build #${buildNum}`);
    return true;
  }

  try {
    await ascFetch(token, `/appStoreVersions/${versionId}/relationships/build`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    });

    log(`  ✓ Build #${buildNum} attached successfully`);
    return true;
  } catch (e) {
    if (e.message.includes('already attached') || e.message.includes('related')) {
      log(`  ✓ Build #${buildNum} already attached (idempotent)`);
      return true;
    }

    log(`  ✗ Error attaching build: ${e.message}`);
    return false;
  }
}

async function findExistingReviewSubmission(token, appId) {
  // ASC 2022+ uses /reviewSubmissions (per-app), not /appStoreVersionSubmissions (per-version).
  // Look for any open submission (state IN_REVIEW, WAITING_FOR_REVIEW, READY_FOR_REVIEW).
  try {
    const res = await ascFetch(
      token,
      `/reviewSubmissions?filter[app]=${appId}&filter[state]=READY_FOR_REVIEW,WAITING_FOR_REVIEW,IN_REVIEW&limit=5`
    );
    return res?.data?.[0] || null;
  } catch (e) {
    return null;
  }
}

async function listReviewSubmissionItems(token, submissionId) {
  try {
    const res = await ascFetch(token, `/reviewSubmissions/${submissionId}/items?limit=200`);
    return res?.data || [];
  } catch {
    return [];
  }
}

async function createReviewSubmission(token, appId, platform = 'IOS') {
  const body = {
    data: {
      type: 'reviewSubmissions',
      attributes: { platform },
      relationships: {
        app: { data: { type: 'apps', id: appId } },
      },
    },
  };
  if (!flags.live) {
    logDryRun('POST', `/reviewSubmissions`, body);
    return { id: '<dry-run-submission-id>' };
  }
  const res = await ascFetch(token, `/reviewSubmissions`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return res?.data;
}

async function addVersionToReviewSubmission(token, submissionId, versionId) {
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
  const res = await ascFetch(token, `/reviewSubmissionItems`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return res?.data;
}

async function finalizeReviewSubmission(token, submissionId) {
  // Setting submitted=true transitions state from READY_FOR_REVIEW → WAITING_FOR_REVIEW.
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
  await ascFetch(token, `/reviewSubmissions/${submissionId}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  return true;
}

async function submitVersionForReview(token, appId, versionId, versionNum) {
  // Modern flow (ASC 2022+):
  //   1. Look for an existing open reviewSubmission for this app.
  //   2. If none, POST /v1/reviewSubmissions to create a draft.
  //   3. POST /v1/reviewSubmissionItems to add the appStoreVersion to it.
  //   4. PATCH /v1/reviewSubmissions/{id} with submitted=true to finalize.
  //
  // The pre-2022 /appStoreVersionSubmissions endpoint now returns
  // 403 "Allowed operation is: DELETE".
  log(`  Submitting version ${versionNum} for review (modern reviewSubmissions API)...`);

  let submission = await findExistingReviewSubmission(token, appId);
  if (submission?.id) {
    const state = submission.attributes?.state;
    if (state === 'WAITING_FOR_REVIEW' || state === 'IN_REVIEW') {
      log(`  ✓ Version ${versionNum} already submitted (reviewSubmissions/${submission.id}, state ${state})`);
      return true;
    }
    log(`  ℹ Reusing existing READY_FOR_REVIEW submission (id ${submission.id})`);
  } else {
    log(`  Creating new reviewSubmission...`);
    submission = await createReviewSubmission(token, appId, 'IOS');
    log(`  ✓ Created reviewSubmissions/${submission.id}`);
  }

  // Add the version, but FIRST check if it's already linked (real idempotency —
  // not a vague 409-text match, which previously masked unrelated 409s and let
  // us finalize an empty submission).
  const existingItems = flags.live ? await listReviewSubmissionItems(token, submission.id) : [];
  let alreadyLinked = false;
  for (const item of existingItems) {
    if (item.relationships?.appStoreVersion?.data?.id === versionId) {
      alreadyLinked = true;
      log(`  ✓ Version already in submission (reviewSubmissionItems/${item.id})`);
      break;
    }
  }
  if (!alreadyLinked) {
    log(`  Adding appStoreVersion ${versionId} to submission...`);
    const item = await addVersionToReviewSubmission(token, submission.id, versionId);
    log(`  ✓ Added reviewSubmissionItems/${item.id}`);
  }

  log(`  Finalizing submission (submitted=true)...`);
  await finalizeReviewSubmission(token, submission.id);
  log(`  ✓ Version ${versionNum} submitted for App Review (submission ID: ${submission.id})`);
  return true;
}

async function submitApp(token, appKey) {
  const appConfig = CONFIG[appKey];
  if (!appConfig) {
    log(`✗ Unknown app: ${appKey}`);
    return false;
  }

  const { appId, name } = appConfig;
  log(`\n════════════════════════════════════════════════════`);
  log(`  ${name} (App ID: ${appId})`);
  log(`════════════════════════════════════════════════════`);

  // 1. Find the build to attach
  let buildToAttach = null;

  if (flags.build) {
    buildToAttach = await getBuildRelationship(token, appId, flags.build);
    if (!buildToAttach) {
      log(`✗ Could not find build #${flags.build}`);
      return false;
    }
    log(`  ✓ Using specified build #${flags.build}`);
  } else {
    buildToAttach = await findLatestBuild(token, appId);
    if (!buildToAttach) {
      log(`✗ Could not find a valid build to attach`);
      return false;
    }
  }

  const buildId = buildToAttach.id;
  const buildNum = buildToAttach.attributes.version;

  // 2. Find the version to attach to
  const version = await findPrepareForSubmissionVersion(token, appId);
  if (!version) {
    log(`✗ Could not find a PREPARE_FOR_SUBMISSION version`);
    log(`  Next steps: Create a v1.0 app version in ASC manually, save to PREPARE_FOR_SUBMISSION state`);
    return false;
  }

  const versionId = version.id;
  const versionNum = version.attributes.versionString;

  // 3. Attach the build
  if (!(await attachBuildToVersion(token, appId, versionId, buildId, buildNum))) {
    return false;
  }

  // 4. Submit for review (if requested)
  if (flags.autoSubmit) {
    if (!(await submitVersionForReview(token, appId, versionId, versionNum))) {
      return false;
    }
  } else {
    log(`\n  ℹ Build attached. To submit for review, re-run with --auto-submit --live`);
  }

  return true;
}

// ─────────────────────────────────────────────────────────────────────────
// ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────

async function main() {
  log('\n╔═══════════════════════════════════════════════════════════╗');
  log('║  iOS App Store Connect Submission Tool                    ║');
  log('╚═══════════════════════════════════════════════════════════╝\n');

  // Validate
  if (!flags.live) {
    log('  [DRY-RUN MODE] — no API calls will be made');
    log('  Add --live to actually submit\n');
  }

  if (!['bidder', 'staff', 'both'].includes(flags.app)) {
    err(`✗ Invalid --app value: ${flags.app} (use: bidder, staff, or both)`);
    process.exit(1);
  }

  if (flags.build && (flags.build <= 0 || !Number.isInteger(flags.build))) {
    err(`✗ Invalid --build value: ${flags.build} (must be a positive integer)`);
    process.exit(1);
  }

  if (!ASC_KEY_PATH || !existsSync(ASC_KEY_PATH)) {
    err(`✗ ASC API key not found. Searched:`);
    err(`    - ${join(REPO_ROOT, '.secrets', 'AuthKey_25M83P99J8.p8')}`);
    err(`    - ../../.secrets/AuthKey_25M83P99J8.p8 (from worktree)`);
    err(`    - C:\\Users\\jmacl\\Projects\\auction-platform\\.secrets\\AuthKey_25M83P99J8.p8`);
    process.exit(1);
  }
  log(`  Using ASC key: ${ASC_KEY_PATH}`);

  // Create JWT
  let token;
  try {
    token = makeJwt();
    log('✓ JWT minted (ES256, raw r||s signature)\n');
  } catch (e) {
    err(`✗ Failed to create JWT: ${e.message}`);
    process.exit(1);
  }

  // Determine which apps to submit
  const appsToSubmit =
    flags.app === 'both' ? ['bidder', 'staff'] : [flags.app];

  // Submit each app
  const results = {};
  for (const app of appsToSubmit) {
    results[app] = await submitApp(token, app);
  }

  // Summary
  log(`\n════════════════════════════════════════════════════`);
  log(`  SUMMARY`);
  log(`════════════════════════════════════════════════════`);

  let allSuccess = true;
  for (const [app, success] of Object.entries(results)) {
    const status = success ? '✓ SUCCESS' : '✗ FAILED';
    log(`  ${CONFIG[app].name}: ${status}`);
    if (!success) allSuccess = false;
  }

  if (!flags.live) {
    log(`\n  This was a DRY-RUN. To make actual changes, add --live\n`);
  } else {
    log(`\n  Changes applied to App Store Connect.\n`);
  }

  if (!allSuccess) {
    process.exit(1);
  }
}

main().catch((e) => {
  err(`\n✗ Fatal error: ${e.message}`);
  process.exit(1);
});
