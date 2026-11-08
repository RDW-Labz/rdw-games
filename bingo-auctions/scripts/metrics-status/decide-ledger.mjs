#!/usr/bin/env node
// ============================================================================
// scripts/metrics-status/decide-ledger.mjs
//
// Print `frozen` when a run must read the durable release ledger, or
// `first-run` when a human explicitly confirmed that metrics were never
// published. Anything else exits non-zero so the workflow aborts.
//
// The workflow passes the state of two refs:
//   metrics-history  append-only, durable disclosure ledger (source of truth)
//   metrics-status   consumer-facing snapshot (safe to withdraw/delete)
//
// Usage:
//   node scripts/metrics-status/decide-ledger.mjs \
//     --published-exists true --history-exists true
// ============================================================================

import { decideLedgerSource } from './lib.mjs';

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : 'false';
};
const truthy = (raw) => raw === 'true';

try {
  const source = decideLedgerSource({
    publishedExists: truthy(value('published-exists')),
    historyExists: truthy(value('history-exists')),
    confirmedFirstRun: truthy(value('confirmed-first-run')),
  });
  process.stdout.write(`${source}\n`);
} catch (error) {
  console.error(`[metrics] ${String(error?.message ?? error)}`);
  process.exit(1);
}
