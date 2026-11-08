#!/usr/bin/env node
// Apply every packages/db migration, in filename order, to a TARGET Supabase
// project via the Management API SQL endpoint.
//
// Purpose: (re)build the ISOLATED test/sandbox backend that the authenticated
// Robo crawl (+ future Maestro authed flows + Playwright e2e) run against, so
// those tests can log in, bid, check out, and break things with ZERO effect on
// prod. This script never touches prod unless you pass prod's ref explicitly.
//
// Usage:
//   SUPABASE_ACCESS_TOKEN=sbp_... node scripts/test-backend/apply-schema.mjs <projectRef> [migrationsDir]
//
// NOTE: migrations are NOT idempotent — only run against a FRESH/empty project.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ref = process.argv[2];
const migDir =
  process.argv[3] ||
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'db', 'migrations');
const token = process.env.SUPABASE_ACCESS_TOKEN;

if (!ref || !token) {
  console.error('Need <projectRef> arg and SUPABASE_ACCESS_TOKEN env var.');
  process.exit(1);
}

const files = readdirSync(migDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();
console.log(`Applying ${files.length} migrations to project ${ref} ...`);

const url = `https://api.supabase.com/v1/projects/${ref}/database/query`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let applied = 0;
for (const f of files) {
  const sql = readFileSync(join(migDir, f), 'utf8');
  if (!sql.trim()) {
    console.log(`-- skip empty ${f}`);
    continue;
  }
  let attempt = 0;
  for (;;) {
    attempt++;
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: sql }),
    });
    if (res.ok) {
      applied++;
      break;
    }
    const body = await res.text();
    if (res.status === 429 && attempt <= 4) {
      await sleep(4000);
      continue;
    }
    console.error(`\nFAILED at ${f} (HTTP ${res.status}):\n${body.slice(0, 1800)}`);
    process.exit(2);
  }
  if (applied % 20 === 0) console.log(`  ... ${applied}/${files.length}`);
  await sleep(120);
}
console.log(`\nDONE: applied ${applied}/${files.length} migrations to ${ref}.`);
