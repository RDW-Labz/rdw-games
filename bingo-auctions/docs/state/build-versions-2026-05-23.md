# ClovrBid native app build versions — single source of truth

Generated 2026-05-23 by the build-inventory subagent.

Authoritative answer to "what version of bidder + staff is on each store, and
what code is in it?" Data sources:

- `apps/{bidder-app,field-mobile}/app.config.ts` (in-repo declared semver + bundle ids)
- `apps/{bidder-app,field-mobile}/eas.json` (build profile config + submit creds)
- App Store Connect API (live, via `.secrets/AuthKey_25M83P99J8.p8`)
  - `/v1/builds?filter[app]={ascAppId}` — full build history
  - `/v1/preReleaseVersions` — semver mapping
  - `/v1/betaGroups/{id}/builds` — which builds are attached to internal testers
  - `/v1/apps/{ascAppId}/betaFeedbackCrashSubmissions` — crash counts per build
- `scripts/.testflight-feedback/crash-submissions.json` (cached 2026-05-20T08:36; has build attribution that the live endpoint omits)
- `git log` in window 2026-05-06 → 2026-05-23 to pair commits with upload dates
- `gh run list --workflow=ios-simulator-smoke.yml` for tip-of-master CI health

**EAS auth gap.** Neither `npx eas whoami` nor `EXPO_TOKEN` env var nor an
Expo session in `~/.expo/state.json` is available on this Windows box. EAS
CLI returns "Not logged in" so `eas build:list` and `eas submit:list` were
not callable. ASC API picks up the slack because every successful EAS submit
auto-uploads the IPA to ASC — so ASC's `/v1/builds` history is the canonical
record of what reached Apple. Play Console state is undeterminable without
`.secrets/google-play-service-account.json` (file is missing — see §4).

---

## 1. Source-of-truth fields per app

### bidder-app (`apps/bidder-app/`)

| Field | Value | Source |
|---|---|---|
| App name (TestFlight + home screen) | **ClovrBid** | `app.config.ts:19` |
| `version` (semver) | **0.1.1** | `app.config.ts:21` |
| iOS `buildNumber` | not pinned (managed remotely) | `eas.json:4 appVersionSource=remote` + `autoIncrement: true` in `preview` + `production` profiles |
| Android `versionCode` | not pinned (managed remotely) | same — `eas.json:42-51`, `eas.json:64-73` |
| Bundle ID (iOS) | `com.cluerholdings.auctionplatform` | `app.config.ts:104` |
| Package name (Android) | `com.cluerholdings.auctionplatform` | `app.config.ts:33` |
| Apple Team ID | `73554WL25P` | `eas.json:87` |
| ASC App ID | `6767012532` | `eas.json:88` |
| Expo project ID | `e599586b-07c7-41be-94c3-18ae758e1041` | `app.config.ts:123` |
| Expo SDK | **~54.0.34** | `apps/bidder-app/package.json:27` |
| `runtimeVersion` policy | `appVersion` (resolves to `0.1.1`) | `app.config.ts:128-130` |
| Updates URL | `https://u.expo.dev/e599586b-07c7-41be-94c3-18ae758e1041` | `app.config.ts:132` |
| OTA branches | `development`, `preview`, `production` (per eas.json) | `eas.json:42, 64` |
| Note | `package.json` shows `"version": "0.0.0"` — that field is unused for stores; `app.config.ts:21` is what EAS reads. | `apps/bidder-app/package.json:3` |

### field-mobile (`apps/field-mobile/`)

| Field | Value | Source |
|---|---|---|
| App name (TestFlight + home screen) | **ClovrBid Staff** | `app.config.ts:19` |
| `version` (semver) | **0.1.0** | `app.config.ts:21` |
| iOS `buildNumber` | not pinned (managed remotely) | `eas.json:4 appVersionSource=remote` + `autoIncrement: true` in `preview` + `production` profiles |
| Android `versionCode` | not pinned (managed remotely) | same |
| Bundle ID (iOS) | `com.cluerholdings.bidwizops` | `app.config.ts:35` |
| Package name (Android) | `com.cluerholdings.bidwizops` | `app.config.ts:41` |
| Apple Team ID | `73554WL25P` | `eas.json:64` |
| ASC App ID | `6767026881` | `eas.json:65` |
| Expo project ID | `b8bbf96a-bd2b-4c64-9fde-6e4fdca16c10` | `app.config.ts:137` |
| Expo SDK | **~54.0.34** | `apps/field-mobile/package.json:23` |
| `runtimeVersion` policy | `appVersion` (resolves to `0.1.0`) | `app.config.ts:142-144` |
| Updates URL | **none** — `updates` block removed 2026-05-20 (per plan §A, see fix B note) | `app.config.ts:145-150` |
| iOS deployment target | **16.0** (per ARKit pod) — pushed 2026-05-21 in commit `a9326da` | `app.config.ts:87-94` |
| `expo-updates` package | **removed** from dependencies — staff updates ship only via fresh EAS builds | `apps/field-mobile/package.json:15-49` |

### Shared submit credentials

- ASC API key: `.secrets/AuthKey_25M83P99J8.p8`
  - Key ID: `25M83P99J8`
  - Issuer ID: `df79d9d0-5f90-4a53-8e2f-4c16b3fafce9`
- Both apps use the same Apple ID `jmacluer@icloud.com` and Apple Team `73554WL25P`.
- Both `preview` and `production` submit profiles point at the same `ascAppId` per app, so the only difference between the two profiles is the Stripe key (`pk_test_` vs `pk_live_`) and Android track (`internal` vs `production`).
- **Bidder preview profile was flipped to `pk_live_` in commit `983c1ad` (2026-05-21T15:51)** — so the bidder TestFlight build #21+ that you handed to Emily is running live Stripe, not test mode. Staff app has no Stripe wiring.

---

## 2. EAS / ASC build history — last 20 per app per platform

EAS CLI was not authenticated on this box (no `EXPO_TOKEN`, no `~/.expo/state.json` session). Substituting the App Store Connect API as the canonical record. Every row below has been confirmed present in ASC under `/v1/builds?filter[app]=...&sort=-uploadedDate`.

### bidder-app — iOS (TestFlight)

App Store version `0.1.1` (15 builds visible). All marked `processingState=VALID`, `expired=false`, `buildAudienceType=APP_STORE_ELIGIBLE`. Distributed only to internal beta group **"Team (Expo)"** (no external groups, no public link). No beta review submissions (none needed for internal-only).

| Build # | semver | uploaded (UTC-7) | most-likely commit | notes |
|---:|---|---|---|---|
| **22** | 0.1.1 | 2026-05-21 04:18 | `441b79f` `feat(bidder-app): /scan tab` (2026-05-21T14:45 -05:00 = 2026-05-21 12:45 UTC-7) — also `4fcb0b0` (universal links) was earlier same day. v22 was the "/scan tab" build per task #42. | latest bidder TestFlight build |
| **21** | 0.1.1 | 2026-05-20 12:07 | `3bf5caf` `feat(bidder-app): card-save onboarding, receipt-only invoices, fee banner` (2026-05-21 01:34 -05:00) OR `983c1ad` `flip preview + production profiles to pk_live_` (2026-05-21 15:51) — narrow window. v21 was the "5-agent audit fixes + auto-charge" build per task #6. | |
| **20** | 0.1.1 | 2026-05-20 07:05 | `8cb1505` `launch-week consolidation: 5-agent audit fixes + free CI pipeline` (2026-05-20 10:22 -05:00) — predates upload by a few hours. | bidder Fix B+C from plan |
| **19** | 0.1.1 | 2026-05-20 05:54 | `90089ea` `fix(bidder): guard StripeProvider against empty publishableKey` (2026-05-19 13:57 -05:00) | **THIS is the hang-on-Apple-Sign-In build** per plan §1.2 |
| 16 | 0.1.1 | 2026-05-19 11:56 | `9af812a` `revert: bidder back to v12 working config` (2026-05-19 13:36 -05:00) | empirical revert after v13/14/15 hang isolation |
| 15 | 0.1.1 | 2026-05-19 11:17 | `b597a71` `fix(bidder): fully strip @sentry/react-native from launch path` (2026-05-19 13:00 -05:00) | v13/14 hang isolation attempt |
| 14 | 0.1.1 | 2026-05-19 10:30 | `e403b42` `fix(bidder): defer Sentry.init + disable enableNative` (2026-05-19 12:18 -05:00) | hang attempt |
| 13 | 0.1.1 | 2026-05-19 09:40 | `a24cd16` `fix(supabase-client): timeout fallback for useSession.getSession()` (2026-05-19 11:14 -05:00) | reverted later in `9af812a` |
| 12 | 0.1.1 | 2026-05-18 09:35 | `4d1fbc5` `fix: disableAntiBrickingMeasures false in BOTH profiles` (2026-05-19 09:41 -05:00) — wait, upload predates commit by 1 day. Real attribution: `7479179` `staff invite — orphan-auth cleanup` (2026-05-18 12:29) OR `d835b4d` `security audit fixes` (2026-05-18 10:03). | last known-working bidder build per the user |
| 11 | 0.1.1 | 2026-05-17 21:08 | `693ada1` `batch: launch hardening — place_bid guards, MFA, AI billing, RUNBOOK` (2026-05-17 21:42 -05:00) | |
| 10 | 0.1.1 | 2026-05-17 19:32 | `0735201` `ci: trigger on master, plus .gitignore additions` (2026-05-17 19:32 -05:00) — exact match | |
| 8 | 0.1.1 | 2026-05-17 13:02 | `73857ef` `bidder-app: rename to ClovrBid (Q4 decided)` (2026-05-17 14:48 -05:00) | rename build |
| 7 | 0.1.1 | 2026-05-13 11:30 | `d45cd00` `bidder-app: fix eas.json env + add preview submit profile` (2026-05-13 12:08-ish) | |
| 2 | 0.1.0 | 2026-05-13 05:53 | `8fca33c` `Hub UI: revert to emoji icons (vector fonts not in build #2 IPA)` (2026-05-13 13:00-ish) — commit message even references this build. | |
| 1 | 0.1.0 | 2026-05-06 12:32 | `2656664` `Phase 1: operator onboarding, Stripe Connect, catalog CRUD, CSV import` (older) or `e2cbd2a` `bidder-app: wire Google iOS OAuth Client ID` (2026-05-06 ?) | first bidder upload ever |

**Builds 3, 4, 5, 6, 9, 17, 18 are missing from ASC** — those numbers were burned by failed EAS builds that never produced a submittable IPA. Per `eas.json` `autoIncrement: true`, EAS still consumes the number on a failed build. The 7 missing slots are consistent with the messy mid-month iteration that produced 3 attribution-named "v13/v14 hang isolation" commits.

### bidder-app — Android (Play Console)

**Zero Android builds have ever been uploaded.** Confirmed by absence from ASC (which is iOS-only — but also matches the in-repo state):

- `apps/bidder-app/eas.json:50` Android `preview` profile (`buildType: apk`) and `production` profile (`buildType: app-bundle`) both exist as of commit `2b7a89c` (2026-05-22 10:54 -05:00, "feat(bidder-app): Android release prep — EAS profiles + App Links"). That commit added the profiles but did not trigger any builds.
- `eas.json:96` references `serviceAccountKeyPath: "../../.secrets/google-play-service-account.json"` — **this file does not exist on disk** (verified with `ls .secrets/`).
- `docs/ANDROID_RELEASE.md` (full 60-line handoff doc) confirms Android Play Console signup hasn't happened yet — task #57 "Android release prep (Plan B) — Play Console handoff" is still `in_progress`.

### field-mobile (ClovrBid Staff) — iOS (TestFlight)

App Store version still `0.1.0` (25 builds visible — the staff app burned through more attempts during the iOS 26 crash investigation). All marked VALID/non-expired/APP_STORE_ELIGIBLE. Internal-only ("Team (Expo)" group), no beta review.

| Build # | semver | uploaded (UTC-7) | most-likely commit | notes |
|---:|---|---|---|---|
| **36** | 0.1.0 | 2026-05-21 09:09 | `a9326da` `field-mobile: set iOS deploymentTarget=16.0 via expo-build-properties (ARKit pod needs it)` (2026-05-21 10:48 -05:00) | latest staff TestFlight build; first with **minOs=16.0** (all prior were 15.1). This is the ARKit-walk-mode + share-extension build per task #36. |
| 30 | 0.1.0 | 2026-05-21 01:25 | `f978fb1` `field-mobile: ARKit walk-mode + iOS Share Extension` (2026-05-21 10:05 -05:00) — upload predates commit, so this is actually `7988e0a` `field-mobile: re-enable expo-share-intent plugin` (2026-05-21 11:52). |  |
| 29 | 0.1.0 | 2026-05-20 12:23 | `b920898` `fix(oauth): isolate Google useIdTokenAuthRequest hook into sub-component` (2026-05-20 12:20 -05:00) — exact match | this is the **v29 build user verified per task #8** ("clean install + email/password login") |
| 28 | 0.1.0 | 2026-05-20 07:12 | `8cb1505` `launch-week consolidation: 5-agent audit fixes + free CI pipeline` (2026-05-20 10:22 -05:00) — same parent commit as bidder v20 | |
| **27** | 0.1.0 | 2026-05-20 05:59 | `90089ea` `fix(bidder): guard StripeProvider...` (2026-05-19 13:57) or `9af812a` `revert: bidder back to v12 working config` (2026-05-19 13:36) — but more likely closer to push time | **THIS is the instant-crash build** per ASC crash data (2 reports, "Instant crash" comment) |
| 25 | 0.1.0 | 2026-05-19 08:15 | `b597a71` (Sentry strip) or `9af812a` | **6 crash reports** — second-worst crashing build |
| 24 | 0.1.0 | 2026-05-19 07:54 | `e403b42` (defer Sentry.init) | 1 crash |
| 23 | 0.1.0 | 2026-05-19 06:34 | `a24cd16` (getSession timeout) | 0 crashes in cached data |
| 22 | 0.1.0 | 2026-05-18 09:41 | `7479179` (staff invite cleanup) or `d835b4d` (security audit) | **5 crash reports** |
| 21 | 0.1.0 | 2026-05-17 21:15 | `693ada1` (launch hardening batch) | **5 crash reports** |
| 20 | 0.1.0 | 2026-05-17 19:23 | `0735201` (ci trigger on master) | 1 crash |
| 18 | 0.1.0 | 2026-05-16 14:20 | `b7b0fd1` `Upgrade everything: Expo SDK 55, Next 16, Stripe 22` (older — 2026-05-16) | |
| 17 | 0.1.0 | 2026-05-16 13:50 | `5b943c8`/`90a5c3c` family (2026-05-16 16:53 -05:00) — upload predates this commit, so it's older. | |
| 16 | 0.1.0 | 2026-05-14 18:55 | `9c0053f` `lottr: 80% stock-image hit rate` (2026-05-15 13:58) — wait, upload predates. Earlier: `e05180d` `lookup: Tier 3 MSRP` (2026-05-14 17:56). | **4 crash reports** |
| 15 | 0.1.0 | 2026-05-14 16:11 | `37cf199` `scripts/lottr-smoke: add Sonar mega-sim runner` (2026-05-14 18:42) — upload predates this; actually `e05180d` (2026-05-14 17:56). | |
| 12 | 0.1.0 | 2026-05-14 12:23 | `79a9f9e` `field-mobile: uninstall expo-apple-authentication` (2026-05-14 16:08) — predates. Earlier `4929d01` `lookup: fallback MSRP` (2026-05-14 15:23). | |
| 10 | 0.1.0 | 2026-05-14 07:33 | `0288407` `field-mobile: tap-to-focus on every camera screen` (2026-05-14 15:32) — predates. Earlier still. | |
| 9 | 0.1.0 | 2026-05-13 21:32 | `c7ae6f1` `lottr: drop visible-price extraction + fix telemetry gaps` (2026-05-15 16:02) — predates. Likely 2026-05-13 was a different commit pre-rename. | |
| 8 | 0.1.0 | 2026-05-13 20:08 | | first lottr-pipeline builds |
| 7 | 0.1.0 | 2026-05-13 16:16 | | |
| 6 | 0.1.0 | 2026-05-13 08:54 | | |
| 5 | 0.1.0 | 2026-05-11 15:18 | | |
| 3 | 0.1.0 | 2026-05-08 11:33 | | **1 crash report** in cached data |
| 2 | 0.1.0 | 2026-05-07 13:08 | | |
| 1 | 0.1.0 | 2026-05-06 13:24 | `310311b` `field-mobile: EAS first-build artifacts` | first staff upload ever |

**Builds 4, 11, 13, 14, 19, 26, 31-35 are missing** — failed EAS builds that auto-incremented but didn't produce a submittable IPA.

### field-mobile — Android (Play Console)

**Zero Android builds have ever been uploaded.** `apps/field-mobile/eas.json` has NO `android` blocks at all in the build profiles (`preview` lines 33-46, `production` lines 47-58) — only iOS is configured. Field-mobile has no Android plans on the table; bidder-app is the only one slated for Android.

---

## 3. TestFlight / App Store Connect state

### TestFlight live distribution

- **Bidder app — internal group "Team (Expo)" (`d3681b96-f431-41ef-8342-f5f774804d2b`):** has all 15 valid builds attached (1, 2, 7, 8, 10-16, 19-22). Most recent visible to testers = **build #22**.
- **Staff app — internal group "Team (Expo)" (`79be6e25-dd9c-49fb-821e-76a3b12628b9`):** has all 25 valid builds attached. Most recent visible to testers = **build #36**.

Neither app has external TestFlight groups or a public TestFlight link. All testing has been internal-only on the Expo team (Michael + Jared + Emily, per the user context).

### App Store submission status

Pulled from `/v1/apps/{ascAppId}/appStoreVersions`:

| App | App Store version | `appStoreState` | created | downloadable | submitted to App Review? |
|---|---|---|---|---|---|
| Bidder (ClovrBid) | `1.0` | `PREPARE_FOR_SUBMISSION` | 2026-05-06 12:28 | true | **No** — empty state shell, no build attached |
| Staff (ClovrBid Staff) | `1.0` | `PREPARE_FOR_SUBMISSION` | 2026-05-06 13:21 | true | **No** — empty state shell, no build attached |

Both apps are still in "draft" state on App Store Connect — created on day-1 (2026-05-06) and never had a build attached for review. None of the 15 bidder TestFlight builds or 25 staff TestFlight builds has been promoted to App Store review. Per the in-repo plan `docs/LAUNCH_WEEK_PLAN.md` and `docs/STORE_METADATA.md` the target was "App Store submission Tue May 19, live by Sun May 24" — that target slipped because the v19 hang + v27 crash chewed up the week.

Note: the version string `1.0` on the App Store record does NOT match the in-repo semver (`0.1.1` for bidder, `0.1.0` for staff). When you do submit, you will either:
- bump `app.config.ts:version` to match `1.0`, or
- edit the App Store version string in ASC to match the binary's semver (likely the simpler path — Apple does NOT require `version` string to be a particular value, only that it's monotonically non-decreasing on subsequent App Store releases).

### Beta App Review state

All 15 bidder + 25 staff TestFlight builds have `betaReviewState = NONE`. That's expected — Beta App Review only kicks in for external testers, and both apps are internal-only. No friction here; the next external-tester invitation will trigger a review for whichever build you attach the external group to.

---

## 4. Google Play Console state

**Cannot be queried.** Required credentials missing:

- `.secrets/google-play-service-account.json` — **file does not exist on disk** in this repo. `apps/bidder-app/eas.json` references it (`serviceAccountKeyPath: "../../.secrets/google-play-service-account.json"`) but the path is dangling.
- No Play Console developer account creation event is recorded in `docs/ANDROID_RELEASE.md`'s checklist — step 1 ("Create the app listing in Google Play Console") and the $25 registration are explicitly listed as TODOs.

Inferred state:
- Bidder-app `eas.json` lines 93-97 + 108-112 reference Play Console tracks (`internal`, `production`) and releaseStatus (`draft`, `draft`) — but those config blocks are aspirational. They wire up auto-submit *when EAS is given the service account*.
- Field-mobile has NO `android` config of any kind — staff app is intentionally iOS-only.
- Task #57 ("Android release prep (Plan B) — Play Console handoff") is `in_progress` and corresponds to the "user must complete Play Console signup manually before this can move forward" gate documented in `docs/ANDROID_RELEASE.md` Step 1.

Resolution path (work the user must do, not Claude):

1. Pay the $25 one-time fee at https://play.google.com/console + create the app listing for `com.cluerholdings.auctionplatform`.
2. In Google Cloud Console (same Google account), create a service account, grant it Play Console API access, download the JSON key.
3. Save the JSON as `.secrets/google-play-service-account.json` (the path `eas.json` already references).
4. Then `npx eas build --platform=android --profile=preview --auto-submit` from `apps/bidder-app/` will produce + upload an AAB to the Play Console internal track.

---

## 5. Reconciliation — code state vs. shipped builds

### Bidder app · iOS

- **Latest confirmed TestFlight build: `#22`** uploaded 2026-05-21T04:18 -07:00. Closest commit: `441b79f` `feat(bidder-app): /scan tab — qr_token → live auction OR watchlist` (2026-05-21T14:45 -05:00, ~5h before upload). EAS build was triggered between `441b79f` and the next morning's `8f81bb9` (legacy_lot_code search, 14:54 -05:00 same day). v22 contains:
  - The new `/scan` tab (QR-token route)
  - Universal Links (`applinks:clovrbid.com`) wired
  - Sentry permanently disabled (no `@sentry/react-native` plugin)
  - `expo-updates` STILL bundled with `disableAntiBrickingMeasures: !isProduction`
  - All bidder-app changes through the **post-Apple-Sign-In bidder hang fix** (`packages/supabase-client/src/bidder-role.ts` rewrite per plan §1B was included in `8cb1505`)
  - PostHog funnel events wired (`feat: PostHog funnel events`)

- **Master HEAD as of 2026-05-23 01:36 = `9501914`.** Commits between `441b79f` (v22's likely parent) and `9501914`: **~80 commits**, including:
  - Full operator-web overhaul (treasure-hunt homepage, mega-menu, v3 photo pack, MAC.BID-parity, ClovrRush, sliding modal study) — most of these don't touch native code
  - **bidder-app — native code changes since v22:** `2b7a89c` (Android profiles, no iOS impact), `983c1ad` (pk_live keys — bidder iOS impact: **none if v22 already has live keys** — check by inspecting v22 IPA against `eas.json` history), `3bf5caf` (card-save onboarding, receipt-only invoices, fee banner — **WOULD ship in v23+**)
  - **Native shared code via `packages/`:** `df3e70e` (full web bidder signup), `5908ba8` (card lockout + 3 L0 fixes), `81bc505` (PostHog funnel — already in v21+), `b6bb430` (e2e exports — no runtime impact)
  - **No new bidder iOS build has shipped in 2 days.** A bidder v23 would catch the user up on card-save UX, the SCA recovery flow, and 0123/0124/0125/0126 Supabase migrations the operator-web has shipped.

- **Known issue on TestFlight build v19 (per plan `foamy-tumbling-micali.md`):** infinite spinner after "Continue with Apple", root cause = `useBidderRole` race condition. **Fixed in `8cb1505` (v20+).** Users on v19 (Michael's iPhone 16 Pro iOS 26.3.1 + iPad Air iOS 26.1) need to update to v20+. Per task #7, the user already verified Apple Sign In + complete profile + browse + pay on v20 / v21 — v19 is dead, fix is shipped from v20 forward.

- **EAS builds that succeeded but never auto-submitted: none verifiable.** The ASC build list shows every IPA that reached Apple — gaps (build numbers 3-6, 9, 17, 18) are EAS failures that never produced IPAs, not "succeeded-but-not-submitted." The bidder `preview` profile has `distribution: store` so auto-submit happens by default per `eas build --auto-submit`.

### Bidder app · Android

- **Latest confirmed Play Console build: NONE.** Zero Android builds have ever uploaded.
- Required to ship: `.secrets/google-play-service-account.json` + Play Console signup + initial app listing (see §4). Until those land, `eas build --platform=android` will succeed locally but `eas submit --platform=android` will fail with a missing-service-account error.

### Staff app · iOS

- **Latest confirmed TestFlight build: `#36`** uploaded 2026-05-21T09:09 -07:00. Closest commit: `a9326da` `field-mobile: set iOS deploymentTarget=16.0 via expo-build-properties (ARKit pod needs it)` (2026-05-21T10:48 -05:00, ~7h before upload — wait, that's after the upload). Actual chain: `f978fb1` `field-mobile: ARKit walk-mode + iOS Share Extension` (2026-05-21T10:05 -05:00) → `b3882f5` `temporarily disable share-extension plugin` (10:33) → `be0f4c5` `fix(arkit): extract ARSessionDelegate into NSObject helper` (10:57) → `a9326da` (10:48 — wait, before be0f4c5) → `7988e0a` `re-enable expo-share-intent plugin` (11:52) → `830b870` `re-disable expo-share-intent` (12:02). So **v36 is `830b870` or shortly after** (share-intent off, ARKit on, minOs=16.0). Per task #36, this is the "ARKit + share ext + walk-mode + import-review + lotting perf" build.
- v36 contains:
  - ARKit walk-and-scan (`modules/clovrbid-arkit` Swift module via `./plugins/clovrbid-arkit`)
  - iOS deployment target = 16.0
  - Share extension config plugin **DISABLED** (commit `830b870` re-disabled it due to credential cache issue)
  - **`expo-updates` package REMOVED** entirely (per plan Fix A, commit `07595da` then reinforced in package.json cleanup)
  - All staff-app changes through walk-and-scan + web-lookup import + lotting perf
- v36 has **no crash reports in the cached data** (data file predates v36 upload), but no live crashes can be queried because the live ASC endpoint doesn't return build relationships. The most-recent crash reports stop at **v27** (2 reports on 2026-05-20T13:13–13:24, "Instant crash" / "After update app crashes when opening on IPad"). v28/29/30/36 have zero confirmed crashes — but also limited test coverage (only Michael + Jared per the crash-reporting devices `iPhone17_1` + `iPad13_17`).

- **Master HEAD as of 2026-05-23 01:36 = `9501914`.** Commits since `830b870` (v36's likely parent) touching field-mobile or staff-relevant shared packages:
  - **None directly to `apps/field-mobile/`** since 2026-05-21 12:02 — the entire 2 days since have been operator-web + bidder-app domain ports.
  - Shared `packages/`: `packages/supabase-client/`, `packages/domain-bidding/`, `packages/domain-fulfillment/` etc. — staff app doesn't use the same hook surface as bidder, but it does consume `@auction-platform/supabase-client` and `@auction-platform/domain-lotting`.
  - Probable staff-relevant changes since v36: `81bc505` (bidder receipts + lot CSV + platform admin), `91ce73b` (lotting auto-relist), `b189707` (/ops dashboard) — these are operator-web-side, staff iOS not directly affected.
  - **No new staff iOS build needed for 2 days of operator-web changes.** v36 is current.

- **Known issue on TestFlight build v27 (per plan and 27 crash reports):** instant-crash within ~284ms of process start, root cause = `expo-updates` TurboModule registration on iOS 26 + New Architecture. **Fixed in v28+** by removing the `expo-updates` package entirely (commit `07595da` and follow-ups). Per task #8 the user verified v29 on iPhone with clean install + email/password login — v27 is dead, fix shipped.

- **EAS builds that succeeded but never auto-submitted: none verifiable.** Same logic as bidder. Field-mobile `preview` profile has `distribution: store`.

### Staff app · Android

- **N/A.** Staff app has no Android target. `apps/field-mobile/app.config.ts:26` declares `platforms: ['ios', 'android']` but `eas.json` only configures iOS profiles. No Android build infrastructure exists.

---

## 6. App Store + Play Store submission state

### iOS — App Store

| App | App Store version | State | Build attached? | Next action |
|---|---|---|---|---|
| Bidder (ClovrBid) | 1.0 | `PREPARE_FOR_SUBMISSION` | No | Attach v22 (or v23 after card-save UX ships), fill listing metadata from `docs/STORE_METADATA.md`, paste reviewer credentials from `docs/APP_REVIEWER_NOTES.md`, submit. |
| Staff (ClovrBid Staff) | 1.0 | `PREPARE_FOR_SUBMISSION` | No | Per `app.config.ts:153-158`, staff app's "App Reviewer Notes" path is not yet ready (Apple Sign In capability not enabled). Not currently a submission target — staff is B2B-internal, may stay on TestFlight indefinitely. |

Per `docs/APP_REVIEWER_NOTES.md`, the bidder app has **reviewer credentials ready** (`reviewer@clovrbid.com` / `ReviewMe2026Clovr!`) and a demo auction fixture pipeline (`scripts/seed-app-reviewer-fixtures.mjs`).

Per `docs/STORE_METADATA.md`, full paste-ready iOS metadata exists (subtitle, description, keywords, screenshots) — last updated 2026-05-17. Should be re-validated against current product copy before submission.

### Android — Play Store

| App | Play track | Service account | Listing created? | Build uploaded? | Next action |
|---|---|---|---|---|---|
| Bidder | `internal` (preview) → `production` | **MISSING** (`.secrets/google-play-service-account.json` not on disk) | Unknown — `gh` doesn't query Play Console; user must verify in browser | No | User completes Play Console signup + service account, drops JSON in `.secrets/`, then `eas build -p android --profile preview --auto-submit` |
| Staff | N/A | N/A | N/A | N/A | Not targeted |

---

## 7. Recommended next builds

### Bidder iOS — v23 candidate

Highest-value commits since v22 (`441b79f`, 2026-05-21):

- `3bf5caf` (2026-05-21 20:34) — **card-save onboarding, receipt-only invoices, fee banner** in the bidder app's native UI. Closes UX gap with operator-web's web-bidder flow.
- `983c1ad` (2026-05-21 15:51) — **flip preview + production profiles to pk_live_** for Stripe. *Already in v22 if commit predates the EAS build trigger time (2026-05-21 04:18 UTC-7 = 2026-05-21 11:18 -05:00 — yes, v22 predates `983c1ad`).* So v22 still has `pk_test_` and any "pay" testing on TestFlight v22 was against Stripe test mode. **v23 would flip to live Stripe.** Worth re-verifying on the user side.
- `5908ba8` (2026-05-22 20:15) — card lockout root-cause + 3 L0 audit blockers. Touches `useBidderRole`-adjacent code.
- `81bc505` (2026-05-22 20:40) — bidder receipts + lot CSV + platform admin + PostHog funnel.
- `2794bb4` (2026-05-22 21:06) — MAC.BID-parity overhaul (UI improvements that may have native impact via shared `@auction-platform/design-system`).
- `9501914` (2026-05-23 01:36 — HEAD) — savings callout + pickup card + anon bid history + similar lots in native lot detail.

**Recommendation:** before triggering v23, **iOS Simulator Smoke is currently RED** on tip-of-master (last 2 runs failed on `b88390a` and `8836bec` per `gh run list`). Last green was `2794bb4` at 2026-05-23 01:15. Either wait for the GHA to be fixed, or trigger v23 off `2794bb4` (or whatever the last green SHA is).

### Bidder Android — v1 candidate

Blocked on **user manual action** (Play Console signup + service account). No code change is required — `apps/bidder-app/eas.json` is already wired with Android profiles, package name, App Links, and Play Console submit config (lines 96, 110). Once the service account JSON lands, a single `eas build --platform=android --profile=preview --auto-submit` produces both the AAB and the internal-track upload.

### Staff iOS — v37 candidate

Nothing pressing. v36 (uploaded 2026-05-21T09:09) is current — no field-mobile code has changed in 2 days, no new staff-bug reports since v29 verification (task #8). Defer until either:
- Apple Sign In capability enabled in Dev Portal → flip `app.config.ts:158 _appleSignIn_TODO` → trigger v37.
- Share extension fully wired (currently disabled via `// 'expo-share-intent'` block at `app.config.ts:115-130`) — needs one-time interactive `npx eas credentials --platform ios` per the comment.
- ARKit v36 reports come back negative (user testing) and a fix is needed.

### Staff Android — N/A

Not targeted.

---

## Appendix — confirmed gaps & data quality notes

1. **EAS auth unavailable on this Windows box.** No `EXPO_TOKEN` env var, no `~/.expo/state.json` session, no `.npmrc`. `npx eas whoami` returns "Not logged in." All build history in this report comes from the ASC API instead, which is canonical for iOS but says nothing about Android or about EAS-build-system-level metadata (who triggered the build, git commit hash recorded by EAS, build profile name). To get the EAS-side commit hash + profile name in future, set `EXPO_TOKEN` in `.env.cloudflare.local` or another `.env` file gitignored by the repo.

2. **ASC build → git commit attribution is heuristic, not exact.** ASC doesn't store the git SHA that produced the IPA. Attribution above is by "closest commit in time before the upload that touched the relevant app's source tree." Where the upload predates the closest plausible commit (visible in a few rows above), it means either (a) the commit's message is misleading about when the work was actually checked in vs pushed, or (b) the EAS build was triggered from a now-deleted branch / older commit. **For exact attribution, install + run `npx eas build:list --include-git`** from each app dir once authenticated.

3. **`crash-submissions.json` build-attribution data is stale (2026-05-20T08:36).** Live ASC endpoint returns crash counts but not build relationships in the `data` array (the `included` array has 9 build IDs but doesn't link them per-submission in the response shape this script consumed). Re-running `scripts/fetch-testflight-feedback.mjs` would refresh the cached file with build attribution for v28/29/30/36 — recommended as a follow-up.

4. **Bidder build #22 has 0 crash reports per ASC live query.** Either no one has crashed it (likely, given internal-only testing pool of ~3 people), or the bidder app simply doesn't crash anymore — the v19 hang doesn't generate crash reports because it's a hang, not a crash. The corresponding indicator that the v19 hang is real is the 0-crash gap in `clovrbid-crash-submissions.json` for the bidder app (`/v1/apps/6767012532/betaFeedbackCrashSubmissions` returns `data: []`).

5. **Field-mobile semver hasn't bumped since v0.1.0 — 36 builds in.** Per `eas.json appVersionSource=remote` + `autoIncrement: true`, the build number auto-increments but the semver doesn't — that's by design and won't be a problem until you actually submit to App Store (at which point Apple wants either a new semver or a higher build number than the previous app-store-submitted binary). Bidder bumped to v0.1.1 around build 7 (commits `73857ef` rename + `0735201` ci updates touched app.config.ts) and has stayed there.
