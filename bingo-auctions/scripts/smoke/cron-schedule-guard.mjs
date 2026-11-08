#!/usr/bin/env node
// cron-schedule-guard.mjs
// ----------------------------------------------------------------------------
// Keeps the three places that describe scheduled work from drifting apart.
// Runs in CI (lint job) and locally: `node scripts/smoke/cron-schedule-guard.mjs`
//
// ── WHY ─────────────────────────────────────────────────────────────────────
// Four separate production failures, all the same shape: a list naming a thing
// that was not there, and nothing comparing the two.
//
//   /api/cron/refund-jobs-drain   POSTed to a 404 every minute (#321). The
//                                 Square cutover deleted the route; the
//                                 SCHEDULES entry stayed.
//   /api/cron/settlements-release HTTP 404, fired hourly (#330)
//   /api/cron/reconcile-payments  HTTP 404, fired hourly — no implementation
//                                 had ever existed anywhere in the repo (#330)
//   /api/cron/social-post         the mirror image: a handler nothing
//                                 scheduled; removed during cleanup step 6.
//
// PR #330 found the last two by diffing SCHEDULES against the route directory
// BY HAND and wrote "the difference is empty" in the description. That is this
// check, executed once, by a person, and then thrown away. This is that diff,
// kept.
//
// Cheap on purpose: pure file reads, no network, no credentials, milliseconds.
//
// ── THE THREE AXES ──────────────────────────────────────────────────────────
// A missing entry in any direction fails silently in production, which is why
// all three are checked rather than only the obvious one:
//
//   1. SCHEDULES path  -> handler exists         else: POST to a 404, forever
//   2. handler         -> named in SCHEDULES     else: dead code, or work that
//                                                silently never runs
//   3. SCHEDULES cron <-> wrangler triggers      else: the entry never fires,
//                                                or the trigger fires and the
//                                                Worker logs 'no paths
//                                                configured' and returns
// ----------------------------------------------------------------------------

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TRIGGER_SRC = join(REPO_ROOT, 'apps/cron-trigger/src/index.ts');
const WRANGLER = join(REPO_ROOT, 'apps/cron-trigger/wrangler.jsonc');
const ROUTES_DIR = join(REPO_ROOT, 'apps/operator-web/src/app/api/cron');

// Handlers that exist on purpose without a schedule. Each needs a reason: an
// entry here is a deliberate statement that the work is not running, which is
// exactly the fact that was invisible before.
//
// Adding a name here is the escape hatch. Prefer scheduling it or deleting it.
const ALLOW_UNSCHEDULED = new Map();

// ── Comment stripping ───────────────────────────────────────────────────────
// Required, not cosmetic: the SCHEDULES block documents the routes it has
// REMOVED, in prose, by path. Without this the guard reads
// "the Stripe-era /api/cron/refund-jobs-drain was removed" as a live entry and
// demands a handler for the very route we deleted.
//
// Quote-aware so a `//` inside a string (a URL) survives.
function stripComments(src) {
  let out = '';
  let i = 0;
  let quote = null;
  let inBlock = false;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (inBlock) {
      if (c === '*' && next === '/') { inBlock = false; i += 2; continue; }
      if (c === '\n') out += c;            // keep line numbers honest
      i += 1;
      continue;
    }
    if (quote) {
      out += c;
      if (c === '\\') { out += next ?? ''; i += 2; continue; }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i += 1; continue; }
    if (c === '/' && next === '*') { inBlock = true; i += 2; continue; }
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** The SCHEDULES object literal, brace-matched so a nested `}` cannot end it early. */
function extractSchedulesBlock(src) {
  const anchor = src.indexOf('const SCHEDULES');
  if (anchor === -1) throw new Error('SCHEDULES not found in apps/cron-trigger/src/index.ts');
  const open = src.indexOf('{', anchor);
  if (open === -1) throw new Error('SCHEDULES has no opening brace');
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error('SCHEDULES object literal is unterminated');
}

/** cron expression -> route paths, read from the literal. */
function parseSchedules(block) {
  const out = new Map();
  // A key is a quoted cron expression followed by `: [`.
  const keyRe = /['"]([^'"]+)['"]\s*:\s*\[/g;
  let m;
  while ((m = keyRe.exec(block)) !== null) {
    const cron = m[1];
    const start = keyRe.lastIndex;
    const end = block.indexOf(']', start);
    if (end === -1) throw new Error(`unterminated array for cron ${cron}`);
    const paths = [...block.slice(start, end).matchAll(/['"](\/api\/cron\/[^'"]+)['"]/g)]
      .map((p) => p[1]);
    out.set(cron, paths);
  }
  return out;
}

function parseWranglerCrons() {
  const parsed = JSON.parse(stripComments(readFileSync(WRANGLER, 'utf8')));
  const crons = parsed?.triggers?.crons;
  if (!Array.isArray(crons)) throw new Error('triggers.crons missing from wrangler.jsonc');
  return new Set(crons);
}

function handlersOnDisk() {
  return new Set(
    readdirSync(ROUTES_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .filter((d) => ['route.ts', 'route.tsx', 'route.js'].some(
        (f) => existsSync(join(ROUTES_DIR, d.name, f)),
      ))
      .map((d) => d.name),
  );
}

// ── Run ─────────────────────────────────────────────────────────────────────
const failures = [];
const notes = [];

const schedules = parseSchedules(extractSchedulesBlock(stripComments(readFileSync(TRIGGER_SRC, 'utf8'))));
const wranglerCrons = parseWranglerCrons();
const handlers = handlersOnDisk();

const scheduledNames = new Set();
for (const [cron, paths] of schedules) {
  for (const p of paths) {
    const name = p.replace(/^\/api\/cron\//, '').replace(/\/+$/, '');
    scheduledNames.add(name);

    // 1. Scheduled -> handler must exist.
    if (!handlers.has(name)) {
      failures.push(
        `SCHEDULES['${cron}'] POSTs to ${p}, but apps/operator-web/src/app/api/cron/${name}/route.ts ` +
        `does not exist. The Worker will POST to a 404 on every tick.\n` +
        `    Fix: restore the handler, or remove the entry from SCHEDULES. Before removing, check ` +
        `the work is genuinely obsolete and not just unimplemented — #330 verified against prod first.`,
      );
    }
  }
}

// 2. Handler -> must be scheduled, or explicitly allowed.
for (const name of [...handlers].sort()) {
  if (scheduledNames.has(name)) continue;
  if (ALLOW_UNSCHEDULED.has(name)) {
    notes.push(`${name}: unscheduled on purpose — ${ALLOW_UNSCHEDULED.get(name)}`);
    continue;
  }
  failures.push(
    `apps/operator-web/src/app/api/cron/${name}/route.ts exists but nothing schedules it, so it ` +
    `never runs.\n` +
    `    Fix: add '/api/cron/${name}' to SCHEDULES in apps/cron-trigger/src/index.ts, delete the ` +
    `route, or add it to ALLOW_UNSCHEDULED in this file with a reason.`,
  );
}

// 3. Cron expressions must agree with the Worker's own triggers.
for (const cron of schedules.keys()) {
  if (!wranglerCrons.has(cron)) {
    failures.push(
      `SCHEDULES has the key '${cron}' but wrangler.jsonc triggers.crons does not. Cloudflare will ` +
      `never deliver that event, so ${schedules.get(cron).length} route(s) silently never run.\n` +
      `    Fix: add '${cron}' to triggers.crons in apps/cron-trigger/wrangler.jsonc.`,
    );
  }
}
for (const cron of wranglerCrons) {
  if (!schedules.has(cron)) {
    failures.push(
      `wrangler.jsonc schedules '${cron}' but SCHEDULES has no entry for it. The Worker wakes up, ` +
      `logs 'no paths configured', and does nothing.\n` +
      `    Fix: add the key to SCHEDULES, or drop the trigger from wrangler.jsonc.`,
    );
  }
}

const routeCount = [...schedules.values()].reduce((n, p) => n + p.length, 0);

if (failures.length > 0) {
  console.error(`\ncron-schedule-guard: ${failures.length} problem(s)\n`);
  for (const f of failures) console.error(`  ✗ ${f}\n`);
  console.error(
    'Every one of these fails silently in production: a 404 on a timer, or work that never runs.\n',
  );
  process.exit(1);
}

console.log(
  `cron-schedule-guard: ok — ${routeCount} scheduled route(s) across ${schedules.size} cron ` +
  `expression(s), all present; ${handlers.size} handler(s) on disk, all accounted for.`,
);
for (const n of notes) console.log(`  note: ${n}`);
