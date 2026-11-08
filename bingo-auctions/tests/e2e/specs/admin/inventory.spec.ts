// tests/e2e/specs/admin/inventory.spec.ts
//
// /lotting/inventory — the page the user was specifically confused
// about. Verifies the strict-C architecture is reflected in the UI.

import { test, expect } from '../../fixtures/sim';

test.describe('inventory page', () => {
  test('renders heading + filter pills', async ({ page }) => {
    await page.goto('/lotting/inventory');
    await expect(page.getByRole('heading', { name: /Inventory/i }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: /^All\b/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /Pending intake/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /In inventory/i })).toBeVisible();
  });

  test('Total count = sum of (pending + in_inventory) tiles', async ({ page }) => {
    await page.goto('/lotting/inventory');
    await page.getByRole('heading', { name: /Inventory/i }).first().waitFor();

    // Read all three Stat tiles in one DOM pass. The Stat tile renders
    // as <div container><div>{label}</div><div>{value}</div></div>; we
    // look for a leaf div whose text content is exactly the label
    // (avoiding the filter pill, whose label is "Pending intake (3)").
    const counts = await page.evaluate((labels: string[]) => {
      const out: Record<string, number | null> = {};
      const allDivs = Array.from(document.querySelectorAll('div'));
      for (const label of labels) {
        const labelEl = allDivs.find(
          (el) => el.children.length === 0 && (el.textContent || '').trim() === label,
        );
        if (!labelEl || !labelEl.nextElementSibling) {
          out[label] = null;
          continue;
        }
        const valText = (labelEl.nextElementSibling.textContent || '').trim();
        const n = parseInt(valText.replace(/,/g, ''), 10);
        out[label] = Number.isFinite(n) ? n : null;
      }
      return out;
    }, ['Total', 'Pending intake', 'In inventory']);

    expect(counts['Total'], 'Total tile present').not.toBeNull();
    expect(counts['Pending intake'], 'Pending intake tile present').not.toBeNull();
    expect(counts['In inventory'], 'In inventory tile present').not.toBeNull();
    expect(counts['Total']).toBe((counts['Pending intake'] ?? 0) + (counts['In inventory'] ?? 0));
  });

  test('filter pill query string survives navigation', async ({ page }) => {
    await page.goto('/lotting/inventory');
    await page.getByRole('link', { name: /In inventory/i }).click();
    await expect(page).toHaveURL(/status=in_inventory/);
    await expect(page.getByRole('heading', { name: /Inventory/i }).first()).toBeVisible();
  });

  test('search by lot_code prefix filters the table', async ({ page, sim }) => {
    test.skip(!sim.quickLotCode, 'no SIM quickLot to search for');
    await page.goto('/lotting/inventory');

    const search = page.locator('input[type="search"][name="q"]').first();
    await search.fill(sim.quickLotCode!);
    await page.getByRole('button', { name: /Apply/i }).click();

    await expect(page).toHaveURL(/[?&]q=/);
    await expect(page.getByText(sim.quickLotCode!, { exact: true }).first()).toBeVisible();
  });

  test('searching nonsense renders empty state', async ({ page }) => {
    await page.goto('/lotting/inventory?q=ZZZZ-NO-SUCH-LOT-ZZZZ');
    await expect(page.getByRole('heading', { name: /Inventory/i }).first()).toBeVisible();
    const rows = await page.locator('tbody tr').count();
    expect(rows).toBeLessThanOrEqual(0);
  });
});
