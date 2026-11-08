// tests/e2e/specs/admin/auth.spec.ts
//
// Admin auth + post-login routing. Uses storageState from global-setup.
// Project gating is in playwright.config.ts (testMatch).

import { test, expect } from '../../fixtures/sim';

// The fixtures path is one level deeper now; rewrite the import.
// Eslint can't see the import wasn't broken — runtime resolution will.

test('admin lands on a recognized post-auth route', async ({ page }) => {
  await page.goto('/');
  await expect(page).not.toHaveURL(/\/login/);
  const url = page.url();
  const ok = /\/(dashboard|lotting|onboarding|imports|auctions|inventory|warehouses)\b/.test(url) || url.endsWith('/');
  expect(ok, 'expected post-auth route, got ' + url).toBe(true);
});

test('admin can open /lotting/inventory without bouncing to login', async ({ page }) => {
  const resp = await page.goto('/lotting/inventory');
  expect(resp?.status() ?? 0).toBeLessThan(400);
  await expect(page).not.toHaveURL(/\/login/);
  await expect(page.getByRole('heading', { name: /Inventory/i }).first()).toBeVisible();
});
