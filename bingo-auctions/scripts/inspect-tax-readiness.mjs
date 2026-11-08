#!/usr/bin/env node
// =============================================================================
// scripts/inspect-tax-readiness.mjs
//
// READ-ONLY sales-tax enablement readiness probe — the Step 4 pre-enable
// checks from docs/state/PATCH-sales-tax-enablement-2026-05-26.md.
//
//   1. Stripe Customer address coverage on the PLATFORM account (gates Fix A:
//      automatic_tax on the off-session auto-charge PI needs a customer
//      location).
//   2. Stripe Tax registration status on BinGo's CONNECTED account (gates
//      Step 2: without a registration, automatic_tax returns $0 even when the
//      collect_sales_tax flag is on).
//
// Strictly GET-only against the Stripe REST API. No creates/updates/deletes,
// no DB writes. The secret key is read from .secrets/clovrbid-stripe-live.env
// at runtime (never embedded).
//
// Usage:
//   node scripts/inspect-tax-readiness.mjs
// =============================================================================

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

(function loadEnv() {
  const candidates = [
    join(__dirname, '..', '.secrets', 'clovrbid-stripe-live.env'),
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
      const k = line.slice(0, eq).trim();
      let v = line.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!(k in process.env)) process.env[k] = v;
    }
  }
})();

const SK = process.env.STRIPE_SECRET_KEY;
if (!SK || !SK.startsWith('sk_')) {
  console.error('Missing STRIPE_SECRET_KEY (expected sk_live_… from .secrets/clovrbid-stripe-live.env)');
  process.exit(1);
}
const CONNECTED = 'acct_1TaQ4DB4jGyANhBb'; // BinGo Auctions connected account

async function sget(path, { account } = {}) {
  const headers = { Authorization: `Bearer ${SK}` };
  if (account) headers['Stripe-Account'] = account;
  const r = await fetch(`https://api.stripe.com/v1/${path}`, { headers });
  const body = await r.json();
  if (!r.ok) throw new Error(`${r.status} ${path}: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

(async () => {
  console.log(`Stripe key mode: ${SK.includes('_live_') ? 'LIVE' : 'TEST'}`);
  const acct = await sget('account');
  console.log(`Platform account: ${acct.id} (${acct.business_profile?.name ?? acct.email ?? '?'})`);

  // ── Task 1: customer address coverage (platform account) ──────────────────
  const cust = await sget('customers?limit=100');
  const list = cust.data ?? [];
  let withAddr = 0;
  let bidderTagged = 0;
  let bidderWithAddr = 0;
  for (const c of list) {
    const a = c.address;
    const usable = Boolean(a && (a.postal_code || a.country));
    if (usable) withAddr++;
    if (c.metadata && c.metadata.bidder_id) {
      bidderTagged++;
      if (usable) bidderWithAddr++;
    }
  }
  console.log(`\n[Customers] sampled ${list.length} most-recent (has_more=${cust.has_more})`);
  console.log(`  with usable address (postal/country): ${withAddr}/${list.length}`);
  console.log(`  bidder-tagged (metadata.bidder_id):    ${bidderTagged}`);
  console.log(`  bidder-tagged WITH address:            ${bidderWithAddr}/${bidderTagged}`);
  if (bidderTagged > 0 && bidderWithAddr === 0) {
    console.log('  ⚠ No bidder customer has an address → off-session tax would error until Fix A backfills (going forward) or a backfill runs.');
  }

  // ── Task 2: connected-account Stripe Tax status ───────────────────────────
  try {
    const reg = await sget('tax/registrations?limit=20', { account: CONNECTED });
    const regs = reg.data ?? [];
    console.log(`\n[Connected ${CONNECTED}] Stripe Tax registrations: ${regs.length}`);
    for (const x of regs) {
      console.log('  - ' + JSON.stringify({ country: x.country, status: x.status, active_from: x.active_from, us: x.country_options?.us }));
    }
    if (regs.length === 0) {
      console.log('  ⚠ NO registrations → automatic_tax returns $0 even with collect_sales_tax on. Step 2 (Dashboard) not done.');
    }
  } catch (e) {
    console.log(`\n[Connected ${CONNECTED}] tax/registrations: ${e.message}`);
    console.log('  (A permission error here likely means Tax is not yet configured on the connected account — verify in the Dashboard.)');
  }
  try {
    const ts = await sget('tax/settings', { account: CONNECTED });
    console.log(`[Connected] tax/settings status=${ts.status} default_tax_behavior=${ts.defaults?.tax_behavior ?? '?'} origin_address=${ts.head_office ? 'set' : 'unset'}`);
  } catch (e) {
    console.log(`[Connected] tax/settings: ${e.message}`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
