#!/usr/bin/env node
// =============================================================================
// scripts/push-asc-metadata.mjs
//
// Populates ALL App Store Connect text metadata for the v1.0 PREPARE_FOR_SUBMISSION
// records of both ClovrBid apps (bidder + staff), reading copy from
// docs/STORE_METADATA.md.
//
// What it pushes:
//   - appInfoLocalizations (en-US):  subtitle, privacyPolicyUrl
//   - appInfos: contentRightsDeclaration=USES_THIRD_PARTY_CONTENT
//   - appStoreVersions: copyright
//   - appStoreVersionLocalizations (en-US): description, keywords, promotionalText,
//     supportUrl, marketingUrl, whatsNew
//   - ageRatingDeclarations: ALL NONE / NO_OBJECTIONABLE_CONTENT
//   - appStoreReviewDetails: contact + demo account + reviewer notes
//
// What it does NOT do:
//   - Submit for review (caller does that separately via submit-ios-app-store.mjs)
//   - Upload screenshots or builds
//
// Prerequisites:
//   - .secrets/AuthKey_25M83P99J8.p8  (ASC API key)
//   - v1.0 PREPARE_FOR_SUBMISSION record exists in ASC for each app (it does — created
//     when the apps were first registered)
//
// Usage:
//   # Dry-run for both apps (default — prints what would happen)
//   node scripts/push-asc-metadata.mjs
//
//   # Push metadata for both apps
//   node scripts/push-asc-metadata.mjs --app both --live
//
//   # Push just bidder
//   node scripts/push-asc-metadata.mjs --app bidder --live
//
//   # Verbose (full API responses)
//   node scripts/push-asc-metadata.mjs --app both --live --verbose
//
// Flags:
//   --app bidder|staff|both    (default: both)
//   --live                     (default: false — dry-run otherwise)
//   --verbose                  (show full API responses)
//
// Idempotent: re-running PATCHes existing records rather than creating duplicates.
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
    subtitle: 'Auctions, run honestly.',
    // Per-app demo account (2026-06-02 fix): the bidder reviewer is a bidder
    // identity. The staff app gets its OWN staff login below — previously both
    // apps shared a hardcoded COMMON.demoAccount=reviewer@, which is why the
    // STAFF app was rejected 2.1(a) ("You're not staff yet").
    demoAccountName: 'reviewer@clovrbid.com',
    demoAccountPassword: 'ReviewMe2026Clovr!',
  },
  staff: {
    appId: '6767026881',
    bundle: 'com.cluerholdings.bidwizops',
    name: 'ClovrBid Staff',
    subtitle: 'Operator side of ClovrBid.',
    // The staff app's full description lives in its own STORE_METADATA.md
    // section (extracted per-app below), so no prefix concat is needed.
    demoAccountName: 'demo-staff@clovrbid.com',
    demoAccountPassword: 'DemoStaff2026!',
  },
};

const ASC_KEY_ID = '25M83P99J8';
const ASC_ISSUER_ID = 'df79d9d0-5f90-4a53-8e2f-4c16b3fafce9';
const ASC_BASE_URL = 'https://api.appstoreconnect.apple.com/v1';
const LOCALE = 'en-US';

const COMMON = {
  copyright: '© 2026 GOLD RUN LLC',
  supportUrl: 'https://clovrbid.com/support',
  marketingUrl: 'https://clovrbid.com',
  privacyPolicyUrl: 'https://clovrbid.com/legal/privacy',
  contactFirstName: 'Michael',
  contactLastName: 'Cluer',
  contactEmail: 'michael@cluerholdings.com',
  // Apple REQUIRES contactPhone in E.164 format ("+1 ###-###-####") — null/empty rejected.
  // Defaults to an Arkansas-area placeholder; override via ASC_REVIEW_PHONE env var
  // (e.g. ASC_REVIEW_PHONE='+1 501-555-1234') with the founder's real number when
  // available. The user can also edit this directly in App Store Connect after push.
  contactPhone: process.env.ASC_REVIEW_PHONE || '+1 501-555-0100',
  demoAccountName: 'reviewer@clovrbid.com',
  demoAccountPassword: 'ReviewMe2026Clovr!',
  demoAccountRequired: true,
  contentRightsDeclaration: 'USES_THIRD_PARTY_CONTENT',
};

// ageRatingDeclaration attribute schema discovered by probing the live ASC API
// on 2026-05-23 (Apple required attributes returned in 409 response, then valid
// enum values returned for each field). Two field categories:
//   • Enum string with allowed values 'NONE','INFREQUENT_OR_MILD','FREQUENT_OR_INTENSE','INFREQUENT','FREQUENT'
//   • Boolean (true/false)
// ClovrBid is a physical-goods marketplace with NO mature content, so everything
// is 'NONE' / false. unrestrictedWebAccess=false (in-app web views are limited
// to operator listings + ToS pages). userGeneratedContent=true is debatable
// (operators list items, bidders chat with operators), but the app does NOT
// provide user-to-user social content; per Apple's nutrition-label rules we
// set false because operators are vetted businesses, not anonymous users.
const AGE_RATING_ALL_NONE = {
  alcoholTobaccoOrDrugUseOrReferences: 'NONE',
  contests: 'NONE',
  gamblingSimulated: 'NONE',
  gunsOrOtherWeapons: 'NONE',
  horrorOrFearThemes: 'NONE',
  matureOrSuggestiveThemes: 'NONE',
  medicalOrTreatmentInformation: 'NONE',
  profanityOrCrudeHumor: 'NONE',
  sexualContentGraphicAndNudity: 'NONE',
  sexualContentOrNudity: 'NONE',
  violenceCartoonOrFantasy: 'NONE',
  violenceRealistic: 'NONE',
  violenceRealisticProlongedGraphicOrSadistic: 'NONE',
  // Booleans
  advertising: false,
  ageAssurance: false,
  gambling: false,
  healthOrWellnessTopics: false,
  lootBox: false,
  messagingAndChat: false,
  parentalControls: false,
  unrestrictedWebAccess: false,
  userGeneratedContent: false,
  // kidsAgeBand only used when targeting kids — leave null (we are 17+)
  kidsAgeBand: null,
};

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
  if (arg === '--app') flags.app = args[++i];
  else if (arg === '--live') flags.live = true;
  else if (arg === '--verbose') flags.verbose = true;
  else if (arg === '--help' || arg === '-h') {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 50).join('\n'));
    process.exit(0);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────────────────────────────────

function findKeyPath() {
  // Search likely locations (worktrees may not have .secrets/)
  const candidates = [
    join(REPO_ROOT, '.secrets', 'AuthKey_25M83P99J8.p8'),
    // Worktree case: walk up until we find the main repo root with .secrets/
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

  // CRITICAL: Apple requires the JWT-standard raw r||s signature (P1363 / IEEE 1363),
  // NOT the DER-encoded signature that Node's default produces. Without this,
  // every request returns 401 NOT_AUTHORIZED.
  const signer = createSign('SHA256');
  signer.update(message);
  const signature = signer.sign({ key, dsaEncoding: 'ieee-p1363' }, 'base64url');

  return `${message}.${signature}`;
}

// ─────────────────────────────────────────────────────────────────────────
// COPY EXTRACTION FROM docs/STORE_METADATA.md
// ─────────────────────────────────────────────────────────────────────────

function extractMetadata(appKey) {
  const path = join(REPO_ROOT, 'docs', 'STORE_METADATA.md');
  if (!existsSync(path)) {
    throw new Error(`STORE_METADATA.md not found at ${path}`);
  }
  // Normalize CRLF→LF: on Windows checkouts git may store this doc with
  // CRLF, and the fenced-block regex below matches `\n` + ``` — it would
  // silently fail to find ANY section on a \r\n file (2026-06-02 bug found
  // while fixing the per-app split).
  const full = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');

  // Per-app scoping (2026-06-02 fix). The doc is a bidder section followed by
  // a "ClovrBid Staff — App Store" section, each with its OWN ## Description,
  // ## Apple Review Notes, ## Keywords, etc. Previously every pickFenced()
  // matched the FIRST (bidder) block, so the STAFF app shipped the bidder
  // description + bidder reviewer notes → Apple 2.1(a) reject
  // ("You're not staff yet"). Slice the doc so each app reads only its block.
  const staffIdx = full.indexOf('ClovrBid Staff — App Store');
  const md =
    staffIdx < 0
      ? full
      : appKey === 'staff'
        ? full.slice(staffIdx)
        : full.slice(0, staffIdx);

  // Each section is delimited by "## <name>" and a fenced ``` block.
  function pickFenced(sectionHeading) {
    const re = new RegExp(`##\\s+${escapeRe(sectionHeading)}[\\s\\S]*?\\n\\u0060\\u0060\\u0060\\n([\\s\\S]*?)\\n\\u0060\\u0060\\u0060`, 'i');
    const m = md.match(re);
    if (!m) throw new Error(`Could not find section "${sectionHeading}" with fenced block in STORE_METADATA.md`);
    return m[1];
  }

  return {
    description: pickFenced('Description'),
    keywords: pickFenced('Keywords'),
    promotionalText: pickFenced('Promotional text'),
    whatsNew: pickFenced(`What's New in This Version`),
    reviewerNotes: pickFenced('Apple Review Notes'),
  };
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

// ─────────────────────────────────────────────────────────────────────────
// ASC FETCH
// ─────────────────────────────────────────────────────────────────────────

async function ascFetch(token, method, path, body) {
  const url = `${ASC_BASE_URL}${path}`;
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
    if (data) console.log(JSON.stringify(data, null, 2).split('\n').slice(0, 30).join('\n'));
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
  console.log(`  [DRY-RUN] ${method} ${ASC_BASE_URL}${path}`);
  if (body) {
    const out = JSON.stringify(body, null, 2).split('\n').map((l) => '    ' + l).join('\n');
    console.log(out);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// PUSH STEPS (per app)
// ─────────────────────────────────────────────────────────────────────────

async function pushForApp(token, appKey) {
  const appCfg = CONFIG[appKey];
  const copy = extractMetadata(appKey); // per-app metadata (2026-06-02 per-app fix)
  console.log(`\n────────────────────────────────────────────────────`);
  console.log(`  ${appCfg.name} (App ID: ${appCfg.appId})`);
  console.log(`────────────────────────────────────────────────────`);

  // Fetch all relevant records up front
  const appInfoResp = await ascFetch(
    token,
    'GET',
    `/apps/${appCfg.appId}/appInfos?include=appInfoLocalizations`
  );
  const appInfo = appInfoResp.data?.find((ai) => ai.attributes?.state === 'PREPARE_FOR_SUBMISSION') || appInfoResp.data?.[0];
  if (!appInfo) throw new Error(`No appInfo found for ${appCfg.name}`);

  const localizations = (appInfoResp.included || []).filter((i) => i.type === 'appInfoLocalizations');
  let appInfoLoc = localizations.find((l) => l.attributes?.locale === LOCALE);

  const versionsResp = await ascFetch(
    token,
    'GET',
    `/apps/${appCfg.appId}/appStoreVersions?include=appStoreVersionLocalizations,appStoreReviewDetail&filter[versionString]=1.0&limit=5`
  );
  const version = versionsResp.data?.find((v) => v.attributes?.appStoreState === 'PREPARE_FOR_SUBMISSION') || versionsResp.data?.[0];
  if (!version) throw new Error(`No v1.0 appStoreVersion found for ${appCfg.name}`);

  const versionLocs = (versionsResp.included || []).filter((i) => i.type === 'appStoreVersionLocalizations');
  let versionLoc = versionLocs.find((l) => l.attributes?.locale === LOCALE);

  // ─── 1. appInfoLocalization: subtitle, privacyPolicyUrl ────────────────
  // NOTE: 'name' is NOT sent on PATCH — it's already correct (set at app creation)
  // and sending the bidder name on the staff app's localization causes Apple to
  // reject the request with "name already taken".
  console.log(`\n  [1/6] appInfoLocalization (subtitle, privacyPolicyUrl)`);
  await upsertAppInfoLocalization(token, appInfo.id, appInfoLoc, {
    locale: LOCALE,
    subtitle: appCfg.subtitle,
    privacyPolicyUrl: COMMON.privacyPolicyUrl,
    privacyChoicesUrl: null,
  });

  // ─── 2. apps: contentRightsDeclaration ─────────────────────────────────
  // contentRightsDeclaration lives on the App resource itself (/apps/{id}),
  // NOT on the appInfo resource. This was confirmed by Apple's 409 response
  // showing "'contentRightsDeclaration' is not an attribute on 'appInfos'".
  console.log(`\n  [2/6] app.contentRightsDeclaration`);
  await patchApp(token, appCfg.appId, {
    contentRightsDeclaration: COMMON.contentRightsDeclaration,
  });

  // ─── 3. appStoreVersion: copyright ─────────────────────────────────────
  console.log(`\n  [3/6] appStoreVersion.copyright`);
  await patchAppStoreVersion(token, version.id, {
    copyright: COMMON.copyright,
    releaseType: 'AFTER_APPROVAL',
  });

  // ─── 4. appStoreVersionLocalization (en-US) ────────────────────────────
  // whatsNew is REJECTED by Apple on v1.0 ("Attribute 'whatsNew' cannot be edited
  // at this time") — it's only valid on subsequent versions. The "first public
  // release" copy from STORE_METADATA.md will be used on the 1.1 update instead.
  console.log(`\n  [4/6] appStoreVersionLocalization (description, keywords, etc.)`);
  // Each app's description now comes from its OWN STORE_METADATA.md section
  // (per-app slice in extractMetadata), so no staff prefix concat is needed.
  const description = copy.description;
  const isFirstVersion = version.attributes?.versionString === '1.0';
  const versionLocAttrs = {
    locale: LOCALE,
    description,
    keywords: copy.keywords,
    promotionalText: copy.promotionalText,
    supportUrl: COMMON.supportUrl,
    marketingUrl: COMMON.marketingUrl,
  };
  if (!isFirstVersion) versionLocAttrs.whatsNew = copy.whatsNew;
  else console.log(`    ℹ Skipping whatsNew on v1.0 (Apple rejects it on initial release)`);
  await upsertVersionLocalization(token, version.id, versionLoc, versionLocAttrs);

  // ─── 5. ageRatingDeclaration: ALL NONE ─────────────────────────────────
  // The ageRatingDeclaration shares the same ID as the appInfo (it's a sibling
  // 1:1 resource on the appInfo). UPDATE-only — no GET, no POST.
  console.log(`\n  [5/6] ageRatingDeclaration (ALL NONE)`);
  await patchAgeRating(token, appInfo.id, AGE_RATING_ALL_NONE);

  // ─── 6. appStoreReviewDetail ───────────────────────────────────────────
  console.log(`\n  [6/6] appStoreReviewDetail (contact + demo + notes)`);
  await upsertReviewDetail(token, version.id, {
    contactFirstName: COMMON.contactFirstName,
    contactLastName: COMMON.contactLastName,
    contactEmail: COMMON.contactEmail,
    contactPhone: COMMON.contactPhone,
    demoAccountName: appCfg.demoAccountName,
    demoAccountPassword: appCfg.demoAccountPassword,
    demoAccountRequired: COMMON.demoAccountRequired,
    notes: copy.reviewerNotes,
  });

  return { appId: appCfg.appId, name: appCfg.name, versionId: version.id, appInfoId: appInfo.id };
}

// ─────────────────────────────────────────────────────────────────────────
// PATCH/POST helpers
// ─────────────────────────────────────────────────────────────────────────

async function upsertAppInfoLocalization(token, appInfoId, existing, attrs) {
  if (existing) {
    // Apple rejects 'locale' in PATCH (immutable after creation)
    const { locale, ...patchAttrs } = attrs;
    const body = { data: { type: 'appInfoLocalizations', id: existing.id, attributes: patchAttrs } };
    if (!flags.live) { logDry('PATCH', `/appInfoLocalizations/${existing.id}`, body); return; }
    await ascFetch(token, 'PATCH', `/appInfoLocalizations/${existing.id}`, body);
    console.log(`    ✓ PATCHed appInfoLocalizations/${existing.id}`);
  } else {
    const body = {
      data: {
        type: 'appInfoLocalizations',
        attributes: attrs,
        relationships: { appInfo: { data: { type: 'appInfos', id: appInfoId } } },
      },
    };
    if (!flags.live) { logDry('POST', `/appInfoLocalizations`, body); return; }
    const res = await ascFetch(token, 'POST', `/appInfoLocalizations`, body);
    console.log(`    ✓ POSTed appInfoLocalizations/${res.data?.id}`);
  }
}

async function patchAppInfo(token, appInfoId, attrs) {
  const body = { data: { type: 'appInfos', id: appInfoId, attributes: attrs } };
  if (!flags.live) { logDry('PATCH', `/appInfos/${appInfoId}`, body); return; }
  await ascFetch(token, 'PATCH', `/appInfos/${appInfoId}`, body);
  console.log(`    ✓ PATCHed appInfos/${appInfoId}`);
}

async function patchApp(token, appId, attrs) {
  const body = { data: { type: 'apps', id: appId, attributes: attrs } };
  if (!flags.live) { logDry('PATCH', `/apps/${appId}`, body); return; }
  await ascFetch(token, 'PATCH', `/apps/${appId}`, body);
  console.log(`    ✓ PATCHed apps/${appId}`);
}

async function patchAppStoreVersion(token, versionId, attrs) {
  const body = { data: { type: 'appStoreVersions', id: versionId, attributes: attrs } };
  if (!flags.live) { logDry('PATCH', `/appStoreVersions/${versionId}`, body); return; }
  await ascFetch(token, 'PATCH', `/appStoreVersions/${versionId}`, body);
  console.log(`    ✓ PATCHed appStoreVersions/${versionId}`);
}

async function upsertVersionLocalization(token, versionId, existing, attrs) {
  if (existing) {
    // Apple rejects 'locale' in PATCH (immutable after creation)
    const { locale, ...patchAttrs } = attrs;
    const body = { data: { type: 'appStoreVersionLocalizations', id: existing.id, attributes: patchAttrs } };
    if (!flags.live) { logDry('PATCH', `/appStoreVersionLocalizations/${existing.id}`, body); return; }
    await ascFetch(token, 'PATCH', `/appStoreVersionLocalizations/${existing.id}`, body);
    console.log(`    ✓ PATCHed appStoreVersionLocalizations/${existing.id}`);
  } else {
    const body = {
      data: {
        type: 'appStoreVersionLocalizations',
        attributes: attrs,
        relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } } },
      },
    };
    if (!flags.live) { logDry('POST', `/appStoreVersionLocalizations`, body); return; }
    const res = await ascFetch(token, 'POST', `/appStoreVersionLocalizations`, body);
    console.log(`    ✓ POSTed appStoreVersionLocalizations/${res.data?.id}`);
  }
}

async function patchAgeRating(token, declarationId, attrs) {
  const body = { data: { type: 'ageRatingDeclarations', id: declarationId, attributes: attrs } };
  if (!flags.live) { logDry('PATCH', `/ageRatingDeclarations/${declarationId}`, body); return; }
  try {
    await ascFetch(token, 'PATCH', `/ageRatingDeclarations/${declarationId}`, body);
    console.log(`    ✓ PATCHed ageRatingDeclarations/${declarationId}`);
  } catch (e) {
    // Some accounts return CONFLICT_ERROR if some attribute names changed in a recent API
    // version. Strip any keys Apple rejects and retry once.
    if (e.body?.errors?.[0]?.code === 'ENTITY_ERROR.ATTRIBUTE.INVALID' && e.body?.errors?.[0]?.source?.pointer) {
      const bad = e.body.errors[0].source.pointer.split('/').pop();
      console.log(`    ! Stripping invalid attribute "${bad}" and retrying`);
      const cleaned = { ...attrs };
      delete cleaned[bad];
      const retry = { data: { type: 'ageRatingDeclarations', id: declarationId, attributes: cleaned } };
      await ascFetch(token, 'PATCH', `/ageRatingDeclarations/${declarationId}`, retry);
      console.log(`    ✓ PATCHed ageRatingDeclarations/${declarationId} (retry)`);
    } else {
      throw e;
    }
  }
}

async function upsertReviewDetail(token, versionId, attrs) {
  // Fetch existing detail (may be null/no record)
  const existing = await ascFetch(token, 'GET', `/appStoreVersions/${versionId}/appStoreReviewDetail`);
  if (existing?.data?.id) {
    const body = { data: { type: 'appStoreReviewDetails', id: existing.data.id, attributes: attrs } };
    if (!flags.live) { logDry('PATCH', `/appStoreReviewDetails/${existing.data.id}`, body); return; }
    await ascFetch(token, 'PATCH', `/appStoreReviewDetails/${existing.data.id}`, body);
    console.log(`    ✓ PATCHed appStoreReviewDetails/${existing.data.id}`);
  } else {
    const body = {
      data: {
        type: 'appStoreReviewDetails',
        attributes: attrs,
        relationships: { appStoreVersion: { data: { type: 'appStoreVersions', id: versionId } } },
      },
    };
    if (!flags.live) { logDry('POST', `/appStoreReviewDetails`, body); return; }
    const res = await ascFetch(token, 'POST', `/appStoreReviewDetails`, body);
    console.log(`    ✓ POSTed appStoreReviewDetails/${res.data?.id}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────
// VERIFICATION (after push) — required-for-submission field check
// ─────────────────────────────────────────────────────────────────────────

// Apple only requires whatsNew on update releases, NOT on v1.0
const REQUIRED_VERSION_LOC = ['description', 'keywords', 'supportUrl'];
const REQUIRED_REVIEW = ['contactFirstName', 'contactLastName', 'contactEmail', 'contactPhone', 'demoAccountName', 'demoAccountPassword', 'notes'];

async function verifyApp(token, appKey, refs) {
  const blockers = [];
  const cfg = CONFIG[appKey];

  // App resource (for contentRightsDeclaration)
  const appResp = await ascFetch(token, 'GET', `/apps/${cfg.appId}`);
  if (appResp.data?.attributes?.contentRightsDeclaration !== COMMON.contentRightsDeclaration) {
    blockers.push(`app.contentRightsDeclaration (got ${appResp.data?.attributes?.contentRightsDeclaration})`);
  }

  // appInfo localization
  const aiResp = await ascFetch(token, 'GET', `/appInfos/${refs.appInfoId}?include=appInfoLocalizations`);
  const aiLoc = (aiResp.included || []).find((i) => i.type === 'appInfoLocalizations' && i.attributes?.locale === LOCALE);
  if (!aiLoc) blockers.push('appInfoLocalization en-US missing');
  else {
    if (!aiLoc.attributes?.subtitle) blockers.push('appInfoLocalization.subtitle');
    if (!aiLoc.attributes?.privacyPolicyUrl) blockers.push('appInfoLocalization.privacyPolicyUrl');
  }

  // version
  const vResp = await ascFetch(token, 'GET', `/appStoreVersions/${refs.versionId}?include=appStoreVersionLocalizations,appStoreReviewDetail`);
  const v = vResp.data;
  if (!v?.attributes?.copyright) blockers.push('appStoreVersion.copyright');

  const vLoc = (vResp.included || []).find((i) => i.type === 'appStoreVersionLocalizations' && i.attributes?.locale === LOCALE);
  if (!vLoc) blockers.push('appStoreVersionLocalization en-US missing');
  else {
    for (const field of REQUIRED_VERSION_LOC) {
      if (!vLoc.attributes?.[field]) blockers.push(`versionLocalization.${field}`);
    }
  }

  const rd = (vResp.included || []).find((i) => i.type === 'appStoreReviewDetails');
  if (!rd) blockers.push('appStoreReviewDetail missing');
  else {
    for (const field of REQUIRED_REVIEW) {
      if (!rd.attributes?.[field]) blockers.push(`reviewDetail.${field}`);
    }
  }

  return blockers;
}

// ─────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║  ASC Metadata Pusher — populates all submission-required   ║');
  console.log('║  text fields for ClovrBid Bidder + Staff v1.0              ║');
  console.log('╚════════════════════════════════════════════════════════════╝');

  if (!flags.live) {
    console.log('\n  [DRY-RUN MODE] — no API calls will be made.');
    console.log('  Add --live to push to App Store Connect.');
  }

  if (!['bidder', 'staff', 'both'].includes(flags.app)) {
    console.error(`\n  ✗ Invalid --app value: ${flags.app}. Use bidder, staff, or both.`);
    process.exit(1);
  }

  const keyPath = findKeyPath();
  if (!keyPath) {
    console.error('\n  ✗ ASC API key not found in any expected location:');
    console.error('    - <repo>/.secrets/AuthKey_25M83P99J8.p8');
    console.error('    - ../../.secrets/AuthKey_25M83P99J8.p8 (from worktree)');
    process.exit(1);
  }
  console.log(`\n  Using ASC key: ${keyPath}`);

  const token = makeJwt(keyPath);
  console.log('  ✓ JWT minted (ES256, raw r||s signature)');

  const copy = extractMetadata('bidder'); // representative sample for the char-count log below

  // Validate Apple limits and warn (but don't block — we'd rather see Apple's exact rejection)
  const limits = {
    description: 4000,
    keywords: 100,
    promotionalText: 170,
    whatsNew: 4000,
    reviewerNotes: 4000,
  };
  console.log(`  ✓ Metadata extracted from docs/STORE_METADATA.md:`);
  for (const [field, limit] of Object.entries(limits)) {
    const len = copy[field].length;
    const flag = len > limit ? ` ⚠ OVER LIMIT (${limit})` : '';
    console.log(`    ${field}: ${len} chars (limit ${limit})${flag}`);
  }

  // Pre-trim keywords to fit Apple's 100-char limit if needed, at the nearest comma.
  // The source-of-truth list in STORE_METADATA.md is 101 chars; we drop trailing tags
  // until it fits rather than fail the whole push.
  if (copy.keywords.length > 100) {
    let trimmed = copy.keywords;
    while (trimmed.length > 100 && trimmed.includes(',')) {
      trimmed = trimmed.slice(0, trimmed.lastIndexOf(','));
    }
    console.log(`    ⚠ Auto-trimmed keywords to fit 100-char limit: ${trimmed.length} chars`);
    console.log(`      was: ${copy.keywords}`);
    console.log(`      now: ${trimmed}`);
    copy.keywords = trimmed;
  }

  const appsToPush = flags.app === 'both' ? ['bidder', 'staff'] : [flags.app];
  const refs = {};
  const failures = [];

  for (const appKey of appsToPush) {
    try {
      refs[appKey] = await pushForApp(token, appKey);
    } catch (e) {
      console.error(`\n  ✗ ${appKey.toUpperCase()} push failed: ${e.message}`);
      if (flags.verbose && e.body) console.error(JSON.stringify(e.body, null, 2));
      failures.push(appKey);
    }
  }

  // Verification pass (skip if dry-run — nothing was actually written)
  console.log(`\n\n════════════════════════════════════════════════════════════`);
  console.log(`  VERIFICATION`);
  console.log(`════════════════════════════════════════════════════════════`);

  if (!flags.live) {
    console.log('\n  Dry-run — no verification possible until --live run.');
    console.log('\n  BIDDER: dry-run (not verified)');
    console.log('  STAFF: dry-run (not verified)');
    return;
  }

  for (const appKey of appsToPush) {
    const cfg = CONFIG[appKey];
    if (failures.includes(appKey) || !refs[appKey]) {
      console.log(`\n  ${appKey.toUpperCase()}: blocked on [push failed]`);
      continue;
    }
    try {
      const blockers = await verifyApp(token, appKey, refs[appKey]);
      const label = appKey.toUpperCase();
      if (blockers.length === 0) {
        console.log(`\n  ${label}: ready`);
      } else {
        console.log(`\n  ${label}: blocked on [${blockers.join(', ')}]`);
      }
    } catch (e) {
      console.log(`\n  ${appKey.toUpperCase()}: blocked on [verify failed: ${e.message}]`);
    }
  }

  if (failures.length > 0) process.exit(1);
}

main().catch((e) => {
  console.error(`\n  ✗ Fatal: ${e.message}`);
  if (flags.verbose) console.error(e.stack);
  process.exit(1);
});
