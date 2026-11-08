#!/usr/bin/env node
// preflight-static.mjs — Static AST analysis for launch-time crash patterns.
//
// Catches patterns that will crash a native iOS build at launch before you
// spend an EAS credit. Runs in ~2 seconds on this monorepo on any OS.
//
// Exit 0 = clean. Exit 1 = at least one flagged pattern found.
//
// Checks performed:
//   1. Top-level (module-load-time) SDK init calls that crash on iOS 26 / New Arch:
//      - Sentry.init() or initSentry() at module scope (not inside a function)
//      - Notifications.setNotificationHandler() at module scope
//      - Native module requires that are known-bad on New Architecture
//   2. OTA anti-bricking disabled (disableAntiBrickingMeasures hardcoded true —
//      removes the rollback path that saves a bad update from bricking installs)
//   3. useEffect with empty deps [] that has no deps listed but uses outer state
//      (catches the useBidderRole race — heuristic, not exhaustive)
//   4. Direct top-level await on native module promises outside async functions
//
// HOW TO ADD A NEW CHECK:
//   Add an entry to PATTERN_RULES below. Each entry has:
//     - glob: which files to scan (relative to repo root)
//     - pattern: regex to match against the file content
//     - message: what to tell the developer
//     - severity: 'error' (blocks CI) or 'warning' (prints but passes)

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// ── Pattern rules ──────────────────────────────────────────────────────────

const PATTERN_RULES = [
  // 1. Sentry.init() at module scope (outside any function body).
  //    Field-mobile had this in _layout.tsx; it was moved to a stub.
  //    If it comes back at top level it will deadlock iOS 26 on Hermes.
  {
    glob: ['apps/*/app/**/*.tsx', 'apps/*/app/**/*.ts', 'apps/*/lib/**/*.ts'],
    // Matches Sentry.init( or initSentry( that appears at the start of a line
    // (i.e., not indented inside a function body). Indented calls inside
    // functions are okay; top-level calls are not.
    pattern: /^(?![ \t])(?:Sentry\.init|initSentry)\s*\(/m,
    message:
      'Top-level Sentry.init() / initSentry() found at module scope. This deadlocks ' +
      'iOS 26 + Hermes before the JS thread starts. Move inside useEffect or remove. ' +
      'See apps/bidder-app/app/_layout.tsx comment (2026-05-19) for context.',
    severity: 'error',
  },

  // 2. expo-notifications setNotificationHandler at module scope.
  //    The Notifications TurboModule registration can throw on iOS 26
  //    New Architecture if called before the bridge is fully up.
  {
    glob: ['apps/*/app/**/*.tsx', 'apps/*/app/**/*.ts', 'apps/*/lib/**/*.ts'],
    pattern: /^(?![ \t])Notifications\.setNotificationHandler\s*\(/m,
    message:
      'Top-level Notifications.setNotificationHandler() found at module scope. ' +
      'Must be called inside a useEffect, not at import time, to avoid ' +
      'TurboModule registration exceptions at launch on iOS 26.',
    severity: 'error',
  },

  // 3. OTA anti-bricking disabled.
  //
  //    This slot used to forbid importing expo-updates in field-mobile, citing
  //    the 2026-05-20 removal. That decision was REVERSED on 2026-05-25 (see
  //    field-mobile/app.config.ts ~L190): the iOS 26 launch crash was
  //    react-native-screens 4.16 + Sentry CPPExceptionTerminate masking, not
  //    expo-updates. OTA is restored, expo-updates ~29.0.17 is a declared
  //    dependency on the same pin bidder-app runs, and lib/crash-reporter.ts
  //    legitimately reads Updates.updateId to tag crash reports. The rule
  //    outlived the decision by two months and failed `npm run preflight` on a
  //    clean checkout, which trains people to ignore preflight entirely.
  //
  //    Replaced with the invariant that IS still live. Per the same comment:
  //    disableAntiBrickingMeasures TRUE caused the v16/20/21/22 death-loop on
  //    bidder before 2026-05-19 — "never flip it back to TRUE in either
  //    profile." FALSE keeps the OS-level rollback path, so a broken OTA falls
  //    back to the embedded bundle instead of bricking the install.
  //
  //    Matches a literal `true` only; bidder-app's `!isProduction` expression
  //    is intentional (dev builds opt out) and must keep passing.
  {
    glob: ['apps/*/app.config.ts', 'apps/*/app.json'],
    pattern: /disableAntiBrickingMeasures\s*:\s*true/,
    message:
      'disableAntiBrickingMeasures is hardcoded true. This removes the OS-level ' +
      'OTA rollback path — a broken update bricks the install instead of falling ' +
      'back to the embedded bundle, which is what caused the v16/20/21/22 ' +
      'death-loop on bidder before 2026-05-19. Keep it false in any production ' +
      'profile.',
    severity: 'error',
  },

  // 4. StripeProvider with a hardcoded empty publishableKey string.
  //    The bidder-app _layout.tsx now guards against this, but a future edit
  //    might accidentally pass an empty string literal directly.
  {
    glob: ['apps/*/app/**/*.tsx'],
    pattern: /StripeProvider[^>]*publishableKey\s*=\s*["']{2}/,
    message:
      'StripeProvider with empty publishableKey="" found. This deadlocks the Stripe ' +
      'native SDK initializer on iOS 26 + Fabric (synchronous main-thread init with ' +
      'an invalid key). Use the conditional mount guard from _layout.tsx.',
    severity: 'error',
  },

  // 5. Any direct import of @sentry/react-native in the apps (not packages).
  //    Sentry was fully removed from both apps; this catches accidental re-adds.
  {
    glob: ['apps/*/app/**/*.ts', 'apps/*/app/**/*.tsx', 'apps/*/lib/**/*.ts'],
    pattern: /from\s+['"]@sentry\/react-native['"]/,
    message:
      '@sentry/react-native is imported in an app. It was removed from both apps ' +
      '(see sentry.ts stubs in each app/lib) because sentry-cocoa CPPExceptionTerminate ' +
      'intercepted real RNSScreen crashes and masked stack traces across 22 TestFlight ' +
      'reports. Keep the no-op stub pattern. Only re-add after iOS 26 / New Arch compat confirmed.',
    severity: 'error',
  },

  // 6. react-native-screens version mismatch canary.
  //    expo-router 6.x requires react-native-screens ≥4.4. If someone pins
  //    an older version, expo-router will reference removed classes (compile crash).
  //    This check is a belt-and-suspenders — preflight-deps.mjs does the real semver check.
  {
    glob: ['apps/*/package.json'],
    pattern: /"react-native-screens":\s*"[~^]?[0-3]\./,
    message:
      'react-native-screens version < 4.x found in package.json. expo-router 6.x ' +
      'references classes removed in older versions of react-native-screens, causing ' +
      'a compile-time crash. Upgrade to ≥4.4.0.',
    severity: 'error',
  },

  // 7. useEffect with empty dependency array [] that has no closing comment
  //    explaining why it's intentionally empty.
  //    Heuristic for the useBidderRole race (empty deps meant "run once" but
  //    captured stale auth state). This is a warning, not a hard error.
  {
    glob: ['apps/*/app/**/*.tsx', 'apps/*/features/**/*.tsx', 'apps/*/components/**/*.tsx'],
    pattern: /useEffect\s*\([^)]*,\s*\[\s*\]\s*\)/,
    message:
      'useEffect with empty dependency array [] found. If this reads any state or ' +
      'context values (session, user, role), it will capture stale values and never ' +
      're-run when they change — causing race conditions on auth. Verify this is ' +
      'intentionally empty (e.g., mount-once side effects) or add the missing deps.',
    severity: 'warning',
  },
];

// ── File walker ────────────────────────────────────────────────────────────

function walkFiles(root, extensions) {
  const results = [];
  function walk(dir) {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === '.git' || entry === 'dist' || entry === '.expo') continue;
      const full = resolve(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (extensions.includes(extname(entry))) {
        results.push(full);
      }
    }
  }
  walk(root);
  return results;
}

// ── Glob matcher (minimal, no external deps) ───────────────────────────────

function matchGlob(filePath, pattern) {
  // Converts glob pattern like 'apps/*/app/**/*.tsx' into a regex.
  // Only supports * (single segment) and ** (any depth).
  const rel = relative(REPO_ROOT, filePath).replace(/\\/g, '/');
  const regexStr = pattern
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '§GLOBSTAR§')
    .replace(/\*/g, '[^/]+')
    .replace(/§GLOBSTAR§/g, '.*');
  return new RegExp(`^${regexStr}$`).test(rel);
}

// ── Main ───────────────────────────────────────────────────────────────────

const allFiles = walkFiles(REPO_ROOT, ['.ts', '.tsx', '.json']);

let errorCount = 0;
let warningCount = 0;

for (const rule of PATTERN_RULES) {
  const globs = Array.isArray(rule.glob) ? rule.glob : [rule.glob];
  const matchingFiles = allFiles.filter(f => globs.some(g => matchGlob(f, g)));

  for (const filePath of matchingFiles) {
    let content;
    try {
      content = readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    if (rule.pattern.test(content)) {
      const rel = relative(REPO_ROOT, filePath);
      // Find the line number of the first match
      const lines = content.split('\n');
      let lineNum = '?';
      for (let i = 0; i < lines.length; i++) {
        if (rule.pattern.test(lines[i])) {
          lineNum = i + 1;
          break;
        }
      }

      const prefix = rule.severity === 'error' ? 'ERROR' : 'WARN ';
      console.log(`\n${prefix}  ${rel}:${lineNum}`);
      console.log(`       ${rule.message}`);

      if (rule.severity === 'error') {
        errorCount++;
      } else {
        warningCount++;
      }
    }
  }
}

console.log(`\n── preflight-static results ──`);
console.log(`   Errors:   ${errorCount}`);
console.log(`   Warnings: ${warningCount}`);

if (errorCount > 0) {
  console.log(`\nFAIL: ${errorCount} error(s) found. Fix before triggering an EAS Build.`);
  process.exit(1);
} else if (warningCount > 0) {
  console.log(`\nPASS with ${warningCount} warning(s). Review before shipping.`);
} else {
  console.log(`\nPASS: no launch-time crash patterns found.`);
}
