#!/usr/bin/env node
// source-guards.mjs
// ----------------------------------------------------------------------------
// Static regression guards. Fast grep-style assertions that block the exact
// bug PATTERNS we've already paid to fix from creeping back in. Runs in CI
// (lint job) and locally: `node scripts/smoke/source-guards.mjs`.
//
// Each guard matches a CODE pattern (object key, quoted column, call shape) —
// NOT bare identifiers — so explanatory prose/comments that *mention* the
// banned thing don't trip it. Add a guard whenever a postmortem fix has a
// "never do X again" rule that's cheap to express as a regex.
// ----------------------------------------------------------------------------

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');

// Directories to scan (app source only — generated types + deps excluded).
const SCAN_DIRS = [
  'apps/operator-web/src',
  'apps/bidder-app/app',
  'apps/bidder-app/components',
  'apps/field-mobile/app',
  'apps/field-mobile/features',
  'apps/field-mobile/components',
  'packages',
];

const SKIP_DIR = new Set(['node_modules', '.next', '.turbo', 'dist', 'build', '.expo']);
// Generated DB types legitimately contain every column name, incl. removed
// legacy ones still present in the DB. Never guard against those.
const SKIP_FILE_SUBSTR = ['database.types.ts'];
const EXTS = new Set(['.ts', '.tsx']);

/**
 * Guards. `pattern` is tested per-line. `allow` (optional) is a regex that, if
 * it matches the same line, exempts it (for the rare legitimate use).
 */
const GUARDS = [
  {
    id: 'no-automatic_tax',
    why: 'automatic_tax is NOT a valid PaymentIntent param — it broke EVERY charge on 2026-06-02 (PR #178). Tax must go through stripe.tax.calculations (task #40), never declared on a PI/Checkout/subscription.',
    // Object-key / property usage, e.g. `automatic_tax: { enabled: true }`.
    pattern: /automatic_tax\s*:/,
  },
  {
    id: 'subscriptions-checkout-needs-planId',
    why: 'POST /api/subscriptions/checkout requires { planId } (mig 0177 per-plan model), not { operatorId }. (PR #204 fix.)',
    pattern: /subscriptions\/checkout['"]\s*,\s*\{\s*operatorId\b/,
  },
  {
    id: 'no-legacy-pro-columns',
    why: 'operators.pro_enabled / pro_monthly_cents / pro_stripe_price_id are the dead legacy Pro-tier columns (PR #203 removed the UI; memberships use operator_pro_plans). Reading them in app code is a regression.',
    // Bare column word (catches select strings AND .eq()). Comment lines are
    // skipped by the scanner, so prose that mentions these columns is exempt.
    pattern: /\b(pro_enabled|pro_monthly_cents|pro_stripe_price_id)\b/,
  },
  {
    id: 'no-policy-shipping_offered',
    why: 'operator_policies.shipping_offered was the duplicate shipping flag (PR #203). Shipping is operators.offers_shipping only. Reading the policy flag in app code re-introduces the drift.',
    // Bare column word (select string / .eq) — comment lines are skipped so
    // prose that mentions operator_policies.shipping_offered is exempt.
    pattern: /\bshipping_offered\b/,
  },
];

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return; // dir may not exist in every checkout
  }
  for (const name of entries) {
    if (SKIP_DIR.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      yield* walk(full);
    } else if (EXTS.has(full.slice(full.lastIndexOf('.')))) {
      if (SKIP_FILE_SUBSTR.some((s) => full.includes(s))) continue;
      yield full;
    }
  }
}

const violations = [];

for (const rel of SCAN_DIRS) {
  const base = join(REPO_ROOT, rel);
  for (const file of walk(base)) {
    let raw;
    try {
      // Normalize CRLF -> LF first. JS regex `.` does NOT match `\r`, so the
      // `//`/`/* */` comment strippers below silently fail on CRLF files
      // (Windows working trees) — normalizing makes them behave identically
      // on Windows and on the Linux CI checkout.
      raw = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    } catch {
      continue;
    }
    const rawLines = raw.split('\n');
    // Blank out /* ... */ blocks (incl. multi-line + JSX {/* ... */}) by
    // replacing their non-newline chars with spaces (preserves line NUMBERS),
    // then strip // line comments. Guards then only ever see CODE, so prose
    // that merely mentions a banned token never trips them.
    const codeLines = raw
      .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''));
    codeLines.forEach((code, i) => {
      for (const g of GUARDS) {
        if (g.pattern.test(code) && !(g.allow && g.allow.test(code))) {
          violations.push({
            guard: g.id,
            why: g.why,
            file: relative(REPO_ROOT, file).split(sep).join('/'),
            line: i + 1,
            text: (rawLines[i] ?? '').trim().slice(0, 160),
          });
        }
      }
    });
  }
}

if (violations.length === 0) {
  console.log(`source-guards: OK (${GUARDS.length} guards, no violations)`);
  process.exit(0);
}

console.error(`source-guards: ${violations.length} violation(s) found:\n`);
const byGuard = new Map();
for (const v of violations) {
  if (!byGuard.has(v.guard)) byGuard.set(v.guard, []);
  byGuard.get(v.guard).push(v);
}
for (const [guard, vs] of byGuard) {
  console.error(`✗ [${guard}] ${vs[0].why}`);
  for (const v of vs) console.error(`    ${v.file}:${v.line}  ${v.text}`);
  console.error('');
}
process.exit(1);
