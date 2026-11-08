// Playwright fixture — pre-authenticated bidder context.
//
// Replaces the inline `goto /login → fill → click → waitForURL` dance
// inside individual test bodies. Tests that need a signed-in bidder
// just do:
//
//   import { test } from '../fixtures/bidder-auth';
//   test('...', async ({ bidderPage }) => { await bidderPage.goto(...); });
//
// Why a fixture (not a `beforeEach`):
//   - Per-test isolation: each test gets a fresh browser context with
//     fresh cookies, so a flaky test can't poison a sibling.
//   - Lazy + cached: the fixture only runs when a test requests it.
//   - Composition: future fixtures (operator, super-admin) layer on
//     top with the same pattern.
//
// Required env (same as the global-setup script):
//   E2E_TEST_USER_PASSWORD — synthetic bidder password
//   The bidder email is hard-coded to playwright-e2e@clovrbid.test
//   because the global-setup script seeds exactly that account.

import { test as base, type Page } from '@playwright/test';

const TEST_EMAIL = 'playwright-e2e@clovrbid.test';

interface BidderAuthFixtures {
  /**
   * A browser page already signed in as the synthetic test bidder.
   * Each test gets its own isolated browser context — no cookie leaks
   * between tests, no need to sign out at the end.
   */
  bidderPage: Page;
}

export const test = base.extend<BidderAuthFixtures>({
  bidderPage: async ({ page }, use) => {
    const password = process.env.E2E_TEST_USER_PASSWORD;
    if (!password) {
      throw new Error('E2E_TEST_USER_PASSWORD must be set for bidderPage fixture');
    }

    // Use the real /login UI so the fixture exercises the same auth
    // cookie path a human bidder would use. The form has no <label>
    // elements — we select by input type, which is stable across
    // restyles.
    await page.goto('/login');
    await page.locator('input[type="email"]').fill(TEST_EMAIL);
    await page.locator('input[type="password"]').fill(password);
    await Promise.all([
      page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 15_000 }),
      page.getByRole('button', { name: /^sign in$/i }).click(),
    ]);

    // eslint-disable-next-line react-hooks/rules-of-hooks -- Playwright fixture parameter named `use`, not React's `use()` hook.
    await use(page);
    // Cleanup is automatic — Playwright tears down the context after
    // the test completes.
  },
});

export { expect } from '@playwright/test';
