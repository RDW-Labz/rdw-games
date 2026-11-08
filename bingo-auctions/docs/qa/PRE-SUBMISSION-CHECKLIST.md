# Pre-Submission Checklist (mobile + web)

Run this before every App Store / Play Store submission. The #1 historical
rejection/early-crash cause has been **launch crashes** (iOS-26 RNScreen, 2026-05-20;
TestFlight insta-crashes, 2026-05-24), so the device launch smoke is the gate that
matters most. (Maestro setup details: `docs/qa/maestro-setup.md`.)

## 1. Automated gates (already running — just confirm green)

**Every PR (`ci.yml` + `e2e.yml`):**
- `typecheck`, `lint` (+ `source-guards.mjs` regression guards), `test`
- `schema migrations` → `cron_functions_smoke.sql` + `app_read_paths_smoke.sql` (DB/read-path drift)
- `Playwright (chromium)` → operator-web card-flow + audit-fixes vs **prod**

**Maestro Smoke (`maestro.yml`, on push to master + manual):**
- iOS Simulator **and** Android emulator **launch-crash smoke** for **both** apps
  (bidder-app **and** field-mobile) — boots the app, asserts the first screen renders.
  A pure launch crash fails here.

## 2. Manual pre-submission run

```bash
# a) Device launch smoke for BOTH apps, BOTH platforms (no screenshots — fast).
gh workflow run maestro.yml --ref master
gh run watch <run-id>            # all 4 legs (ios/android x bidder/field) must pass

# b) Deployed-web reachability (operator console + public site).
node scripts/smoke/prod-http-smoke.mjs

# c) Real crash telemetry from the CURRENT TestFlight build BEFORE rebuilding
#    (per memory: pull real .crash text first, don't reason from source).
node scripts/fetch-testflight-crashlogs.mjs   # bidder + staff

# d) If UI changed, regenerate App Store screenshots (macOS, ~90 min):
gh workflow run maestro.yml --ref master -f run_screenshots=true

# e) Build + submit (dry-run first; see SUBMISSION_PLAYBOOK.md):
gh workflow run eas-build.yml --ref master -f app=both -f profile=production -f submit=true
```

Manual smell-test on a real device / simulator before submit:
- Launch cold (kill first) -> no crash, lands on sign-in.
- Sign in -> Browse renders, tap a lot -> lot detail renders (no crash).
- Staff app: sign in -> Lotting hub + Checkout tabs render.

## 3. Known gaps / next increments (not yet automated)

Deliberate edges of the current smoke layer — close them when the payoff is worth
the device-minutes:

1. **Bid happy-path is not in CI.** `e2e/maestro/bidder-app/01-bid-flow.yaml` asserts
   a real bid but needs (a) seeded data (lot `BIN-000035` + a card-on-file account) and
   (b) **3 testIDs that don't exist yet**: `lot-card-{code}` (browse/auction lot list),
   `bid-amount-input` + `place-bid-button` (in `@auction-platform/domain-bidding`
   `PlaceBidSheet`). Add those testIDs, then run this flow on Maestro Cloud.
2. **No post-login navigate-every-screen crash smoke.** The CI launch smoke builds with a
   placeholder backend so it can't authenticate. A deeper "log in -> visit every tab ->
   assert each mounts" flow needs a real-backend build (mirror the `ios-screenshots`
   job's `SCREENSHOT_SUPABASE_*` env) — add it as a dispatch-only job.
3. **Screenshot flows have no hard assertions** (they're `optional: true`) — good for
   App Store assets, not regression. Convert one key milestone per flow to `assertVisible`.

## 4. Required CI secrets (already set; re-verify if a run can't auth)
`BIDDER_EMAIL/PASSWORD`, `BIDDER_PICKUP_EMAIL/PASSWORD`, `STAFF_EMAIL/PASSWORD`,
`SCREENSHOT_SUPABASE_URL/ANON_KEY`, `SCREENSHOT_API_BASE_URL`, `EXPO_TOKEN`.
