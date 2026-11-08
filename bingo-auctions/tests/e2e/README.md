# mega-sim Phase 3 — Playwright UI tests

UI-layer tests for `apps/operator-web`. Catches SSR / auth-cookie /
page-rendering / server-action bugs that the API-level mega-sim
(phases 1+2) can't see.

## Install + run

```bash
cd tests/e2e
npm install
npx playwright install chromium      # one-time

# Local dev server (default — Playwright manages it for you)
npm test

# Pre-built / deployed
BASE_URL=https://… npm test

# Keep the SIM operator + auth state around after the run
KEEP_SIM=1 npm test
```

Reports land in `artifacts/playwright-report/` at the repo root. Open
`index.html` or run `npm run report` from this directory.

## What it tests

| Spec | What it catches |
|---|---|
| `auth.spec.ts` | Login redirect, role-gated routes, session-cookie survival across page loads |
| `inventory.spec.ts` | The `/lotting/inventory` page (counts, filter pills, search, empty state — the page you were confused about) |
| `manifest-pool.spec.ts` | Manifest detail view + the 0059 architecture invariant (no "Lot N selected" button) |
| `auction-builder.spec.ts` | `/auctions` list + new-auction form render |

## Architecture

`global-setup.ts` seeds a SIM operator by calling directly into the
mega-sim's persona modules (`scripts/mega-sim/personas/operator.js`,
`lotter.js`, `picker.js`). Then it signs admin + picker in via the real
login page, captures cookies into `.auth/admin.json` + `.auth/picker.json`.

`playwright.config.ts` declares two projects (`admin`, `picker`), each
using the matching storageState. Specs skip themselves out of projects
they don't belong to (`test.skip(testInfo.project.name !== 'admin')`).

`global-teardown.ts` calls `scripts/mega-sim/cleanup.cleanup()` to
remove the SIM operator + bound users.

## When tests fail

- Login failure: check `.auth/<role>-login-failure.html` (saved by
  global-setup). Probably means the operator-web dev server didn't
  start, or the login form selectors changed.
- DB row not found: check the SIM context with `KEEP_SIM=1` and inspect
  in the live dashboard.
- Selector flake: prefer `getByRole` + accessible names over text;
  add `data-testid` on the operator-web component if the selector
  needs more stability.
