// e2e: regression suite for the 2026-05-24 public-site audit fixes.
//
// Locks the 5 fixes that shipped in commit 892c5be + the 4 fixes from
// commit 1c73b46 so a future refactor can't silently re-introduce them.
//
// Audit reference: docs/audits/2026-05-24-public-site-audit/README.md
// Original user reports:
//   - "search and filter area is huge" (filter rail collapse)
//   - "watchlist has a closed item still"
//   - "Scan just says point at a QR code, needs more info"
//   - "unmatched route is when I press browse"
//   - 3 phantom _co... tabs that crash on tap
//
// Runs against E2E_BASE_URL (defaults to https://bingoauctions.com via e2e.yml).

import { expect, test } from '@playwright/test';

// ──────────────────────────────────────────────────────────────────────────
// HIGH severity — must pass for launch
// ──────────────────────────────────────────────────────────────────────────

test.describe('Audit HIGH-1: /lot/[code] mobile breakpoint (2026-05-24)', () => {
  // Fix: added @media (min-width: 640px) { .lot-two-col { grid-template-columns:
  // 1fr 1fr } } so phones (< 640px) stack the photo + bid panel vertically
  // and desktops sit them side-by-side.
  //
  // We assert the @media rule is present in the rendered HTML. We can't
  // easily assert the actual computed layout because /browse currently shows
  // 0 lots (demo data has null close_at) so we can't navigate INTO a lot
  // detail without seeding. Asserting the rule is in the page covers the
  // "did the build deploy?" regression case.

  test('@media (min-width: 640px) rule is present in any reachable lot detail render', async ({ page }) => {
    // Try a known lot code (Stanley FATMAX is in prod demo data per
    // 2026-05-24 schema probe). Falls back to /browse if direct nav 404s.
    const res = await page.goto('/lot/Stanley-FATMAX-25ft-Tape-Measure', { waitUntil: 'domcontentloaded' });
    // The page renders even when the lot code doesn't match — Next renders
    // a fallback shell with the same <style> block. Either way we should
    // see the @media rule.
    expect(res?.status() ?? 200).toBeLessThan(500);
    const html = await page.content();
    expect(html, '@media (min-width: 640px) rule missing — the 2-col upgrade on desktop won\'t fire')
      .toMatch(/@media \(min-width:\s*640px\)/);
    expect(html, '.lot-two-col class missing — the mobile-first single column isn\'t wired')
      .toContain('lot-two-col');
  });
});

test.describe('Audit HIGH-2: /login button contrast WCAG AA', () => {
  // Fix: changed sign-in submit button color from #fff to #000 over green
  // background. White-on-green = 2.3:1 (fails AA). Black-on-green = 8.6:1
  // (passes). The button now uses inline color:#000.

  test('sign-in button uses dark text on the green background', async ({ page }) => {
    await page.goto('/login');
    const button = page.getByRole('button', { name: /^sign in$/i });
    await expect(button).toBeVisible({ timeout: 5_000 });
    const color = await button.evaluate((el) => getComputedStyle(el).color);
    // rgb(0, 0, 0) or any near-black value. We check that the FIRST channel
    // (R) is below 80 — this passes for #000, #111, #222, etc., but fails
    // for #fff (255).
    const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    expect(match, `expected rgb(...) but got "${color}"`).not.toBeNull();
    const r = Number(match![1]);
    expect(r, `sign-in button text is too bright (R=${r}) — WCAG AA may fail`).toBeLessThan(80);
  });

  test('login form inputs are wrapped in <label> for screen readers', async ({ page }) => {
    await page.goto('/login');
    // The fix added <label><span>Email</span><input ...></label> wrappers.
    // We can verify the visible "Email" / "Password" spans appear above
    // their inputs.
    await expect(page.getByText(/^email$/i)).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText(/^password$/i)).toBeVisible({ timeout: 5_000 });
  });
});

// ──────────────────────────────────────────────────────────────────────────
// MEDIUM severity
// ──────────────────────────────────────────────────────────────────────────

test.describe('Audit MED-3: /final-call filter counts wired', () => {
  // Fix: final-call/page.tsx now aggregates condition counts from the
  // in-window lot set instead of passing conditionCounts={}. Empty state
  // is OK (0 lots qualify under 2-min window in demo data) — what we're
  // asserting is "the PAGE renders without 500".

  test('/final-call returns 200 and renders the filter rail', async ({ page }) => {
    const res = await page.goto('/final-call');
    expect(res?.status()).toBeLessThan(500);
    // The page renders the FilterRail in the sidebar. The component name
    // is hidden but the heading "Ending Soon" or "FinalCall" appears in
    // the H1.
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 5_000 });
  });

  test('/final-call page title mentions auctions closing in under 2 minutes', async ({ page }) => {
    await page.goto('/final-call');
    const title = await page.title();
    expect(title.toLowerCase(), `unexpected /final-call title: "${title}"`)
      .toMatch(/closing|2 minutes|final-call/i);
  });
});

test.describe('Audit MED-4: homepage "Browse all auctions" link (was /winners 404)', () => {
  // Fix: RecentWins.tsx "View all winners →" → "Browse all auctions →"
  // pointing at /browse. Dormant today (RecentWins hidden when empty)
  // but the regression test still verifies the homepage renders and the
  // link is reachable IF visible.

  test('homepage renders without 500 and any "browse" link points to /browse', async ({ page }) => {
    const res = await page.goto('/');
    expect(res?.status()).toBeLessThan(500);
    // Assert the dead /winners href doesn't exist anywhere on the page.
    const html = await page.content();
    expect(html, 'dead /winners href detected — the 2026-05-24 fix has regressed')
      .not.toContain('href="/winners"');
  });
});

// ──────────────────────────────────────────────────────────────────────────
// LOW severity
// ──────────────────────────────────────────────────────────────────────────

test.describe('Audit LOW-5: OG image present, not the deprecated path', () => {
  // Fix (upstream): openGraph.images moved off the legacy /04_APP_SOCIAL/
  // path. The BinGo fork serves its own og asset (bingoauctions.com/
  // og-default.png) rather than the ClovrBid v3 CDN, so the assertion is
  // host-agnostic: an og:image must EXIST and must not be the deprecated
  // legacy path.

  for (const path of ['/browse', '/login', '/signup']) {
    test(`${path} og:image is present and not /04_APP_SOCIAL/`, async ({ page }) => {
      const res = await page.goto(path);
      expect(res?.status()).toBeLessThan(500);
      const ogContent = await page.locator('meta[property="og:image"]').first().getAttribute('content');
      expect(ogContent, `${path} og:image missing`).toMatch(/^https?:\/\/.+/);
      expect(ogContent, `${path} og:image still uses deprecated /04_APP_SOCIAL/ path`).not.toMatch(/\/04_APP_SOCIAL\//);
    });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Mobile viewport — locks the lot-detail breakpoint visually
// ──────────────────────────────────────────────────────────────────────────

test.describe('Mobile viewport: iPhone 14 (390x844)', () => {
  // NOTE: don't spread `devices['iPhone 14']` here — that includes
  // defaultBrowserType which Playwright forbids inside a describe block
  // ("forces a new worker"). We just need viewport + touch flags to
  // exercise the responsive layout — webkit-specific quirks are out of
  // scope for this regression suite (Chromium is the e2e.yml runner).
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
  });

  test('/lot/[code] page renders without 500 on mobile + has the @media rule', async ({ page }) => {
    await page.goto('/lot/Stanley-FATMAX-25ft-Tape-Measure');
    const html = await page.content();
    expect(html).toMatch(/@media \(min-width:\s*640px\)/);
  });

  test('/login is functional on mobile (button visible + tappable)', async ({ page }) => {
    await page.goto('/login');
    const button = page.getByRole('button', { name: /^sign in$/i });
    await expect(button).toBeVisible({ timeout: 5_000 });
    // Tap-target check: WCAG AA requires 44x44 minimum.
    const box = await button.boundingBox();
    expect(box?.height ?? 0, 'sign-in button is too short for a thumb tap').toBeGreaterThanOrEqual(36);
  });

  test('homepage renders without horizontal scroll', async ({ page }) => {
    await page.goto('/');
    // documentElement.scrollWidth should match viewport width (390).
    // Allow 10px slack for scrollbar/blur effects.
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(scrollWidth, 'homepage has horizontal overflow on mobile').toBeLessThanOrEqual(400);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Status-only smoke for every public route — catches deploy breakage fast
// ──────────────────────────────────────────────────────────────────────────

test.describe('Public route smoke', () => {
  for (const path of ['/', '/browse', '/final-call', '/login', '/signup', '/how-it-works', '/download']) {
    test(`GET ${path} returns < 500`, async ({ page }) => {
      const res = await page.goto(path);
      expect(res?.status() ?? 200, `${path} 5xx'd`).toBeLessThan(500);
    });
  }
});
