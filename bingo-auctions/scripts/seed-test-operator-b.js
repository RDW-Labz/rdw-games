#!/usr/bin/env node
// =============================================================================
// scripts/seed-test-operator-b.js
//
// Idempotent seeder for the second test operator (TST = Test Operator B).
// Used by the cross-tenant RLS tests in scripts/smoke-test-e2e.js.
//
// Steps:
//   1. Apply seeds/test-operator-b.sql via the Management API SQL endpoint
//      (creates operator + warehouse + bin rows).
//   2. Create or update the auth user via the Supabase admin API
//      (auth.users can't be inserted from raw SQL).
//   3. Insert/upsert the operator_users row linking the auth user to TST.
//
// Idempotent: each step is ON CONFLICT DO NOTHING (or the admin-API
// equivalent). Safe to re-run any number of times.
//
// Usage:
//   node scripts/seed-test-operator-b.js
//
// Credentials needed (auto-loaded from apps/operator-web/.env.local +
// .env.migrations.local):
//   NEXT_PUBLIC_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//   SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF (for SQL endpoint)
//
// SUPABASE_PROJECT_REF has no default, deliberately. This repo was forked from
// ClovrBid, and a guessed ref seeds operator rows into another company's
// production database. BinGo prod is npwseclcxcatjhgjrtwe.
// =============================================================================

const fs = require('fs');
const path = require('path');
const ws = require('ws');

(function loadDotEnv() {
  const candidates = [
    path.join(__dirname, '..', '.env.migrations.local'),
    path.join(__dirname, '..', 'apps', 'operator-web', '.env.local'),
    path.join(__dirname, '..', '.env.local'),
  ];
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue;
    for (const raw of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 1) continue;
      const k = line.slice(0, eq).trim();
      const v = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
      if (!process.env[k]) process.env[k] = v;
    }
  }
})();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ACCESS_TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const PROJECT_REF = process.env.SUPABASE_PROJECT_REF;

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

// The Management API path targets a project by ref in the URL. An unset ref
// used to fall through to a hardcoded default (ClovrBid's, this repo's
// upstream), so a PAT with no ref seeded rows into another company's
// production database. This script writes; it does not guess. The PostgREST
// fallback is exempt — it targets NEXT_PUBLIC_SUPABASE_URL and never reads
// the ref.
if (ACCESS_TOKEN && !PROJECT_REF) {
  console.error(
    '[seed-test-operator-b] SUPABASE_PROJECT_REF is not set.\n\n' +
      '  SUPABASE_ACCESS_TOKEN is set, so the seed SQL would run through the\n' +
      '  Management API. This script will not guess which project to write\n' +
      '  to. Set the ref explicitly:\n\n' +
      '    $env:SUPABASE_PROJECT_REF = "npwseclcxcatjhgjrtwe"\n' +
      '    node scripts/seed-test-operator-b.js\n\n' +
      '  or add SUPABASE_PROJECT_REF to .env.migrations.local at the repo root.\n' +
      '  BinGo prod is npwseclcxcatjhgjrtwe — confirm the ref before seeding.\n\n' +
      '  (Or unset SUPABASE_ACCESS_TOKEN to use the PostgREST fallback, which\n' +
      '  targets NEXT_PUBLIC_SUPABASE_URL.)',
  );
  process.exit(1);
}

// Steps 1 and 2-3 hit different projects if the ref and the URL disagree:
// operator rows land via the ref, the auth user via the URL. Refuse the split.
if (ACCESS_TOKEN && new URL(SUPABASE_URL).hostname !== `${PROJECT_REF}.supabase.co`) {
  console.error(
    `[seed-test-operator-b] SUPABASE_PROJECT_REF (${PROJECT_REF}) does not match\n` +
      `  NEXT_PUBLIC_SUPABASE_URL (${SUPABASE_URL}). The SQL step and the auth\n` +
      '  step would write to two different projects. Fix one of them.',
  );
  process.exit(1);
}

// ── TST identifiers (must stay in sync with seeds/test-operator-b.sql) ────
const TST = {
  operatorId: '33333333-3333-3333-3333-333333333333',
  warehouseId: '44444444-4444-4444-4444-444444444444',
  binId: '55555555-5555-5555-5555-555555555555',
  email: 'test-b@bidwizops.local',
  // Strong-ish password — only used in tests, never logged. Stays in
  // smoke-test-e2e.js so the e2e suite can sign in as TST. Rotate if
  // this repo ever becomes public.
  password: 'TestOperatorB!2026',
};

const { createClient } = require('@supabase/supabase-js');
const sb = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { transport: ws },
});

// ── Step 1: apply seed SQL via Management API ─────────────────────────────
async function applySeedSql() {
  if (!ACCESS_TOKEN) {
    console.warn('SUPABASE_ACCESS_TOKEN not set — falling back to direct SQL via PostgREST.');
    console.warn('This works but errors on RLS-protected tables. Best to add the PAT to .env.migrations.local.');
  }

  const sqlPath = path.join(__dirname, '..', 'seeds', 'test-operator-b.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');

  if (ACCESS_TOKEN) {
    const url = `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: sql }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Seed SQL failed: HTTP ${res.status} — ${body.slice(0, 300)}`);
    }
    console.log('  ✓ seeds/test-operator-b.sql applied');
    return;
  }

  // Fallback: try inserting directly via PostgREST as service role.
  // This is the same effect as the SQL but row-by-row.
  await sb.from('operators').upsert({
    id: TST.operatorId,
    slug: 'test-operator-b',
    business_name: 'Test Operator B',
    contact_email: TST.email,
    status: 'active',
    code: 'TST',
    next_lot_seq: 1,
    monthly_subscription_cents: 9900,
    application_fee_bps: 200,
    default_buyer_premium_bps: 1500,
    default_soft_close_minutes: 3,
  }, { onConflict: 'id', ignoreDuplicates: true });
  await sb.from('warehouses').upsert({
    id: TST.warehouseId,
    operator_id: TST.operatorId,
    name: 'TST Main Warehouse',
    address_line1: '999 Tenant Way',
    city: 'Bentonville',
    state: 'AR',
    postal_code: '72712',
    floor_plan_width_px: 1000,
    floor_plan_height_px: 700,
  }, { onConflict: 'id', ignoreDuplicates: true });
  await sb.from('bins').upsert({
    id: TST.binId,
    warehouse_id: TST.warehouseId,
    code: 'TST-A1',
    aisle: 'A',
    x_px: 100,
    y_px: 100,
    qr_token: '66666666-6666-6666-6666-666666666666',
  }, { onConflict: 'id', ignoreDuplicates: true });
  console.log('  ✓ seed rows upserted via PostgREST fallback');
}

// ── Step 2: create or update the auth user ────────────────────────────────
async function ensureAuthUser() {
  // listUsers paginated; the test user almost certainly fits in the first page.
  const { data: list, error: listErr } = await sb.auth.admin.listUsers({
    page: 1,
    perPage: 200,
  });
  if (listErr) throw new Error(`auth.admin.listUsers: ${listErr.message}`);

  const existing = (list.users ?? []).find((u) => u.email === TST.email);
  if (existing) {
    // Already exists — make sure the password is set to the known test value
    // (in case it was reset). email_confirm:true makes it usable immediately.
    const { error: upErr } = await sb.auth.admin.updateUserById(existing.id, {
      password: TST.password,
      email_confirm: true,
    });
    if (upErr) throw new Error(`auth.admin.updateUserById: ${upErr.message}`);
    console.log('  ✓ auth user exists, password reset to test value');
    return existing.id;
  }

  const { data: created, error: createErr } = await sb.auth.admin.createUser({
    email: TST.email,
    password: TST.password,
    email_confirm: true,
    user_metadata: { seeded: true, role: 'test-operator-b' },
  });
  if (createErr) throw new Error(`auth.admin.createUser: ${createErr.message}`);
  if (!created.user) throw new Error('createUser returned no user');
  console.log(`  ✓ auth user created: ${created.user.id}`);
  return created.user.id;
}

// ── Step 3: link auth user to TST via operator_users ──────────────────────
async function linkOperatorUser(userId) {
  // operator_users has UNIQUE on user_id only, plus required email field.
  // Use that as the conflict target so re-running this seed is idempotent.
  const { error } = await sb.from('operator_users').upsert(
    {
      user_id: userId,
      operator_id: TST.operatorId,
      role: 'admin',
      email: TST.email,
      display_name: 'Test Operator B Admin',
      accepted_at: new Date().toISOString(),
    },
    { onConflict: 'user_id', ignoreDuplicates: false },
  );
  if (error) throw new Error(`operator_users upsert: ${error.message}`);
  console.log('  ✓ operator_users row linked');
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log('Seeding test operator B (TST)…');
  console.log(`  email:    ${TST.email}`);
  console.log(`  password: ${TST.password}  (test only)`);
  console.log(`  operator: ${TST.operatorId} (code TST)`);
  console.log('');
  await applySeedSql();
  const userId = await ensureAuthUser();
  await linkOperatorUser(userId);
  console.log('');
  console.log('Done. Cross-tenant tests can now sign in as TST.');
}

main().catch((e) => {
  console.error('Fatal:', e.message);
  process.exit(2);
});
