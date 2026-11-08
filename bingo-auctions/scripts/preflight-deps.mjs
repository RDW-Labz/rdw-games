#!/usr/bin/env node
// preflight-deps.mjs — Dependency compatibility check.
//
// Cross-references the apps' package.json against:
//   1. Expo SDK 54's pinned / recommended version ranges.
//   2. A curated "known-bad on iOS 26 + New Architecture" list derived from
//      the crash history in this project.
//
// Runs on Windows, macOS, Linux — no native deps.
// Exit 0 = clean. Exit 1 = at least one incompatible dependency.
//
// Sources:
//   - https://docs.expo.dev/versions/v54.0.0/ (SDK 54 known versions)
//   - TestFlight crash investigation notes in scripts/.testflight-feedback/
//   - apps/bidder-app/app.config.ts and apps/field-mobile/app.config.ts comments

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// ── Expo SDK 54 pinned versions ────────────────────────────────────────────
// These are the versions Expo SDK 54 was tested with.
// Entries where minVersion > maxVersion mean "any version is fine."
// 'exact' means the version must match exactly (no range).
// 'min' means must be >= this version.
// 'max' means must be < this version.
// 'bannedRange' means these semver ranges are known-bad regardless of Expo.

// NOTE on Expo package versioning: many expo-* packages publish with the Expo
// SDK minor as their npm major. For example, expo-updates for SDK 54 publishes
// as 29.x.y (not 0.29.y), expo-notifications as 0.32.x, expo-camera as 17.x.y.
// All version pins here use the actual npm-published semver, not Expo's doc notation.
const SDK54_PINS = {
  'expo': { min: '54.0.0', max: '55.0.0' },
  'react': { exact: '19.1.0' },
  'react-native': { min: '0.77.0', max: '0.82.0' },
  'expo-router': { min: '6.0.0', max: '7.0.0' },
  'expo-updates': { min: '29.0.0', max: '30.0.0' },        // npm: 29.x for SDK 54
  'expo-notifications': { min: '0.32.0', max: '0.33.0' },  // npm: 0.32.x for SDK 54
  'expo-camera': { min: '17.0.0', max: '18.0.0' },         // npm: 17.x for SDK 54
  'expo-constants': { min: '18.0.0', max: '19.0.0' },      // npm: 18.x for SDK 54
  'react-native-screens': { min: '4.4.0', max: '5.0.0' },
  'react-native-reanimated': { min: '4.0.0', max: '5.0.0' },
  'react-native-gesture-handler': { min: '2.20.0', max: '3.0.0' },
  'react-native-safe-area-context': { min: '5.0.0', max: '6.0.0' },
  '@stripe/stripe-react-native': { min: '0.40.0', max: '0.60.0' },
};

// ── Known-bad on iOS 26 + New Architecture ─────────────────────────────────
// These specific version ranges caused crashes in this project's TestFlight
// history. The notes field explains the failure mode.

const KNOWN_BAD_IOS26 = [
  {
    package: '@sentry/react-native',
    bannedRange: '>=1.0.0',  // entire package is banned until iOS 26 compat confirmed
    notes:
      'Sentry CPPExceptionTerminate handler intercepted RNSScreen crashes on iOS 26 ' +
      'and masked real stack traces across 22 TestFlight crash reports. ' +
      'Remove entirely. See field-mobile/lib/sentry.ts stub.',
  },
  // expo-updates was listed here as banned in field-mobile, citing the
  // 2026-05-20 removal. That decision was REVERSED on 2026-05-25 — see
  // field-mobile/app.config.ts ~L190: the iOS 26 launch crash was
  // react-native-screens 4.16 + Sentry CPPExceptionTerminate masking, not
  // expo-updates. OTA is restored and field-mobile runs the same ~29.0.17 pin
  // as bidder-app. The SDK54_PINS entry above still validates that pin, which
  // is the check worth keeping. Removed 2026-07-29: it had been failing
  // `npm run preflight` on a clean checkout for two months.
  {
    package: 'react-native-worklets-core',
    bannedRange: '<1.5.0',
    notes:
      'Versions < 1.5 of react-native-worklets-core crash with GCPointer corruption ' +
      'on New Architecture (Fabric) when screens are unmounted. Upgrade to >=1.5.0.',
  },
];

// ── Semver helpers (no external deps) ─────────────────────────────────────

function parseVersion(v) {
  // Strip leading ~, ^, >=, <=, >, <, =
  const clean = v.replace(/^[~^>=<]+/, '').trim().split('-')[0]; // strip prerelease
  const parts = clean.split('.').map(Number);
  return { major: parts[0] || 0, minor: parts[1] || 0, patch: parts[2] || 0 };
}

function versionGte(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa.major !== pb.major) return pa.major > pb.major;
  if (pa.minor !== pb.minor) return pa.minor > pb.minor;
  return pa.patch >= pb.patch;
}

function versionLt(a, b) {
  return !versionGte(a, b);
}

function resolvedVersion(declared) {
  // Strip npm range chars to get the declared version for comparison.
  return declared.replace(/^[~^>=<]+/, '').trim();
}

function checkBannedRange(version, range) {
  // Minimal banned-range check: supports '>=X.Y.Z' form.
  if (range.startsWith('>=')) {
    const threshold = range.slice(2);
    return versionGte(resolvedVersion(version), threshold);
  }
  if (range.startsWith('<')) {
    const threshold = range.slice(1);
    return versionLt(resolvedVersion(version), threshold);
  }
  return false;
}

// ── App package.json reader ────────────────────────────────────────────────

const APPS = [
  { name: 'bidder-app', path: resolve(REPO_ROOT, 'apps/bidder-app/package.json') },
  { name: 'field-mobile', path: resolve(REPO_ROOT, 'apps/field-mobile/package.json') },
];

let errorCount = 0;
let warningCount = 0;

function fail(app, pkg, version, message) {
  console.log(`\nERROR  [${app}] ${pkg}@${version}`);
  console.log(`       ${message}`);
  errorCount++;
}

function warn(app, pkg, version, message) {
  console.log(`\nWARN   [${app}] ${pkg}@${version}`);
  console.log(`       ${message}`);
  warningCount++;
}

// ── Main ───────────────────────────────────────────────────────────────────

for (const app of APPS) {
  if (!existsSync(app.path)) {
    console.log(`SKIP: ${app.name} package.json not found at ${app.path}`);
    continue;
  }

  const pkg = JSON.parse(readFileSync(app.path, 'utf8'));
  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

  // Check against SDK 54 pins
  for (const [pkgName, constraint] of Object.entries(SDK54_PINS)) {
    if (!(pkgName in allDeps)) continue;
    const declared = allDeps[pkgName];
    const resolved = resolvedVersion(declared);

    if (constraint.exact && resolved !== constraint.exact) {
      fail(app.name, pkgName, declared,
        `Must be exactly ${constraint.exact} for Expo SDK 54. Found: ${declared}`);
    }
    if (constraint.min && versionLt(resolved, constraint.min)) {
      fail(app.name, pkgName, declared,
        `Must be >= ${constraint.min} for Expo SDK 54. Found: ${declared}`);
    }
    if (constraint.max && versionGte(resolved, constraint.max)) {
      fail(app.name, pkgName, declared,
        `Must be < ${constraint.max} for Expo SDK 54 (breaking change). Found: ${declared}`);
    }
  }

  // Check known-bad iOS 26 list
  for (const entry of KNOWN_BAD_IOS26) {
    // If affectedApps is specified, only check those apps
    if (entry.affectedApps && !entry.affectedApps.includes(app.name)) continue;

    if (!(entry.package in allDeps)) continue;
    const declared = allDeps[entry.package];

    if (checkBannedRange(declared, entry.bannedRange)) {
      fail(app.name, entry.package, declared,
        `Known-bad on iOS 26 + New Architecture (${entry.bannedRange}). ${entry.notes}`);
    }
  }

  // (Removed 2026-07-29) A cross-check here failed the build whenever
  // field-mobile declared expo-updates, on the strength of the 2026-05-20
  // removal. app.config.ts records that OTA was restored on 2026-05-25, so the
  // check contradicted the shipping config. See the KNOWN_BAD_IOS26 note above.

  // Check for missing newArchEnabled — both apps must have it.
  // We check app.config.ts for this rather than package.json.
  const configPath = resolve(REPO_ROOT, 'apps', app.name, 'app.config.ts');
  if (existsSync(configPath)) {
    const configContent = readFileSync(configPath, 'utf8');
    if (!configContent.includes('newArchEnabled: true')) {
      warn(app.name, 'app.config.ts', 'n/a',
        'newArchEnabled: true not found in app.config.ts. Both apps require New Architecture ' +
        'for RN 0.81 / Expo SDK 54 compatibility. Add newArchEnabled: true to the config.');
    }
  }
}

// ── Root workspace check ───────────────────────────────────────────────────

const rootPkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'));
const nodeVersion = rootPkg.engines?.node;
if (nodeVersion) {
  // Ensure the running node version satisfies the engines field
  const running = process.version.slice(1); // strip leading 'v'
  const minNode = nodeVersion.replace('>=', '').trim().split('.')[0];
  if (Number(running.split('.')[0]) < Number(minNode)) {
    fail('root', 'node', running,
      `engines.node requires >= ${nodeVersion}. Running ${process.version}. ` +
      'Upgrade Node.js before building.');
  }
}

// ── Results ────────────────────────────────────────────────────────────────

console.log(`\n── preflight-deps results ──`);
console.log(`   Errors:   ${errorCount}`);
console.log(`   Warnings: ${warningCount}`);

if (errorCount > 0) {
  console.log(`\nFAIL: ${errorCount} incompatible dependency/config error(s). Fix before EAS Build.`);
  process.exit(1);
} else if (warningCount > 0) {
  console.log(`\nPASS with ${warningCount} warning(s). Review before shipping.`);
} else {
  console.log(`\nPASS: all dependency versions compatible with Expo SDK 54 + iOS 26.`);
}
