# BinGo Staff

Expo + React Native app for operator warehouse staff. Intake scanning, lotting with AI (via LotTR), ARKit walk-and-scan floor mapping (iOS 16+), and inventory management. Runs on iOS and Android; updates ship via EAS builds + TestFlight, not OTA.

## Quickstart

Install dependencies:

```bash
npm install
```

Start the development server:

```bash
npx expo start
```

Run on iOS (macOS required):

```bash
npx expo run:ios
```

Run on Android:

```bash
npx expo run:android
```

On physical devices, use the Expo Go app or a development build (see below).

## Environment Variables

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
```

Required variables:

| Variable | Description |
|---|---|
| `EXPO_PUBLIC_SUPABASE_URL` | Supabase project URL. Local dev: `http://127.0.0.1:54321` |
| `EXPO_PUBLIC_SUPABASE_ANON_KEY` | Supabase public anon key. Get from `supabase status` or dashboard. |
| `EXPO_PUBLIC_API_BASE_URL` | Base URL of operator-web backend (no trailing slash). Local: `http://<your-lan-ip>:3000`. Production: `https://bingoauctions.com` |

Optional variables:

| Variable | Description |
|---|---|
| `EXPO_PUBLIC_POSTHOG_KEY` | PostHog analytics key (leave blank to disable). |
| `EXPO_PUBLIC_SENTRY_DSN` | Sentry error reporting (leave blank to disable). |

**Do NOT add AI provider keys to `.env`.** The mobile app never holds `OPENROUTER_API_KEY` or similar — all AI calls are proxied through operator-web's `/api/lottr/*` routes, which validate the Supabase JWT server-side before forwarding to external AI services.

## Building for TestFlight

Staff app updates ship via fresh EAS builds pushed to TestFlight. There is no OTA (over-the-air) update mechanism.

Build for preview (TestFlight):

```bash
npx eas build --platform ios --profile preview
```

After the build completes, EAS will auto-submit to TestFlight (configured in `eas.json`).

To check build status:

```bash
npx eas build:list
```

## Why No expo-updates (OTA)

The staff app intentionally has no OTA update mechanism. In May 2026, the `expo-updates` package crashed at launch on iOS 26 with an unhandled Objective-C exception from `EXUpdatesAppController`'s native init when running on React Native 0.81.5 + New Architecture.

Details:

- **Root cause:** `EXUpdatesAppController` initialization in the bare native module conflicted with iOS 26's runtime
- **Why disabling didn't work:** Setting `updates.enabled: false` in `app.config.ts` didn't prevent the native module registration
- **The fix:** Removed `expo-updates` from `package.json` entirely (line 145–150 in `app.config.ts` explains the decision)
- **Reference:** See `app/(staff)/_layout.tsx:20–29` for the removal comment

Staff updates now ship exclusively via fresh EAS builds distributed through TestFlight and App Store.

## App Configuration

**Display name:** BinGo Staff\
**Bundle ID (iOS):** `com.cluerholdings.bidwizops`  
**Package (Android):** `com.cluerholdings.bidwizops`  
**Current version:** 0.1.0  
**iOS deployment target:** 16.0 (required by ARKit module)

See `app.config.ts` for runtime configuration logic.

## Architecture

### AI Proxy Pattern

All AI calls are proxied through operator-web's `/api/lottr/*` routes:

```
field-mobile (Bearer JWT)
    ↓
operator-web (/api/lottr/scan-photo, etc.)
    ↓
OpenRouter / Anthropic / other AI providers
```

The mobile app sends a base64-encoded image or text query; operator-web validates the Supabase JWT via `admin.auth.getUser()`, confirms the user has an `operator_users` row, then forwards to the AI provider. The mobile app never sees the API key.

Proxy endpoints (see `apps/operator-web/src/app/api/lottr/` for implementations):

| Route | Body | Purpose |
|---|---|---|
| `POST /api/lottr/scan-photo` | `{ base64, mediaType }` | Identify items from barcode or item photo |
| `POST /api/lottr/identify-photo` | `{ base64, mediaType }` | Generic image-to-text (fallback) |
| `POST /api/lottr/lookup-code` | `{ code }` | UPC/EAN lookup via OpenRouter |
| `POST /api/lottr/search-keyword` | `{ query }` | Keyword-based item search |

Mobile client in `lib/lottr-client.ts` handles requests and JWT attachment.

### Backend Deployment

The operator-web backend (which handles `/api/lottr/*` routes and all app APIs) is deployed to **Cloudflare Workers**, not Vercel. Deployment scripts:

- Local deploy from WSL: `bash scripts/deploy-cf.sh`
- CI/CD: `.github/workflows/deploy-cloudflare.yml`

The field-mobile app itself is a standalone React Native app — it does not run on Cloudflare. It only makes API calls to operator-web running on Cloudflare.

## Features

### Intake (Scan to Bin)

Barcode scanning with camera integration. Staff scan items and bins, creating new lots. Full integration with inventory system.

### Lotting (LotTR-Pro)

AI-powered lot classification and description. Supports:

- **Local (Ollama):** Run models locally via Ollama tunnel
- **Remote (OpenRouter):** Call OpenRouter API via operator-web proxy

Llama 3.2 11B-Vision by default; swappable in settings.

### Walk-and-Scan (ARKit, iOS 16+)

Real-time AR camera pose tracking while staff walk the warehouse floor, capturing floor plan coordinates and item placement relative to warehouse features. ARKit falls back gracefully on unsupported devices.

### Share Extension (iOS)

Receive URLs shared from Safari, Amazon, eBay, or other apps. URLs are passed to intake flow for web-scraping and item data population.

### Batch Operations

- **Batch put-away:** Move multiple items to bins at once
- **Batch print:** Print labels for multiple lots
- **Batch edit:** Update metadata across lots

### Picker Mode

Floor plan display with interactive bin navigation, lot-to-bin assignment, and staged inventory view.

### Layout / Floor Plan

Visual warehouse layout with drag-and-drop bin placement. Snap photos of the warehouse and AI-annotates bin locations.

### Inventory & Label Print

Edit lot metadata in-app. Print QR code labels via network printers or AirPrint.

## Native Modules

- **ARKit** (iOS 16+) — Pose tracking, floor plane detection. Gracefully unavailable on older iOS or Android.
- **Vision Camera** — Barcode scanning and item photo capture
- **Share Extension** (iOS) — Receive URLs from other apps
- **AsyncStorage** — Local session persistence

## Sister Apps

- **[bidder-app](../bidder-app/)** — Consumer-facing React Native app for bidders. Separate Expo project, same Supabase backend.
- **[operator-web](../operator-web/)** — Next.js web console for warehouse operators and admins. Hosts `/api/lottr/*` proxy routes. Deployed to Cloudflare Workers.

## Running Locally (Full Stack)

1. **Start Supabase** (terminal 1):

```bash
supabase start
```

2. **Start operator-web dev server** (terminal 2):

```bash
cd apps/operator-web
cp .env.local.example .env.local
# Add OPENROUTER_API_KEY to .env.local
npm run dev
```

3. **Start field-mobile** (terminal 3):

```bash
cd apps/field-mobile
cp .env.example .env
# Set EXPO_PUBLIC_API_BASE_URL to http://<your-lan-ip>:3000
npm start
```

On physical devices, set `EXPO_PUBLIC_API_BASE_URL` to your machine's LAN IP (not `localhost` — the device needs to reach the dev server over the network).

## Troubleshooting

### Build fails with "higher minimum deployment target"

The iOS deployment target is pinned to 16.0 (ARKit requirement). If EAS complains about a higher required target, update `app.config.ts` line 90–93.

### Share extension not working on iOS

The share extension target (`com.cluerholdings.bidwizops.share-extension`) requires provisioning profiles. Run this once:

```bash
npx eas credentials --platform ios
```

Then uncomment the `expo-share-intent` plugin block in `app.config.ts` lines 116–130 and re-build.

### ARKit crashing on iOS

ARKit is only available on iOS 16+. The app falls back to standard camera mode on older versions. If you see crashes, check the iOS version in TestFlight builds.

### Proxy routes returning 401

Ensure:

1. `EXPO_PUBLIC_API_BASE_URL` points to a running operator-web instance
2. The Supabase auth token is valid (check `supabase.auth.getSession()`)
3. Your user has an `operator_users` row in the Supabase database

## Filing Issues

**Internal:** Chat / Slack  
**TestFlight feedback:** Use the in-app feedback button on the TestFlight app page

## TypeScript Checks

Before committing:

```bash
npm run typecheck
```

This runs `tsc --noEmit` to catch type errors.
