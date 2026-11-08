// tests/e2e/specs/admin/auction-builder.spec.ts
//
// /auctions — list + new auction. Phase 3 happy-path UI coverage.

import { test, expect } from '../../fixtures/sim';

test.describe('auctions', () => {
  test('/auctions list renders', async ({ page }) => {
    const resp = await page.goto('/auctions');
    expect(resp?.status() ?? 0).toBeLessThan(400);
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.locator('h1, h2').first()).toBeVisible();
  });

  test('/auctions/new renders an auction-creation form', async ({ page }) => {
    const resp = await page.goto('/auctions/new');
    expect(resp?.status() ?? 0).toBeLessThan(400);
    await expect(page).not.toHaveURL(/\/login/);
    const inputs = page.locator('input[type="text"], input:not([type])');
    await expect(inputs.first()).toBeVisible({ timeout: 10_000 });
  });
});
