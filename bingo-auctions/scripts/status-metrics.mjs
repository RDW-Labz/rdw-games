#!/usr/bin/env node
// ============================================================================
// scripts/status-metrics.mjs
//
// Daily read-only business metrics for Grok (#725). Counts and sums only: no
// names, emails, phones, addresses, user ids, invoice lines or free text.
//
// Read-only by construction: the one statement in scripts/metrics-status/lib.mjs
// is a SELECT, assertReadOnly() refuses anything else, the Management API is
// called with read_only: true so the database itself refuses any write the
// lexical guard missed, and the published document is built from an allowlist
// — unknown columns are never copied.
//
// Run by .github/workflows/metrics-status.yml, which appends the per-day ledger
// to the durable `metrics-history` ref and publishes status/metrics.json plus a
// copy of the ledger on the disposable `metrics-status` branch. It never writes
// to master. A run must read the durable ledger unless a human confirmed a true
// first run (see decide-ledger.mjs).
//
// Env:
//   SUPABASE_ACCESS_TOKEN  Management API token (required)
//   SUPABASE_PROJECT_REF   BinGo project ref (required, no default)
//
// Usage:
//   node scripts/status-metrics.mjs --out status/metrics.json --frozen ledger.json
//   node scripts/status-metrics.mjs --out status/metrics.json --first-run
//   node scripts/status-metrics.mjs --dry-run --first-run   # print, write nothing
// ============================================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  assertMetricsShape,
  buildMetrics,
  buildQuery,
  parseFrozenDays,
  publishableDays,
  readOnlyBody,
} from './metrics-status/lib.mjs';

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const outIndex = args.indexOf('--out');
const OUT = outIndex >= 0 ? args[outIndex + 1] : null;
const frozenIndex = args.indexOf('--frozen');
const FROZEN = frozenIndex >= 0 ? args[frozenIndex + 1] : null;
const FIRST_RUN = args.includes('--first-run');

function fail(message) {
  console.error(`[metrics] ${message}`);
  process.exit(1);
}

const token = process.env.SUPABASE_ACCESS_TOKEN;
const project = process.env.SUPABASE_PROJECT_REF;
if (!token) fail('SUPABASE_ACCESS_TOKEN is required.');
if (!project) fail('SUPABASE_PROJECT_REF is required (no default project).');

async function main() {
  // Immutable releases (RED TEAM #807 HIGH): read the per-day ledger this
  // branch published last time and let those days win over a fresh query, so
  // a later ledger correction cannot change history and become recoverable by
  // subtracting retained snapshots.
  //
  // A missing/unreadable ledger is only acceptable when the workflow proved
  // the snapshot branch does not exist (`--first-run`). Any other case aborts:
  // silently recomputing history would re-enable monetary disclosure
  // (RED TEAM at ed981234).
  //
  // This runs BEFORE the query because the ever-released days are inlined into
  // the SELECT: an aged-out released day must still return its linked-record
  // fingerprint so movement cannot hide behind the horizon (RED TEAM at
  // 77941b64 HIGH 3).
  let frozen = null;
  let frozenDays = null;
  if (FIRST_RUN) {
    if (FROZEN && existsSync(FROZEN)) {
      fail('--first-run cannot be combined with an existing frozen ledger');
    }
  } else {
    if (!FROZEN) fail('--frozen <path> is required (or --first-run for a verified first run).');
    if (!existsSync(FROZEN)) {
      fail('frozen ledger is missing; refusing to recompute published history');
    }
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(FROZEN, 'utf8'));
    } catch (error) {
      fail(`frozen ledger is not valid JSON: ${String(error?.message ?? error).slice(0, 120)}`);
    }
    frozen = parsed?.days ?? null;
    if (frozen == null) fail('frozen ledger has no days; refusing to recompute published history');
    // Validate the ledger before publishing the document it feeds.
    frozenDays = parseFrozenDays(frozen);
  }

  const releasedDays = frozenDays
    ? [...frozenDays.released.gross_sales_days, ...frozenDays.released.refund_days].map((bucket) =>
        new Date(bucket.day * 86_400_000).toISOString().slice(0, 10),
      )
    : [];

  const query = buildQuery(releasedDays);
  const res = await fetch(`https://api.supabase.com/v1/projects/${project}/database/query`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(readOnlyBody(query)),
  });
  const body = await res.text();
  if (!res.ok) fail(`query failed ${res.status}: ${body.slice(0, 300)}`);

  let rows;
  try {
    rows = JSON.parse(body);
  } catch {
    fail('query returned invalid JSON');
  }
  if (!Array.isArray(rows) || rows.length !== 1) {
    fail(
      `expected exactly one aggregate row, got ${Array.isArray(rows) ? rows.length : 'non-array'}`,
    );
  }

  // One clock for both artifacts: a UTC-midnight boundary between two
  // `new Date()` calls could otherwise make the feed and the sidecar use
  // different horizons (RED TEAM at 08fa83f0 HIGH 3).
  const now = new Date();
  const doc = assertMetricsShape(buildMetrics(rows[0], now, { frozen }));
  const json = `${JSON.stringify(doc, null, 2)}\n`;
  console.log(`[metrics] generated_at=${doc.generated_at}`);

  if (DRY) {
    console.log(json);
    return;
  }
  if (!OUT) fail('--out <path> is required unless --dry-run is set.');
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, json);
  const dayLedger = publishableDays(rows[0], now, { frozen });
  writeFileSync(join(dirname(OUT), 'metrics-days.json'), `${JSON.stringify(dayLedger, null, 2)}\n`);
  console.log(`[metrics] wrote ${OUT} and metrics-days.json`);
}

main().catch((error) => fail(String(error?.message ?? error).slice(0, 300)));
