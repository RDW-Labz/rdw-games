#!/usr/bin/env node
// =============================================================================
// scripts/upload-asc-screenshots.mjs
//
// Uploads App Store screenshots to App Store Connect (ASC) via the public API
// using the same .p8 JWT auth pattern as push-asc-metadata.mjs and
// submit-ios-app-store.mjs.
//
// Three-phase flow per screenshot (per Apple's documented contract):
//   1. POST /v1/appScreenshots
//      Body: { data: { type: "appScreenshots",
//                      attributes: { fileName, fileSize },
//                      relationships: { appScreenshotSet: {...} } } }
//      Response includes `attributes.uploadOperations[]` — an array of HTTP
//      operations { method, url, length, offset, requestHeaders[{name,value}] }
//      pointing at a presigned upload endpoint.
//   2. PUT each upload operation in order. Slice the PNG buffer at
//      [offset, offset+length) and send it to the operation's URL with EXACTLY
//      the headers Apple provided (Content-Type, Content-Length, etc.).
//   3. PATCH /v1/appScreenshots/{id} with { uploaded: true,
//      sourceFileChecksum: <MD5 hex digest of full file> } to finalize.
//      Then poll GET /v1/appScreenshots/{id} until
//      attributes.assetDeliveryState.state === "COMPLETE" (or FAILED).
//
// Apple required display sizes (display type → accepted pixel dimensions):
//   APP_IPHONE_67      → 1290x2796 or 1320x2868   (6.7"/6.9" — iPhone 14 Pro Max
//                                                 through iPhone 16 Pro Max.
//                                                 Apple expanded the accepted
//                                                 resolutions for this slot but
//                                                 kept the enum name; there is
//                                                 NO `APP_IPHONE_69`.)
//   APP_IPHONE_65      → 1242x2688 or 1284x2778   (iPhone Plus / older Pro Max)
//   APP_IPHONE_61      → 1170x2532                (iPhone 13)
//   APP_IPAD_PRO_3GEN_129 → 2048x2732             (12.9" iPad Pro)
//
// Usage:
//   # Dry-run (default) — prints what would be uploaded without API calls
//   node scripts/upload-asc-screenshots.mjs
//
//   # Upload the 5 captured iPhone 16 Pro Max PNGs to the bidder app
//   node scripts/upload-asc-screenshots.mjs --app bidder --live
//
//   # Verbose (full API responses + per-operation byte ranges)
//   node scripts/upload-asc-screenshots.mjs --app bidder --live --verbose
//
//   # Custom dir / display type
//   node scripts/upload-asc-screenshots.mjs --app bidder --display APP_IPHONE_67 \
//       --dir "C:\tmp\screenshots-v3\ios-app-store-screenshots-iphone-16-pro-max" --live
//
// Flags:
//   --app bidder|staff       (default: bidder)
//   --display APP_IPHONE_67  (default: APP_IPHONE_67 — covers 6.7"/6.9", incl. iPhone 16 Pro Max)
//   --dir <path>             (default: C:\tmp\screenshots-v3\ios-app-store-screenshots-iphone-16-pro-max)
//   --live                   (default: false — dry-run otherwise)
//   --verbose                (show full API responses + per-op chunks)
//
// Idempotent: a screenshot is skipped if a screenshot with the same fileName
// already exists in the set AND is in COMPLETE state. Re-running after a
// partial failure will only attempt the missing/failed files.
// =============================================================================

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, basename } from 'node:path';
import { createSign, createHash } from 'node:crypto';

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
const LOCALE = 'en-US';

const DEFAULT_SCREENSHOT_DIR =
  'C:\\tmp\\screenshots-v3\\ios-app-store-screenshots-iphone-16-pro-max';

// Apple's documented poll cadence for asset delivery state. ASC typically
// reports COMPLETE within seconds for small (<200KB) PNGs but can take up
// to ~30s on first uploads of the day.
const POLL_INTERVAL_MS = 2000;
const POLL_MAX_ATTEMPTS = 30; // 60s ceiling per file

// ─────────────────────────────────────────────────────────────────────────
// CLI FLAGS
// ─────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flags = {
  app: 'bidder',
  // APP_IPHONE_67 is the correct slot for both the 6.7" iPhone 14/15 Pro Max
  // (1290x2796) AND the 6.9" iPhone 16 Pro Max (1320x2868). The ASC API does
  // not have a separate APP_IPHONE_69 — Apple expanded the accepted
  // resolutions for this slot when iOS 18 / iPhone 16 launched.
  display: 'APP_IPHONE_67',
  dir: DEFAULT_SCREENSHOT_DIR,
  live: false,
  verbose: false,
};

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--app') flags.app = args[++i];
  else if (arg === '--display') flags.display = args[++i];
  else if (arg === '--dir') flags.dir = args[++i];
  else if (arg === '--live') flags.live = true;
  else if (arg === '--verbose') flags.verbose = true;
  else if (arg === '--help' || arg === '-h') {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 60).join('\n'));
    process.exit(0);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// AUTH (same raw r||s JWT pattern as push-asc-metadata.mjs)
// ─────────────────────────────────────────────────────────────────────────

function findKeyPath() {
  const candidates = [
    join(REPO_ROOT, '.secrets', 'AuthKey_25M83P99J8.p8'),
    join(REPO_ROOT, '..', '..', '..', '.secrets', 'AuthKey_25M83P99J8.p8'),
    join(REPO_ROOT, '..', '..', '..', '..', '.secrets', 'AuthKey_25M83P99J8.p8'),
    'C:\\Users\\jmacl\\Projects\\auction-platform\\.secrets\\AuthKey_25M83P99J8.p8',
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

function makeJwt(keyPath) {
  const key = readFileSync(keyPath, 'utf8');
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: 'ES256', kid: ASC_KEY_ID, typ: 'JWT' };
  const payload = {
    iss: ASC_ISSUER_ID,
    iat: now,
    exp: now + 1200, // 20 minutes
    aud: 'appstoreconnect-v1',
  };

  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const message = `${headerB64}.${payloadB64}`;

  // CRITICAL: Apple requires JWT-standard raw r||s signature (IEEE P1363),
  // NOT Node's default DER. Without this every request returns 401.
  const signer = createSign('SHA256');
  signer.update(message);
  const signature = signer.sign({ key, dsaEncoding: 'ieee-p1363' }, 'base64url');

  return `${message}.${signature}`;
}

// ─────────────────────────────────────────────────────────────────────────
// ASC JSON FETCH
// ─────────────────────────────────────────────────────────────────────────

async function ascFetch(token, method, path, body) {
  const url = path.startsWith('http') ? path : `${ASC_BASE_URL}${path}`;
  const init = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  const res = await fetch(url, init);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (flags.verbose) {
    console.log(`[ASC] ${method} ${path} -> ${res.status}`);
    if (data && typeof data === 'object') {
      const dump = JSON.stringify(data, null, 2);
      console.log(dump.length > 2000 ? dump.slice(0, 2000) + '\n... (truncated)' : dump);
    }
  }

  if (!res.ok) {
    const detail = data?.errors?.[0]?.detail || data?.errors?.[0]?.title || (typeof data === 'string' ? data : JSON.stringify(data));
    const err = new Error(`ASC ${res.status} on ${method} ${path}: ${detail}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

function logDry(method, path, body) {
  console.log(`    [DRY-RUN] ${method} ${path}`);
  if (body) {
    const out = JSON.stringify(body, null, 2).split('\n').map((l) => '      ' + l).join('\n');
    console.log(out);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// CHUNKED UPLOAD — PUT each uploadOperation in order
// ─────────────────────────────────────────────────────────────────────────

async function executeUploadOperations(uploadOperations, fileBytes, label) {
  for (let i = 0; i < uploadOperations.length; i++) {
    const op = uploadOperations[i];
    const method = (op.method || 'PUT').toUpperCase();
    const offset = op.offset || 0;
    const length = op.length || fileBytes.length;
    const chunk = fileBytes.subarray(offset, offset + length);

    // Build headers EXACTLY as Apple specified — Content-Type, Content-Length,
    // and any presigned-URL auth headers must come from requestHeaders verbatim.
    const headers = {};
    for (const h of op.requestHeaders || []) {
      if (h?.name) headers[h.name] = h.value;
    }

    if (flags.verbose) {
      console.log(`      op ${i + 1}/${uploadOperations.length}: ${method} ${op.url?.slice(0, 80)}... offset=${offset} len=${length}`);
    }

    // Retry up to 3 times with 2s backoff on transient 5xx / network errors.
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const res = await fetch(op.url, { method, headers, body: chunk });
        if (res.status >= 200 && res.status < 300) {
          lastErr = null;
          break;
        }
        const text = await res.text().catch(() => '');
        lastErr = new Error(`HTTP ${res.status} on op ${i + 1}: ${text.slice(0, 200)}`);
        if (res.status < 500) break; // 4xx is not transient
      } catch (e) {
        lastErr = e;
      }
      if (attempt < 3) await new Promise((r) => setTimeout(r, 2000));
    }

    if (lastErr) {
      throw new Error(`Upload op ${i + 1}/${uploadOperations.length} for ${label} failed: ${lastErr.message}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// SCREENSHOT SET DISCOVERY / CREATION
// ─────────────────────────────────────────────────────────────────────────

async function findOrCreatePrepareForSubmissionVersion(token, appId) {
  const res = await ascFetch(
    token,
    'GET',
    `/apps/${appId}/appStoreVersions?filter[appStoreState]=PREPARE_FOR_SUBMISSION&limit=5`
  );
  const versions = res?.data || [];
  // Prefer v1.0; otherwise take the most recent PREPARE_FOR_SUBMISSION record.
  const v10 = versions.find((v) => v.attributes?.versionString === '1.0');
  const version = v10 || versions[0];
  if (!version) throw new Error(`No PREPARE_FOR_SUBMISSION appStoreVersion for app ${appId}`);
  return version;
}

async function findEnUsLocalization(token, versionId) {
  const res = await ascFetch(
    token,
    'GET',
    `/appStoreVersions/${versionId}/appStoreVersionLocalizations?limit=200`
  );
  const locs = res?.data || [];
  const loc = locs.find((l) => l.attributes?.locale === LOCALE);
  if (!loc) throw new Error(`No ${LOCALE} appStoreVersionLocalization for version ${versionId}`);
  return loc;
}

async function findOrCreateScreenshotSet(token, locId, displayType) {
  // List all sets on this localization; reuse the matching displayType if it exists.
  const res = await ascFetch(
    token,
    'GET',
    `/appStoreVersionLocalizations/${locId}/appScreenshotSets?limit=200`
  );
  const sets = res?.data || [];
  let set = sets.find((s) => s.attributes?.screenshotDisplayType === displayType);

  if (set) {
    console.log(`    ✓ Reusing existing ${displayType} set: ${set.id}`);
    return set;
  }

  console.log(`    Creating new ${displayType} set...`);
  const body = {
    data: {
      type: 'appScreenshotSets',
      attributes: { screenshotDisplayType: displayType },
      relationships: {
        appStoreVersionLocalization: {
          data: { type: 'appStoreVersionLocalizations', id: locId },
        },
      },
    },
  };
  if (!flags.live) {
    logDry('POST', '/appScreenshotSets', body);
    return { id: '<dry-run-set-id>', attributes: { screenshotDisplayType: displayType } };
  }
  const created = await ascFetch(token, 'POST', '/appScreenshotSets', body);
  console.log(`    ✓ Created appScreenshotSets/${created.data.id}`);
  return created.data;
}

async function listScreenshotsInSet(token, setId) {
  if (setId === '<dry-run-set-id>') return [];
  const res = await ascFetch(
    token,
    'GET',
    `/appScreenshotSets/${setId}/appScreenshots?limit=200`
  );
  return res?.data || [];
}

// ─────────────────────────────────────────────────────────────────────────
// UPLOAD ONE SCREENSHOT (3-phase)
// ─────────────────────────────────────────────────────────────────────────

async function uploadOneScreenshot(token, setId, filePath, existingByName) {
  const fileName = basename(filePath);
  const bytes = readFileSync(filePath);
  const fileSize = bytes.length;

  const existing = existingByName.get(fileName);
  if (existing) {
    const state = existing.attributes?.assetDeliveryState?.state;
    if (state === 'COMPLETE') {
      console.log(`    • ${fileName}: already UPLOADED (id ${existing.id}) — skipping`);
      return { fileName, id: existing.id, state: 'COMPLETE', skipped: true };
    }
    // If state is UPLOAD_FAILED or NOT_UPLOADED, treat as stale and re-upload
    // (delete the stale record first to avoid duplicates).
    console.log(`    • ${fileName}: existing record in state ${state} — deleting + re-uploading`);
    if (flags.live) {
      try {
        await ascFetch(token, 'DELETE', `/appScreenshots/${existing.id}`);
      } catch (e) {
        console.log(`      ! Failed to delete stale ${existing.id}: ${e.message}`);
      }
    }
  }

  console.log(`    • ${fileName}: ${fileSize.toLocaleString()} bytes`);

  // ─── Phase 1: POST /v1/appScreenshots ─────────────────────────────────
  const createBody = {
    data: {
      type: 'appScreenshots',
      attributes: { fileName, fileSize },
      relationships: {
        appScreenshotSet: {
          data: { type: 'appScreenshotSets', id: setId },
        },
      },
    },
  };

  if (!flags.live) {
    logDry('POST', '/appScreenshots', createBody);
    console.log(`      [DRY-RUN] would PUT ${fileSize} bytes in N upload ops`);
    console.log(`      [DRY-RUN] would PATCH /appScreenshots/<id> { uploaded: true, sourceFileChecksum: <md5> }`);
    return { fileName, id: '<dry-run>', state: 'DRY_RUN', skipped: false };
  }

  const created = await ascFetch(token, 'POST', '/appScreenshots', createBody);
  const screenshotId = created.data.id;
  const uploadOperations = created.data.attributes?.uploadOperations || [];
  console.log(`      ✓ Reserved appScreenshots/${screenshotId} (${uploadOperations.length} upload ops)`);

  // ─── Phase 2: PUT chunks per uploadOperation ──────────────────────────
  await executeUploadOperations(uploadOperations, bytes, fileName);
  console.log(`      ✓ Uploaded ${uploadOperations.length} chunk(s) totalling ${fileSize.toLocaleString()} bytes`);

  // ─── Phase 3: PATCH to finalize ───────────────────────────────────────
  const md5 = createHash('md5').update(bytes).digest('hex');
  const patchBody = {
    data: {
      type: 'appScreenshots',
      id: screenshotId,
      attributes: { uploaded: true, sourceFileChecksum: md5 },
    },
  };
  await ascFetch(token, 'PATCH', `/appScreenshots/${screenshotId}`, patchBody);
  console.log(`      ✓ Finalized (md5=${md5.slice(0, 8)}...)`);

  // ─── Phase 4: Poll until assetDeliveryState.state == COMPLETE ─────────
  let finalState = null;
  for (let attempt = 1; attempt <= POLL_MAX_ATTEMPTS; attempt++) {
    const polled = await ascFetch(token, 'GET', `/appScreenshots/${screenshotId}`);
    const state = polled?.data?.attributes?.assetDeliveryState?.state;
    if (flags.verbose) console.log(`      poll ${attempt}: ${state}`);
    if (state === 'COMPLETE' || state === 'UPLOAD_COMPLETE') {
      finalState = 'COMPLETE';
      break;
    }
    if (state === 'FAILED' || state === 'UPLOAD_FAILED') {
      finalState = 'FAILED';
      console.log(`      ✗ Asset delivery FAILED: ${JSON.stringify(polled?.data?.attributes?.assetDeliveryState)}`);
      break;
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  if (!finalState) {
    finalState = 'TIMEOUT';
    console.log(`      ! Timed out waiting for COMPLETE after ${POLL_MAX_ATTEMPTS} polls`);
  } else if (finalState === 'COMPLETE') {
    console.log(`      ✓ COMPLETE`);
  }

  return { fileName, id: screenshotId, state: finalState, skipped: false };
}

// ─────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║  ASC Screenshot Uploader                                   ║');
  console.log('║  3-phase upload to App Store Connect via .p8 JWT           ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  if (!CONFIG[flags.app]) {
    console.error(`\n  ✗ Invalid --app value: ${flags.app}. Use bidder or staff.`);
    process.exit(1);
  }

  if (!flags.live) {
    console.log('\n  [DRY-RUN MODE] — no API calls will be made.');
    console.log('  Add --live to push to App Store Connect.');
  }

  if (!existsSync(flags.dir)) {
    console.error(`\n  ✗ Screenshot dir not found: ${flags.dir}`);
    process.exit(1);
  }

  const keyPath = findKeyPath();
  if (!keyPath) {
    console.error('\n  ✗ ASC API key not found.');
    process.exit(1);
  }
  console.log(`\n  App:      ${CONFIG[flags.app].name} (${CONFIG[flags.app].appId})`);
  console.log(`  Display:  ${flags.display}`);
  console.log(`  Dir:      ${flags.dir}`);
  console.log(`  Key:      ${keyPath}`);

  const token = makeJwt(keyPath);
  console.log('  ✓ JWT minted (ES256, raw r||s signature)');

  // Enumerate PNG files in sorted alphabetical order so numbered prefixes
  // (01-, 02-, ...) determine the display order in App Store Connect.
  const allFiles = readdirSync(flags.dir)
    .filter((f) => f.toLowerCase().endsWith('.png'))
    .sort();
  if (allFiles.length === 0) {
    console.error(`\n  ✗ No PNG files in ${flags.dir}`);
    process.exit(1);
  }
  console.log(`\n  Found ${allFiles.length} PNG file(s) (alphabetical order):`);
  for (const f of allFiles) {
    const sz = statSync(join(flags.dir, f)).size;
    console.log(`    • ${f}  (${sz.toLocaleString()} bytes)`);
  }

  // ─── Resolve the v1.0 version + en-US localization + screenshot set ───
  console.log(`\n  [1/4] Locating PREPARE_FOR_SUBMISSION version`);
  const version = await findOrCreatePrepareForSubmissionVersion(token, CONFIG[flags.app].appId);
  console.log(`    ✓ appStoreVersions/${version.id} (v${version.attributes?.versionString})`);

  console.log(`\n  [2/4] Locating ${LOCALE} localization`);
  const loc = await findEnUsLocalization(token, version.id);
  console.log(`    ✓ appStoreVersionLocalizations/${loc.id}`);

  console.log(`\n  [3/4] Locating / creating ${flags.display} screenshot set`);
  const set = await findOrCreateScreenshotSet(token, loc.id, flags.display);

  // ─── Upload each file (idempotent via filename match) ─────────────────
  console.log(`\n  [4/4] Uploading screenshots`);
  const existingScreenshots = await listScreenshotsInSet(token, set.id);
  const existingByName = new Map();
  for (const s of existingScreenshots) {
    const name = s.attributes?.fileName;
    if (name) existingByName.set(name, s);
  }
  if (existingByName.size > 0) {
    console.log(`    ℹ Set already contains ${existingByName.size} screenshot(s); will skip COMPLETE ones with matching fileName.`);
  }

  const results = [];
  for (const f of allFiles) {
    const filePath = join(flags.dir, f);
    try {
      const result = await uploadOneScreenshot(token, set.id, filePath, existingByName);
      results.push(result);
    } catch (e) {
      console.log(`    ✗ ${f}: ${e.message}`);
      if (flags.verbose && e.body) console.log(JSON.stringify(e.body, null, 2));
      results.push({ fileName: f, id: null, state: 'ERROR', error: e.message, skipped: false });
    }
  }

  // ─── Summary ──────────────────────────────────────────────────────────
  console.log(`\n════════════════════════════════════════════════════════════`);
  console.log(`  SUMMARY`);
  console.log(`════════════════════════════════════════════════════════════`);
  let okCount = 0;
  let failCount = 0;
  for (const r of results) {
    const tag =
      r.state === 'COMPLETE' || r.state === 'DRY_RUN' ? '✓' :
      r.skipped ? '✓ (skipped, already complete)' :
      '✗';
    const stateStr = r.skipped && r.state === 'COMPLETE' ? 'COMPLETE (existing)' : r.state;
    console.log(`  ${tag} ${r.fileName}  →  ${stateStr}${r.error ? ' — ' + r.error : ''}`);
    if (r.state === 'COMPLETE' || r.state === 'DRY_RUN') okCount++;
    else failCount++;
  }

  console.log(`\n  Result: ${okCount} ok / ${failCount} failed of ${results.length} total`);

  if (!flags.live) {
    console.log(`\n  This was a DRY-RUN. Add --live to actually upload.\n`);
  }

  if (failCount > 0 && flags.live) process.exit(1);
}

main().catch((e) => {
  console.error(`\n  ✗ Fatal: ${e.message}`);
  if (flags.verbose) console.error(e.stack);
  process.exit(1);
});
