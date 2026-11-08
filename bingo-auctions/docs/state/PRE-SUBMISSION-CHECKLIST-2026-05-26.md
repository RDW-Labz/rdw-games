# Pre-submission readiness checklist (2026-05-26)

Final go/no-go list before dispatching `eas-build.yml -f submit=true`. Status as of master @ post-PR-#75 (W2/W3/W6-P2/W9 all merged).

## Code readiness

| Item | State | Detail |
|---|---|---|
| All Phase C workstreams merged | ✓ | W1, W2, W3, W4, W5-DB+UI, W6-P0+P1+P2, W7, W8, W9 (slice 2+3), W10, W11 all on master |
| DB migrations applied to prod | ✓ | through `0148_loads_table.sql` (verified live) |
| Tests pass on master | ✓ | PR #75 CI: typecheck, lint, Playwright, schema migrations, test, db package tests — all green |
| TestFlight OTA up to date | ✓ | b11 + b12 OTAs dispatched to preview + production channels |
| No uncommitted WIP on master | ✓ | clean (untracked state docs only) |

## Apple / iOS

### ASC credentials + workflow

| Item | State | Detail |
|---|---|---|
| ASC API key `.p8` | ✓ | `.secrets/AuthKey_25M83P99J8.p8` (key id `25M83P99J8`, issuer `df79d9d0-…-fce9`) |
| GHA secrets `ASC_API_KEY`, `ASC_API_KEY_ID`, `ASC_API_KEY_ISSUER_ID` | ✓ | set 2026-05-23 |
| `apps/bidder-app/eas.json` submit config | ✓ | production + preview both have iOS submit blocks with `ascAppId 6767012532` |
| `apps/field-mobile/eas.json` submit config | ✓ | iOS only (`ascAppId 6767026881`); no Android (staff Play not registered) |
| `eas-build.yml` workflow | ✓ | supports `submit: true` input; materializes key on disk; sets `EXPO_APPLE_TEAM_ID 73554WL25P`, `EXPO_APPLE_TEAM_TYPE COMPANY_OR_ORGANIZATION` |

### ASC app records

| App | ASC App ID | State |
|---|---|---|
| ClovrBid Bidder | `6767012532` | Active; recent TestFlight builds (7, 8, 10) |
| ClovrBid Staff | `6767026881` | Active; recent TestFlight builds (1, 8, 10). Public name "ClovrBid Staff"; "bidwizops" is only the immutable bundle id. |

### Store metadata

| Item | State | Detail |
|---|---|---|
| Bidder description + keywords + subtitle | ✓ | `docs/STORE_METADATA.md` — comprehensive |
| Bidder "What's New" copy | ✓ | in STORE_METADATA.md |
| Bidder Privacy nutrition labels (text) | ✓ | drafted in STORE_METADATA.md; **must be entered into ASC web by Michael** if not already from prior submissions |
| Bidder support URL, marketing URL, privacy URL | ✓ | clovrbid.com paths |
| Staff description + metadata | ⚠ TODO | Bidder-only today; new `docs/STORE_METADATA_STAFF.md` needed |
| Reviewer credentials (bidder) | ✓ | `docs/APP_REVIEWER_NOTES.md` — `reviewer@clovrbid.com` / `ReviewMe2026Clovr!` |
| Reviewer credentials (staff) | ✓ | seeded as `demo-staff@clovrbid.com` / `DemoStaff2026!` — but no separate reviewer-notes file |
| Demo auction live + 30 days out | ✓ | re-seeded 2026-05-26; closes 2026-06-25 |

### Screenshots

| Item | State | Detail |
|---|---|---|
| Maestro screenshot flows committed | ✓ | bidder: 4 (home / lot-detail / bid-placed / pickup); staff: 2 (lotting-hub / checkout-verify) |
| Maestro workflow with screenshot job | ✓ | `.github/workflows/maestro.yml` ios-screenshots job (manual dispatch) |
| Screenshot device matrix | ✓ | iPhone 16 Pro Max 6.7" (1290×2796) — only required size per Apple's 2025 rules |
| **Fresh screenshots after b12 OTA** | 🟡 IN PROGRESS | dispatched workflow run `26463351262` at 17:13Z 2026-05-26 |
| Screenshots uploaded to ASC | ⚠ depends on above | uploader `scripts/upload-asc-screenshots.mjs` works for bidder; staff path needs generalization (low risk — can upload manually if needed) |

### Compliance items (Apple)

| Item | State | Detail |
|---|---|---|
| Export compliance (encryption) | ✓ | answer "No, uses only standard system encryption" |
| IDFA / SKAdNetwork | ✓ | not used (no ads) — answer "No" in ASC |
| Content rating (17+) | ✓ | documented in STORE_METADATA.md |
| Account deletion (5.1.1(v)) | ✓ | implemented + reviewer notes describe path |
| Sign in with Apple (4.8) | ✓ | wired (per APP_REVIEWER_NOTES) |
| Stripe / IAP separation (3.1.1) | ✓ | reviewer notes block explains marketplace + Stripe Connect Standard with destination charges |

## Google / Android

### Play Console + service account

| Item | State | Detail |
|---|---|---|
| Service account `eas-android-publish` | ✓ | `.secrets/google-play-service-account.json` |
| Service account has Release Manager on Bidder | ✓ | verified via `scripts/verify-play-api-only.mjs` (200 OK) |
| Service account has Release Manager on Staff | ✗ | Staff app not registered yet |
| `apps/bidder-app/eas.json` Android submit config | ✓ | track=internal (preview), track=production (production), releaseStatus=draft |
| `apps/field-mobile/eas.json` Android submit config | ✗ | No Android submit block (intentional until app exists) |

### Play app records

| App | Package | State |
|---|---|---|
| ClovrBid Bidder | `com.cluerholdings.auctionplatform` | Registered, all 4 tracks empty (production/beta/alpha/internal) — first AAB upload pending |
| ClovrBid Staff | `com.cluerholdings.bidwizops` | **NOT registered** — must be created by Michael in Play Console |

### Play store metadata

| Item | State | Detail |
|---|---|---|
| Bidder short description (80 chars) | ✓ | in STORE_METADATA.md |
| Bidder full description (4000 chars) | ✓ | in STORE_METADATA.md |
| Bidder data safety form | ⚠ ASC equivalent done; Play form is **separate** and must be entered in Play Console |
| Bidder content rating questionnaire | ⚠ to be filled in Play Console (Michael, web action) |
| Bidder graphic assets (icon, feature graphic, screenshots) | 🟡 same as iOS — workflow run pending |

## Blockers summary (in priority order)

| # | Blocker | Owner | Action | Time |
|---|---|---|---|---|
| 1 | **Staff Android — register in Play Console** | Michael | play.google.com/console → Create app → `com.cluerholdings.bidwizops` under RDW LLC | 5 min |
| 2 | **Staff app metadata + reviewer notes** | code | extend STORE_METADATA.md with a Staff section; single file with staff block (in flight) | 15 min |
| 3 | **Fresh screenshots after b12 OTA** | running | wait for workflow run `26463351262` to finish | ~25 min |
| 4 | **Verify Apple Privacy nutrition labels are entered in ASC** | Michael web action OR scripts/push-asc-metadata.mjs | check ASC → App Privacy page; if blank, paste from STORE_METADATA.md "App Privacy disclosure form (iOS)" | 5 min |
| 5 | **Verify Play "Data safety" form is filled** | Michael web action | Play Console → App content → Data safety; mirror Apple disclosures | 10 min |
| 6 | **Content rating questionnaire (Play)** | Michael web action | Play Console → App content → Content rating | 5 min |

Items 1-6 must clear before Phase 2 build+submit. Items 1-2 are blockers for full coverage; items 4-6 can be done IN PARALLEL with the build running.

## Phase 2 commands (after blockers clear)

```powershell
cd C:\Users\jmacl\Projects\auction-platform
git log --oneline -3   # confirm latest commit you want to ship

# Bidder iOS + Android — TestFlight + Play internal track
gh workflow run "eas-build.yml" -f app=bidder -f profile=production -f platform=all -f submit=true

# Staff iOS only (no Android until blocker #1 clears)
gh workflow run "eas-build.yml" -f app=staff  -f profile=production -f platform=ios -f submit=true
```

Each runs ~25 min on EAS Cloud + ~5 min for `eas submit` to upload to TestFlight / Play. Bidder + staff run independently.

## Phase 3 monitoring

After dispatch:
1. Watch GHA Actions tab — confirm both workflows complete green
2. ASC → TestFlight tab — new build appears within ~5 min of EAS completion; status "Processing" → "Ready to Submit"
3. Play Console → Release → Testing → Internal — new AAB appears in draft
4. ASC → App Store → v1.x → click "Submit for Review" (web UI) OR re-run eas-build with submit=true (idempotent)
5. Apple review: 24-48 hours, you'll get email status changes
6. Play internal testing: ≥12 testers for 14 consecutive days before Google unlocks promote-to-beta

## Rollback safety

If a submission needs to be pulled:
- iOS: ASC → version → "Reject Binary" before review starts; OR if approved but not released, "Remove from Sale"
- Android: Play Console → Release → Halt rollout (production) or remove from track (internal/beta)
- App-level: dispatch an OTA via `eas update --branch production` (and `preview`) — bidder/staff already on OTA channels, will get patches without going through review

## Reference docs

| Doc | Purpose |
|---|---|
| `docs/state/PRE-SUBMISSION-CHECKLIST-2026-05-26.md` | **this** — readiness check |
| `docs/state/SUBMISSION-PLAN-2026-05-26.md` | submission strategy + Phase 1-4 plan |
| `scripts/SUBMISSION_PLAYBOOK.md` | step-by-step script usage |
| `docs/STORE_METADATA.md` | listing copy (bidder; staff section pending) |
| `docs/APP_REVIEWER_NOTES.md` | reviewer credentials (bidder; staff block pending) |
| `apps/bidder-app/eas.json` | bidder build/submit config |
| `apps/field-mobile/eas.json` | staff build/submit config |
