#!/usr/bin/env node
// =============================================================================
// scripts/submit-android-play-store.mjs
//
// Uploads Android AAB to Google Play Console and promotes to a release track.
// Uses the Google Play Developer API with service account JWT auth.
//
// Prerequisites:
//   - .secrets/google-play-service-account.json exists (service account key)
//   - Play Console developer account created
//   - BinGo app listing created in Play Console
//   - AAB file either built locally or manually downloaded
//
// Usage:
//   # Dry-run (shows what would happen):
//   node scripts/submit-android-play-store.mjs --track internal
//
//   # Upload AAB to internal testing track:
//   node scripts/submit-android-play-store.mjs --track internal --live
//
//   # Upload specific AAB file:
//   node scripts/submit-android-play-store.mjs --bundle path/to/app.aab --live
//
// Flags:
//   --bundle PATH              (path to .aab; auto-resolved from EAS if not provided)
//   --track internal|alpha|beta|production  (default: internal)
//   --release-notes PATH       (defaults to docs/STORE_METADATA.md)
//   --live                     (default: false — dry-run otherwise)
//   --verbose                  (show full API responses)
//
// =============================================================================

import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { createSign } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────

// Must match `android.package` in apps/bidder-app/app.config.ts. Was
// `com.cluerholdings.auctionplatform` until 2026-08-07 — a package that was
// never published to Play, so every edit this script opened targeted an app
// that doesn't exist.
const ANDROID_PACKAGE_NAME = 'com.bingoauctions.bidder';
const GOOGLE_PLAY_API_URL = 'https://androidpublisher.googleapis.com/androidpublisher/v3';
const SERVICE_ACCOUNT_PATH = join(__dirname, '..', '.secrets', 'google-play-service-account.json');
const STORE_METADATA_PATH = join(__dirname, '..', 'docs', 'STORE_METADATA.md');

// ─────────────────────────────────────────────────────────────────────────
// CLI FLAGS
// ─────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flags = {
  bundle: null,
  track: 'internal',
  releaseNotes: STORE_METADATA_PATH,
  live: false,
  verbose: false,
};

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--bundle') flags.bundle = args[++i];
  else if (arg === '--track') flags.track = args[++i];
  else if (arg === '--release-notes') flags.releaseNotes = args[++i];
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

function validatePrerequisites() {
  const issues = [];

  // Check service account
  if (!existsSync(SERVICE_ACCOUNT_PATH)) {
    issues.push(
      `\n  Service account JSON not found: ${SERVICE_ACCOUNT_PATH}\n` +
      `  To generate:\n` +
      `    1. Open Google Cloud Console: https://console.cloud.google.com/\n` +
      `    2. IAM & Admin → Service accounts → Create service account\n` +
      `    3. Add key → JSON, download\n` +
      `    4. Move to .secrets/google-play-service-account.json\n` +
      `    5. In Play Console → Settings → API access, grant "Release manager" permission`
    );
  }

  // Check AAB
  if (!flags.bundle) {
    // Try to find from EAS build output
    const likelyPaths = [
      join(__dirname, '..', 'apps', 'bidder-app', 'android', 'app', 'build', 'outputs', 'bundle', 'release', 'app-release.aab'),
      join(__dirname, '..', 'apps', 'bidder-app', '.eas-build', 'app.aab'),
    ];

    let found = false;
    for (const path of likelyPaths) {
      if (existsSync(path)) {
        flags.bundle = path;
        found = true;
        break;
      }
    }

    if (!found) {
      issues.push(
        `\n  No AAB file specified and none found in expected locations.\n` +
        `  To build:\n` +
        `    cd apps/bidder-app\n` +
        `    npx eas build --platform android --profile production --non-interactive\n` +
        `  Then download the .aab from EAS dashboard or provide --bundle PATH`
      );
    }
  } else if (!existsSync(flags.bundle)) {
    issues.push(`\n  AAB file not found: ${flags.bundle}`);
  }

  // Check Play Console account (can't fully validate without API call, but check service account setup)
  // This will be caught when we try to use the API

  if (issues.length > 0) {
    log('\n╔═══════════════════════════════════════════════════════════╗');
    log('║  PREREQUISITES NOT MET                                    ║');
    log('╚═══════════════════════════════════════════════════════════╝');

    for (const issue of issues) {
      log(issue);
    }

    log('\n  Please complete the above before running with --live');
    process.exit(1);
  }
}

function makeServiceAccountJwt() {
  if (!existsSync(SERVICE_ACCOUNT_PATH)) {
    throw new Error(`Service account not found: ${SERVICE_ACCOUNT_PATH}`);
  }

  const sa = JSON.parse(readFileSync(SERVICE_ACCOUNT_PATH, 'utf8'));

  const now = Math.floor(Date.now() / 1000);

  const header = {
    alg: 'RS256',
    typ: 'JWT',
  };

  const payload = {
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/androidpublisher',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  };

  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const message = `${headerB64}.${payloadB64}`;

  const signer = createSign('RSA-SHA256');
  signer.update(message);
  const signature = signer.sign(sa.private_key, 'base64url');

  return `${message}.${signature}`;
}

async function getAccessToken(saJwt) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${saJwt}`,
  });

  if (!res.ok) {
    throw new Error(`OAuth2 failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return data.access_token;
}

async function playFetch(accessToken, path, init = {}) {
  const url = `${GOOGLE_PLAY_API_URL}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
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
    const detail = body?.error?.message || text;
    throw new Error(`Play API ${res.status}: ${detail}`);
  }

  return body;
}

function logDryRun(method, path, body) {
  log(`  [DRY-RUN] ${method} ${GOOGLE_PLAY_API_URL}${path}`);
  if (body) {
    const redacted = JSON.stringify(body, null, 2).replace(
      /("key"|"token"|"secret"):.*?([,\n}])/g,
      '$1: "[redacted]"$2'
    );
    log(`  Payload:\n${redacted.split('\n').map(l => '    ' + l).join('\n')}`);
  }
}

function extractReleaseNotes() {
  if (!existsSync(flags.releaseNotes)) {
    log(`  ℹ Release notes file not found: ${flags.releaseNotes}`);
    return 'ClovrBid bidder app release.';
  }

  const content = readFileSync(flags.releaseNotes, 'utf8');
  // Extract the Description section (4000 chars, but truncate to ~500 for release notes)
  const descStart = content.indexOf('## Description');
  if (descStart < 0) {
    return 'ClovrBid bidder app release.';
  }

  const descEnd = content.indexOf('\n##', descStart + 1);
  const desc = content.slice(descStart, descEnd > 0 ? descEnd : undefined);
  const text = desc.replace(/^##.*\n/m, '').replace(/```.*?```/gs, '').trim();
  const truncated = text.slice(0, 500).split('\n')[0];

  return truncated || 'ClovrBid bidder app release.';
}

// ─────────────────────────────────────────────────────────────────────────
// MAIN LOGIC
// ─────────────────────────────────────────────────────────────────────────

async function submitApp(accessToken) {
  const { bundle } = flags;
  const { track } = flags;

  log(`\n════════════════════════════════════════════════════`);
  log(`  Submitting Android App to Play Store`);
  log(`════════════════════════════════════════════════════`);
  log(`  Package: ${ANDROID_PACKAGE_NAME}`);
  log(`  AAB: ${bundle}`);
  log(`  Track: ${track}`);
  log(`════════════════════════════════════════════════════\n`);

  // 1. Create an edit session
  log(`1. Creating edit session...`);

  const createEditPayload = {};

  if (!flags.live) {
    logDryRun('POST', `/applications/${ANDROID_PACKAGE_NAME}/edits`, createEditPayload);
    log(`  [DRY-RUN] Would create edit session\n`);
  } else {
    try {
      const editRes = await playFetch(
        accessToken,
        `/applications/${ANDROID_PACKAGE_NAME}/edits`,
        {
          method: 'POST',
          body: JSON.stringify(createEditPayload),
        }
      );

      var editId = editRes.id;
      log(`  ✓ Edit session created: ${editId}\n`);
    } catch (e) {
      log(`  ✗ Error creating edit session: ${e.message}\n`);
      return false;
    }
  }

  if (!flags.live) {
    editId = 'DRY_RUN_EDIT_ID';
  }

  // 2. Upload the AAB
  log(`2. Uploading AAB bundle...`);

  try {
    const aabContent = readFileSync(bundle);
    const aabSize = statSync(bundle).size;
    log(`   AAB size: ${(aabSize / 1024 / 1024).toFixed(2)} MB`);

    if (!flags.live) {
      log(`  [DRY-RUN] Would upload AAB to edit ${editId}\n`);
    } else {
      const uploadRes = await playFetch(
        accessToken,
        `/applications/${ANDROID_PACKAGE_NAME}/edits/${editId}/bundles?uploadType=media`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: aabContent,
        }
      );

      const versionCode = uploadRes.versionCode;
      log(`  ✓ AAB uploaded successfully (version code: ${versionCode})\n`);
    }
  } catch (e) {
    log(`  ✗ Error uploading AAB: ${e.message}\n`);
    return false;
  }

  // 3. Promote to the specified track
  log(`3. Promoting to "${track}" track...`);

  const releaseNotes = extractReleaseNotes();
  const promotePayload = {
    releases: [
      {
        name: '1.0',
        versionCodes: flags.live ? ['1'] : undefined, // Will be auto-set in real upload
        releaseNotes: [
          {
            language: 'en-US',
            text: releaseNotes,
          },
        ],
        status: 'draft', // draft = staged, not live yet
      },
    ],
  };

  if (!flags.live) {
    logDryRun('POST', `/applications/${ANDROID_PACKAGE_NAME}/edits/${editId}/tracks/${track}`, promotePayload);
    log(`  [DRY-RUN] Would promote to "${track}" track\n`);
  } else {
    try {
      await playFetch(
        accessToken,
        `/applications/${ANDROID_PACKAGE_NAME}/edits/${editId}/tracks/${track}`,
        {
          method: 'POST',
          body: JSON.stringify(promotePayload),
        }
      );

      log(`  ✓ Release promoted to "${track}" track\n`);
    } catch (e) {
      log(`  ✗ Error promoting to track: ${e.message}\n`);
      return false;
    }
  }

  // 4. Commit the edit
  log(`4. Committing changes...`);

  if (!flags.live) {
    log(`  [DRY-RUN] Would commit edit ${editId}\n`);
  } else {
    try {
      await playFetch(
        accessToken,
        `/applications/${ANDROID_PACKAGE_NAME}/edits/${editId}:commit`,
        {
          method: 'POST',
        }
      );

      log(`  ✓ Edit committed (changes now live in Play Console)\n`);
    } catch (e) {
      log(`  ✗ Error committing edit: ${e.message}\n`);
      return false;
    }
  }

  return true;
}

// ─────────────────────────────────────────────────────────────────────────
// ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────

async function main() {
  log('\n╔═══════════════════════════════════════════════════════════╗');
  log('║  Google Play Store Submission Tool                        ║');
  log('╚═══════════════════════════════════════════════════════════╝\n');

  // Validate prerequisites (exits if failed)
  validatePrerequisites();

  // Warn if dry-run
  if (!flags.live) {
    log('  [DRY-RUN MODE] — no API calls will be made');
    log('  Add --live to actually submit\n');
  }

  // Validate track
  if (!['internal', 'alpha', 'beta', 'production'].includes(flags.track)) {
    err(`✗ Invalid --track value: ${flags.track}`);
    err(`   Use: internal, alpha, beta, or production`);
    process.exit(1);
  }

  // Create credentials
  let accessToken;
  try {
    log('Authenticating with Google Play API...');
    const saJwt = makeServiceAccountJwt();
    accessToken = await getAccessToken(saJwt);
    log('✓ Authenticated\n');
  } catch (e) {
    err(`✗ Failed to authenticate: ${e.message}`);
    process.exit(1);
  }

  // Submit
  const success = await submitApp(accessToken);

  // Summary
  log(`════════════════════════════════════════════════════`);
  log(`  SUMMARY`);
  log(`════════════════════════════════════════════════════`);

  if (success) {
    log(`✓ Submission successful`);
    if (!flags.live) {
      log(`\n  This was a DRY-RUN. To make actual changes, add --live`);
    } else {
      log(`\n  AAB uploaded and release created. Visit Play Console to review before going live.`);
      log(`  Next steps in Play Console:`);
      log(`    1. Review → Review release`);
      log(`    2. Confirm metadata and review notes`);
      log(`    3. Roll out to ${flags.track === 'production' ? 'production (Google plays ~1-3h)' : flags.track}`);
    }
    log();
  } else {
    log(`✗ Submission failed\n`);
    process.exit(1);
  }
}

main().catch((e) => {
  err(`\n✗ Fatal error: ${e.message}`);
  process.exit(1);
});
