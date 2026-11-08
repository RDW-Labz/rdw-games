// Playwright config for operator-web e2e smoke tests.
//
// Goals (intentionally narrow at launch):
//   1. Catch the 2026-05-22 lockout class — verify the bidder card page
//      renders the form (not "Payments unavailable") AND that the
//      Stripe publishable key reaches the rendered React payload.
//   2. Catch routing regressions — public pages return 200, auth gates
//      redirect correctly, no 500s on critical paths.
//   3. Establish infrastructure for future e2e tests with zero ceremony.
//
// Target: the deployed prod site (https://bingoauctions.com) by default. We
// run AFTER the deploy step in CI so tests exercise the same Worker the
// public hits. Local dev can override via E2E_BASE_URL.
//
// Why prod (not preview/staging): we don't have a staging env yet, and
// every smoke we care about is a read-only navigation that doesn't
// mutate prod state. The one test that signs in does so as a dedicated
// `playwright-e2e@clovrbid.test` synthetic bidder created by
// e2e/setup/global-setup.ts — non-real email (.test is a reserved,
// unreachable TLD), no payment method, never used outside e2e.

// 2026-09-14: this defaulted to https://clovrbid.com, the pre-rename domain,
// long after the BinGo fork moved to bingoauctions.com. CI always passes
// E2E_BASE_URL explicitly (see .github/workflows/e2e.yml, whose own comment
// says "this is the BinGo fork -- never clovrbid.com"), so the suite was fine
// there and nothing surfaced the drift. A local `npm run e2e` with no env var
// pointed the whole suite at a domain this project does not own.
//
// NOTE: `playwright-e2e@clovrbid.test` above is NOT stale and must NOT be
// swept with the domain. It is a synthetic login identity, not a URL: the
// address is a literal key matched in e2e/setup/global-setup.ts,
// e2e/fixtures/bidder-auth.ts and e2e/card-flow.spec.ts, and renaming it in
// one place breaks sign-in for every e2e run. `.test` is a reserved TLD, so
// it is also deliberately unreachable.
//
// (While fixing the URL above I checked this line's original claim that the
// bidder was "seeded via migration 0123". It was wrong -- 0123 is
// 0123_bidder_stripe_key_mode.sql, and global-setup.ts states outright why
// the user "lives in setup (not a migration)": gotrue hashes the password,
// so plain SQL cannot create it. Corrected above.)

import { defineConfig, devices } from '@playwright/test';

// Default is bingoauctions.com — this is the BinGo fork, and clovrbid.com is a
// DIFFERENT live site. CI always sets E2E_BASE_URL explicitly (see e2e.yml,
// whose comment already says "never clovrbid.com"), so this default only bit
// ad-hoc local runs, which silently tested the wrong company's storefront.
// Kept in step with e2e/setup/wait-for-build.ts, which falls back to the same
// value when resolving /api/version.
const BASE_URL = process.env.E2E_BASE_URL ?? 'https://bingoauctions.com';

export default defineConfig({
  testDir: './e2e',
  // Don't recurse into setup helpers — the setup file isn't itself a test.
  testIgnore: ['**/setup/**', '**/helpers/**'],
  // Global setup ensures the synthetic bidder + bidders row exist before
  // any test runs. Idempotent — safe to invoke on every CI run.
  globalSetup: require.resolve('./e2e/setup/global-setup'),
  // Tests must be deterministic — if one fails, we want the report,
  // not a flake-mask retry. Bump if a particular test proves flaky.
  retries: 0,
  // Single worker for now — our tests are dependency-ordered (auth
  // setup must complete before assertions) and the parallelism gain
  // doesn't justify the cookie-jar coordination cost at our scale.
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: BASE_URL,
    // Capture trace + screenshot + video + network logs on failure so a
    // CI failure is debuggable from the GHA artifacts page without
    // re-running locally. Video is retain-on-failure (not 'on') because
    // recording every test wastes storage and the cases where we need
    // a video are the ones that failed.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // Generous timeout — CF cold-start can add a second or two.
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  expect: {
    timeout: 10_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
