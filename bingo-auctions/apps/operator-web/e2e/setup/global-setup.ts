// Playwright global setup — runs ONCE before any tests in any project.
//
// Idempotently ensures a synthetic bidder exists for e2e auth:
//   email:         playwright-e2e@clovrbid.test
//   password:      $E2E_TEST_USER_PASSWORD
//   bidders row:   birth_date set, no card on file, no stripe_customer_id
//                   (the card-flow test exercises the "no card yet" branch)
//
// Why a synthetic test user rather than a real account:
//   - The .test TLD is reserved and unreachable, so no real human gets
//     spam or stuck verification emails.
//   - email_confirm: true skips the email-confirmation step entirely.
//   - The synthetic user never has a payment method, so no real Stripe
//     state can leak.
//
// Why this lives in setup (not a migration):
//   - Supabase auth.users password hashing is done by gotrue, not by
//     plain SQL — the admin SDK is the supported path.
//   - The setup runs on every CI invocation, so credentials can rotate
//     without a migration deploy.

import { createClient } from '@supabase/supabase-js';
import { waitForBuild } from './wait-for-build';

const EMAIL = 'playwright-e2e@clovrbid.test';
const DISPLAY = 'Playwright Test Bidder';
const BIRTH = '1990-01-01';

export default async function globalSetup() {
  // FIRST, before any Supabase work: say which build of the site we are about
  // to test, and (when E2E_REQUIRE_BUILD is set) wait until prod is actually
  // serving the commit under test.
  //
  // This suite runs against prod but is triggered by the push to master, while
  // deploying is a separate manual workflow — so a spec asserting freshly
  // merged behaviour can run against the PREVIOUS build and fail for a reason
  // that has nothing to do with the code. On 2026-09-15 the MOB-01 run
  // finished 4m09s before the deploy that made it pass, and the red check
  // nearly got a working fix reverted off a live site. See wait-for-build.ts.
  //
  // Deliberately ahead of the auth setup: it is cheap, and "you are testing
  // yesterday's build" is more useful than a service-role error when both are
  // true.
  await waitForBuild(process.env.E2E_BASE_URL ?? 'https://bingoauctions.com');

  // Resolve env. We intentionally use a dedicated E2E_* prefix so a
  // misconfigured CI environment doesn't accidentally use production
  // service role keys for tests. The deploy workflow exports these as
  // GHA secrets explicitly to the e2e job only.
  const url = process.env.E2E_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey =
    process.env.E2E_SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  const password = process.env.E2E_TEST_USER_PASSWORD;

  if (!url) throw new Error('e2e: NEXT_PUBLIC_SUPABASE_URL or E2E_SUPABASE_URL must be set');
  if (!serviceKey) throw new Error('e2e: SUPABASE_SERVICE_ROLE_KEY must be set');
  if (!password) throw new Error('e2e: E2E_TEST_USER_PASSWORD must be set');

  const admin = createClient(url, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // Find existing user by email. listUsers paginates — and on 2026-07-05
  // launch weekend the auth user count crossed a single page, so the old
  // page-1-only lookup missed the test user and createUser failed with
  // "already registered" on every run. Walk ALL pages until found.
  let existingUserId: string | null = null;
  for (let page = 1; existingUserId === null; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`e2e: listUsers failed: ${error.message}`);
    const found = data.users.find((u) => u.email?.toLowerCase() === EMAIL);
    if (found) {
      existingUserId = found.id;
      break;
    }
    if (data.users.length < 1000) break; // last page, user genuinely absent
    if (page > 50) throw new Error('e2e: listUsers pagination ran away (>50k users?)');
  }

  if (existingUserId) {
    // Sync password + ensure email is confirmed in case it drifted.
    const { error } = await admin.auth.admin.updateUserById(existingUserId, {
      password,
      email_confirm: true,
    });
    if (error) throw new Error(`e2e: updateUser failed: ${error.message}`);
  } else {
    const { data, error } = await admin.auth.admin.createUser({
      email: EMAIL,
      password,
      email_confirm: true,
      user_metadata: { display_name: DISPLAY },
    });
    if (error) throw new Error(`e2e: createUser failed: ${error.message}`);
    existingUserId = data.user.id;
  }

  // Upsert the bidders row to a known state. We DELIBERATELY do NOT
  // set default_payment_method_id or stripe_customer_id — the card-flow
  // test asserts the "no card yet" branch renders the form, which is
  // the exact bug class we want to lock down.
  const { error: upsertErr } = await admin
    .from('bidders')
    .upsert(
      {
        id: existingUserId,
        email: EMAIL,
        display_name: DISPLAY,
        birth_date: BIRTH,
        default_payment_method_id: null,
        stripe_customer_id: null,
      },
      { onConflict: 'id' },
    );
  if (upsertErr) throw new Error(`e2e: bidders upsert failed: ${upsertErr.message}`);

  // eslint-disable-next-line no-console
  console.log(`[e2e setup] synthetic bidder ready: ${EMAIL} (user_id=${existingUserId})`);

  // ─────────────────────────────────────────────────────────────────────
  // Self-check: actually sign in with the password we just set.
  //
  // The 2026-05-22 launch lockout was made worse by a 2nd-order issue:
  // we discovered the e2e password wasn't working only after the
  // authenticated test failed with a vague "Invalid login credentials"
  // error. Adding a sign-in self-check here means a future password
  // rotation OR a Supabase auth-config drift (password policy, email
  // confirm requirements, etc.) fails LOUDLY in setup — before any
  // test runs — with an actionable error.
  //
  // Uses the gotrue /token endpoint directly (not supabase-js client)
  // so we're testing the exact same code path the browser will hit
  // when it submits the login form.
  // ─────────────────────────────────────────────────────────────────────
  const anonKey =
    process.env.E2E_SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!anonKey) {
    throw new Error(
      'e2e: NEXT_PUBLIC_SUPABASE_ANON_KEY (or E2E_SUPABASE_ANON_KEY) must be set so we can verify password signin works',
    );
  }
  const signinRes = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anonKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password }),
  });
  if (!signinRes.ok) {
    const body = await signinRes.text();
    throw new Error(
      `e2e: SELF-CHECK FAILED — synthetic bidder password works for admin but NOT for password signin. ` +
        `Supabase auth-config drift suspected (password policy, email-domain blocklist, etc.). ` +
        `Response ${signinRes.status}: ${body.slice(0, 300)}`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(`[e2e setup] self-check passed: password signin succeeded for ${EMAIL}`);
}
