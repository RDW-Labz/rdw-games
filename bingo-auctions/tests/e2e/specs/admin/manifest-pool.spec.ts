// tests/e2e/specs/admin/manifest-pool.spec.ts
//
// /imports/[id] — manifest pool view. Verifies the strict-C
// architecture is reflected in the UI.

import { test, expect } from '../../fixtures/sim';

test.describe('manifest pool', () => {
  test('imports list page loads', async ({ page }) => {
    const resp = await page.goto('/imports');
    expect(resp?.status() ?? 0).toBeLessThan(400);
    await expect(page).not.toHaveURL(/\/login/);
    await expect(page.locator('h1, h2').first()).toBeVisible();
  });

  test('a SIM import appears in the imports list', async ({ page }) => {
    await page.goto('/imports');
    await expect(page.getByText(/sim-manifest/i).first()).toBeVisible({ timeout: 10_000 });
  });

  test('SIM import detail loads (no premature lot CTA)', async ({ page }) => {
    await page.goto('/imports');
    const link = page.getByRole('link').filter({ hasText: /sim-manifest/i }).first();
    await link.click();
    await expect(page).toHaveURL(/\/imports\/[0-9a-f-]+/);
    await page.waitForLoadState('networkidle');

    // Strict-C invariant: NO "Lot N selected" button. If this fails,
    // operator-web's manifest pool UI still has the 0029-era CTA that
    // 0059 deprecated.
    const lotCtas = page.getByRole('button').filter({ hasText: /Lot (N |\d+ )?selected/i });
    const count = await lotCtas.count();
    expect(count, 'Lot-selected button should be removed per 0059 architecture').toBe(0);
  });
});
