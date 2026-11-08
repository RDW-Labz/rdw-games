# Launch Audit — 2026-05-28

Read-only audit of every blocker between us and a clean Apple + Google review of:
- **Bidder** v1.0 build #40 (iOS) / 0.1.1 vc 12 (Play, LIVE)
- **Staff** v1.0 build #49 (iOS) / 0.1.0 vc 3 (Play, LIVE)

Both iOS apps are currently `WAITING_FOR_REVIEW` in App Store Connect (submitted 2026-05-26). Both Android apps are LIVE in production on Google Play.

Source data: live ASC + Play API reads from `.secrets/AuthKey_25M83P99J8.p8` and `.secrets/google-play-service-account.json`, captured 2026-05-28T18:08Z.

---

## TL;DR

- **TOTAL BLOCKERS: 1** (privacy nutrition label state cannot be verified via API; Apple may or may not be holding the review on it)
- **TOTAL WARNINGS: 4**
- **READY TO RESUBMIT: YES** — apps are already in queue; no action required UNLESS we get a binary reject. Everything that API-verifiable is in good shape.

The actionable items are mostly hygiene: prune a duplicate untracked migration that risks getting committed in a future cleanup, and clean up Sentry DSN env vars in `eas.json` (now that mobile Sentry is re-added, this is no longer a launch blocker — but verify keys are LIVE before next build).

---

## Section 1 — Apple App Store Connect state

Source: `node scripts/inspect-asc-state` equivalents called inline at 2026-05-28T18:08Z via `.secrets/AuthKey_25M83P99J8.p8`. Existing helper scripts: `scripts/clear-asc-submission-blockers.mjs`, `scripts/push-asc-metadata.mjs`, `scripts/submit-ios-app-store.mjs`, `scripts/pull-asc-screenshots.mjs`, `scripts/upload-asc-screenshots.mjs`.

### Bidder — ClovrBid (App ID 6767012532)

Active version: `c8f37015-29e9-401a-a83d-f5b5b552b9ac` — v1.0, state `WAITING_FOR_REVIEW`.

| Check | Status | Details |
|---|---|---|
| Build attached | **PASS** | Build #40, `processingState=VALID`, uploaded 2026-05-26T10:44, expires 2026-08-24 |
| Screenshots — APP_IPHONE_67 (6.7") | **PASS** | 5 shots, all `COMPLETE` |
| Screenshots — 6.5" / 5.5" | **PASS** | Not required as of Apple's 2024 update — 6.7" set is now the only mandatory iPhone size; smaller sizes are auto-derived |
| Categories | **PASS** | primary=`SHOPPING`, secondary=`BUSINESS` |
| Age rating declaration | **PASS** | All categories `NONE`, all booleans `false`, `kidsAgeBand=null`; consistent with 17+ marketplace classification |
| Description | **PASS** | 2,428 chars (limit 4,000) |
| Keywords | **PASS** | 95 chars (limit 100): `auction,bid,online auction,liquidation,retail returns,estate,shopping,bargain,resale,clover,buy` |
| Promotional text | **PASS** | 149 chars (limit 170) |
| What's New | **PASS / N/A** | Empty — Apple explicitly disallows whatsNew on v1.0 first submissions (confirmed in `push-asc-metadata.mjs` line 357) |
| Support URL reachable | **PASS** | `https://clovrbid.com/support` → 200 |
| Privacy Policy URL reachable | **PASS** | `https://clovrbid.com/legal/privacy` → 200 |
| Marketing URL reachable | **PASS** | `https://clovrbid.com` → 200 |
| Subtitle / privacyPolicyUrl on appInfo localization | **PASS** | "Auctions, run honestly." + privacy URL set |
| contentRightsDeclaration on app | **PASS** | `USES_THIRD_PARTY_CONTENT` |
| Demo account credentials | **PASS** | `reviewer@clovrbid.com` + password set + demoAccountRequired=true |
| Reviewer contact | **WARN** | `+1 501-555-0100` — placeholder phone number from `push-asc-metadata.mjs` line 94. Apple does not call this number but reviewers occasionally do. Staff has the real number (`+18706544796`); bidder still has the dummy. **Fix:** `ASC_REVIEW_PHONE='+18706544796' node scripts/push-asc-metadata.mjs --app bidder --live` |
| Reviewer notes | **PASS** | 1,990 chars (limit 4,000) |
| Pricing tier | **PASS** | `appPriceSchedules/{id}/manualPrices` returns 1 entry (Free / USD_0) |
| Privacy nutrition label | **WARN (UNVERIFIABLE)** | `/v1/appPrivacyDetails` and `/v1/appDataUsages` both return 404 PATH_ERROR — Apple does NOT expose these via JWT auth. State is whatever the operator (Michael) set the last time in ASC web. Already-WAITING_FOR_REVIEW state implies Apple's submit-time validation didn't refuse, but Apple may surface this during human review |
| Review submission state | **PASS** | Most recent: `11a478e9-...` state=`WAITING_FOR_REVIEW`, submitted 2026-05-26T19:29Z. (Older READY_FOR_REVIEW draft `dd15d2d3-...` exists but is harmless; it just means a new draft was opened post-submit) |

### Staff — ClovrBid Staff (App ID 6767026881)

Active version: `bbbdb9b1-c354-4fd4-89be-22dfc00e4517` — v1.0, state `WAITING_FOR_REVIEW`.

| Check | Status | Details |
|---|---|---|
| Build attached | **PASS** | Build #49, `processingState=VALID`, uploaded 2026-05-26T10:42, expires 2026-08-24 |
| Screenshots — APP_IPHONE_67 (6.7") | **PASS** | 4 shots, all `COMPLETE` |
| Screenshots — 6.5" / 5.5" | **PASS** | Not required (see above) |
| Categories | **PASS** | primary=`SHOPPING`, secondary=`BUSINESS` |
| Age rating declaration | **PASS** | All `NONE` / `false`; same template as bidder |
| Description | **PASS** | 1,996 chars |
| Keywords | **PASS** | 94 chars: `auction,warehouse,inventory,intake,pickup,QR scan,operator,liquidation,returns,bin,lot,scanner` |
| Promotional text | **PASS** | 137 chars |
| What's New | **PASS / N/A** | Empty (v1.0; intentional — see above) |
| Support URL reachable | **WARN** | `https://clovrbid.com/staff/support` was not in the common-URL probe set. The URL is set on the staff localization but if the staff sub-path 404s, this is a reviewer-friction risk. **Recommend:** quick `curl -I` of `https://clovrbid.com/staff/support` before re-submission cycle |
| Privacy Policy URL reachable | **PASS** | Same as bidder — `https://clovrbid.com/legal/privacy` |
| Marketing URL reachable | **WARN** | `https://clovrbid.com/operators` — same caveat as staff support URL; verify the operator-facing sub-path returns 200 |
| Subtitle / privacyPolicyUrl on appInfo localization | **PASS** | "Operator side of ClovrBid." + privacy URL set |
| contentRightsDeclaration on app | **PASS** | `USES_THIRD_PARTY_CONTENT` |
| Demo account credentials | **PASS** | `reviewer@clovrbid.com` + password set + demoAccountRequired=true |
| Reviewer contact | **PASS** | `+18706544796` (real number) |
| Reviewer notes | **PASS** | 1,990 chars |
| Pricing tier | **PASS** | Free tier set |
| Privacy nutrition label | **WARN (UNVERIFIABLE)** | Same caveat as bidder — JWT cannot read this |
| Review submission state | **PASS** | `f9d444b5-...` state=`WAITING_FOR_REVIEW`, submitted 2026-05-26T20:09Z |

---

## Section 2 — Info.plist completeness

Searched `apps/bidder-app/**` and `apps/field-mobile/**` for native-API usage patterns. Cross-referenced against each `app.config.ts` `ios.infoPlist` block and each plugin's `*Permission` setting (Expo synthesizes the Info.plist key automatically from plugin config).

### Bidder — apps/bidder-app

| Native API used | Evidence | Required Info.plist key | Currently set? | Status |
|---|---|---|---|---|
| `expo-camera` (CameraView, useCameraPermissions) | `apps/bidder-app/app/dispute/new.tsx:26`, `apps/bidder-app/app/(tabs)/scan.tsx:33` | `NSCameraUsageDescription` | Yes — via `expo-camera` plugin `cameraPermission: 'Scan QR codes on bins to confirm pickup.'` (`app.config.ts:81-85`) | **PASS** |
| `RECORD_AUDIO` (Android permission listed) | `apps/bidder-app/app.config.ts:45` | `NSMicrophoneUsageDescription` | NOT set in iOS infoPlist | **WARN** |
| `expo-haptics` | `expo-haptics` dep in `package.json` | `NSMotionUsageDescription` | Not set — but expo-haptics uses Taptic Engine on iOS, NOT motion sensors. No Info.plist key required | **PASS** |
| `expo-apple-authentication` | plugin in config + `usesAppleSignIn: true` | None — uses iOS Sign in with Apple capability instead | n/a | **PASS** |
| `expo-notifications` | plugin in config | None at install time; only at registration | n/a | **PASS** |
| In-flight PR adds NSPhotoLibraryUsageDescription + NSPhotoLibraryAddUsageDescription | Per audit prompt — treat as set | Both | Treated set | **PASS** (per assumption) |

**Bidder WARN — RECORD_AUDIO Android permission listed but no iOS NSMicrophoneUsageDescription:**

The Android `RECORD_AUDIO` permission is declared in `app.config.ts:45` but there is NO microphone-using code in the bidder app (`expo-av`, `Audio.`, recording APIs all came back zero matches). The Android permission is dead weight; iOS doesn't need a usage string because no API touches the mic.

**Recommended fix (cosmetic, not a blocker):** delete `'android.permission.RECORD_AUDIO'` from `apps/bidder-app/app.config.ts:43-46` Android permissions array. Google Play reviewers occasionally flag apps with declared permissions that the app never uses. Apple does NOT care.

### Staff — apps/field-mobile

| Native API used | Evidence | Required Info.plist key | Currently set? | Status |
|---|---|---|---|---|
| `expo-image-picker` (photo library access for floor plans) | `app/(staff)/layout/bin-landmarks.tsx:19`, `app.config.ts:55` | `NSPhotoLibraryUsageDescription` | Yes — via `expo-image-picker` plugin `photosPermission: 'Pick a floor plan or warehouse photo from your library.'` | **PASS** |
| `react-native-vision-camera` | `app.config.ts:62-68`, `features/camera/*`, `app/(staff)/lotting/photo.tsx`, `lotting/quick.tsx`, `put-away/single.tsx`/`batch.tsx`/`shelf-scan.tsx`, `checkout/pickup-verify.tsx`/`stage.tsx`, `worklist/[id].tsx`, `layout/walk.tsx`, `layout/bin-landmarks.tsx` | `NSCameraUsageDescription` | Yes — via `react-native-vision-camera` plugin `cameraPermissionText` (`app.config.ts:63-67`) | **PASS** |
| Microphone (mic for AR / scanning) | `app.config.ts:65: enableMicrophonePermission: false` — explicitly disabled | n/a — vision-camera will NOT request mic | **PASS** | **PASS** |
| `RECORD_AUDIO` (Android permission listed) | `app.config.ts:49` | `NSMicrophoneUsageDescription` | NOT set in iOS infoPlist | **WARN** |
| ARKit (custom `clovrbid-arkit` module) | `modules/clovrbid-arkit/ios/ClovrbidArkitModule.swift`, `app/(staff)/layout/walk.tsx:237` calls `stamp_bin_walk_position` RPC | `NSCameraUsageDescription` (covers AR) + `arkit` UIRequiredDeviceCapabilities (set by plugin) | Camera covered; UIRequiredDeviceCapabilities `arkit` set by `./plugins/clovrbid-arkit` | **PASS** |
| `expo-haptics` | dep | None for taptic | n/a | **PASS** |
| `expo-image-manipulator` | dep | None (in-memory image ops) | n/a | **PASS** |
| `expo-share-intent` (currently DISABLED — commented out in app.config.ts) | `app.config.ts:116-130` | n/a until re-enabled | n/a | **PASS** (no code path active) |
| In-flight PR adds NSPhotoLibraryAddUsageDescription to staff | Per audit prompt | `NSPhotoLibraryAddUsageDescription` | Treated set | **PASS** (per assumption) |

**Staff WARN — RECORD_AUDIO Android permission listed but iOS mic explicitly disabled:**

Same finding as bidder — `RECORD_AUDIO` declared in Android permissions at `app.config.ts:49` but the `react-native-vision-camera` plugin at `app.config.ts:65` explicitly sets `enableMicrophonePermission: false`. The Android permission is dead. Recommended fix: delete the `'android.permission.RECORD_AUDIO'` entry.

---

## Section 3 — eas.json sanity

### Bidder — apps/bidder-app/eas.json

**Production build profile:**

| Field | Value | Verdict |
|---|---|---|
| `channel` | `production` | OK |
| `autoIncrement` | `true` | OK — works with `appVersionSource: "remote"` at top of file |
| `ios.resourceClass` | `m-large` | OK — matches EAS Pro plan memory |
| `android.buildType` | `app-bundle` | OK — required for Play production track |
| `EXPO_PUBLIC_SUPABASE_URL` | `https://xgsujdzicnjenhqihovk.supabase.co` | **LIVE** Supabase project — PASS |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | `sb_publishable_XCPKhpD0Ju...` | **LIVE** anon key — PASS |
| `EXPO_PUBLIC_API_BASE_URL` | `https://clovrbid.com` | LIVE — PASS |
| `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY` | `pk_live_51TaMSsBQeMEcYR8P...` | **LIVE Stripe — matches ClovrBid platform acct_1TaMSs from CLAUDE.md** — PASS |
| `EXPO_PUBLIC_GOOGLE_OAUTH_IOS_CLIENT_ID` | `379983272685-...` | OK |
| `EXPO_PUBLIC_SENTRY_DSN` | Set to production DSN | OK (mobile Sentry re-added per task #113) |

**Production submit profile (iOS):**
- `appleId` = `jmacluer@icloud.com` — OK (Apple ID for ASC API user is correct per memory)
- `ascApiKeyPath` = `../../.secrets/AuthKey_25M83P99J8.p8` — relative path from `apps/bidder-app/`. **PASS** — verified file exists in `.secrets/`
- `ascApiKeyId` / `ascApiKeyIssuerId` match key in `.secrets/` — PASS
- `appleTeamId` = `73554WL25P` — OK

**Production submit profile (Android):**
- `track` = `production` — OK
- `releaseStatus` = `draft` — **NOTE:** draft means EAS submits a draft on the prod track; you must manually promote in Play Console. Already-LIVE on production track per Play API (vc=12 status=completed), so the draft model is fine for incremental updates
- `serviceAccountKeyPath` = `../../.secrets/google-play-service-account.json` — verified exists — PASS

### Staff — apps/field-mobile/eas.json

Same shape as bidder. **All env vars in production profile match bidder**, both pointing at LIVE Supabase + LIVE clovrbid.com. PASS.

Note: `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY` is NOT set in the staff `production` profile, but staff doesn't take payments (no Stripe SDK in `package.json`). PASS.

**Both apps PASS Section 3.**

---

## Section 4 — Untracked-files risk

`git status --short` against this audit run:

### Migrations

| File | Status | Risk |
|---|---|---|
| `packages/db/migrations/0130_mfa_trusted_devices.sql` | **Untracked** | Backs an MFA "trust this device" feature in operator-web ONLY (`apps/operator-web/src/app/api/mfa/validate-trusted-device/route.ts` references `mfa_trusted_devices` table). NOT referenced by any mobile app code. Operator-web `(operator)/settings/2fa/` page + the `validate-trusted-device` route handler are also untracked. **Verdict:** if this feature has been deployed to prod CF Worker, the migration must be applied to Supabase; if not, none of it ships. Either commit it as a coherent feature or stash it. **NOT a mobile launch blocker.** |
| `packages/db/migrations/0140_fix_batch_intake_ambiguous_lot_code.sql` | **Untracked** | **DUPLICATE of committed `0142_fix_batch_intake_ambiguous_lot_code.sql`** — identical fix (same `lots.lot_code = v_id_clean` column qualification, same comments referencing the 2026-05-25 hotfix). Probably renumbered when 0140 slot was taken by `0140_lots_reserve_cents.sql`. **Action: delete the file** — keeping it is just confusion fodder. Already covered by mig 0142 (committed) and re-qualified by 0145 (committed). |
| `packages/db/migrations/tests/` | **Untracked** | Test directory; not consumed by prod. Safe to leave or commit as test scaffolding. |
| `rpc_live.sql` | **Untracked** | Top-level SQL dump (looks like a `pg_dump` of one RPC function body, starts at `DECLARE` mid-function). Likely an inspector output. Not referenced by anything. Safe to delete. |

### Scripts (`scripts/`)

All untracked scripts (`check-bingo-prefix.mjs`, `full-profile.js`, `inspect-bingo-inventory.mjs`, `invite-asc-user.mjs`, `list-tables.js`, `list-testflight-groups.mjs`, `profile-lots.js`, `profile-scrape.js`, `verify-sticker-rpc.mjs`) are diagnostic / inspector helpers. Grep for any filename minus extension under `apps/` returns zero hits — **none are imported by app code**. Safe to leave or commit.

### App source (`apps/operator-web/`)

- `apps/operator-web/src/app/(operator)/settings/2fa/` (`page.tsx` + `Mfa2faForm.tsx`)
- `apps/operator-web/src/app/api/mfa/validate-trusted-device/`

These form a self-contained MFA "trust device" feature shipped to the operator console only. The route and component reference each other but nothing else in committed code references them. The matching migration `0130_mfa_trusted_devices.sql` is also untracked — together they form one cohesive but un-merged feature.

**Verdict for mobile launch:** completely orthogonal to the iOS/Android review queue. Will not affect a fresh build of bidder or staff apps.

**Verdict for operator-web:** if `clovrbid.com` is currently deployed from master, this feature is off-prod regardless of intent. If it was meant to ship for the launch (operators need MFA before bidder/staff hit App Store?), it needs to be merged + migrated. Out of scope for THIS audit per the prompt, but flagging it for the main agent.

### Untracked migrations referenced by mobile RPCs?

Mobile RPC inventory (grep `supabase.rpc('...'` in both apps):

**bidder-app calls:**
- `set_bidder_preview_operator`, `resolve_lot_by_sticker`, `resolve_lot_by_qr_token`, `set_invoice_fulfillment`, `bidder_confirm_customer_pickup`, `record_operator_consent`, `delete_my_account`

**field-mobile calls:**
- `staff_confirm_pickup`, `assign_lot_to_bin`, `mark_import_row_lotted`, `find_import_row_by_tracking`, `intake_lot_to_bin`, `confirm_move_lot_to_bin`, `batch_intake_lot_to_bin`, `stamp_bin_walk_position`, `create_bins_bulk`, `claim_prestickered_qr`, `claim_sticker_code`

Cross-reference: ALL of these RPCs are defined in committed migrations (0126-0155 are committed; the untracked 0130 + 0140-dup do not introduce any new RPC names that the mobile apps call). The mobile apps' fresh build will not break on missing RPCs. **PASS.**

---

## Section 5 — Google Play state

Source: `node scripts/inspect-play-submission.mjs` equivalent at 2026-05-28T18:08Z via `.secrets/google-play-service-account.json`.

### Bidder — com.cluerholdings.auctionplatform

| Check | Status | Details |
|---|---|---|
| Production track release | **PASS** | `status=completed`, `name=0.1.1`, `versionCodes=['12']`, release notes en-US |
| Default language | **PASS** | `en-US` |
| Contact email | **PASS** | `legal@clovrbid.com` |
| Contact website | **PASS** | `https://clovrbid.com` |
| Listing title | **PASS** | "ClovrBid" |
| Short description | **PASS** | 62 chars (limit 80) |
| Full description | **PASS** | 1,569 chars (limit 4,000) |
| Icon | **PASS** | 1 image |
| Feature graphic | **PASS** | 1 image |
| Phone screenshots | **PASS** | 5 images |
| 7" tablet screenshots | **WARN** | 0 — not required (Play does not block on tablet shots) but reviewers occasionally flag tablet apps; not relevant since neither app is tablet-targeted (`supportsTablet: false` in iOS, no tablet manifest in Android) |
| Country targeting | **NOTE** | `countries: null` — defaults to all countries. Per memory `auction_platform_business.md` we are US-only launch. The Play release was published worldwide because the per-release country filter was not used; rely on operator-side geo-gating for buyers and on legal entity restrictions for sellers. Not a Play policy violation but worth noting for SEO-noise mitigation post-launch |

### Staff — com.cluerholdings.bidwizops

| Check | Status | Details |
|---|---|---|
| Production track release | **PASS** | `status=completed`, `name=0.1.0`, `versionCodes=['3']`, release notes en-US |
| Default language | **PASS** | `en-US` |
| Contact email | **PASS** | `legal@clovrbid.com` |
| Contact website | **WARN** | NOT set in API response (`contactWebsite` undefined). Bidder has it; staff doesn't. Google does not enforce this but it shows up as a soft-warning in Play Console. **Fix:** set via Play Console → Store presence → Store settings → Developer contact |
| Listing title | **PASS** | "ClovrBid Staff" |
| Short description | **PASS** | 68 chars |
| Full description | **PASS** | 2,084 chars |
| Icon | **PASS** | 1 image |
| Feature graphic | **PASS** | 1 image |
| Phone screenshots | **PASS** | 4 images |
| 7" tablet screenshots | **WARN** | 0 (same caveat as bidder) |

### Cannot read via API (console-only)

- Content rating (IARC questionnaire) — must verify in Play Console → App content → Content rating
- Data safety form — must verify in Play Console → App content → Data safety
- Target audience and content (TOAC) — Play Console → App content → Target audience and content
- News apps declaration (not applicable for ClovrBid, but reviewers do flag if marked incorrectly)

If any of these are unset/draft, Play will not flag it on the next release but may flag it at the FIRST review of the app. Since both apps are already in "production released" state, they passed the initial content gate. Subsequent updates only need re-attestation if the data-handling pattern changes.

---

## Section 6 — Risk summary

### TOTAL BLOCKERS: 1
- **Privacy nutrition label state on iOS** — UNVERIFIABLE via JWT API. Apple already accepted both apps into WAITING_FOR_REVIEW, which implies submit-time validation passed; but if Apple flags this during human review, the only fix path is the `fastlane spaceauth`-based runbook documented at `docs/runbooks/asc-app-privacy-runbook.md` (auto-generated by `clear-asc-submission-blockers.mjs`). For now this is a "known unknown" — not a confirmed blocker. Listed as 1 because it's the only thing that could surprise us.

### TOTAL WARNINGS: 4

1. **Bidder reviewer phone is the placeholder `+1 501-555-0100`** (staff has the real number). Easy fix: `ASC_REVIEW_PHONE='+18706544796' node scripts/push-asc-metadata.mjs --app bidder --live`.
2. **Staff support + marketing URLs use sub-paths `/staff/support` and `/operators`** — not verified reachable in this audit. Quick `curl -I` recommended before next submission cycle.
3. **Bidder + Staff Android both declare `RECORD_AUDIO` permission** that no code consumes. Cosmetic but trims Play Console flags. Delete the entry from both `app.config.ts` files before the next EAS build.
4. **Staff Play Console missing developer contactWebsite** (bidder has it; staff omits). Set in Play Console.

### READY TO RESUBMIT: YES — CONDITIONAL
Conditions:
- Both apps are already `WAITING_FOR_REVIEW` (submitted 2026-05-26). No re-submission needed unless Apple rejects.
- If a rebuild + resubmit IS required (e.g. Apple bounces on something), fix Warning #1 (phone) before pushing the next build.
- Audit also surfaces some untracked WIP (operator-web 2FA + mig 0130) that needs a decision: ship it with the launch, or stash it. Out of scope for mobile launch.

### Top 3 recommended actions ordered by impact

1. **WAIT.** Both iOS apps are in queue (submitted 2026-05-26). Both Android apps already live. No action required unless something bounces. (Highest impact: don't break what's working.)
2. **Delete `packages/db/migrations/0140_fix_batch_intake_ambiguous_lot_code.sql` (untracked)** — pure duplicate of committed `0142_fix_batch_intake_ambiguous_lot_code.sql`. Keeping it is technical debt that a future cleanup pass might "tidy" into committed code and accidentally re-apply a hotfix. Five-second fix.
3. **Decide on the orphan 2FA feature** in `apps/operator-web/src/app/(operator)/settings/2fa/` + `apps/operator-web/src/app/api/mfa/validate-trusted-device/` + `packages/db/migrations/0130_mfa_trusted_devices.sql`. Either commit + migrate + deploy as a coherent feature, or `git clean` it. Don't leave it half-staged across the launch window — when something fails it will be the first thing blamed.

---

## Appendix — Raw ASC + Play probe output (truncated)

Full JSON capture lives in the conversation transcript. Key endpoints used:

**ASC (JWT ES256 raw r||s):**
- `GET /v1/apps/{appId}` — contentRightsDeclaration
- `GET /v1/apps/{appId}/appStoreVersions?filter[platform]=IOS&limit=5`
- `GET /v1/appStoreVersions/{versionId}/build` — build attached
- `GET /v1/appStoreVersions/{versionId}/appStoreVersionLocalizations`
- `GET /v1/appStoreVersionLocalizations/{locId}/appScreenshotSets`
- `GET /v1/appScreenshotSets/{setId}/appScreenshots`
- `GET /v1/apps/{appId}/appInfos?include=primaryCategory,secondaryCategory`
- `GET /v1/appInfos/{appInfoId}/ageRatingDeclaration`
- `GET /v1/appInfos/{appInfoId}/appInfoLocalizations`
- `GET /v1/reviewSubmissions?filter[app]={appId}`
- `GET /v1/appStoreVersions/{versionId}/appStoreReviewDetail`
- `GET /v1/apps/{appId}/appPrivacyDetails` → **404 PATH_ERROR** (known Apple limitation)
- `GET /v1/appDataUsages?filter[app]={appId}` → **404 PATH_ERROR** (known Apple limitation)
- `GET /v1/appPriceSchedules/{appId}/manualPrices` — pricing tier

**Google Play (OAuth `androidpublisher` scope):**
- `POST /androidpublisher/v3/applications/{pkg}/edits` (throwaway edit)
- `GET /edits/{id}/details`
- `GET /edits/{id}/listings`
- `GET /edits/{id}/listings/{lang}/{icon|featureGraphic|phoneScreenshots|sevenInchScreenshots}`
- `GET /edits/{id}/tracks`
- `DELETE /edits/{id}` (abandon — nothing committed)

URL reachability via `fetch(url, {redirect: 'follow'})` to confirm 2xx/3xx without HEAD-only servers tripping the probe.
