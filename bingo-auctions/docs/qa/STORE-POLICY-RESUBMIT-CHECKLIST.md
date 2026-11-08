# Store Policy Pre-Resubmit Checklist (verified 2026-06-04)

Supersedes the raw audit in **PR #188** (`docs/audits/app-store-compliance-2026-06-03.md`
+ `google-play-compliance-2026-06-03.md`). Those docs flagged 3 "hard blockers";
independent re-verification against the **current** code + **current** Apple / Google /
Expo behavior (2026-06-04, four parallel agents) found **none of them block submission
today**. This file is the corrected, actionable version.

> Operational launch-crash / smoke gating lives in `docs/qa/PRE-SUBMISSION-CHECKLIST.md`
> (Maestro both apps/both platforms, prod-http smoke, crashlog pull). That is *QA*;
> this file is *store policy*. Complementary, not duplicative.

## Re-verification results

| # | Original audit claim | Verified status (2026-06-04) | Evidence |
|---|---|---|---|
| 1 | iOS privacy manifests missing → rejection | **NOT a hard blocker** | Expo SDK 54 libs ship their own `.xcprivacy` (RN→UserDefaults, expo-file-system→FileTimestamp/DiskSpace, expo-device→BootTime). ~7 bidder + 5 staff iOS uploads reached ASC; only ITMS-90683 (purpose strings, fixed) ever raised — never ITMS-91053. Added a `CA92.1` UserDefaults entry to both `app.config.ts` as belt-and-suspenders (pre-empts a possible *non-blocking* Apple email). Effective next native build. |
| 2 | iOS Pro-sub served outside IAP (3.1.1) | **DONE** | Subscription route gated out (`_layout.tsx`) + profile link removed; screen rewired to `operator_pro_plans` (PR #204). |
| 3 | Staff `READ_MEDIA_IMAGES` (Play #1 blocker) | **NOT an issue** | `expo-image-picker` dropped that permission in v16.0.0; app is on v17.0.11 and is camera-only (zero gallery/library picking). Nothing injects `READ_MEDIA_*`. No change needed. |
| 4 | Bidder "TestFlight / Play Internal" copy (2.3.x) | **Not reviewer-visible** | Banner is staff-role-gated (`role !== 'bidder'`); the seeded reviewer account is bidder-only. Reworded to neutral copy anyway (ships next OTA). |
| 5 | Android `RECORD_AUDIO` permission | **DONE** | Removed (PR #118). |
| 6 | PostHog data-safety mismatch | **De-risked to doc-only** | No `EXPO_PUBLIC_POSTHOG_KEY` ships in either `eas.json` → PostHog is dead in prod (Sentry only). Reconcile the store forms; no false declaration risk. |
| 7 | `assetlinks.json` `PLACEHOLDER_SHA256` | **FIXED** | Real Play App Signing SHA-256 pulled headlessly via `scripts/get-play-app-signing-sha.mjs` (generatedApks API, bidder versionCode 12) and written into the route. Was deep-link-only, never submission-blocking. Activate by deploying operator-web. |

## Shipped in this PR (`chore/store-resubmit-hardening`)

- `apps/operator-web/.../assetlinks.json/route.ts` — real app-signing SHA-256 (Android App Links verify after deploy).
- `apps/bidder-app/app.config.ts` + `apps/field-mobile/app.config.ts` — `ios.privacyManifests` `CA92.1` (effective next native build).
- `apps/bidder-app/app/(tabs)/profile.tsx` — neutral staff copy (effective next OTA).
- `scripts/get-play-app-signing-sha.mjs` — headless app-signing-key SHA retrieval tool.

## Remaining non-code (ASC / Play Console / runbook) before next resubmit

- [ ] **Deploy operator-web** so `/.well-known/assetlinks.json` serves the real fingerprint, then verify in a browser.
- [ ] ASC **App Privacy** + Play **Data-safety** forms: reconcile to "Sentry only, no PostHog."
- [ ] **Re-seed demo reviewer fixtures** (`scripts/seed-app-reviewer-fixtures.mjs`) immediately before submitting.
- [ ] Reconcile **staff age-rating** inconsistency (STORE_METADATA 4+ vs PLAY-CONSOLE-CHECKLIST 18+).
- [ ] (Optional) Verify **Push** capability is enabled in ASC for the bidder app.

## Verdict

**No code blockers remain** for the next App Store / Play resubmission. The two iOS
privacy-manifest entries + the neutral copy ship with the next native build / OTA;
assetlinks needs only an operator-web deploy. PR #188's two audit docs can be **closed
as superseded** by this checklist.
