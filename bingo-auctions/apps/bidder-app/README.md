# BinGo Bidder App

Public-facing iOS + Android mobile app for consumer bidders on the auction platform. Built with Expo + React Native 0.81.5.

Bundle ID: `com.cluerholdings.auctionplatform` (legacy; see [Architecture Notes](#architecture-notes)).  
Version: 0.1.1  
App name: **BinGo**

## Overview

The bidder app enables end users to:
- Browse live and scheduled lots across operators
- Manage watchlists and bidding activity
- Place and proxy bids with soft-close countdown mechanics
- Scan QR codes on bins to resolve lot deep-links
- Complete pickups with signature capture
- Access a warehouse map with bin locations (if enabled by operator)
- Sign in via email/password, Apple Sign-In, or Google Sign-In

Key screens: **Browse** (home), **Watchlist**, **My Bids**, **Scan**, **Pickup**, **Profile**.

## Quickstart

### Prerequisites
- Node.js 22.11.0+
- npm (not pnpm)
- iOS: Xcode 16+ on macOS
- Android: Android SDK (API 21+)

### Local Development

1. Install dependencies:
   ```bash
   npm install
   ```

2. Start the dev server:
   ```bash
   npm run start
   ```

3. Run on iOS simulator:
   ```bash
   npm run ios
   ```

4. Run on Android emulator:
   ```bash
   npm run android
   ```

### Using Expo Go

For quick testing on a physical device without a dev client:
1. Install Expo Go from App Store or Google Play
2. Run `npm run start`
3. Scan QR code in terminal with your phone

### Using Development Client

For testing with native modules (camera, notifications, Stripe):
1. Install Expo CLI: `npm install -g expo-cli`
2. Create a dev build via EAS:
   ```bash
   eas build --platform ios --profile development
   ```
3. Once built, TestFlight will install automatically on your device
4. Run `npm run start` and scan the QR code to load your changes

## Environment Variables

All environment variables must be prefixed with `EXPO_PUBLIC_` to be accessible at runtime. Local overrides use `.env.local`.

| Variable | Purpose | Default (development) |
|----------|---------|---|
| `EXPO_PUBLIC_SUPABASE_URL` | Supabase project URL | `https://xgsujdzicnjenhqihovk.supabase.co` |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | Supabase anonymous key | `sb_publishable_XCPKhpD0JuDatqUldAVLmw_WMApkNi6` |
| `EXPO_PUBLIC_API_BASE_URL` | API base URL (production: `https://bingoauctions.com`) | `https://bingoauctions.com` |
| `EXPO_PUBLIC_GOOGLE_OAUTH_IOS_CLIENT_ID` | Google OAuth client ID for iOS | `379983272685-5b3urch9chchlrgoflhnbhk31e4hvthm.apps.googleusercontent.com` |
| `EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY` | Stripe publishable key (pk_live_* for preview/production) | `pk_test_*` for development |
| `EXPO_PUBLIC_SENTRY_DSN` | **Deprecated** — removed 2026-05-19. Do not use. | — |

### Stripe Key Flipping

- **Development** (`development` EAS profile): Uses `pk_test_*`
- **Preview + Production** (`preview` and `production` EAS profiles): Use `pk_live_*` (flipped 2026-05-21)

The key flip enables real Stripe test/live environments to match preview vs. production app binaries. Local development can override via `.env.local`:
```
EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_51TWlcx17JHWfuqJl...
```

## Building for TestFlight + Play Console

### Prerequisites

Ensure you have secrets in place:
- `~/.secrets/AuthKey_25M83P99J8.p8` — Apple App Store Connect API key
- `~/.secrets/google-play-service-account.json` — Google Play service account (for Android; not in repo; set up locally)

### Build Commands

**Preview (TestFlight + Play Console internal track):**
```bash
eas build --platform ios --profile preview
eas build --platform android --profile preview
```

**Production (App Store + Play Store):**
```bash
eas build --platform ios --profile production
eas build --platform android --profile production
```

**iOS simulator (smoke tests only; not distributable):**
```bash
eas build --platform ios --profile simulator-smoke
```

Build profiles are defined in `eas.json` with:
- Automated version code/number increment (`autoIncrement: true` for preview/production)
- Channel targeting (`preview` channel for TestFlight, `production` for App Store)
- Environment-specific Stripe keys

### App Store Connect

App ID: `6767012532`  
Team ID: `73554WL25P`

After the first Android build, copy the SHA-256 signing certificate fingerprint from Play Console → Setup → App integrity → App signing into `apps/operator-web/src/app/.well-known/assetlinks.json/route.ts` to enable Android App Links. Then redeploy operator-web.

TestFlight build numbers are auto-incremented; do not hardcode in documentation (see EAS Build logs or App Store Connect for current version).

## Stripe

Preview and production builds use **live Stripe keys** (`pk_live_*`) to enable real test transactions on Stripe's production environment. This is intentional—the Stripe CLI in backend services uses test mode keys while the app uses live public keys, creating a testing sandbox within production infrastructure.

To override locally:
```bash
echo 'EXPO_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_xyz' >> .env.local
npm run start
```

## OTA Updates

The app supports over-the-air updates via `expo-updates`. When you push an OTA, both TestFlight and release-track users receive the update on their next app launch (via `checkAutomatically: 'ON_LOAD'` in `app.config.ts`).

### Pushing Updates

```bash
# Preview channel (TestFlight users)
eas update --branch preview

# Production channel (App Store users)
eas update --branch production
```

**Important:** Always target **BOTH** `preview` and `production` branches unless you have a specific reason not to. The preview branch is what TestFlight users see; production is for App Store releases.

### Limitations

- **WSL ARM machines**: EAS Update cannot bundle Hermes bytecode (hermesc is x86_64 ELF, incompatible with aarch64). OTAs must be pushed from an x86_64 machine or bundled into the next `eas build` (which uses EAS cloud builders).
- **OTA + anti-bricking**: The `disableAntiBrickingMeasures` flag is set to `true` for preview/development builds to allow users to escape dead-loop OTAs. It is `false` for production (App Store requires this to pass review).

## Universal Links & Scan Tab

QR codes on bins link to `bingoauctions.com/l/{qr_token}`, which deep-links into the app to a specific lot.

### How It Works

1. User scans QR code on physical bin (Scan tab)
2. Or clicks `bingoauctions.com/l/{token}` link in browser
3. OS recognizes the domain + path pattern via:
   - **iOS**: `associatedDomains: ['applinks:bingoauctions.com']` in `app.config.ts`
   - **Android**: `intentFilters` with `data.pathPattern: '/l/.*'` in `app.config.ts`
4. App opens directly to the lot detail screen (no web fallback)

The domain validation files are:
- **iOS**: `https://bingoauctions.com/.well-known/apple-app-site-association`
- **Android**: `https://bingoauctions.com/.well-known/assetlinks.json`

Both are served by `apps/operator-web/src/app/.well-known/*/route.ts` and must include the app bundle ID (iOS) and signing certificate fingerprint (Android) to authenticate the link.

## Sister Apps

- **[field-mobile](../field-mobile/)** — Operator staff app for in-warehouse lot intake, scanning, and fulfillment
- **[operator-web](../operator-web/)** — Web console for operator admin + public-facing lot browsing (authenticated bidders)

## Architecture Notes

### Legacy Bundle ID

The bundle ID is intentionally kept as `com.cluerholdings.auctionplatform` across brand changes. Renaming would require:
- New App ID in Apple Developer Portal
- New App Store Connect record (replacing ASC App ID 6767012532)
- Losing all TestFlight history on the original record

Not worth the churn. Apple displays the user-facing `name` field ("BinGo") on the home screen and in TestFlight; the bundle ID is internal infrastructure.

### Sentry Removal

Sentry was removed entirely on 2026-05-19 due to iOS 26 launch crash. The `@sentry/react-native` Expo plugin was suspected of hanging during native build initialization (Info.plist edits, Pod install of sentry-cocoa SDK). The plugin's pre-JS initialization can block the app thread on iOS 26.x with Hermes + Fabric, causing the splash screen to hang indefinitely.

Solution: Removed the plugin entirely. The `lib/sentry.ts` file remains for future re-enable but is no longer imported. Do not re-enable until the iOS 26 hang is isolated and fixed.

### React Native & Hermes

- React Native 0.81.5 with New Architecture enabled (`newArchEnabled: true`)
- Hermes bytecode engine for smaller bundle sizes and faster startup
- On ARM machines (e.g., Mac M1/M2 with WSL ARM), the hermesc binary cannot be invoked during OTA bundle operations

## Testing Locally

### Unit Tests

No test runner is configured. To add:
```bash
npm install --save-dev jest @testing-library/react-native
npm test
```

### E2E Tests

E2E tests are not yet implemented. To add Playwright:
```bash
npm install --save-dev playwright @testing-library/react-native
```

See `apps/operator-web/` for a Playwright E2E example.

### Common Gotchas

- **Expo Go is limited**: It does not load native modules (camera, Stripe integration, notifications). Use the dev client for full testing.
- **Stripe Key Mismatch**: If Stripe rejects your card, check `eas.json` env vars—development uses `pk_test_*`, preview/production use `pk_live_*`.
- **Deep-links not opening**: Verify `.well-known/apple-app-site-association` and `assetlinks.json` are deployed. Rebuild and reinstall the app; iOS caches the file.
- **OTA updates not showing**: Run `eas update --branch <your-branch>`, then completely close and reopen the app (not just backgrounding). Updates check on app launch via `checkAutomatically: 'ON_LOAD'`.
- **Permissions denied on Android**: Check `android.permissions` in `app.config.ts`. Camera and audio permissions are requested during onboarding.

## Scripts

```bash
npm run start         # Start Expo dev server
npm run ios          # Run on iOS simulator
npm run android      # Run on Android emulator
npm run web          # Start web (experimental)
npm run lint         # ESLint
npm run typecheck    # TypeScript check
```

## Key Files

- **`app.config.ts`** — Expo configuration (runtime profiles, permissions, deep-links, anti-bricking)
- **`eas.json`** — EAS Build profiles (channels, env vars, signing, version management)
- **`app/(tabs)/*`** — Tab navigator screens (Browse, Watchlist, My Bids, Scan, Pickup, Profile)
- **`app/(auth)/*`** — Authentication flows (login, signup, OAuth, forgot-password)
- **`app/lot/[id].tsx`** — Lot detail page (bidding, watchlist, soft-close)
- **`app/pickup/[id].tsx`** — Pickup detail page (warehouse map, signature capture)
- **`app/complete-profile.tsx`** — Post-signup profile completion (DOB, consents)
- **`lib/`** — Utilities (push notifications, image upload, PostHog analytics, Sentry stubs)

## Support & Feedback

For bugs, feature requests, or documentation issues, open an issue in the main [auction-platform](../README.md) repository.

---

**Last updated:** 2026-05-23  
**Status:** Production (iOS App Store, TestFlight; Android Play Store internal track)
