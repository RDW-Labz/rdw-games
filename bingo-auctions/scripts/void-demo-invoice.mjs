#!/usr/bin/env node
// =============================================================================
// scripts/void-demo-invoice.mjs
//
// One-off cleanup script: voids demo invoice 9282720d-9b0c-4ffd-8171-c91c25ef86e4
// (Emily's $1.15 BIN-000035 win, 2026-05-23 lifecycle test).
//
// No Stripe PaymentIntent was ever created (BinGo operator has no
// stripe_account_id). The invoice is stuck in payment_failed_grace with no
// money moved — safe to cancel administratively.
//
// Target status: 'canceled'  (the invoice_status enum value for operator manual
//                void; there is no 'void' value in the enum — see migration
//                0104_invoice_status_grace_enum.sql + 0001_init.sql).
//
// Usage:
//   node scripts/void-demo-invoice.mjs           # dry-run (default, no writes)
//   node scripts/void-demo-invoice.mjs --dry-run  # explicit dry-run
//   node scripts/void-demo-invoice.mjs --live      # perform actual writes
//
// Safety model:
//   - Default is --dry-run. You must explicitly pass --live.
//   - Four pre-flight checks run before ANY write. Any failure aborts.
//   - Idempotent: if invoice is already 'canceled', exits 0 with message.
//   - All writes use service-role key over PostgREST (no SQL injection surface).
// =============================================================================

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const INVOICE_ID = '9282720d-9b0c-4ffd-8171-c91c25ef86e4';
const EXPECTED_TOTAL_CENTS = 115;
const CANCELED_STATUS = 'canceled'; // The enum value for operator-initiated void

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const isLive = args.includes('--live');
const isDryRun = !isLive; // default is dry-run

// ---------------------------------------------------------------------------
// Env loading (mirrors inspect-operator-state.mjs pattern)
// ---------------------------------------------------------------------------
const __dirname = dirname(fileURLToPath(import.meta.url));

(function loadDotEnv() {
  const candidates = [
    join(__dirname, '..', '.env.migrations.local'),
    join(__dirname, '..', 'apps', 'operator-web', '.env.local'),
    join(__dirname, '..', '.env.local'),
  ];
  for (const f of candidates) {
    if (!existsSync(f)) continue;
    for (const raw of readFileSync(f, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  }
})();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(
    'ABORT: Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env.',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// PostgREST helpers
// ---------------------------------------------------------------------------

/** GET /rest/v1/<path> — returns parsed JSON or throws. */
async function pgGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      Accept: 'application/json',
    },
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`GET ${path} → ${r.status} ${r.statusText}: ${body}`);
  }
  return r.json();
}

/** PATCH /rest/v1/<path> with JSON body — returns 204 or throws. */
async function pgPatch(path, payload) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`PATCH ${path} → ${r.status} ${r.statusText}: ${body}`);
  }
}

/** DELETE /rest/v1/<path> — returns 204 or throws. */
async function pgDelete(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'DELETE',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      Prefer: 'return=minimal',
    },
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`DELETE ${path} → ${r.status} ${r.statusText}: ${body}`);
  }
}

/** POST /rest/v1/<path> with JSON body — returns 201 or throws. */
async function pgInsert(path, payload) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`POST ${path} → ${r.status} ${r.statusText}: ${body}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const MODE = isDryRun ? '[DRY-RUN]' : '[LIVE]';

console.log('');
console.log('======================================================');
console.log(`  void-demo-invoice.mjs  ${MODE}`);
console.log('======================================================');
console.log(`  Invoice ID : ${INVOICE_ID}`);
console.log(`  Mode       : ${isDryRun ? 'dry-run (pass --live to write)' : 'LIVE — writes will be performed'}`);
console.log('');

// ---------------------------------------------------------------------------
// Step 1: Fetch the invoice
// ---------------------------------------------------------------------------
console.log('Step 1: Fetching invoice...');

const invoiceRows = await pgGet(
  `invoices?id=eq.${INVOICE_ID}&select=id,status,stripe_payment_intent_id,paid_at,total_cents`,
);

if (invoiceRows.length === 0) {
  console.error(`ABORT: Invoice ${INVOICE_ID} not found.`);
  process.exit(1);
}

const invoice = invoiceRows[0];
console.log(`  status                   : ${invoice.status}`);
console.log(`  total_cents              : ${invoice.total_cents}`);
console.log(`  paid_at                  : ${invoice.paid_at ?? 'NULL'}`);
console.log(`  stripe_payment_intent_id : ${invoice.stripe_payment_intent_id ?? 'NULL'}`);
console.log('');

// ---------------------------------------------------------------------------
// Idempotency check: already done?
// ---------------------------------------------------------------------------
if (invoice.status === CANCELED_STATUS) {
  console.log(`Invoice is already '${CANCELED_STATUS}'. Nothing to do. Exiting 0.`);
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Step 2: Pre-flight sanity checks — ALL must pass before ANY write
// ---------------------------------------------------------------------------
console.log('Step 2: Running pre-flight sanity checks...');

const failures = [];

if (invoice.status !== 'payment_failed_grace') {
  failures.push(
    `status is '${invoice.status}', expected 'payment_failed_grace'`,
  );
}

if (invoice.stripe_payment_intent_id !== null) {
  failures.push(
    `stripe_payment_intent_id is '${invoice.stripe_payment_intent_id}', expected NULL — Stripe state exists, manual void is unsafe`,
  );
}

if (invoice.paid_at !== null) {
  failures.push(
    `paid_at is '${invoice.paid_at}', expected NULL — invoice appears to have been paid`,
  );
}

if (invoice.total_cents !== EXPECTED_TOTAL_CENTS) {
  failures.push(
    `total_cents is ${invoice.total_cents}, expected ${EXPECTED_TOTAL_CENTS} — wrong invoice?`,
  );
}

if (failures.length > 0) {
  console.error('');
  console.error('ABORT: Pre-flight checks failed:');
  for (const f of failures) {
    console.error(`  - ${f}`);
  }
  console.error('No writes were performed.');
  process.exit(1);
}

console.log('  [PASS] status === payment_failed_grace');
console.log('  [PASS] stripe_payment_intent_id IS NULL');
console.log('  [PASS] paid_at IS NULL');
console.log(`  [PASS] total_cents === ${EXPECTED_TOTAL_CENTS}`);
console.log('');

// ---------------------------------------------------------------------------
// Step 3: Check for auto_charge_jobs row
// ---------------------------------------------------------------------------
console.log('Step 3: Checking for auto_charge_jobs row...');

const chargeJobs = await pgGet(
  `auto_charge_jobs?invoice_id=eq.${INVOICE_ID}&select=invoice_id,attempt_count,next_attempt_at`,
);

const hasChargeJob = chargeJobs.length > 0;
if (hasChargeJob) {
  console.log(
    `  Found 1 auto_charge_jobs row (attempt_count=${chargeJobs[0].attempt_count}).`,
  );
} else {
  console.log('  No auto_charge_jobs row found (already deleted or never created).');
}
console.log('');

// ---------------------------------------------------------------------------
// Step 4: Check invoice_status_history table exists (schema guard)
//
// The schema types confirm it exists (database.types.ts line 1087), but we
// verify at runtime by attempting a HEAD request against the table.
// ---------------------------------------------------------------------------
console.log('Step 4: Verifying invoice_status_history table is accessible...');

let historyTableExists = false;
try {
  // Use limit=0 to avoid fetching rows; just verify the table is accessible.
  await pgGet('invoice_status_history?limit=0');
  historyTableExists = true;
  console.log('  invoice_status_history table is accessible.');
} catch (err) {
  console.warn(`  WARNING: invoice_status_history not accessible (${err.message}). Audit row will be skipped.`);
}
console.log('');

// ---------------------------------------------------------------------------
// Step 5: Report planned writes
// ---------------------------------------------------------------------------
console.log('Step 5: Planned writes:');
console.log(`  [1] PATCH invoices id=${INVOICE_ID}`);
console.log(`        status → '${CANCELED_STATUS}'`);
console.log('        updated_at → NOW()');

if (hasChargeJob) {
  console.log(`  [2] DELETE auto_charge_jobs invoice_id=${INVOICE_ID}`);
} else {
  console.log('  [2] DELETE auto_charge_jobs — skipped (no row)');
}

if (historyTableExists) {
  console.log(`  [3] INSERT invoice_status_history`);
  console.log(`        invoice_id   : ${INVOICE_ID}`);
  console.log(`        from_status  : payment_failed_grace`);
  console.log(`        to_status    : ${CANCELED_STATUS}`);
  console.log("        changed_by   : NULL (service-role script)");
  console.log("        context      : { reason: 'demo_data_cleanup', script: 'void-demo-invoice.mjs' }");
} else {
  console.log('  [3] INSERT invoice_status_history — skipped (table not accessible)');
}

console.log('  [4] LOT — NOT TOUCHED (lot status ambiguity; invoice void is sufficient cleanup)');
console.log('');

// ---------------------------------------------------------------------------
// Step 6: Execute writes (only in --live mode)
// ---------------------------------------------------------------------------
if (isDryRun) {
  console.log('DRY-RUN complete. No changes made. Pass --live to execute.');
  console.log('');
  process.exit(0);
}

console.log('Step 6: Executing writes...');

// Write 1: Update invoice status to canceled
console.log('  [1] PATCH invoices...');
await pgPatch(`invoices?id=eq.${INVOICE_ID}`, {
  status: CANCELED_STATUS,
  updated_at: new Date().toISOString(),
});
console.log('      Done.');

// Write 2: Delete auto_charge_jobs row (if exists)
if (hasChargeJob) {
  console.log('  [2] DELETE auto_charge_jobs...');
  await pgDelete(`auto_charge_jobs?invoice_id=eq.${INVOICE_ID}`);
  console.log('      Done.');
} else {
  console.log('  [2] DELETE auto_charge_jobs — skipped.');
}

// Write 3: Insert audit history row
if (historyTableExists) {
  console.log('  [3] INSERT invoice_status_history...');
  await pgInsert('invoice_status_history', {
    invoice_id: INVOICE_ID,
    from_status: 'payment_failed_grace',
    to_status: CANCELED_STATUS,
    changed_by: null,
    context: {
      reason: 'demo_data_cleanup',
      script: 'void-demo-invoice.mjs',
      note: '2026-05-23 lifecycle test; BinGo operator had no Stripe account; no PaymentIntent created; no money moved',
    },
  });
  console.log('      Done.');
} else {
  console.log('  [3] INSERT invoice_status_history — skipped.');
}

console.log('');
console.log('======================================================');
console.log('  All writes complete.');
console.log(`  Invoice ${INVOICE_ID} is now '${CANCELED_STATUS}'.`);
console.log('======================================================');
console.log('');
