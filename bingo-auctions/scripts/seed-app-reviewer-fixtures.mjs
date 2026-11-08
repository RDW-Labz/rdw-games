#!/usr/bin/env node
// scripts/seed-app-reviewer-fixtures.mjs
//
// Seeds the Apple/Google App Reviewer demo fixtures:
//   - One "Demo Auctioneer" operator (slug=demo, bypasses Stripe Connect)
//   - One staff user (demo-staff@clovrbid.com) tied to that operator
//   - One bidder (reviewer@clovrbid.com) with identity_verified_at set so
//     they can bid above the $500 threshold without going through Stripe
//     Identity
//   - One warehouse + 3 bins
//   - One auction "ClovrBid Demo Auction" with 3 lots; each lot's
//     close_at = NOW + 30d (matches the auction's ends_at) so the lots
//     actually open for bidding and the App Reviewer can place a bid
//
// Idempotent: re-running drops + re-creates the demo auction's lots so the
// reviewer always sees a fresh-looking auction. Operator and bidder rows
// persist across runs.
//
// Run with:
//   node scripts/seed-app-reviewer-fixtures.mjs
//
// Requires .env.smoke.local or env vars (explicit env wins over the file):
//   NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//   SUPABASE_ACCESS_TOKEN (or SUPABASE_MGMT_TOKEN), SUPABASE_PROJECT_REF
//
// Neither the URL nor the project ref has a default, deliberately. This repo
// was forked from ClovrBid, and a guessed target seeds demo fixtures into
// another company's production database. BinGo prod is npwseclcxcatjhgjrtwe.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = dirname(dirname(__filename));

// Load env from .env.smoke.local
const envPath = join(REPO_ROOT, '.env.smoke.local');
const env = {};
try {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}
// Explicit env wins over the file, matching the loaders in the sibling scripts.
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
// Audit C1 (2026-05-18): MGMT token was hard-coded here and committed
// to a public-ish repo. Token is being rotated — read from env going
// forward.
const MGMT_TOKEN = env.SUPABASE_MGMT_TOKEN || env.SUPABASE_ACCESS_TOKEN;
const PROJECT_REF = env.SUPABASE_PROJECT_REF;

if (!SERVICE_KEY) {
  console.error('FATAL: SUPABASE_SERVICE_ROLE_KEY missing from .env.smoke.local');
  process.exit(1);
}
if (!MGMT_TOKEN) {
  console.error('FATAL: SUPABASE_MGMT_TOKEN missing from .env.smoke.local');
  console.error('Get one at https://supabase.com/dashboard/account/tokens');
  process.exit(1);
}

// Both the auth admin API (by URL) and the Management API SQL endpoint (by
// ref) used to fall back to hardcoded ClovrBid values, this repo's upstream.
// A token with no target seeded demo operators, bidders and lots into another
// company's production database. This script writes; it does not guess.
if (!SUPABASE_URL || !PROJECT_REF) {
  console.error(
    '[seed-app-reviewer-fixtures] Supabase target is not fully set.\n\n' +
      `  NEXT_PUBLIC_SUPABASE_URL: ${SUPABASE_URL || '(missing)'}\n` +
      `  SUPABASE_PROJECT_REF:     ${PROJECT_REF || '(missing)'}\n\n` +
      '  This script will not guess which project to write to. Set both\n' +
      '  explicitly, in .env.smoke.local at the repo root or in the shell:\n\n' +
      '    NEXT_PUBLIC_SUPABASE_URL=https://npwseclcxcatjhgjrtwe.supabase.co\n' +
      '    SUPABASE_PROJECT_REF=npwseclcxcatjhgjrtwe\n\n' +
      '  BinGo prod is npwseclcxcatjhgjrtwe — confirm the target before seeding.',
  );
  process.exit(1);
}

// The auth user is created via the URL and the rows via the ref. If they name
// different projects the fixtures split across two databases. Refuse.
if (new URL(SUPABASE_URL).hostname !== `${PROJECT_REF}.supabase.co`) {
  console.error(
    `[seed-app-reviewer-fixtures] SUPABASE_PROJECT_REF (${PROJECT_REF}) does not\n` +
      `  match NEXT_PUBLIC_SUPABASE_URL (${SUPABASE_URL}). Fix one of them.`,
  );
  process.exit(1);
}

const REVIEWER_EMAIL = 'reviewer@clovrbid.com';
const REVIEWER_PASSWORD = 'ReviewMe2026Clovr!';
const STAFF_EMAIL = 'demo-staff@clovrbid.com';
const STAFF_PASSWORD = 'DemoStaff2026!';

const DEMO_OPERATOR_ID = '99999999-9999-9999-9999-999999999999';

async function adminCreateOrFindUser(email, password, role) {
  // Try to create. If 422 (already exists), look up by email.
  const createRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: { role, demo: true },
    }),
  });
  if (createRes.ok) {
    const j = await createRes.json();
    return j.id;
  }
  // 422 likely = email already registered. Look up.
  const listRes = await fetch(
    `${SUPABASE_URL}/auth/v1/admin/users?email=${encodeURIComponent(email)}`,
    { headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` } },
  );
  const list = await listRes.json();
  const user = list.users?.find((u) => u.email === email);
  if (!user) {
    throw new Error(`could not create or find ${email}: ${createRes.status}`);
  }
  // Update password so it matches what we want
  await fetch(`${SUPABASE_URL}/auth/v1/admin/users/${user.id}`, {
    method: 'PUT',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ password, email_confirm: true }),
  });
  return user.id;
}

async function runSql(sql, params = []) {
  // Supabase Management API → SQL editor endpoint
  const res = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${MGMT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query: sql }),
    },
  );
  const j = await res.json();
  if (j.message && j.message.startsWith('Failed')) {
    throw new Error(`SQL failed: ${j.message}`);
  }
  return j;
}

(async () => {
  console.log('Seeding App Reviewer fixtures...');

  // 1. Create auth users
  console.log('  → creating reviewer + demo-staff auth users');
  const reviewerId = await adminCreateOrFindUser(REVIEWER_EMAIL, REVIEWER_PASSWORD, 'bidder');
  const staffId = await adminCreateOrFindUser(STAFF_EMAIL, STAFF_PASSWORD, 'operator-admin');
  console.log(`    reviewer:    ${reviewerId}`);
  console.log(`    demo-staff:  ${staffId}`);

  // 2. Upsert operator
  console.log('  → upserting Demo Auctioneer operator');
  await runSql(`
    INSERT INTO operators (
      id, slug, business_name, legal_name, contact_email, code, status,
      stripe_onboarding_complete, stripe_onboarding_skipped,
      monthly_subscription_cents, application_fee_bps, default_buyer_premium_bps,
      default_soft_close_minutes, settlement_hold_days, next_lot_seq,
      pro_enabled, pro_monthly_cents, pro_early_access_minutes,
      pro_msrp_filter_enabled, pro_last_chance_members_only,
      bidder_features, monthly_ai_budget_cents, ai_billing_markup_bps,
      subscription_tier, founder_pricing, is_demo
    )
    VALUES (
      '${DEMO_OPERATOR_ID}', 'demo', 'Demo Auctioneer', 'Demo Auctioneer LLC',
      '${STAFF_EMAIL}', 'DEMO', 'active',
      TRUE, TRUE,
      9900, 250, 1500,
      3, 4, 1,
      FALSE, 0, 0, FALSE, FALSE,
      '{}'::jsonb, 100000, 2500,
      'starter', TRUE, TRUE
    )
    ON CONFLICT (id) DO UPDATE SET
      business_name = EXCLUDED.business_name,
      status        = 'active',
      stripe_onboarding_complete = TRUE,
      stripe_onboarding_skipped  = TRUE,
      -- H4-c: mark demo operator hidden from the public storefront (visible
      -- only to reviewer bidders). Migration 0181 added operators.is_demo.
      is_demo       = TRUE;
  `);

  // 3. operator_users join (staff is admin)
  console.log('  → linking staff user to operator');
  await runSql(`
    INSERT INTO operator_users (id, operator_id, user_id, role, email, display_name)
    VALUES (gen_random_uuid(), '${DEMO_OPERATOR_ID}', '${staffId}', 'admin', '${STAFF_EMAIL}', 'Demo Staff')
    ON CONFLICT DO NOTHING;
  `);

  // 4. Warehouse + bins
  console.log('  → creating warehouse + 3 bins');
  await runSql(`
    INSERT INTO warehouses (id, operator_id, name, address_line1, city, state, postal_code, country, timezone, pickup_hours)
    VALUES (
      '88888888-8888-8888-8888-888888888888'::uuid,
      '${DEMO_OPERATOR_ID}',
      'Demo Warehouse',
      '123 Demo Street',
      'Demo City',
      'AR',
      '72701',
      'US',
      'America/Chicago',
      '{"mon":[{"open":"09:00","close":"17:00"}],"tue":[{"open":"09:00","close":"17:00"}],"wed":[{"open":"09:00","close":"17:00"}],"thu":[{"open":"09:00","close":"17:00"}],"fri":[{"open":"09:00","close":"17:00"}],"sat":[],"sun":[]}'::jsonb
    )
    ON CONFLICT (id) DO NOTHING;

    INSERT INTO bins (id, warehouse_id, code, aisle, bay, level, position, x_px, y_px, qr_token)
    VALUES
      ('77777777-7777-7777-7777-777777777771', '88888888-8888-8888-8888-888888888888', 'A-01-1-1', 'A', 1, 1, 1, 100, 100, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa01'),
      ('77777777-7777-7777-7777-777777777772', '88888888-8888-8888-8888-888888888888', 'A-02-1-1', 'A', 2, 1, 1, 200, 100, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa02'),
      ('77777777-7777-7777-7777-777777777773', '88888888-8888-8888-8888-888888888888', 'A-03-1-1', 'A', 3, 1, 1, 300, 100, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaa03')
    ON CONFLICT (id) DO NOTHING;
  `);

  // 5. Bidder row (reviewer) — birth_date set so age gate passes
  console.log('  → upserting reviewer bidder row');
  await runSql(`
    INSERT INTO bidders (id, email, display_name, birth_date, identity_verified_at, is_reviewer)
    VALUES (
      '${reviewerId}', '${REVIEWER_EMAIL}', 'App Reviewer',
      '1990-01-01', now(), TRUE
    )
    ON CONFLICT (id) DO UPDATE SET
      email = EXCLUDED.email,
      display_name = EXCLUDED.display_name,
      identity_verified_at = now(),
      -- H4-c: mark this account as the app reviewer so it can read the demo
      -- operator's hidden auctions/lots. Migration 0181 added bidders.is_reviewer.
      is_reviewer = TRUE,
      deleted_at = NULL;
  `);

  // 6. Tear down any prior demo auction so re-runs are fresh
  console.log('  → tearing down old demo auction (if any)');
  await runSql(`
    DELETE FROM bids WHERE lot_id IN (
      SELECT id FROM lots WHERE operator_id = '${DEMO_OPERATOR_ID}'
    );
    DELETE FROM lots WHERE operator_id = '${DEMO_OPERATOR_ID}';
    DELETE FROM auctions WHERE operator_id = '${DEMO_OPERATOR_ID}';
  `);

  // 7. Auction: opens immediately, closes in 30 days
  console.log('  → creating demo auction');
  const auctionRes = await runSql(`
    INSERT INTO auctions (
      id, operator_id, warehouse_id, title, description, status,
      starts_at, ends_at, soft_close_minutes, close_stagger_seconds,
      pickup_starts_at, pickup_ends_at, buyer_premium_bps, format
    )
    VALUES (
      gen_random_uuid(), '${DEMO_OPERATOR_ID}',
      '88888888-8888-8888-8888-888888888888',
      'ClovrBid Demo Auction — App Review',
      'Permanent demo auction for Apple + Google reviewers. See review notes for details.',
      'scheduled',
      now(), now() + INTERVAL '30 days',
      3, 0,
      now() + INTERVAL '31 days', now() + INTERVAL '37 days',
      1500, 'standard'
    )
    RETURNING id;
  `);
  const auctionId = auctionRes[0]?.id;
  console.log(`    auction:     ${auctionId}`);

  // 8. Three lots, each in a different bin
  console.log('  → creating 3 lots');
  await runSql(`
    WITH next_codes AS (
      SELECT generate_series(1, 3) AS seq
    )
    INSERT INTO lots (
      id, operator_id, auction_id, warehouse_id,
      lot_code, title, description, condition,
      msrp_cents, starting_bid_cents, status, lot_number,
      photo_urls, source, close_at
    )
    SELECT
      gen_random_uuid(),
      '${DEMO_OPERATOR_ID}',
      '${auctionId}',
      '88888888-8888-8888-8888-888888888888',
      'DEMO-' || lpad(nc.seq::text, 6, '0'),
      CASE nc.seq
        WHEN 1 THEN 'Stanley FATMAX 25ft Tape Measure'
        WHEN 2 THEN 'Sony WH-1000XM4 Wireless Headphones'
        WHEN 3 THEN 'KitchenAid Artisan 5-Quart Stand Mixer (Empire Red)'
      END,
      CASE nc.seq
        WHEN 1 THEN 'Open-box. Tested, all features work. Original packaging slightly damaged.'
        WHEN 2 THEN 'Customer return. Like-new condition with original box, cable, and case.'
        WHEN 3 THEN 'Open-box from a returns liquidation. Visual inspection — appears unused. No accessories beyond bowl + paddle.'
      END,
      (CASE nc.seq
        WHEN 1 THEN 'open_box'
        WHEN 2 THEN 'appears_new'
        WHEN 3 THEN 'open_box'
      END)::lot_condition,
      CASE nc.seq WHEN 1 THEN 2999 WHEN 2 THEN 34999 WHEN 3 THEN 44999 END,
      CASE nc.seq WHEN 1 THEN 100 WHEN 2 THEN 500 WHEN 3 THEN 2000 END,
      'scheduled',
      nc.seq::int,
      ARRAY[
        'https://m.media-amazon.com/images/I/71vRZjlhDmL._AC_SL1500_.jpg'
      ],
      'demo-fixture',
      -- close_at must be set or the lot is invisible to open_due_lots
      -- (close_at > now()) and never opens. Match the auction's ends_at
      -- (now + 30d) so reviewer-visible lots are live for the full window.
      -- Belt-and-suspenders with mig 0179's default-on-attach trigger.
      now() + INTERVAL '30 days'
    FROM next_codes nc
    RETURNING lot_code, title;
  `);

  // 9. Make sure the auction's pickup window is forward-dated correctly
  // and the auction is in the right status
  await runSql(`
    UPDATE auctions SET status = 'scheduled' WHERE id = '${auctionId}';
  `);

  console.log();
  console.log('============================================');
  console.log('Demo reviewer fixtures READY');
  console.log('============================================');
  console.log(`  Reviewer login:   ${REVIEWER_EMAIL} / ${REVIEWER_PASSWORD}`);
  console.log(`  Demo operator:    Demo Auctioneer (${DEMO_OPERATOR_ID})`);
  console.log(`  Demo staff:       ${STAFF_EMAIL} / ${STAFF_PASSWORD}`);
  console.log(`  Auction ID:       ${auctionId}`);
  console.log(`  Auction closes:   ${new Date(Date.now() + 30 * 86400_000).toISOString()}`);
  console.log();
  console.log('Reviewer notes paste-ready at: docs/APP_REVIEWER_NOTES.md');
})().catch((e) => {
  console.error('FAIL:', e);
  process.exit(1);
});
