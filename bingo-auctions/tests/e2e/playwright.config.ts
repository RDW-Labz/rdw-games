// tests/e2e/playwright.config.ts
//
// Phase 3 of the mega-sim. Drives operator-web through a real browser
// to catch SSR / auth-cookie / page-rendering bugs the API-level sim
// can't see. Reuses the mega-sim's operator-setup persona to seed a
// fresh SIM operator, then runs all specs against it.
//
// Default mode: spins up `apps/operator-web` via `npm run dev` at
// localhost:3000. Override BASE_URL to point at deployed Vercel.
//
//   cd tests/e2e
//   npm install
//   npx playwright install chromium
//   npm test                                  # local dev server
//   BASE_URL=https://… npm test               # deployed
//
// Reports land in artifacts/playwright-report/ at the repo root.

import { defineConfig, devices } from '@playwright/test';
import * as path from 'node:path';

const baseURL = process.env.BASE_URL || 'http://localhost:3000';
const isDeployed = !!process.env.BASE_URL;

export default defineConfig({
  testDir: './specs',
  fullyParallel: false, // SIM operator is shared state; keep tests serial
  workers: 1,
  retries: 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: '../../artifacts/playwright-report', open: 'never' }],
    ['json',  { outputFile: '../../artifacts/playwright-report/report.json' }],
  ],
  timeout: 60_000,
  expect: { timeout: 10_000 },

  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  // Global setup seeds the SIM operator + saves admin auth state.
  // Global teardown removes the SIM operator + bound users.
  globalSetup: path.resolve(__dirname, 'global-setup.ts'),
  globalTeardown: path.resolve(__dirname, 'global-teardown.ts'),

  projects: [
    {
      name: 'admin',
      testMatch: /specs[\\/]admin[\\/].*\.spec\.ts$/,
      use: {
        ...devices['Desktop Chrome'],
        storageState: path.resolve(__dirname, '.auth/admin.json'),
      },
    },
    {
      name: 'picker',
      testMatch: /specs[\\/]picker[\\/].*\.spec\.ts$/,
      use: {
        ...devices['Desktop Chrome'],
        storageState: path.resolve(__dirname, '.auth/picker.json'),
      },
    },
  ],

  // Only spin up the dev server when we're NOT pointing at a deployed
  // instance. webServer is what Playwright uses to manage processes.
  ...(isDeployed
    ? {}
    : {
        webServer: {
          // Launch operator-web from the workspace root so npm-workspaces
          // resolve correctly. `cd ../../apps/operator-web && npm run dev`
          // works from tests/e2e/.
          command: 'npm --workspace=apps/operator-web run dev',
          cwd: path.resolve(__dirname, '..', '..'),
          url: baseURL,
          reuseExistingServer: true,
          timeout: 180_000, // first Next compile can be slow
          stdout: 'pipe',
          stderr: 'pipe',
        },
      }),
});
