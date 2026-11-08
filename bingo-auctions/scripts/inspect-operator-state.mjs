#!/usr/bin/env node
// =============================================================================
// scripts/inspect-operator-state.mjs
//
// One-off READ-ONLY inspector for diagnosing the 2026-05-23 auto-charge failure.
// Uses direct PostgREST fetch() against Supabase REST API to avoid the Node 20
// WebSocket issue with @supabase/supabase-js realtime client.
//
// Reports:
//   1. All operators with their Stripe Connect onboarding state.
//   2. The BIN-000035 lot row + which operator owns it.
//   3. The invoice 9282720d-9b0c-4ffd-8171-c91c25ef86e4 state.
//   4. Any auto_charge_jobs row for that invoice.
//   5. Emily bidder state (winner of the lot).
//
// Usage:
//   node scripts/inspect-operator-state.mjs
// =============================================================================

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  }
})();

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in env');
  process.exit(1);
}

async function pgrest(path) {
  const r = await fetch(`${url}/rest/v1/${path}`, {
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
    },
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`${r.status} ${r.statusText}: ${body}`);
  }
  return r.json();
}

function table(rows, cols) {
  if (!rows || rows.length === 0) {
    console.log('  (no rows)');
    return;
  }
  for (const row of rows) {
    console.log('  ─────────────────────');
    for (const c of cols) {
      let v = row[c];
      if (v === null || v === undefined) v = 'NULL';
      else if (typeof v === 'object') v = JSON.stringify(v);
      console.log(`  ${String(c).padEnd(30)} ${v}`);
    }
  }
}

console.log('\n========================================');
console.log('1) ALL OPERATORS - Stripe Connect state');
console.log('========================================');
let ops = [];
try {
  ops = await pgrest('operators?select=id,code,slug,business_name,stripe_account_id,stripe_onboarding_complete,stripe_onboarding_skipped,status&order=created_at.asc');
  table(ops, ['code', 'business_name', 'status', 'stripe_account_id', 'stripe_onboarding_complete', 'stripe_onboarding_skipped']);
} catch (e) { console.error('  ERROR:', e.message); }

console.log('\n========================================');
console.log('2) BIN-000035 lot + owning operator');
console.log('========================================');
let lots = [];
try {
  // BIN-000035 could be lot_code (typical), external_code (mfr SKU), or a bins.code reference.
  lots = await pgrest('lots?lot_code=eq.BIN-000035&select=id,lot_code,external_code,operator_id,status,close_at,closed_at,winner_bidder_id,current_bid_cents,intake_bin_id');
  if (lots.length === 0) {
    console.log('  Not found by lot_code — trying external_code...');
    lots = await pgrest('lots?external_code=eq.BIN-000035&select=id,lot_code,external_code,operator_id,status,close_at,closed_at,winner_bidder_id,current_bid_cents,intake_bin_id');
  }
  if (lots.length === 0) {
    console.log('  Not found — trying via bins.code = BIN-000035...');
    const bins = await pgrest('bins?code=eq.BIN-000035&select=id,code,warehouse_id');
    if (bins.length > 0) {
      console.log(`  Found bin: ${bins[0].id} — querying lots in that bin...`);
      lots = await pgrest(`lots?intake_bin_id=eq.${bins[0].id}&select=id,lot_code,external_code,operator_id,status,close_at,closed_at,winner_bidder_id,current_bid_cents,intake_bin_id&order=created_at.desc&limit=5`);
    }
  }
  table(lots, ['lot_code', 'external_code', 'operator_id', 'status', 'close_at', 'closed_at', 'winner_bidder_id', 'current_bid_cents']);
  if (lots[0]) {
    const ownerOp = ops.find((o) => o.id === lots[0].operator_id);
    console.log(`\n  Owning operator: ${ownerOp ? ownerOp.code + ' / ' + ownerOp.business_name : '(unknown id ' + lots[0].operator_id + ')'}`);
    console.log(`  Owner stripe_account_id: ${ownerOp?.stripe_account_id ?? 'NULL'}`);
    console.log(`  Owner stripe_onboarding_complete: ${ownerOp?.stripe_onboarding_complete}`);
    console.log(`  Owner stripe_onboarding_skipped: ${ownerOp?.stripe_onboarding_skipped}`);
  }
} catch (e) { console.error('  ERROR:', e.message); }

console.log('\n========================================');
console.log('3) Invoice 9282720d... state');
console.log('========================================');
let invs = [];
try {
  invs = await pgrest('invoices?id=eq.9282720d-9b0c-4ffd-8171-c91c25ef86e4&select=*');
  table(invs, ['status', 'bidder_id', 'operator_id', 'total_cents', 'subtotal_cents', 'buyer_premium_cents', 'application_fee_cents', 'stripe_payment_intent_id', 'stripe_charge_id', 'paid_at', 'created_at']);
} catch (e) { console.error('  ERROR:', e.message); }

console.log('\n========================================');
console.log('4) auto_charge_jobs row');
console.log('========================================');
try {
  const jobs = await pgrest('auto_charge_jobs?invoice_id=eq.9282720d-9b0c-4ffd-8171-c91c25ef86e4&select=invoice_id,bidder_id,next_attempt_at,attempt_count,last_error,created_at');
  table(jobs, ['next_attempt_at', 'attempt_count', 'last_error', 'created_at']);
} catch (e) { console.error('  ERROR:', e.message); }

console.log('\n========================================');
console.log('5) Emily bidder state (winner)');
console.log('========================================');
try {
  if (invs[0]) {
    const bidders = await pgrest(`bidders?id=eq.${invs[0].bidder_id}&select=id,display_name,email,stripe_customer_id,default_payment_method_id,stripe_key_mode`);
    table(bidders, ['display_name', 'email', 'stripe_customer_id', 'default_payment_method_id', 'stripe_key_mode']);
  }
} catch (e) { console.error('  ERROR:', e.message); }

console.log('\n========================================');
console.log('Inspection complete.');
console.log('========================================\n');
