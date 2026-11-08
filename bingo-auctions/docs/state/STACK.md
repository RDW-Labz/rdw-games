# ClovrBid Stack — Runners, Credentials, and Headless Surfaces

> Canonical "what we use, where it runs, where the keys live" doc.
> Updated 2026-05-24 after the EAS Pro upgrade + the launch-night build cleanup.
> See also: `docs/state/STATUS.md` for what's currently shipping; `docs/state/POST-V1-PLAN.md` for what's queued for v1.0.1+.

---

## TL;DR — Where work runs

| Workload | Runner | Cost lever |
|---|---|---|
| iOS / Android **production builds** | **EAS Cloud Pro** (m-large workers, priority queue, unlimited concurrent) | Pro plan ($99/mo) — already paid |
| **EAS Submit** (TestFlight + Play Store upload) | EAS Cloud Pro | included |
| **EAS Update** (JS-only OTA) | EAS Cloud Pro | included |
| Mobile **screenshot capture** (Maestro flows for ASC submission) | GHA macOS-15 (10x minute multiplier) — **path-gated to mobile commits only** | 50 macOS min/mo Pro free, then $0.08/min x 10 = $0.80/min |
| **CI** (lint, typecheck, test, schema migrations) | GHA Linux | 1x multiplier, 2000 min/mo Pro free, basically free |
| **Cloudflare Worker** deploy (operator-web) | GHA Linux | included |
| Local CLI / API scripts (ASC, Stripe, Supabase, Expo GraphQL) | User's Windows laptop | free |

**What we deliberately stopped doing:**
- `ios-simulator-smoke.yml` — DELETED 2026-05-24. EAS Build's archive step IS the smoke; the redundant 8-sec-survive check burned ~10 GHA macOS min per push.
- `android-simulator-smoke.yml` — DELETED 2026-05-24. Same. Plus this one consistently failed on the ubuntu disk-space issue.

---

## Mobile build pipeline (EAS Cloud Pro)

### Two apps
- `apps/bidder-app/` -> public bidder app (iOS App Store + Google Play). Bundle id `com.cluerholdings.auctionplatform`.
- `apps/field-mobile/` -> operator staff app (iOS App Store only — no Android target). Bundle id `com.cluerholdings.bidwizops`.

### Build profiles (in each `eas.json`)
- `development` — Expo Go dev clients (internal distribution)
- `preview` — TestFlight + Play Internal Testing (autoIncrement build number)
- `production` — App Store + Play Production (autoIncrement, **m-large workers**)
- `simulator-smoke` — historical, can be removed; not used after smoke workflows deleted

### Driver workflow
- `.github/workflows/eas-build.yml` (Linux runner) — dispatches `eas build` for any combination of `app`, `profile`, `platform`, and `submit`. Runs on a tiny Linux container; the heavy macOS lifting happens on EAS Cloud. Cost: pennies per dispatch.

### OTA workflow
- `.github/workflows/eas-update.yml` — JS-only updates that bypass App/Play review. Dispatches `eas update` to both `preview` and `production` channels by default (per memory `feedback_ota_both_branches.md`). Use for any post-launch change that doesn't touch native modules. Per `docs/EAS_UPDATE_PLAYBOOK.md` decision tree.

---

## Screenshot capture (only remaining GHA macOS workload)

`.github/workflows/maestro.yml` — keeps the `ios-screenshots` job (manual `workflow_dispatch` only, path-filtered). Drops everything else. After PR #27 the flows are assertion-tolerant and produce PNGs even when individual steps fail (proven 2026-05-24 — captured 5 valid 1320x2868 PNGs for the bidder app, uploaded to ASC successfully).

Future option if GHA macOS spend creeps back up: Maestro Cloud ($99/mo from mobile.dev — separate vendor from Expo) runs the same flows on their infrastructure. Setup is one `--cloud` flag in the YAML. Defer unless we exceed ~50 macOS min/mo regularly.

---

## Credentials inventory

### Apple — App Store Connect

| Credential | Where it lives | How it's used |
|---|---|---|
| ASC API key (`.p8` file) | **`.secrets/AuthKey_25M83P99J8.p8`** (local, gitignored) + **`ASC_API_KEY` GHA secret** (PEM contents) | Drives all ASC headless API calls. Used by every `scripts/*asc*.mjs` + `eas submit` (after the workflow materializes it to `/tmp/asc-key/AuthKey.p8` per PR #26) |
| Key ID | `25M83P99J8` (constant, hardcoded) + `ASC_API_KEY_ID` GHA secret | JWT `kid` header |
| Issuer ID | `df79d9d0-5f90-4a53-8e2f-4c16b3fafce9` (constant) + `ASC_API_KEY_ISSUER_ID` GHA secret | JWT `iss` claim |
| Apple Team ID | `73554WL25P` (constant, hardcoded in workflows + eas.json) | Cert + provisioning lookups |
| Apple Team Type | `COMPANY_OR_ORGANIZATION` (hardcoded in workflows) | Non-interactive credential mint (PR #17) |
| App ID — Bidder | `6767012532` (ASC) / `com.cluerholdings.auctionplatform` (bundle) | Submission targets |
| App ID — Staff | `6767026881` (ASC) / `com.cluerholdings.bidwizops` (bundle) | Submission targets |
| Distribution certificate + Provisioning profile | **Managed by EAS** (Expo's credential store). View via `eas credentials --platform ios` or Expo dashboard. Local fallback at `apps/*/credentials.json` (NOT present — EAS handles it). | Code-signing during EAS Cloud iOS build |

Note: We DON'T check in `.p12` cert files or `.mobileprovision` files. EAS manages those.

### Apple Sign-In (iOS auth provider — not signing)
- `usesAppleSignIn: true` in `apps/bidder-app/app.config.ts`. Apple ID capabilities enabled on the bundle. No additional credential needed.

### Google — Play Store

| Credential | Where it lives | How it's used |
|---|---|---|
| Google Play service account JSON | **`.secrets/google-play-service-account.json`** (local, gitignored) + **needs GHA secret** when running `eas submit` on Android in CI | Drives all `scripts/*play*.mjs` calls + EAS Android submit |
| Service account email | `play-publisher@cluer-auctions.iam.gserviceaccount.com` | Linked to the Bidder app in Play Console (Release Manager role) — confirmed 2026-05-24 |
| Play Developer API | Enabled on GCP project `379983272685` (confirmed 2026-05-24) | All API calls |
| Android keystore | **Managed by EAS** (Expo's credential store, auto-generated on first build). View via `eas credentials --platform android`. | Signing AABs during EAS Cloud Android build |
| Package name | `com.cluerholdings.auctionplatform` (bidder only — staff has no Android target) | Play Store listing |
| GCP project owner | RDW, LLC (separate from GOLD RUN LLC platform owner per memory `auction_platform_google_play.md`) | Org-level billing + access |

**"I don't see Android in EAS"** — Android creds are in the Expo credential store, viewable via `eas credentials --platform android` (interactive). The dashboard at `https://expo.dev/accounts/rdw_cluer/projects/auction-platform-bidder/credentials` has separate iOS + Android tabs. Android shows once a successful Android build has been done — first bidder Android build (run `26359887832`) succeeded + uploaded to Play Internal Testing on 2026-05-24, so the keystore IS there.

### Expo / EAS

| Credential | Where it lives | How it's used |
|---|---|---|
| Expo access token | **`apps/bidder-app/.env`** + **`apps/field-mobile/.env`** + **`EXPO_TOKEN` GHA secret** | `eas` CLI auth |
| Expo account / org | `@rdw_cluer` | All EAS resources scoped here |
| Plan | **Production / Pro** (active 2026-05-24, per memory `auction_platform_eas_pro.md`) | Unlocks unlimited concurrent + m-large + priority queue |

### Stripe

| Credential | Where it lives | How it's used |
|---|---|---|
| Live secret key | `.secrets/clovrbid-stripe-live.env` (`sk_live_*`) + Cloudflare Worker secrets | Server-side Stripe API |
| Live publishable key | Same env file (`pk_live_*`) + `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY` in eas.json (per profile) | Bidder app card form |
| Webhook secret | `.secrets/stripe-resource-ids.env` (`whsec_*`) + Worker secret | Webhook signature verification |
| Platform account | `acct_1TaMSsBQeMEcYR8P` (ClovrBid / GOLD RUN LLC) — never use the deprecated `acct_1TWlcf` per CLAUDE.md Rule 3 | All platform Stripe ops |

### Supabase

| Credential | Where it lives | How it's used |
|---|---|---|
| Project ref | `xgsujdzicnjenhqihovk` (constant) | Connection target |
| anon public key | `EXPO_PUBLIC_SUPABASE_ANON_KEY` in eas.json (per profile) + Worker secrets | Client-side queries (RLS-gated) |
| service role key | `.secrets/clovrbid-stripe-live.env` + Worker secret + `.env.smoke.local` | Server-side admin ops |
| Management API token | `.env.smoke.local` (`SUPABASE_MGMT_TOKEN`) | DB inspector scripts, seed fixtures |

### Cloudflare

| Credential | Where it lives | How it's used |
|---|---|---|
| API token (Workers + secrets) | `.env.cloudflare.local` + GHA secret | Worker deploys (`bidwizops` + `bidwizops-cron`) |
| Account owner | Darren (CTO) per memory `auction_platform_cloudflare_ownership.md`. Michael has Superadmin via API token. | Org-level billing |

---

## Full headless development + submission surface

What we can do END-TO-END without manual clicks (per memory `feedback_headless_always.md`):

| Action | Tool | Status |
|---|---|---|
| iOS build (signed IPA -> TestFlight) | `gh workflow run "EAS Build" --field app=bidder --field platform=ios --field submit=true` | working |
| Android build (signed AAB -> Play Internal) | same workflow, `--field platform=android` | working |
| OTA update both apps both channels | `gh workflow run "EAS Update (OTA)" --field app=both --field branches=both` | working (per `docs/EAS_UPDATE_PLAYBOOK.md`) |
| Push ASC text metadata (description, keywords, support URL, age rating, etc.) | `node scripts/push-asc-metadata.mjs --app both --live` | working |
| Upload ASC screenshots | `node scripts/upload-asc-screenshots.mjs --app bidder --live` | working (PR #28) |
| Attach build to ASC version + submit for App Review | `node scripts/submit-ios-app-store.mjs --app both --auto-submit --live` | working |
| Enable Apple App ID capabilities | `node scripts/enable-associated-domains-capability.mjs` (pattern works for any capability) | working |
| Inspect ASC bundle capabilities | `node scripts/inspect-app-id-capabilities.mjs` | working |
| Delete stale Apple provisioning profiles | `node scripts/delete-stale-provisioning-profile.mjs` | working |
| Clear Expo's iOS credential cache | `node scripts/clean-expo-ios-credentials.mjs` | working |
| Set ASC categories + pricing + supportsTablet | `node scripts/clear-asc-submission-blockers.mjs --app both --live` | working (PR #29) |
| Enable Play Developer API on GCP | `node scripts/enable-play-api.mjs` (one-time, then verify with `verify-play-api-only.mjs`) | user-blocked: SA needs `serviceusage.services.enable` IAM role for fully headless; otherwise 1-click in GCP |
| Submit Play AAB to internal/prod track | EAS submit via the workflow | working |

## What still REQUIRES manual user input

Apple + Google's architectural limits. Per memory `feedback_headless_always.md`, document any new one here when discovered.

| Action | Why it can't be headless | Frequency |
|---|---|---|
| **App Privacy data usages on ASC** | Apple does NOT expose `/v1/appDataUsages` to JWT-auth API keys. Per `docs/runbooks/asc-app-privacy-runbook.md`, the only headless path is fastlane spaceauth which requires a one-time interactive Apple ID + 2FA. | Once per app, once per data-usage-schema change |
| **Apple Developer Program annual renewal** | Apple ID 2FA + $99/yr payment | Yearly |
| **Stripe Tax country tax-form signing** | Tax entity owner must sign | Per-territory |
| **GCP project owner consent for new APIs** | If the SA lacks `serviceusage.services.enable`, only a GCP project owner can enable a new API. Workaround: grant the SA that role once. | Per new API enabled |

---

## Concurrency notes (Pro plan effect)

Before Pro: 1 EAS build at a time, ~30-60 min queue wait, m-medium worker.
After Pro: unlimited concurrent at m-medium tier, m-large available, priority queue.

Launch night (2026-05-24) actually-measured wall-clock times:
- Bidder iOS production build, cold (m-medium): ~21 min from queue acceptance to FINISHED
- Bidder Android production build, cold (m-medium): ~12 min
- Staff iOS production build, cold (m-medium): ~18 min

Projected with m-large (~20-30% faster per Expo benchmarks):
- Bidder iOS: ~15-17 min (save 4-6 min per cold build)
- Bidder Android: ~9 min (save 3 min per cold build)
- Staff iOS: ~13 min (save 4-5 min per cold build)

Concurrency win: dispatching all 3 in parallel takes ~15-17 min (slowest of the 3) vs ~51 min sequential before Pro. That's a **~3.3x wall-clock speedup** on the launch cycle.

Per-build dollar cost on Pro plan: incremental (eats into the 100+ credits/mo). Pre-Pro on the free tier was 30 credits/mo + sometimes hours of queue wait.

## How to apply this doc

When making a build / submit / cred decision:
1. Check the credentials inventory above — find what you need first.
2. If it's an Apple/Google/Expo/Stripe operation, look at the "Full headless surface" table — there's almost certainly a script for it.
3. If you can't find a script, check the "What still requires manual" table to confirm it's not a known limit.
4. If it's none of the above, write a new headless script and add a row here.
