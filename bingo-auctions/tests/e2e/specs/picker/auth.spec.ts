// tests/e2e/specs/picker/auth.spec.ts
//
// Picker auth — the picker user should be signed in via storageState.

import { test, expect } from '../../fixtures/sim';

test('picker is signed in (not bounced to login)', async ({ page }) => {
  await page.goto('/');
  await expect(page).not.toHaveURL(/\/login/);
});
