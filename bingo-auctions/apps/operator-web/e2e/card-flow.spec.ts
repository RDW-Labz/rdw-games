// e2e: bidder card-on-file flow smoke test (Square Web Payments SDK).
//
// LOCKS THE 2026-05-22 LAUNCH LOCKOUT CLASS (Square edition):
//   The original incident was that the bidder card page rendered as
//   "Payments unavailable" (or worse, looked like it worked while
//   orphaning persisted IDs) because the payment SDK's public key wasn't
//   reaching the client. Post the 6/30 Square cutover the same class
//   exists with SQUARE_APPLICATION_ID / SQUARE_LOCATION_ID (and the
//   2026-07-01 incident was exactly that — a sandbox app id in the prod
//   secret). This test verifies, in a real browser, that:
//     1. The form actually renders (not the "Payments unavailable" panel).
//     2. The Square application id (sq0idp-…) is present in the rendered
//        page payload (server passed the prop).
//     3. The Square card element mounts (a squarecdn.com iframe attaches
//        inside #sq-card-container).
//
// If any of those assertions break in a future change, this test fails
// in CI before the deploy lands. That is the entire point.

import { expect, test } from '@playwright/test';

const TEST_EMAIL = 'playwright-e2e@clovrbid.test';

test.describe('Public routes', () => {
  // Cheap smoke — every route returns 200/3xx, no 500s. Catches build
  // breakage independent of the auth path below.
  for (const path of ['/', '/final-call', '/login', '/signup']) {
    test(`GET ${path} renders without server error`, async ({ page }) => {
      const response = await page.goto(path);
      expect(response, `expected response for ${path}`).not.toBeNull();
      expect(response!.status(), `${path} should not 5xx`).toBeLessThan(500);
    });
  }

  test('unauthenticated /bidder/onboarding/payment-method redirects to /signup', async ({ page }) => {
    const response = await page.goto('/bidder/onboarding/payment-method');
    // Either Playwright followed the redirect (final URL ends at /signup)
    // OR the response is a 307. Both are acceptable.
    const finalUrl = page.url();
    expect(finalUrl, `expected redirect; got ${finalUrl}`).toMatch(/\/(signup|login)/);
    expect(response?.status()).toBeLessThan(500);
  });
});

test.describe('Authenticated bidder card flow', () => {
  test('authenticated bidder sees the card form (NOT "Payments unavailable") and Square app id is present', async ({
    page,
  }) => {
    // 1. Sign in via the real /login UI. This exercises the same auth
    //    cookie path a human bidder would use, so a regression in the
    //    cookie-setting middleware would also be caught here. The form
    //    uses placeholders (no <label>), so we select by input type +
    //    placeholder which is stable across UI restyles.
    await page.goto('/login');
    await page.locator('input[type="email"]').fill(TEST_EMAIL);
    await page.locator('input[type="password"]').fill(process.env.E2E_TEST_USER_PASSWORD ?? '');
    await Promise.all([
      page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 15_000 }),
      page.getByRole('button', { name: /^sign in$/i }).click(),
    ]);

    // 2. Navigate to the card page. The synthetic bidder has
    //    default_payment_method_id=NULL, so the form (not the banner)
    //    is what we expect to see.
    await page.goto('/bidder/onboarding/payment-method');

    // 3. ASSERTION A — the form rendered.
    //    "Save a payment method" is the page H1 when there's no card.
    //    "Payments unavailable" is the fallback when the publishable
    //    key is missing — its presence is the exact bug we're guarding.
    const formHeading = page.getByRole('heading', { name: /save a payment method/i });
    const unavailableHeading = page.getByRole('heading', { name: /payments unavailable/i });

    await expect(unavailableHeading, 'page rendered the "Payments unavailable" fallback — publishable key did not reach the server component').not.toBeVisible({
      timeout: 5_000,
    });
    await expect(formHeading, 'page did not render the card form').toBeVisible({ timeout: 10_000 });

    // 4. ASSERTION B — the Square application id is in the rendered HTML.
    //    The server component passes SQUARE_APPLICATION_ID as a prop to
    //    SquareCardForm, which serializes it into the React payload sent
    //    to the client. A regression that drops the prop (or ships a
    //    sandbox id, sq0idb-) would change/blank this.
    const html = await page.content();
    expect(html, 'no production Square application id (sq0idp-…) in page HTML — server failed to pass the prop').toMatch(
      /sq0idp-[A-Za-z0-9_-]{8,}/,
    );

    // 5. ASSERTION C — the Square card element actually mounted.
    //    SquareCardForm loads web.squarecdn.com/v1/square.js and
    //    card.attach('#sq-card-container') injects the card-entry iframe
    //    (served from squarecdn.com). If the application/location id is
    //    invalid or the SDK fails init, NO iframe attaches at all — which
    //    is exactly the lockout class this test guards.
    const squareIframe = page.locator('#sq-card-container iframe');
    await expect(squareIframe.first(), 'no Square card iframe attached — Web Payments SDK init likely failed').toBeAttached({
      timeout: 20_000,
    });
    expect(
      await squareIframe.count(),
      'expected at least one iframe inside #sq-card-container; got zero',
    ).toBeGreaterThanOrEqual(1);
  });
});
