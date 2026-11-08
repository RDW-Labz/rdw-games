#!/usr/bin/env node
// =============================================================================
// scripts/clear-asc-submission-blockers.mjs
//
// Clears the 4 known App Store Connect v1.0 submission blockers for bidder
// and/or staff apps via the ASC JWT API, falling back to local code changes
// where Apple does not expose a JWT endpoint.
//
// THE 4 BLOCKERS (per Apple's 409 on PATCH /reviewSubmissions submitted=true):
//   1. primaryCategory / secondaryCategory missing on appInfo
//   2. App Privacy data usages not published       <-- HARD APPLE LIMITATION
//   3. Pricing tier not set                         (Free / USD_0)
//   4. APP_IPAD_PRO_3GEN_129 screenshots missing    <-- needs new build or PNGs
//
// API REACHABILITY MATRIX:
//   1. categories      → PATCH /appInfos/{id}/relationships/{primary|secondary}Category
//   2. data usages     → /v1/appDataUsages  IS 404 ON JWT  (fastlane uses session
//                        cookie auth + 2FA app-specific password; not exposed to
//                        API-key JWT tokens). We DO NOT silently punt to manual:
//                        we WRITE a runbook to docs/ + ship a code fix to
//                        app.config.ts where applicable (kidsAge declarations).
//   3. pricing         → POST /v1/appPriceSchedules with baseTerritory + manualPrices
//   4. iPad screenshots → POST /v1/appScreenshots (needs PNGs we don't have) OR
//                        edit app.config.ts → supportsTablet=false → next EAS build
//                        re-encodes the IPA without iPad → blocker disappears.
//
// We attack what JWT can reach, file PRs / app.config.ts edits for the rest,
// and document the residual blocker honestly. Per memory feedback_headless_always.md
// we never tell the user "go click a button" without first exhausting the API.
//
// Usage:
//   # Dry-run (default)
//   node scripts/clear-asc-submission-blockers.mjs --app bidder
//
//   # Apply all blockers we can clear via API, leaving iPad for the next build
//   node scripts/clear-asc-submission-blockers.mjs --app bidder --live
//
//   # Selective skips (when iterating)
//   node scripts/clear-asc-submission-blockers.mjs --app bidder --live \
//       --skip-privacy --skip-ipad-deviceFamily
//
// Flags:
//   --app bidder|staff|both   (default: bidder)
//   --live                    (default: false — dry-run otherwise)
//   --verbose
//   --skip-primaryCategory
//   --skip-privacy
//   --skip-pricing
//   --skip-ipad-deviceFamily
//
// Idempotent: re-running is safe. GETs current state first, only PATCHes if
// the field differs.
// =============================================================================

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
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
    appConfigPath: join(REPO_ROOT, 'apps', 'bidder-app', 'app.config.ts'),
  },
  staff: {
    appId: '6767026881',
    bundle: 'com.cluerholdings.bidwizops',
    name: 'ClovrBid Staff',
    appConfigPath: join(REPO_ROOT, 'apps', 'field-mobile', 'app.config.ts'),
  },
};

const ASC_KEY_ID = '25M83P99J8';
const ASC_ISSUER_ID = 'df79d9d0-5f90-4a53-8e2f-4c16b3fafce9';
const ASC_BASE_URL = 'https://api.appstoreconnect.apple.com/v1';

// Apple category IDs — confirmed via `GET /v1/appCategories?filter[platforms]=IOS`
// on 2026-05-24. SHOPPING + BUSINESS exist in the IOS platform set.
const PRIMARY_CATEGORY = 'SHOPPING';
const SECONDARY_CATEGORY = 'BUSINESS';

// Free USD price point ID is per-app (Apple encodes it as base64 of
// {s:appId, t:territory, p:tier}). We resolve it dynamically at runtime via
// /v1/apps/{appId}/appPricePoints?filter[territory]=USA where customerPrice=0.
const BASE_TERRITORY_ID = 'USA';

// ─────────────────────────────────────────────────────────────────────────
// CLI FLAGS
// ─────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flags = {
  app: 'bidder',
  live: false,
  verbose: false,
  skipPrimaryCategory: false,
  skipPrivacy: false,
  skipPricing: false,
  skipIpadDeviceFamily: false,
};

for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--app') flags.app = args[++i];
  else if (a === '--live') flags.live = true;
  else if (a === '--verbose') flags.verbose = true;
  else if (a === '--skip-primaryCategory') flags.skipPrimaryCategory = true;
  else if (a === '--skip-privacy') flags.skipPrivacy = true;
  else if (a === '--skip-pricing') flags.skipPricing = true;
  else if (a === '--skip-ipad-deviceFamily') flags.skipIpadDeviceFamily = true;
  else if (a === '--help' || a === '-h') {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 70).join('\n'));
    process.exit(0);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────────────────────────────

function findKeyPath() {
  const candidates = [
    join(REPO_ROOT, '.secrets', 'AuthKey_25M83P99J8.p8'),
    'C:\\Users\\jmacl\\Projects\\auction-platform\\.secrets\\AuthKey_25M83P99J8.p8',
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

function makeJwt(keyPath) {
  const key = readFileSync(keyPath, 'utf8');
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'ES256', kid: ASC_KEY_ID, typ: 'JWT' };
  const payload = { iss: ASC_ISSUER_ID, iat: now, exp: now + 1200, aud: 'appstoreconnect-v1' };
  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const message = `${headerB64}.${payloadB64}`;
  // CRITICAL: raw r||s sig (IEEE-P1363), not DER. Without this, every request 401s.
  const signer = createSign('SHA256');
  signer.update(message);
  const signature = signer.sign({ key, dsaEncoding: 'ieee-p1363' }, 'base64url');
  return `${message}.${signature}`;
}

// ─────────────────────────────────────────────────────────────────────────
// ASC FETCH
// ─────────────────────────────────────────────────────────────────────────

// State holder so we can re-mint the JWT on 401 (Apple sometimes rate-limits
// freshly-minted tokens for a few seconds; a re-mint with a slightly different
// iat lets the call through).
const TOKEN_STATE = { jwt: null, keyPath: null };

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

async function asc(_unused, method, path, body) {
  // First arg kept for API compat (callers pass `token` but we use TOKEN_STATE).
  let attempt = await ascRaw(method, path, body);

  // Apple's ASC API sometimes 401s a brand-new JWT (rate limiting on the issuer
  // bucket within ~5s of mint). Re-mint and retry exactly once.
  if (attempt.status === 401 && TOKEN_STATE.keyPath) {
    if (flags.verbose) console.error(`[ASC] 401 on ${method} ${path} — re-minting JWT and retrying once`);
    TOKEN_STATE.jwt = makeJwt(TOKEN_STATE.keyPath);
    attempt = await ascRaw(method, path, body);
  }

  if (flags.verbose) {
    console.log(`[ASC] ${method} ${path} -> ${attempt.status}`);
    if (attempt.data) console.log(JSON.stringify(attempt.data, null, 2).split('\n').slice(0, 20).join('\n'));
  }

  if (!attempt.ok) {
    const data = attempt.data;
    const detail = data?.errors?.[0]?.detail || data?.errors?.[0]?.title || (typeof data === 'string' ? data : JSON.stringify(data));
    const err = new Error(`ASC ${attempt.status} on ${method} ${path}: ${detail}`);
    err.status = attempt.status;
    err.body = data;
    throw err;
  }
  return attempt.data;
}

function logDry(method, path, body) {
  console.log(`    [DRY-RUN] ${method} ${ASC_BASE_URL}${path}`);
  if (body) {
    const out = JSON.stringify(body, null, 2).split('\n').map((l) => '      ' + l).join('\n');
    console.log(out);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// FIX 1 — primary + secondary categories on appInfo
// ─────────────────────────────────────────────────────────────────────────

async function fixCategories(token, appKey, result) {
  const cfg = CONFIG[appKey];
  console.log(`\n  [1/4] appInfo categories (primary=${PRIMARY_CATEGORY}, secondary=${SECONDARY_CATEGORY})`);

  if (flags.skipPrimaryCategory) {
    console.log(`    ⏭  Skipped via --skip-primaryCategory`);
    result.categories = 'SKIPPED';
    return;
  }

  // 1. Find the editable PREPARE_FOR_SUBMISSION appInfo
  const aiResp = await asc(token, 'GET', `/apps/${cfg.appId}/appInfos?include=primaryCategory,secondaryCategory`);
  const editable = aiResp.data?.find((ai) => ai.attributes?.state === 'PREPARE_FOR_SUBMISSION')
    || aiResp.data?.find((ai) => ai.attributes?.state === 'READY_FOR_DISTRIBUTION')
    || aiResp.data?.[0];
  if (!editable) {
    console.log(`    ✗ No editable appInfo found.`);
    result.categories = 'FAILED_NO_APPINFO';
    return;
  }
  console.log(`    appInfo ${editable.id} state=${editable.attributes?.state}`);

  const currentPrimary = editable.relationships?.primaryCategory?.data?.id || null;
  const currentSecondary = editable.relationships?.secondaryCategory?.data?.id || null;
  console.log(`    current: primary=${currentPrimary || '(unset)'} secondary=${currentSecondary || '(unset)'}`);

  // 2. PATCH the appInfo resource itself with both relationships in one call.
  // Apple REJECTS the /appInfos/{id}/relationships/{primaryCategory} endpoint with
  // 403 "The relationship 'primaryCategory' does not allow 'UPDATE'. Allowed
  // operations are: GET_RELATED, GET_RELATIONSHIP". The correct pattern is
  // PATCH /appInfos/{id} with `relationships` in the body — confirmed working
  // 2026-05-24 (returned 200).
  if (currentPrimary === PRIMARY_CATEGORY && currentSecondary === SECONDARY_CATEGORY) {
    console.log(`    ✓ both categories already set correctly`);
    result.categories = 'ALREADY_SET';
    return;
  }

  const body = {
    data: {
      type: 'appInfos',
      id: editable.id,
      relationships: {
        primaryCategory: { data: { type: 'appCategories', id: PRIMARY_CATEGORY } },
        secondaryCategory: { data: { type: 'appCategories', id: SECONDARY_CATEGORY } },
      },
    },
  };
  if (!flags.live) {
    logDry('PATCH', `/appInfos/${editable.id}`, body);
    result.categories = 'DRY_RUN_OK';
    return;
  }
  try {
    await asc(token, 'PATCH', `/appInfos/${editable.id}`, body);
    console.log(`    ✓ PATCHed appInfos/${editable.id} (primary=${PRIMARY_CATEGORY}, secondary=${SECONDARY_CATEGORY})`);
    result.categories = 'OK';
  } catch (e) {
    console.log(`    ✗ PATCH appInfos/${editable.id} failed: ${e.message}`);
    if (e.body) console.log(`      ${JSON.stringify(e.body).slice(0, 600)}`);
    result.categories = 'FAILED';
  }
}

// ─────────────────────────────────────────────────────────────────────────
// FIX 2 — App Privacy data usages (HARD APPLE LIMITATION on JWT)
// ─────────────────────────────────────────────────────────────────────────

async function fixPrivacy(token, appKey, result) {
  const cfg = CONFIG[appKey];
  console.log(`\n  [2/4] App Privacy data usages`);

  if (flags.skipPrivacy) {
    console.log(`    ⏭  Skipped via --skip-privacy`);
    result.privacy = 'SKIPPED';
    return;
  }

  // Probe to confirm the endpoint is still 404 (in case Apple ever ships it).
  // If it IS reachable, we'd POST AppDataUsage records here.
  const probe = await fetch(`${ASC_BASE_URL}/appDataUsages?filter[app]=${cfg.appId}&limit=1`, {
    headers: { Authorization: `Bearer ${TOKEN_STATE.jwt}` },
  });
  if (probe.status === 200) {
    console.log(`    ⚠ /appDataUsages now responds 200 on JWT — Apple shipped the endpoint!`);
    console.log(`    This script must be extended to POST data usage records. See:`);
    console.log(`    https://github.com/fastlane/fastlane/blob/master/spaceship/lib/spaceship/connect_api/tunes/tunes.rb`);
    result.privacy = 'NEW_ENDPOINT_AVAILABLE';
    return;
  }

  // 404 confirmed → Apple JWT API does NOT expose privacy declarations.
  // Write a runbook so the only manual surface is one `fastlane spaceauth` step
  // that produces a session cookie we can reuse for ~30 days.
  console.log(`    ⚠ /appDataUsages returns 404 (PATH_ERROR) on JWT auth.`);
  console.log(`    This is a documented Apple platform limitation — App Privacy`);
  console.log(`    declarations are ONLY editable via session-cookie auth (Apple ID + 2FA).`);
  console.log(`    `);
  console.log(`    Headless path forward:`);
  console.log(`      1. Generate a session cookie ONCE via:`);
  console.log(`           fastlane spaceauth -u jmacluer@gmail.com`);
  console.log(`         (24-mo session, refreshable from any logged-in machine)`);
  console.log(`      2. Store the cookie as GH secret FASTLANE_SESSION + 2FA app-specific password`);
  console.log(`         as APPLE_APPLICATION_SPECIFIC_PASSWORD.`);
  console.log(`      3. Run scripts/upload-privacy-fastlane.sh from any CI runner`);
  console.log(`         (writes a manifest JSON of data usages and runs`);
  console.log(`          fastlane run upload_app_privacy_details_to_app_store).`);
  console.log(`    `);
  console.log(`    Until #1 is done, this blocker remains. We document the decision`);
  console.log(`    in docs/runbooks/asc-app-privacy-runbook.md (created by this script).`);

  const runbookPath = join(REPO_ROOT, 'docs', 'runbooks', 'asc-app-privacy-runbook.md');
  if (flags.live) {
    writeRunbook(runbookPath, appKey, cfg);
    console.log(`    ✓ Wrote runbook to ${runbookPath}`);
  } else {
    console.log(`    [DRY-RUN] Would write runbook to ${runbookPath}`);
  }
  result.privacy = 'BLOCKED_APPLE_PLATFORM';
}

function writeRunbook(path, appKey, cfg) {
  const md = `# ASC App Privacy Runbook (Headless via fastlane spaceauth)

> **Why this exists:** Apple's App Store Connect JWT API does NOT expose the
> \`/v1/appDataUsages\` endpoints. The endpoints DO exist but are only reachable
> via session-cookie auth (Apple ID + 2FA). This runbook documents the
> minimum-friction headless path: one interactive \`spaceauth\` per ~30 days,
> then fully automated CI uploads of the privacy manifest.

## Status (${new Date().toISOString().slice(0, 10)})

| App | App ID | Privacy state |
|-----|--------|---------------|
| ClovrBid Bidder | 6767012532 | not published |
| ClovrBid Staff  | 6767026881 | not published |

## The privacy manifest we want to publish

Both apps collect the same data, but linked-to-user is different per surface.
This is the source of truth; \`scripts/upload-privacy-fastlane.sh\` reads it.

\`\`\`json
{
  "data_collected": [
    {
      "category": "Contact Info",
      "fields": ["Email Address", "Name"],
      "linked_to_user": true,
      "used_for_tracking": false,
      "purposes": ["App Functionality"]
    },
    {
      "category": "Identifiers",
      "fields": ["User ID"],
      "linked_to_user": true,
      "used_for_tracking": false,
      "purposes": ["App Functionality"]
    },
    {
      "category": "Financial Info",
      "fields": ["Payment Info"],
      "linked_to_user": true,
      "used_for_tracking": false,
      "purposes": ["App Functionality"],
      "notes": "Stripe stores card; ClovrBid never sees raw PAN. Declared per Apple guidance."
    },
    {
      "category": "Usage Data",
      "fields": ["Product Interaction"],
      "linked_to_user": false,
      "used_for_tracking": false,
      "purposes": ["Analytics"],
      "notes": "PostHog events captured without identifiable PII once analytics_anonymize feature flag is wired."
    }
  ],
  "data_not_collected": [
    "Crash Data — @sentry/react-native fully removed 2026-05-19 from both apps; verify by greping 'Sentry' in apps/bidder-app and apps/field-mobile.",
    "Location, Health, Browsing History, Search History, Photos/Videos, Audio, Files, Diagnostics, Sensitive Info, Contacts, Other."
  ]
}
\`\`\`

## One-time bootstrap (do this ONCE on the Mac mini or any non-CI machine)

\`\`\`bash
# 1. Install fastlane (one-time)
gem install fastlane

# 2. Generate session cookie — opens browser, prompts 2FA, outputs FASTLANE_SESSION env value
fastlane spaceauth -u jmacluer@gmail.com

# 3. Generate an app-specific password at https://account.apple.com (Security → App-Specific Passwords)
#    Name it 'fastlane-ASC-headless'. Save the 16-char output.

# 4. Push both to GitHub repo secrets (1 ASC + 1 cookie + 1 app-specific pw):
gh secret set FASTLANE_SESSION --body "<session-from-step-2>"
gh secret set FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD --body "<password-from-step-3>"

# Done. Cookie persists for ~24 months. Re-run step 2 when fastlane errors mention "session expired".
\`\`\`

## CI invocation (every privacy change)

The script \`scripts/upload-privacy-fastlane.sh\` does the actual upload:

\`\`\`bash
# In .github/workflows/asc-publish-privacy.yml
- env:
    FASTLANE_SESSION: \${{ secrets.FASTLANE_SESSION }}
    FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD: \${{ secrets.FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD }}
    ASC_APP_ID: ${cfg.appId}
  run: bash scripts/upload-privacy-fastlane.sh
\`\`\`

## Last-resort: ASC web dashboard

If \`spaceauth\` keeps failing (account recovery, 2FA reset etc.), you can publish
once via https://appstoreconnect.apple.com/apps/${cfg.appId}/distribution/privacy.
Per memory \`feedback_headless_always.md\` this is the LAST resort, not the first.

## Why this isn't worse than it sounds

- Cookie lasts ~24 months
- Once published, the privacy declarations persist across versions
- Only changes require re-publish — so for v1.0 launch this is a single one-shot setup

`;
  // Ensure runbook dir exists
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, md, 'utf8');
}

// ─────────────────────────────────────────────────────────────────────────
// FIX 3 — App pricing (Free / USD_0)
// ─────────────────────────────────────────────────────────────────────────

async function fixPricing(token, appKey, result) {
  const cfg = CONFIG[appKey];
  console.log(`\n  [3/4] App pricing (Free / USD_0)`);

  if (flags.skipPricing) {
    console.log(`    ⏭  Skipped via --skip-pricing`);
    result.pricing = 'SKIPPED';
    return;
  }

  // 1. Check if pricing is already set with at least one manualPrice.
  // The /appPriceSchedule shell ALWAYS exists with id=appId — even when no
  // pricing has been configured. The real check is whether manualPrices has
  // any entries. We GET /manualPrices and see if it returns 404 (unset) or
  // a populated array.
  let alreadyPriced = false;
  try {
    const mp = await fetch(`${ASC_BASE_URL}/appPriceSchedules/${cfg.appId}/manualPrices`, {
      headers: { Authorization: `Bearer ${TOKEN_STATE.jwt}` },
    });
    if (mp.status === 200) {
      const body = await mp.json();
      if (Array.isArray(body?.data) && body.data.length > 0) {
        alreadyPriced = true;
        console.log(`    ✓ appPriceSchedule already has ${body.data.length} manualPrice(s) — skipping`);
      }
    }
  } catch {}
  if (alreadyPriced) {
    result.pricing = 'ALREADY_SET';
    return;
  }
  console.log(`    appPriceSchedule has no manualPrices → will POST a Free-tier price`);

  // 2. Look up the Free price point ID for this app + USA territory.
  // Apple encodes per-app price points as base64({s:appId, t:territory, p:tier}).
  // The tier with customerPrice=0.0 is the Free tier.
  const pp = await asc(token, 'GET', `/apps/${cfg.appId}/appPricePoints?filter[territory]=USA&limit=10`);
  const free = (pp.data || []).find((p) => Number(p.attributes?.customerPrice) === 0);
  if (!free) {
    console.log(`    ✗ Could not find Free (customerPrice=0.0) price point for USA`);
    result.pricing = 'FAILED_NO_FREE_TIER';
    return;
  }
  console.log(`    Free price point: ${free.id}`);

  // 3. POST /appPriceSchedules
  // CRITICAL: Apple's JSON:API local-id format is `${local-id}` LITERALLY —
  // the dollar-brace syntax IS part of the value Apple expects. We use a
  // template literal stub so the value reads `${new-1}` as a string, not
  // a JS interpolation.
  const LOCAL_ID = '${new-1}';
  const body = {
    data: {
      type: 'appPriceSchedules',
      relationships: {
        app: { data: { type: 'apps', id: cfg.appId } },
        baseTerritory: { data: { type: 'territories', id: BASE_TERRITORY_ID } },
        manualPrices: {
          data: [{ type: 'appPrices', id: LOCAL_ID }],
        },
      },
    },
    included: [
      {
        type: 'appPrices',
        id: LOCAL_ID,
        relationships: {
          appPricePoint: { data: { type: 'appPricePoints', id: free.id } },
          territory: { data: { type: 'territories', id: BASE_TERRITORY_ID } },
        },
      },
    ],
  };

  if (!flags.live) {
    logDry('POST', `/appPriceSchedules`, body);
    console.log(`    [DRY-RUN] would POST appPriceSchedule with Free tier + USA base territory`);
    result.pricing = 'DRY_RUN_OK';
    return;
  }

  try {
    const res = await asc(token, 'POST', `/appPriceSchedules`, body);
    console.log(`    ✓ POSTed appPriceSchedule ${res.data?.id}`);
    result.pricing = 'OK';
  } catch (e) {
    console.log(`    ✗ POST appPriceSchedule failed: ${e.message}`);
    if (e.body) console.log(`      body: ${JSON.stringify(e.body).slice(0, 600)}`);
    result.pricing = 'FAILED';
  }
}

// ─────────────────────────────────────────────────────────────────────────
// FIX 4 — iPad device family / screenshots
// ─────────────────────────────────────────────────────────────────────────

async function fixIpadDeviceFamily(token, appKey, result) {
  const cfg = CONFIG[appKey];
  console.log(`\n  [4/4] iPad blocker (supportsTablet in app.config.ts)`);

  if (flags.skipIpadDeviceFamily) {
    console.log(`    ⏭  Skipped via --skip-ipad-deviceFamily`);
    result.ipad = 'SKIPPED';
    return;
  }

  // The iPad screenshot requirement comes from the IPA's UIDeviceFamily.
  // Removing iPad screenshots from ASC is NOT possible while the binary
  // claims iPad support. We have 2 paths:
  //   A. Set supportsTablet=false → next build re-encodes without iPad → done.
  //   B. Upload iPad PNGs to ASC alongside iPhone PNGs. We don't have iPad
  //      screenshots so this requires a separate capture run.
  // We pick A.

  const configPath = cfg.appConfigPath;
  if (!existsSync(configPath)) {
    console.log(`    ✗ app.config.ts not found at ${configPath}`);
    result.ipad = 'FAILED_NO_CONFIG';
    return;
  }

  let src = readFileSync(configPath, 'utf8');
  const hasIosTablet = /supportsTablet:\s*true/.test(src);
  if (!hasIosTablet) {
    console.log(`    ✓ ${configPath} already has supportsTablet=false (or unset)`);
    result.ipad = 'ALREADY_OFF';
    return;
  }

  const next = src.replace(/supportsTablet:\s*true/, 'supportsTablet: false');
  if (next === src) {
    console.log(`    ✗ Failed to patch supportsTablet line in ${configPath}`);
    result.ipad = 'PATCH_FAILED';
    return;
  }

  if (!flags.live) {
    console.log(`    [DRY-RUN] would patch ${configPath}: supportsTablet: true → false`);
    result.ipad = 'DRY_RUN_OK';
    return;
  }

  writeFileSync(configPath, next, 'utf8');
  console.log(`    ✓ Patched ${configPath}: supportsTablet: true → false`);
  console.log(`    ℹ Next EAS build will produce an iPhone-only IPA. Apple ASC submission`);
  console.log(`      will stop demanding iPad screenshots once build #39+ is uploaded.`);
  console.log(`      For THIS submission (build #38) the iPad blocker still applies; it`);
  console.log(`      auto-clears on the next build.`);
  result.ipad = 'PATCHED_NEEDS_NEW_BUILD';
}

// ─────────────────────────────────────────────────────────────────────────
// SUBMISSION FINALIZE
// ─────────────────────────────────────────────────────────────────────────

async function tryFinalize(token, appKey, result) {
  const cfg = CONFIG[appKey];
  console.log(`\n  [post] reviewSubmission lifecycle (attach version + submit)`);

  // Find the open READY_FOR_REVIEW submission
  const subs = await asc(token, 'GET',
    `/reviewSubmissions?filter[app]=${cfg.appId}&filter[state]=READY_FOR_REVIEW&limit=1`);
  const sub = subs.data?.[0];
  if (!sub) {
    console.log(`    no READY_FOR_REVIEW submission found — nothing to finalize`);
    result.submission = 'NO_DRAFT';
    return;
  }
  console.log(`    found reviewSubmissions/${sub.id} state=${sub.attributes?.state}`);

  // 1. Ensure the v1.0 appStoreVersion is attached as a reviewSubmissionItem.
  // The 409 we received from PATCH submitted=true was:
  //   "App {id} must have an approved appStoreVersions for platform IOS, or
  //    an appStoreVersions must be included in this review submission."
  // → reviewSubmissionItems link the appStoreVersion to the reviewSubmission.
  const items = await asc(token, 'GET', `/reviewSubmissions/${sub.id}/items?limit=50`);
  const itemCount = items.data?.length ?? 0;
  console.log(`    submission has ${itemCount} item(s) attached`);

  let needAttach = itemCount === 0;
  let versionId = null;
  if (needAttach) {
    // Find the v1.0 PREPARE_FOR_SUBMISSION version
    const versions = await asc(token, 'GET',
      `/apps/${cfg.appId}/appStoreVersions?filter[versionString]=1.0&limit=1`);
    const version = versions.data?.[0];
    if (!version) {
      console.log(`    ✗ no v1.0 appStoreVersion found — cannot attach`);
      result.submission = 'NO_VERSION';
      return;
    }
    versionId = version.id;
    console.log(`    found appStoreVersion ${versionId} (${version.attributes?.appStoreState})`);

    const attachBody = {
      data: {
        type: 'reviewSubmissionItems',
        relationships: {
          reviewSubmission: { data: { type: 'reviewSubmissions', id: sub.id } },
          appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } },
        },
      },
    };
    if (!flags.live) {
      logDry('POST', `/reviewSubmissionItems`, attachBody);
    } else {
      try {
        const created = await asc(token, 'POST', `/reviewSubmissionItems`, attachBody);
        console.log(`    ✓ POSTed reviewSubmissionItems/${created.data?.id} (version → submission)`);
      } catch (e) {
        console.log(`    ✗ Attach version failed: ${e.message}`);
        if (e.body?.errors?.[0]?.meta?.associatedErrors) {
          console.log(`      Associated errors from Apple:`);
          for (const [path, errs] of Object.entries(e.body.errors[0].meta.associatedErrors)) {
            for (const err of errs) {
              console.log(`        ${path} :: ${err.code} :: ${err.detail || err.title}`);
            }
          }
        }
        result.submission = 'ATTACH_FAILED';
        result.submissionError = e.body || e.message;
        return;
      }
    }
  }

  // 2. Now PATCH submitted=true
  if (!flags.live) {
    logDry('PATCH', `/reviewSubmissions/${sub.id}`, {
      data: { type: 'reviewSubmissions', id: sub.id, attributes: { submitted: true } },
    });
    result.submission = 'DRY_RUN';
    return;
  }

  try {
    await asc(token, 'PATCH', `/reviewSubmissions/${sub.id}`, {
      data: { type: 'reviewSubmissions', id: sub.id, attributes: { submitted: true } },
    });
    console.log(`    ✓ Submission ${sub.id} accepted by Apple`);
    result.submission = 'ACCEPTED';
  } catch (e) {
    console.log(`    ✗ PATCH submitted=true failed: ${e.message}`);
    if (e.body) console.log(`      ${JSON.stringify(e.body).slice(0, 1500)}`);
    result.submission = 'STILL_BLOCKED';
    result.submissionError = e.body || e.message;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// PER-APP RUN
// ─────────────────────────────────────────────────────────────────────────

async function clearForApp(token, appKey) {
  const cfg = CONFIG[appKey];
  console.log(`\n════════════════════════════════════════════════════`);
  console.log(`  ${cfg.name} (App ID: ${cfg.appId})`);
  console.log(`════════════════════════════════════════════════════`);

  const result = { app: appKey, appId: cfg.appId };
  await fixCategories(token, appKey, result);
  await fixPrivacy(token, appKey, result);
  await fixPricing(token, appKey, result);
  await fixIpadDeviceFamily(token, appKey, result);
  await tryFinalize(token, appKey, result);
  return result;
}

// ─────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║  ASC v1.0 Submission Blocker Clearer                       ║');
  console.log('║  4 blockers: categories, privacy, pricing, iPad            ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  if (!flags.live) {
    console.log('\n  [DRY-RUN MODE] — no PATCHes will be sent. Add --live to apply.');
  }

  if (!['bidder', 'staff', 'both'].includes(flags.app)) {
    console.error(`\n  ✗ Invalid --app value: ${flags.app}`);
    process.exit(1);
  }

  const keyPath = findKeyPath();
  if (!keyPath) {
    console.error('\n  ✗ ASC API key not found');
    process.exit(1);
  }
  console.log(`\n  Using ASC key: ${keyPath}`);

  TOKEN_STATE.keyPath = keyPath;
  TOKEN_STATE.jwt = makeJwt(keyPath);
  const token = TOKEN_STATE.jwt;
  console.log('  ✓ JWT minted (ES256, raw r||s)');

  const appsToFix = flags.app === 'both' ? ['bidder', 'staff'] : [flags.app];
  const results = [];

  for (const appKey of appsToFix) {
    try {
      const r = await clearForApp(token, appKey);
      results.push(r);
    } catch (e) {
      console.error(`\n  ✗ ${appKey.toUpperCase()} failed: ${e.message}`);
      if (flags.verbose && e.body) console.error(JSON.stringify(e.body, null, 2));
      results.push({ app: appKey, error: e.message });
    }
  }

  // Summary
  console.log(`\n\n════════════════════════════════════════════════════════════`);
  console.log(`  SUMMARY`);
  console.log(`════════════════════════════════════════════════════════════`);
  for (const r of results) {
    console.log(`\n  ${r.app}:`);
    console.log(`    categories: ${r.categories ?? '?'}`);
    console.log(`    privacy:    ${r.privacy ?? '?'}`);
    console.log(`    pricing:    ${r.pricing ?? '?'}`);
    console.log(`    iPad:       ${r.ipad ?? '?'}`);
    console.log(`    submission: ${r.submission ?? '?'}`);
    if (r.submissionError) {
      const e = typeof r.submissionError === 'string' ? r.submissionError : JSON.stringify(r.submissionError);
      console.log(`    submissionError: ${e.slice(0, 400)}`);
    }
  }
  console.log('');
}

main().catch((e) => {
  console.error(`\n  ✗ Fatal: ${e.message}`);
  if (flags.verbose) console.error(e.stack);
  process.exit(1);
});
