#!/usr/bin/env node
// Guard for the mig-0292 class: code enqueues a notifications_outbox row whose
// `kind` is not in the notification_kind enum, so every insert 22P02s at
// runtime while typecheck, lint and the schema-migrations job all stay green.
//
// That shipped once. 0292 added the whole marketing-campaign feature -- tables,
// runner, operator page, a `case 'marketing_campaign'` in the email drain --
// and never added the enum value. Four campaign runs across two days enqueued
// nothing and sent nothing to 410 recipients, while marketing_campaign_runs
// recorded healthy-looking recipient counts because the run row is written
// before the send loop.
//
// Strategy: in every source file that touches notifications_outbox, collect the
// string literals assigned to a `kind:` property, then assert each one is a
// label of the notification_kind enum in the migrated database. Scoping to
// files that mention notifications_outbox keeps unrelated `kind:` properties
// (of which there are many) out of the comparison.
//
// Usage: node scripts/check-notification-kinds.mjs "<postgres connection url>"

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const ROOTS = ['apps/operator-web/src', 'apps/bidder-app', 'apps/field-mobile', 'packages'];
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'build', '.expo', 'coverage']);

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(full);
  }
  return out;
}

// `kind: 'x'` / `kind: "x"`. Also catches `kind: 'x' as const`.
const KIND_RE = /\bkind\s*:\s*['"]([a-z0-9_]+)['"]/g;

const found = new Map(); // kind -> Set(files)
for (const root of ROOTS) {
  for (const file of walk(root)) {
    let src;
    try {
      src = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    // Only files that actually enqueue notifications.
    if (!src.includes('notifications_outbox')) continue;
    for (const m of src.matchAll(KIND_RE)) {
      if (!found.has(m[1])) found.set(m[1], new Set());
      found.get(m[1]).add(file);
    }
  }
}

const conn = process.argv[2];
if (!conn) {
  console.error('usage: node scripts/check-notification-kinds.mjs <postgres-url>');
  process.exit(2);
}

const raw = execFileSync(
  'psql',
  [
    conn,
    '-tAc',
    "SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid WHERE t.typname = 'notification_kind' ORDER BY 1",
  ],
  { encoding: 'utf8' },
);
const enumLabels = new Set(raw.split('\n').map((s) => s.trim()).filter(Boolean));

if (enumLabels.size === 0) {
  console.error('notification_kind enum not found or empty — is the database migrated?');
  process.exit(2);
}

const missing = [...found.keys()].filter((k) => !enumLabels.has(k)).sort();

console.log(
  `checked ${found.size} kind literal(s) from files touching notifications_outbox ` +
    `against ${enumLabels.size} notification_kind label(s)`,
);

if (missing.length > 0) {
  console.error('\nnotification_kind values used in code but MISSING from the enum:');
  for (const k of missing) {
    console.error(`  '${k}'`);
    for (const f of [...found.get(k)].sort()) console.error(`      ${f}`);
  }
  console.error(
    '\nInserting one of these into notifications_outbox fails at runtime with\n' +
      '  22P02 invalid input value for enum notification_kind\n' +
      'Add it with:  ALTER TYPE notification_kind ADD VALUE IF NOT EXISTS \'<kind>\';\n' +
      '(no BEGIN/COMMIT — see mig 0298).',
  );
  process.exit(1);
}

console.log('all enqueued notification kinds exist in the enum');
