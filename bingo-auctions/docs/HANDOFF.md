# Handoff — current state and next-session pickup

Last updated: 2026-05-06 (~end of long EAS session).

> **NOTE (added 2026-05-12):** This doc is historical. The architecture
> described below describes the **pre-Cloudflare, pre-pg_cron auction-engine**
> plan that was superseded. The auction-engine was rewritten as a Supabase
> pg_cron + Cloudflare cron Worker pair, and `packages/auction-engine/` has
> been removed from the repo. For the current state, see
> [`SESSION_HANDOFF.md`](./SESSION_HANDOFF.md) and
> [`AUCTION_ENGINE_DEPLOY.md`](./AUCTION_ENGINE_DEPLOY.md).


## Where the platform is right now

The repo is **mid-migration** to a clean two-app architecture supported by
shared packages (per `docs/MIGRATION-PLAN.md`). Phases 0, 1, C.1, C.2,
3.1–3.5 all shipped. The remaining native-only Phase C work (walk-and-tap
sensors, iOS RoomPlan) is unblocked now that EAS Build / TestFlight is
working.

**On TestFlight (Apple processing as of this writing):**
- `Auction Platform` (consumer bidder) — ASC App ID `6767012532`,
  bundle `com.cluerholdings.auctionplatform`
- `ClovrBid Staff` (B2B field — staff + lotting + warehouse capture) —
  ASC App ID `6767026881`, bundle `com.cluerholdings.bidwizops`

Both built via EAS preview profile (App Store distribution). Sign-in
hits the hosted Supabase project — no LAN dependency.

## Architecture

```
auction-platform/  (npm workspaces)
  packages/
    shared/                types, money, bidding, schemas, features
    design-system/         theme tokens (colors, type, heatFromCloseAt, formatCountdown)
    supabase-client/       supabase singleton, useSession, useRole, useOperatorRole, tracker shim
    domain-bidding/        LotCard, PlaceBidSheet, BuyNowSheet, LiveBidTicker, PhotoCarousel,
                           PhotoLightbox, WatchlistToggle, useCategories, recentlyViewed, savedSearches
    domain-fulfillment/    PickupMap (with landmark rail), PickupScheduler, BinScanner
    domain-lotting/        Anthropic-backed AI: scanPhoto, identifyPhoto, fetchPrices, lookupCode,
                           fetchStockPhotos, createDraftLotFromCandidate, text helpers
    db/                    27 migrations (0001…0026)
    auction-engine/        BullMQ workers (closeLot, buildInvoices, settlements, push, email, sms,
                           closing-soon, saved-searches matcher)
  apps/
    operator-web/          Next.js 16 desktop console (port 3003)
                           routes: auctions, lots, imports, inventory, warehouses, pickups, disputes,
                                   invoices, settlements, payouts, staff, settings, lottr (NEW),
                                   lottr/batch (NEW), lottr/queue (NEW)
                           api routes: lottr/lookup-code, lottr/save-draft, lottr/enrich-lot,
                                       lottr/apply-enrichment
    bidder-app/            Expo SDK 54 — consumer bidder
                           ASC App ID: 6767012532 / EAS project e599586b-…
                           No more picker mode (moved to field-mobile)
    field-mobile/          Expo SDK 54 — B2B field (ClovrBid Staff)
                           ASC App ID: 6767026881 / EAS project b8bbf96a-…
                           routes: (auth)/login, (staff)/picker/*, (staff)/layout/*,
                                   (staff)/lotting/*
```

The two Expo apps share Supabase project, auth, RLS, and packages —
they're thin shells over `packages/`.

## Hosted Supabase

- **Project ref:** `xgsujdzicnjenhqihovk`
- **URL:** `https://xgsujdzicnjenhqihovk.supabase.co`
- **Region:** `us-east-1`
- **Pooler host:** `aws-1-us-east-1.pooler.supabase.com:6543`
- **Pooler user:** `postgres.xgsujdzicnjenhqihovk`
- **DB password:** stored in apps' `.env*` files (gitignored). Reset
  via dashboard if lost.
- **Anon key + service_role key:** in `.env.local` / `.env` files.
  Both keys are also baked into `eas.json` build profiles so the
  TestFlight binaries don't need .env at runtime.

All 26 migrations applied. Local migration 0013 patched to
`DROP FUNCTION IF EXISTS is_subscriber() CASCADE` so the policy from
0008 doesn't block the drop. Plus migration 0025 (inclusive bidder
features), 0026 (bin landmark photos).

**Seed data on hosted:**
- 1 operator: CLU (id `11111111-…`, code `CLU`)
- 1 warehouse: Main Warehouse (id `22222222-…`)
- 6 bins: A-01 → A-03, B-01 → B-03 (in the bidder pickup map's
  pixel grid)
- 67 categories (from migration 0018)
- 1 active auction (id `33333333-…`) with **6 live lots** at varied
  closing times (90 sec, 8 min, 25 min, 90 min, 6 hr, 20 hr) so the
  bidder app's heat-color tiers are exercised. Photos are
  picsum.photos placeholders.

**Auth users:**
- `jmacluer@gmail.com` (Cluer) — admin on CLU operator
  - Auth UUID: `2ef933f7-9f4a-4037-b3c9-fe89223979e9`
  - Bidder row exists; operator_users row pinned to admin
  - Password: `ClovrBid Staff2026!` (set via service_role admin API after
    signup-email-verification redirected to localhost). Rotate before
    real production use.

## TestFlight + Apple

- **Apple Dev account:** jmacluer@icloud.com (Team ID `73554WL25P`,
  individual)
- **App-specific password** stored as `EXPO_APPLE_APP_SPECIFIC_PASSWORD`
  during builds. Was shared in chat → **rotate this** at
  appleid.apple.com → Sign-In and Security → App-Specific Passwords.
- **Distribution Certificate** + **Apple Push Notifications key** on
  EAS server; reused across builds. Expires 2027-05-06.
- **TestFlight group "Team (Expo)"** auto-created by EAS, with
  jmacluer@icloud.com as a tester.

**Email confirmation: STILL ENABLED on Supabase Auth.** The Site URL
is `http://localhost:3000` which 404s for phone signups. Two options:
1. Disable: dashboard → Auth → Providers → Email → "Confirm email"
   OFF.
2. Or: set Site URL to a real public URL + add `auctionplatform://`
   and `bidwizops://` redirect URLs (the Redirect URLs list was
   already updated in this session).

## What's done since the last handoff

11 commits this session (most recent first):

- `135632c` EAS submit: Apple ID + Team ID configured (drops TBD placeholders)
- `e60f1d5` EAS: SENTRY_DISABLE_AUTO_UPLOAD=true on all profiles (no Sentry org yet)
- `c18fb52` operator-web: pin react to 19.1.0 to match the rest of the monorepo
  (was breaking EAS `npm ci` — direct workspace deps bypass root override)
- `ca53708` Regenerate package-lock.json from scratch — npm ci passes
- `affdf4b` Bidder app: dedupe android.permissions array (eas init double-write)
- `7accf04` EAS first-build artifacts: expo-updates + ITSAppUsesNonExemptEncryption + lock sync
- `ffff2bb` EAS init: link both apps to expo.dev projects
- `954bc12` EAS preview: switch to store distribution (TestFlight) — no UDID needed
- `8e80e63` Phase 3.5: Manifest queue (per-row AI enrichment)
- `5a2c28f` Phase 3.3: LotTR-Pro Tier 2 desktop classifier (batch UPC)
- `fca9f31` Hosted Supabase + EAS-ready configs

Earlier in this session:
- `d6a70f2` Phase 3.2.b photo scan → draft lot
- `ff9e94b` Phase 3.2 UPC scan → draft lot
- `0841d52` Phase C.2 sketch builder + Phase 3.1 domain-lotting package
- `dc2184d` Phase C.1 photo import + bin landmark photos
- `ffd44e7` Phase 1 field-mobile (ClovrBid Staff) bootstrap
- `9f4d70e` Phase 0 foundation refactor (4 new packages)
- `dde2dab` Bidder features: shift defaults from opt-in to opt-out
- `c195b92` My Bids: disambiguate bids→lots embed (cyclic FK)
- `82cf7ce` Bidder app: revert urgent-pulse to RN Animated (Reanimated 4 crashes Expo Go)
- `9eb5081` Bidder app audit pass — bidding-flow correctness, perf, polish

## What works end-to-end (or close to it)

- **Bidder app** on TestFlight signs in to hosted Supabase, browse
  grid renders 6 live lots, place_bid RPC works against hosted DB.
  Pickup map renders SVG floor plans (sketch mode output) via SvgUri,
  raster floor plans via expo-image. Bin landmark rail shows under
  the map for any bins with a landmark photo.
- **ClovrBid Staff** signs in (after operator_users gate) → staff home with
  Receiving, Pickup, Warehouse layout (Mode 1 photo / Mode 2 sketch /
  Mode 5 landmarks), Lotting (UPC + Photo scan).
- **operator-web** at :3003 → /lottr landing → batch UPC + manifest
  queue (per-row AI enrichment), enrich-lot + apply-enrichment APIs.
- **Lotting MVP loop**: scan or photograph item (mobile) OR paste a
  manifest of UPCs (desktop) → AI lookup → save as `pending_intake`
  → existing intake scanner (picker mode) → `in_inventory` + bin →
  Auction Builder pulls into auction → live → bidder bids → pickup.

## What's NOT built / known gaps

1. **ANTHROPIC_API_KEY not yet provisioned** for either app or
   operator-web. `apps/field-mobile/.env` has the env var slot
   (`EXPO_PUBLIC_ANTHROPIC_KEY=`); operator-web needs `ANTHROPIC_API_KEY`
   in `.env.local` (server-only). Until set, lotting AI surfaces show
   "no Anthropic key" warnings; everything else works.
2. **Phase C.3 walk-and-tap perimeter capture** — needs custom dev
   client (sensors flaky in Expo Go). Now unblocked since EAS
   credentials are set up.
3. **Phase C.4 iOS RoomPlan** — needs Swift native module + custom
   dev client.
4. **Phase 3.4 stock-photo re-hosting** — currently we save retailer
   CDN URLs into `lots.photo_urls`. Some retailers hot-link block.
   Defer to a worker that mirrors photos into the `lot-photos`
   bucket on a schedule.
5. **Operator-web is localhost-only.** No Cloudflare / Vercel deploy
   yet. Use Cloudflare Access (or Supabase auth + RLS as we already
   have) when deploying for real.
6. **EAS Build expo-updates was added during the first build** —
   both apps now have it configured to receive OTA updates on their
   `preview` channel. We haven't published any updates yet; do so
   with `eas update --branch preview` from each app dir when ready.
7. **No tests.** Most workspaces have `"test": "echo 'no-op'"`.

## How to start a fresh dev session

```bash
# 1. Hosted Supabase already running — no `supabase start` needed for
#    the apps to work. (Local Supabase Docker stack is also still up
#    if you want it for offline experiments; check `docker ps`.)

# 2. operator-web (desktop console)
cd C:\Users\jmacl\Projects\auction-platform
PORT=3003 npm run dev -w @auction-platform/operator-web
# → http://localhost:3003

# 3. auction-engine (BullMQ workers — close lots, build invoices,
#    settle, send push/email/sms)
npm run dev -w @auction-platform/auction-engine
# → :3100/health

# 4. Phone testing: don't run Metro. Install via TestFlight.
#    For dev iteration during a session, OPTIONALLY:
#       cd apps/bidder-app && npx expo start --tunnel
#       cd apps/field-mobile && npx expo start --tunnel --port 8082
#    Note: tunnel mode requires @expo/ngrok which had install issues
#    on Windows ARM in this session. iPhone hotspot or LAN-network
#    Expo Go also work when you're not on guest Wi-Fi.

# 5. Issue an OTA update to the TestFlight build (after committing)
cd apps/bidder-app
EXPO_TOKEN=<token> eas update --branch preview --message "fix X"
# Same for apps/field-mobile.
```

## EAS / Apple commands you'll re-run

```powershell
# All four env vars must be set per PowerShell session:
$env:EXPO_TOKEN = "<from apps/bidder-app/.env>"
$env:EXPO_APPLE_ID = "jmacluer@icloud.com"
$env:EXPO_APPLE_APP_SPECIFIC_PASSWORD = "<rotate; old one was leaked in chat>"
$env:EXPO_APPLE_TEAM_ID = "73554WL25P"

# New build (after code changes):
cd apps/bidder-app    # or apps/field-mobile
eas build --profile preview --platform ios

# Submit the latest build to TestFlight:
eas submit --profile production --platform ios --latest

# Or push an OTA JS update without rebuilding native code:
eas update --branch preview --message "..."
```

## Test credentials (rotate before real ops)

| Surface | email | password |
|---|---|---|
| Bidder app + ClovrBid Staff + operator-web | `jmacluer@gmail.com` | `ClovrBid Staff2026!` |
| Apple Developer | `jmacluer@icloud.com` | (your own) |
| EAS / Expo | account `rdw_cluer` | EXPO_TOKEN auth |

The bidder/admin password was set via service_role admin API after
the email-confirmation redirect to localhost broke the click-to-verify
flow. Rotate via the Forgot Password flow once email confirmation /
redirect URLs are configured properly.

## Key file locations

- Migrations: `packages/db/migrations/00NN_*.sql` (run with
  `scripts/push-hosted-migrations.js` against hosted, or
  `supabase db reset` against local)
- Hosted seed: `scripts/hosted-seed.sql` (bare op + warehouse + bins)
  + `scripts/hosted-test-auctions.sql` (live auction + 6 lots)
- Migration plan: `docs/MIGRATION-PLAN.md` — full multi-phase roadmap
- Bidder UI components: `packages/domain-bidding/src/components/`
- Field-mobile screens: `apps/field-mobile/app/(staff)/{picker,layout,lotting}/`
- LotTR-Pro desktop: `apps/operator-web/src/app/(operator)/lottr/`
- API routes for AI: `apps/operator-web/src/app/api/lottr/`
- LotTR domain logic (Anthropic): `packages/domain-lotting/src/ai/`
- EAS build configs: `apps/bidder-app/eas.json`, `apps/field-mobile/eas.json`

## Sessions of memory the assistant has saved

`C:\Users\jmacl\.claude\projects\C--Users-jmacl-Projects\memory\` includes:

- Auction-platform project pointer + business model + stack decisions
- User context (BidFTA buyer, in-house first operator)
- LotTR app pointer (separate repo at `C:\Users\jmacl\Projects\Lottr App\lottr` —
  source for the AI port we did this session into `packages/domain-lotting/`)
- Inventory + lot-code architectural model

Future sessions should re-load these without prompting.

## Open decisions for the next session

1. **Rotate the Apple app-specific password** that was shared mid-chat.
2. **Add ANTHROPIC_API_KEY** to operator-web `.env.local` (server-only)
   and field-mobile `.env` (`EXPO_PUBLIC_ANTHROPIC_KEY=`) so lotting
   AI surfaces light up. Then rebuild field-mobile with `eas build` to
   pick up the env var, OR push as an EAS Update.
3. **Decide on the Supabase email-confirmation strategy** —
   off entirely for dev (faster) or set Site URL + redirect URLs
   correctly for production-shaped flow.
4. **Custom dev client builds** (`eas build --profile development`) for
   both apps when you start C.3 / C.4. They support hot reload + native
   module changes; faster than rebuilding `preview` for every change.
5. **operator-web deployment target** — Vercel free tier is the obvious
   first stop. Then Cloudflare Access in front of it for an extra
   auth gate, or just trust Supabase RLS.
6. **Real photos** — currently every test lot uses picsum.photos
   placeholder. First real auction needs operator-web's CSV import
   wired up + the Smart Import flow tested against hosted DB.
