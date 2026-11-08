# Apple + Google submission plan — bidder + staff apps (2026-05-26)

Companion to `scripts/SUBMISSION_PLAYBOOK.md`. That playbook is the *how-to*; this doc is the *what's-the-current-state-and-what-do-we-do-next*.

## Apps at a glance

| App | iOS bundle | iOS ASC app id | Android package | Android Play registered? |
|---|---|---|---|---|
| **ClovrBid Bidder** | `com.cluerholdings.auctionplatform` | `6767012532` | `com.cluerholdings.auctionplatform` | ✓ Registered, all 4 tracks empty |
| **ClovrBid Staff** | `com.cluerholdings.bidwizops` | `6767026881` | `com.cluerholdings.bidwizops` | ✗ **NOT registered** (public name "ClovrBid Staff"; bidwizops is bundle id only) |

## Current state (probed live 2026-05-26)

### iOS — App Store Connect

Both apps exist + have TestFlight builds. Post-iOS-26 launch-crash fix (2026-05-20) is live in TestFlight builds 7-10.

**ASC credentials are already wired in GitHub Actions secrets** (`ASC_API_KEY`, `ASC_API_KEY_ID`, `ASC_API_KEY_ISSUER_ID`, set 2026-05-23). These work with `eas submit` in the `eas-build.yml` workflow — that's the path the user has been using for prior submissions.

Local `.secrets/AuthKey_25M83P99J8.p8` is the SAME key, used for crashlog reading + ad-hoc API probes. Local API probes have shown intermittent 401s on some endpoints, but the EAS workflow consistently works because `eas submit` uses the credentials inside the EAS Cloud build environment (no clock-skew, fresh network).

**Submission path = trigger `eas-build.yml` workflow with `submit: true`** — EAS builds the latest commit AND submits to TestFlight/App Store Connect in one shot. Same path used for builds 7-10.

### Android — Google Play Console

- **Bidder (`com.cluerholdings.auctionplatform`)** — Registered + verified 2026-05-22.
  - Default language: `en-US`
  - All 4 tracks exist: production, beta, alpha, internal
  - **All tracks empty — no releases uploaded yet.** This is the gating step for Bidder Android.
- **Staff (`com.cluerholdings.bidwizops`)** — Returns 404 from Play API.
  - Must be **registered first** in Play Console under the same RDW, LLC developer account before any submit.
  - The bundle, name, and basic listing must be filled out by hand the first time. Subsequent updates can be scripted.

Service account `eas-android-publish` (in `.secrets/google-play-service-account.json`) has Release Manager permission for Bidder; needs to be granted the same role for Staff after registration.

## Recommended submission order

### Phase 1 — Pre-flight (one-time setup)

Only Item 1 is actually blocking. Everything else is already done.

| # | Step | Where | Who | Status |
|---|---|---|---|---|
| 1 | Register Staff Android app in Play Console (`com.cluerholdings.bidwizops`, RDW LLC) | play.google.com/console | Michael | **TODO — 5 min web action** |
| 2 | Grant `eas-android-publish` service account Release Manager on the new Staff Play listing | Play Console → API access | Michael | TODO after #1 |
| 3 | Confirm GHA secrets `ASC_API_KEY`, `ASC_API_KEY_ID`, `ASC_API_KEY_ISSUER_ID` exist | `gh secret list` | code | ✓ done (set 2026-05-23) |
| 4 | Confirm `docs/STORE_METADATA.md` + `docs/APP_REVIEWER_NOTES.md` current | repo | both | ✓ recent |
| 5 | Bidder Play Console listing (en-US, all tracks empty) | Play Console | Michael | ✓ done |

### Phase 2 — Build + auto-submit the latest greatest

Single GHA dispatch per app. The workflow `eas-build.yml` builds production AAB/IPA on EAS Cloud and (when `submit: true`) auto-uploads to TestFlight / Play internal track.

**Once master is final** (W2 remaining + W6-P2 remaining + W9 slice 2 all merged):

```powershell
cd C:\Users\jmacl\Projects\auction-platform

# Bidder iOS + Android → TestFlight + Play internal track
gh workflow run "eas-build.yml" -f app=bidder -f profile=production -f platform=all -f submit=true

# Staff iOS only (no Android app yet — gated by Phase 1 step 1)
gh workflow run "eas-build.yml" -f app=staff -f profile=production -f platform=ios -f submit=true
```

Each build takes ~20-25 min on EAS Cloud workers. Total wall time: ~25 min (jobs run in parallel via `concurrency: eas-build-{app}`).

Monitor:
- GHA Actions tab for build progress
- ASC → TestFlight tab for iOS arrival (within ~5 min of EAS completion)
- Play Console → Release → Testing → Internal for Android arrival

### Phase 3 — Promote on each store (manual gates apply)

iOS path (submit for App Store review):
- Wait for the build to appear in ASC → App Store → v1.0
- Click "Submit for Review" in ASC web UI (or rerun the eas-build workflow with submit=true after metadata changes — `eas submit` is idempotent for already-attached builds)
- Apple review: 24-48 hours

Android path (Google gates promote):
- Internal testing: ≥12 testers active for 14 consecutive days BEFORE Google unlocks "Promote to closed (beta)"
- Closed beta: same gate applies before "Promote to production"
- Once gates clear, dispatch again with `--track beta` or `--track production` via:

```powershell
node scripts/submit-android-play-store.mjs --track beta --live
node scripts/submit-android-play-store.mjs --track production --live
```

These scripts use the same Play service account already configured.

## Script gaps to fix before Phase 2

| Gap | File | Fix |
|---|---|---|
| `submit-android-play-store.mjs` hardcodes `ANDROID_PACKAGE_NAME = 'com.cluerholdings.auctionplatform'` (line 44) | `scripts/submit-android-play-store.mjs` | Add `--app bidder\|staff\|both` flag, map to package name like `submit-ios-app-store.mjs` does |
| `submit-ios-app-store.mjs` `/builds` works but `/appStoreVersions` 401s for Bidder app | scripts + ASC | Rotate to Admin-role ASC key |
| No AAB auto-locator for both apps | `scripts/submit-android-play-store.mjs` | Resolve `~/Downloads/<app>-v<N>.aab` or pull latest from EAS — only matters once Phase 1 step 5 produces fresh builds |
| Release notes: `docs/STORE_METADATA.md` is bidder-focused | repo | Add a "Staff" section with the staff-app one-liner |
| Maestro screenshot uploader is bidder-only — no staff-app screenshots in ASC yet | `scripts/upload-asc-screenshots.mjs` | Generalize or run twice with `--app staff` |

## App reviewer fixtures

`docs/APP_REVIEWER_NOTES.md` (current) lists demo credentials for Apple/Google reviewers. Spot-check before each submit:
- Bidder reviewer login: a published bidder account with at least one active auction visible
- Staff reviewer login: a published operator+staff user with at least one lot in `pending_intake` and one staged pickup

## Open items (deferred)

- **GHA workflow `eas-build.yml`** can produce fresh builds in cloud (per memory: EAS Pro plan active with unlimited concurrent macOS-medium + m-large workers). Use this for Phase 1 step 5 instead of local `eas build`.
- **Maestro screenshot regen** for both apps in 3 device sizes after the b12 OTA (so store listings reflect current shelf-scan + Loads UI).
- **Privacy nutrition labels** in ASC need to be updated for both apps if data-collection categories changed since last submission (location for warehouse map, camera for scan, photos for staging — all should already be declared).
- **Stripe/Apple IAP separation**: Bidder app uses Stripe for fund movement (not IAP). Apple reviewer note required — already in `docs/APP_REVIEWER_NOTES.md`.

## Quick reference

| Doc | Purpose |
|---|---|
| `scripts/SUBMISSION_PLAYBOOK.md` | step-by-step *how* to call each script |
| `docs/state/SUBMISSION-PLAN-2026-05-26.md` | *this doc* — current state + ordering |
| `docs/STORE_METADATA.md` | app titles, descriptions, release notes (both stores) |
| `docs/APP_REVIEWER_NOTES.md` | reviewer credentials + test instructions |
| `apps/bidder-app/eas.json` | bidder build profiles |
| `apps/field-mobile/eas.json` | staff build profiles |

## Done first — what gates Phase 2

Single blocker for the FULL submission scope:

1. **Staff Play Console registration** — `com.cluerholdings.bidwizops` returns 404 from Play API today. Must be created under RDW LLC in Play Console before Staff Android can be submitted. 5-minute web action.

For iOS, both apps are ready — `eas-build.yml` with `submit=true` does the rest. The user has used this exact path already for prior TestFlight uploads (see GHA secrets ASC_API_KEY* set 2026-05-23).

For Bidder Android, the listing is already configured — the gating step is just the first AAB upload, which `eas-build.yml -f platform=all -f submit=true` handles.
