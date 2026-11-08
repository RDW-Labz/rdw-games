# Master migration plan — two-app architecture

Last updated: 2026-05-06.

This is the master plan for splitting the monorepo into a clean two-app
architecture supported by shared packages. We picked this over a single
role-gated app because at the target scale (10K+ lotted products / 90K
sqft warehouses) the consumer and field workloads have different
performance, bundle, and update-cadence requirements.

The current state, the end state, and the path between them all live
here. Future sessions should re-read this before starting work.

## End-state architecture

```
auction-platform/
  packages/                              ← shared logic
    shared/                              types, money, bidding helpers (exists)
    design-system/                       colors, type, primitives
    supabase-client/                     supabase init + auth + role gates
    domain-bidding/                      lot detail, bid sheet, watchlist
    domain-fulfillment/                  intake, stage, pickup, landmarks
    domain-lotting/                      LotTR — UPC scan, AI lookup, bulk classify
    domain-layout/                       Phase C capture modes
    db/                                  migrations, seed (exists)
    auction-engine/                      BullMQ workers (exists)

  apps/
    operator-web/                        Next.js — desktop admin
      src/app/(operator)/...             auctions, lots, imports, payouts (exists)
      src/app/(operator)/lottr/          LotTR-Pro Tier 2 desktop
    bidder-mobile/                       Expo — consumer-facing only
      app/(tabs)/, app/lot, app/invoice, app/pickup
    field-mobile/                        Expo — B2B field app (ClovrBid Staff)
      app/(auth)/                        same auth as bidder
      app/picker/                        intake + stage + landmark
      app/lotting/                       LotTR mobile — UPC + AI fill + photos
      app/layout/                        Phase C native capture
      app/operator/                      operator-only field tasks
```

**Key architectural rules:**
- All shared logic lives in `packages/`. Apps are thin shells.
- Both Expo apps consume packages via `@auction-platform/<name>` workspace
  imports — no semver discipline, both always run latest.
- LotTR is a domain package, not an app. It surfaces in operator-web
  (desktop classifier) and field-mobile (UPC scan + AI fill).
- Both Expo apps share Supabase project, auth, RLS, and `operator_staff`
  table. Role gating happens in `packages/supabase-client/`.

## Branding for now

| Surface | Name | Slug / package | Notes |
|---|---|---|---|
| Consumer Expo app | "Auction Platform" | `auction-platform-bidder` | existing |
| B2B field Expo app | **"ClovrBid Staff"** | `bidwizops-field` | placeholder — may rename later |
| Desktop console | "Auction Platform Operator" | n/a (web) | existing |

The platform-wide unified brand is undecided. Renaming the slug + bundle
identifier is a 5-minute job in `app.config.ts` so we can defer the
naming decision until the product has shipped to a real operator.

## Phases

### Phase 0 — Foundation refactor (no behavior change)

Pure structural cleanup. Extract shared code into packages so both apps
can consume it.

- 0.1 Audit `apps/bidder-app/` and identify movable code
- 0.2 Create `packages/design-system/` skeleton
- 0.3 Create `packages/supabase-client/` skeleton
- 0.4 Create `packages/domain-bidding/` skeleton
- 0.5 Create `packages/domain-fulfillment/` skeleton
- 0.6 Move `lib/theme.ts` → design-system (with re-export shim during
  transition)
- 0.7 Move `lib/supabase.ts`, `lib/session.ts`, `lib/role.ts` → supabase-client
- 0.8 Move `features/bidding/*` → domain-bidding
- 0.9 Move picker / intake / stage / pickup logic → domain-fulfillment
- 0.10 Add `operator_staff` migration (0026) + a `useOperatorRole` hook
  in supabase-client
- 0.11 Verify both apps typecheck, Metro bundles, web still serves 200
- 0.12 Commit Phase 0

**Verification gates:**
- `tsc --noEmit` passes on bidder-app, operator-web
- Metro bundle builds without errors
- Bidder app on Expo Go iOS still loads, renders Browse, opens lot detail
- Operator-web at `:3003` still renders dashboard

### Phase 1 — Bootstrap `apps/field-mobile`

Stand up the second Expo app as an empty shell, then move picker logic
in. No new features; just an architectural split.

- 1.1 `npx create-expo-app apps/field-mobile` (Expo SDK 54, TypeScript)
- 1.2 Configure `app.config.ts`: slug `bidwizops-field`, bundle id
  `com.cluerholdings.bidwizops`, version 0.1.0
- 1.3 Wire up `packages/supabase-client/` and `packages/design-system/`
- 1.4 Build the auth flow (login + signup) sharing the same Supabase
  project as bidder-mobile
- 1.5 Add role gate — only users with `operator_staff` row can access
  past auth
- 1.6 Move `apps/bidder-app/app/picker/` → `apps/field-mobile/app/picker/`
- 1.7 Bidder-mobile loses picker mode; field-mobile gains it
- 1.8 EAS Build configuration: dev profile, preview profile, production
  profile. Set up via the user's existing TestFlight / Apple Developer
  account
- 1.9 Verify field-mobile bundles in Expo Go (or custom dev client),
  loads, signs in, lands on picker screen for a staff role
- 1.10 Commit Phase 1

**Blocker for Phase 1:** Apple Developer + TestFlight accounts must be
ready (user confirmed). Slug `bidwizops-field` will be reserved in EAS.

### Phase 2 — Phase C capture modes (in field-mobile)

The native warehouse-capture features. See the earlier in-chat plan
for full details on each mode.

- C.1 Custom dev client + native photo import (Mode 1) + landmark
  photos (Mode 5)
- C.2 Sketch builder (Mode 2) on `react-native-svg`
- C.3 Walk-and-tap perimeter (Mode 3) with inertial dead-reckoning + GPS
- C.4 iOS RoomPlan (Mode 4) — Swift native module wrapping
  `RoomCaptureView`

Modes live under `apps/field-mobile/app/layout/`. Logic lives under
`packages/domain-layout/`.

### Phase 3 — LotTR migration

Fold the existing `C:\Users\jmacl\Projects\Lottr App\lottr` repo into
this monorepo. The classifier becomes a domain package surfaced in two
places.

- 3.1 Audit LotTR — current dependencies, server, classification logic
- 3.2 Extract domain logic to `packages/domain-lotting/`:
  - `classify.ts` — category alias matching
  - `lookup.ts` — AI lookup (Claude vision + web_search)
  - `queue.ts` — manifest staging / bulk processing
  - `scan.ts` — UPC barcode helpers
- 3.3 Build `apps/field-mobile/app/lotting/` — UPC scanner, AI fill,
  photo intake, push results into `lots` via existing intake RPCs
- 3.4 Build `apps/operator-web/src/app/(operator)/lottr/` — Tier 2
  desktop classifier (manifest tables, bulk edit)
- 3.5 Standalone Tier 3 (the existing repo) keeps its standalone form
  for shops that don't run their own auctions — can also depend on
  `packages/domain-lotting/` if it migrates onto the same backend later

### Phase 4 — Polish + release

- 4.1 EAS Update channels per app for OTA JS updates
- 4.2 TestFlight builds for both Expo apps
- 4.3 Public App Store / Play Store listings — bidder-mobile public,
  field-mobile starts as TestFlight-only
- 4.4 Operator nurture emails + onboarding sequence (parked in HANDOFF
  as a separate workstream)

## Risks + decisions held

1. **Custom dev client breaks stock-Expo-Go workflow.** Solution: two
   slugs, two builds. Bidder-mobile stays on Expo Go for consumer
   testing; field-mobile requires a custom dev client (TestFlight +
   internal direct-link).
2. **Inertial dead-reckoning accuracy is rough.** Mode 3 ships with
   "rough outline — drag corners to fix" UX, not surveyor precision.
3. **RoomPlan device gating.** iPhone Pro / iOS 16+ only. Show "Coming
   soon" stub on Android and older iPhones.
4. **Storage budget.** Floor plans + landmark photos × thousands of
   bins grows fast. Auto-resize captures to 2048px max; lifecycle
   policy on `floor-plans` and `bin-landmarks` buckets.
5. **Brand name across the board.** Deferred. ClovrBid Staff is the field
   app placeholder. Platform-wide rename is a future decision.
