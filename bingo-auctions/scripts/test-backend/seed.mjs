#!/usr/bin/env node
// Seed the ISOLATED test/sandbox Supabase backend with synthetic data so the
// authenticated Robo crawl (+ future Maestro authed flows + Playwright e2e) can
// log in and crawl PAST the login screen. Nothing here is real: fake operator,
// fake auction, fake lots, one fake dual-role (bidder + operator-admin) user.
// Re-runnable — idempotent upserts on fixed UUIDs.
//
// Usage:
//   SUPABASE_ACCESS_TOKEN=sbp_... node scripts/test-backend/seed.mjs <projectRef> [email] [password]
import process from 'node:process';

const ref = process.argv[2];
const email = process.argv[3] || 'robo@clovrbid.test';
const password = process.argv[4] || 'RoboCrawl!2026';
const mgmt = process.env.SUPABASE_ACCESS_TOKEN;
if (!ref || !mgmt) {
  console.error('Need <projectRef> arg and SUPABASE_ACCESS_TOKEN env var.');
  process.exit(1);
}

const projectUrl = `https://${ref}.supabase.co`;
const mgmtHeaders = { Authorization: `Bearer ${mgmt}`, 'Content-Type': 'application/json' };

async function runSql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: 'POST',
    headers: mgmtHeaders,
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`SQL HTTP ${res.status}: ${text.slice(0, 1000)}`);
  return text ? JSON.parse(text) : null;
}

// 1. Fetch keys (service_role for Auth Admin API; never printed).
const keys = await (
  await fetch(`https://api.supabase.com/v1/projects/${ref}/api-keys?reveal=true`, {
    headers: mgmtHeaders,
  })
).json();
const serviceRole = keys.find((k) => k.name === 'service_role')?.api_key;
const publishable =
  keys.find((k) => k.name === 'default' && String(k.api_key).startsWith('sb_publishable_'))?.api_key ||
  keys.find((k) => k.name === 'anon')?.api_key;
if (!serviceRole) {
  console.error('No service_role key returned.');
  process.exit(1);
}

// 2. Create (or reset) the auth user.
const adminHeaders = {
  apikey: serviceRole,
  Authorization: `Bearer ${serviceRole}`,
  'Content-Type': 'application/json',
};
let uid;
const createRes = await fetch(`${projectUrl}/auth/v1/admin/users`, {
  method: 'POST',
  headers: adminHeaders,
  body: JSON.stringify({ email, password, email_confirm: true }),
});
if (createRes.ok) {
  uid = (await createRes.json()).id;
  console.log('Created auth user', email, uid);
} else {
  const list = await (
    await fetch(`${projectUrl}/auth/v1/admin/users?per_page=200`, { headers: adminHeaders })
  ).json();
  const u = (list.users || list).find((x) => x.email === email);
  if (!u) throw new Error(`create failed (HTTP ${createRes.status}) and user not found`);
  uid = u.id;
  await fetch(`${projectUrl}/auth/v1/admin/users/${uid}`, {
    method: 'PUT',
    headers: adminHeaders,
    body: JSON.stringify({ password, email_confirm: true }),
  });
  console.log('Reused auth user', email, uid);
}

// 3. Seed synthetic rows (idempotent).
const OP = '00000000-0000-4000-8000-0000000000a1';
const WH = '00000000-0000-4000-8000-0000000000a2';
const AUC = '00000000-0000-4000-8000-0000000000a3';
const seedSql = `
insert into operators (id, slug, business_name, contact_email, code, status)
values ('${OP}','sandbox-auctions','Sandbox Auctions','${email}','SBX','active')
on conflict (id) do update set status='active';

insert into warehouses (id, operator_id, name, address_line1, city, state, postal_code, timezone)
values ('${WH}','${OP}','Sandbox Warehouse','1 Test St','Bentonville','AR','72712','America/Chicago')
on conflict (id) do nothing;

insert into auctions (id, operator_id, warehouse_id, title, starts_at, ends_at, pickup_starts_at, pickup_ends_at, status)
values ('${AUC}','${OP}','${WH}','Sandbox Live Auction', now()-interval '1 hour', now()+interval '7 days', now()+interval '8 days', now()+interval '14 days','live')
on conflict (id) do update set status='live', starts_at=now()-interval '1 hour', ends_at=now()+interval '7 days';

insert into lots (id, operator_id, auction_id, lot_code, title, status, starting_bid_cents)
select gen_random_uuid(), '${OP}', '${AUC}', 'SBX-'||lpad(g::text,6,'0'), 'Sandbox Lot '||g, 'live', 100
from generate_series(1,6) g
on conflict do nothing;

insert into bidders (id, email, display_name, birth_date, default_payment_method_id)
values ('${uid}', '${email}', 'Robo Tester', '1990-01-01', 'pm_sandbox_dummy')
on conflict (id) do update set default_payment_method_id='pm_sandbox_dummy', email=excluded.email;

insert into operator_users (operator_id, user_id, role, email)
values ('${OP}', '${uid}', 'admin', '${email}')
on conflict do nothing;

update platform_settings set payments_disabled=true;
`;
await runSql(seedSql);

// 4. Verify + report (publishable key is safe to print; it ships in the client).
const counts = await runSql(
  `select (select count(*) from auctions where status='live') live_auctions, (select count(*) from lots where status='live') live_lots, (select count(*) from operators where status='active') active_ops, (select payments_disabled from platform_settings limit 1) payments_disabled`,
);
console.log('Seed verify:', JSON.stringify(counts));
console.log('PUBLISHABLE_ANON_KEY=' + publishable);
console.log('SANDBOX_URL=' + projectUrl);
console.log('LOGIN_EMAIL=' + email);
console.log('DONE.');
