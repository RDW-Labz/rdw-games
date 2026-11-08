// MOB-01 — mobile filter sheet behaviour at phone width.
//
// These are interaction regressions that unit tests structurally cannot
// catch: a body scroll lock, a history entry, and a focusable close control
// only exist in a real browser. They are also the whole of the reported bug.
//
// What was wrong (all four symptoms, one component):
//   * The sheet covers 82vh and had NO close/apply control, so a category tap
//     filtered the grid invisibly behind it. Reported as "the category filter
//     doesn't work" — it always worked, the result was never visible.
//   * The drag handle was an aria-hidden decorative div. It looked draggable,
//     so people dragged it, nothing happened, and the sheet read as stuck.
//   * No body scroll lock, so dragging scrolled the page behind the sheet.
//   * `mobileOpen` was React state with no history entry, so Android Back
//     left the storefront entirely instead of closing the sheet.
//
// Runs against the deployed site (see playwright.config.ts) after deploy, so
// it turns green once this ships. No seeded data required — every assertion
// here holds whether or not the catalogue has lots, which matters because the
// local seed is broken and prod inventory turns over constantly.

import { test, expect, type Page } from '@playwright/test';

// The Filters button is in the server HTML, so it can be clicked before React
// has hydrated it; that click does nothing and the sheet never opens (run
// 36594423087, 2026-09-29: the page was fully drawn, the sheet absent). Retry
// the click until the sheet is up, within the normal 10 s budget, so a lost
// pre-hydration click is not a failure but a sheet that never opens still is.
async function openFilters(page: Page) {
  const trigger = page.getByRole('button', { name: /Filters/i }).first();
  await expect(trigger).toBeVisible();
  const sheet = page.getByRole('dialog', { name: 'Filters' });
  await expect(async () => {
    if (!(await sheet.isVisible())) await trigger.click();
    await expect(sheet).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 10_000 });
  return sheet;
}


test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

test.describe('MOB-01 mobile filter sheet', () => {
  test('opens, locks the page behind it, and closes by every control', async ({
    page,
  }) => {
    await page.goto('/browse', { waitUntil: 'domcontentloaded' });

    const sheet = await openFilters(page);

    // The page behind must not scroll while the sheet is up.
    await expect
      .poll(() => page.evaluate(() => document.body.style.overflow))
      .toBe('hidden');

    // The footer control is the feedback that was missing entirely. Its label
    // is asserted by the unit suite (filter-sheet-label.test.ts); here we only
    // require that an actionable control exists at all.
    const footer = sheet.locator('button').last();
    await expect(footer).toBeVisible();

    // Escape closes, and the lock is released rather than stranding the page.
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect
      .poll(() => page.evaluate(() => document.body.style.overflow))
      .not.toBe('hidden');
  });

  test('the drag handle is a real, accessible close control', async ({ page }) => {
    await page.goto('/browse', { waitUntil: 'domcontentloaded' });
    const sheet = await openFilters(page);

    // Previously an aria-hidden <div> — invisible to this query by design.
    const handle = page.getByRole('button', { name: 'Close filters' });
    await expect(handle).toBeVisible();
    await handle.click();
    await expect(sheet).toBeHidden();
  });

  test('Back closes the sheet instead of leaving the storefront', async ({
    page,
  }) => {
    await page.goto('/browse', { waitUntil: 'domcontentloaded' });
    const sheet = await openFilters(page);

    await page.goBack();
    await expect(sheet).toBeHidden();
    // The customer must still be on the storefront, not bounced off it.
    expect(page.url()).toContain('/browse');
  });
});
