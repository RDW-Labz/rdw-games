# Store submission checklist

## One-time setup

### Apple
- [ ] Apple Developer Program membership ($99/yr).
- [ ] App Store Connect: create the app record. Bundle ID:
      `com.cluerholdings.auctionplatform`.
- [ ] Generate an Apple Push Notification key (APNs) and upload to EAS:
      `eas credentials -p ios --action push:apns`.
- [ ] Apple Pay merchant identifier:
      `merchant.com.cluerholdings.auctionplatform` — register in the
      Identifiers section of developer.apple.com.
- [ ] Fill `eas.json` `submit.production.ios` with `ascAppId`, `appleId`,
      `appleTeamId`.

### Google
- [ ] Google Play Console developer account ($25 one-time).
- [ ] Create app record. Package name:
      `com.cluerholdings.auctionplatform`.
- [ ] Create a service account in Google Cloud, grant it Play
      Console access, download the JSON key, save as
      `google-play-service-account.json` next to `eas.json` (keep out of git).
- [ ] Upload an FCM server key to EAS for push:
      `eas credentials -p android --action push:fcm`.

### EAS
- [ ] `eas init` to claim the project, set `extra.eas.projectId` in `app.json`.
- [ ] `eas secret:create EXPO_PUBLIC_SUPABASE_URL=...` and the rest of the
      `EXPO_PUBLIC_*` env vars. Production secrets via `eas secret`, not in git.
- [ ] Sentry: `eas secret:create SENTRY_AUTH_TOKEN=...` so source maps upload
      automatically during the build.

## Build

```bash
# Internal preview build (TestFlight + Play Internal testing)
eas build -p ios --profile preview
eas build -p android --profile preview

# Production
eas build -p all --profile production
```

## Submit

```bash
# After a production build succeeds
eas submit -p ios --latest
eas submit -p android --latest
```

## Pre-submission review checklist

- [ ] App Store Review guidelines: section 3.1.1 — IAP for digital goods.
      Subscriptions to platform-wide perks (early access, MSRP filters) are
      digital goods → must use Apple IAP, NOT Stripe, on iOS. Either:
      (a) gate subscription UI behind Android-only flag for v1, or
      (b) wire Apple IAP via `react-native-iap`. **Do not** ship the current
      Stripe-Checkout subscription flow on iOS without addressing this.
- [ ] Privacy nutrition labels filled in App Store Connect.
- [ ] Data Safety form filled in Play Console.
- [ ] Test the QR scanner permission flow on a fresh device install.
- [ ] Test push notifications end-to-end on TestFlight + Play Internal.
- [ ] Test the staging photo capture path on both iOS and Android.
- [ ] Confirm bidder + operator + picker role experiences all from the same binary.
