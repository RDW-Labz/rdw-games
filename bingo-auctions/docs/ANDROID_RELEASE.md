# ClovrBid Android Release Guide

End-to-end checklist for shipping the bidder-app to Google Play Store
alongside the iOS App Store release. Pairs with `apps/bidder-app/eas.json`
and `apps/operator-web/src/app/.well-known/assetlinks.json/route.ts`.

## Prerequisites

- Verified Google Play Developer account ($25 one-time registration fee)
- Google Cloud Console access (same Google account that owns the Play
  Developer account, or shared org)
- Access to `apps/bidder-app/` with `EXPO_TOKEN` configured in `.env`
- Operator-web deployed at `https://clovrbid.com` (needed for App Links)

---

## Step 1 — Create the app listing in Google Play Console

1. Sign in to [Play Console](https://play.google.com/console).
2. Click **Create app**.
3. Fill in the initial form:
   - **App name**: `ClovrBid`
   - **Default language**: English (United States)
   - **App or game**: App
   - **Free or paid**: Free
4. Accept the declarations:
   - Confirm the app meets the Developer Program Policies.
   - Confirm compliance with US export laws.
5. Click **Create app**.

The package name (`com.cluerholdings.auctionplatform`) is not bound to the
listing until the first AAB is uploaded — see Step 4.

---

## Step 2 — Set up the app in Play Console

Work through every item under **Dashboard → Set up your app**:

### App content

- **Privacy policy URL**: `https://clovrbid.com/legal/privacy`
- **App access**: All features available without special restrictions
  (no login wall blocks core browsing; bidding requires sign-up).
- **Ads**: No
- **Content rating**: Complete the IARC questionnaire. Expected
  outcome: PEGI 3 / ESRB Everyone — no objectionable content
  (the auction marketplace itself is not regulated content under IARC).
- **Target audience and content**: 18+ (financial transactions; auction
  bidding requires legal capacity to contract).
- **News app**: No
- **COVID-19 contact tracing and status**: No
- **Government apps**: No
- **Financial features**: Yes — facilitates payments (Stripe). Disclose
  that the app helps users make purchases and supports digital payments.

### Data safety section

Declare the following collected data types:

| Category        | Data                                  | Collected | Shared | Purpose                     |
|-----------------|---------------------------------------|-----------|--------|-----------------------------|
| Personal info   | Email                                 | Yes       | No     | Account management          |
| Personal info   | Name                                  | Yes       | No     | Invoicing / pickup verify   |
| Personal info   | Address                               | Yes       | No     | Invoicing / shipping        |
| Personal info   | Phone number (optional)               | Yes       | No     | Pickup notifications        |
| Financial info  | Payment method                        | Yes       | Yes (Stripe) | Process payments      |
| Financial info  | Purchase history                      | Yes       | No     | Account history             |
| App activity    | App interactions (bids, watchlist)    | Yes       | No     | Core auction features       |
| App activity    | In-app search history                 | Yes       | No     | Personalization             |
| Device or IDs   | Device or other IDs                   | Yes       | No     | Analytics / crash reporting |

Other declarations:
- **Encrypted in transit**: YES (all traffic is HTTPS / TLS)
- **Users can request deletion**: YES — via the in-app account-deletion
  flow (migration 0089, see `apps/bidder-app/app/account/delete*`)
- **Independent security review**: No (not required)
- **Family policy**: Not applicable (18+ audience)

---

## Step 3 — Create the service account for EAS auto-submit

The EAS submit profile expects
`.secrets/google-play-service-account.json` — generate it once and reuse
it for every release.

1. Open [Google Cloud Console](https://console.cloud.google.com/).
2. Pick (or create) a project. A dedicated project like `clovrbid-prod`
   keeps the keys isolated.
3. Go to **IAM & Admin → Service accounts → Create service account**.
   - **Service account name**: `eas-android-publish`
   - **Service account ID**: auto-fills (keep it)
   - **Role** (project-level): _Service Account User_
4. Click **Done**.
5. On the service account row, click **Manage keys → Add key → Create new
   key → JSON**. Download the file.
6. Move the downloaded JSON to
   `C:\Users\jmacl\Projects\auction-platform\.secrets\google-play-service-account.json`
   (the directory is gitignored).
7. Grant the service account release permissions inside Play Console:
   - Play Console → **Setup → API access**
   - Find the service account by email (something like
     `eas-android-publish@<project>.iam.gserviceaccount.com`)
   - Click **Grant access**
   - On the **App permissions** tab, add the ClovrBid app
   - Permission preset: **Release manager** (or fine-grained: _Release to
     production_, _Release apps to testing tracks_, _Manage testing tracks_)
   - **Invite user** → confirm

The service account propagation can take 5–10 minutes before EAS Submit
can use it.

---

## Step 4 — First build and manual upload

The very first Play Console upload must be manual — Play Console only
binds the package name to the listing after the first AAB lands, and
auto-submit requires the binding to already exist.

```powershell
cd C:\Users\jmacl\Projects\auction-platform\apps\bidder-app
# Production AAB (preferred — `app-bundle` build type)
npx eas build --platform android --profile production --non-interactive
```

When the build completes:

1. EAS dashboard → download the `.aab` file.
2. Play Console → ClovrBid app → **Release → Testing → Internal testing**.
3. **Create new release**.
4. Upload the `.aab`.
5. Add release notes (English (United States) is required).
6. **Save → Review → Roll out to internal testing**.

After this first upload Play Console will show the SHA-256 App signing
fingerprint — see the **"Where you'll get the SHA-256 fingerprint"**
section below.

---

## Step 5 — Internal testing

Add testers so the build is installable from the Play Store:

1. Play Console → ClovrBid → **Testing → Internal testing → Testers tab**.
2. **Create email list** → add the operator's testers' Google Play
   account emails (the email tied to their Play Store profile, not their
   ClovrBid account email).
3. Save the opt-in URL (Play Console shows it under **How testers join
   your test**) — share with testers.
4. Testers tap the opt-in URL on their Android device, accept, then the
   Play Store shows the internal release in the regular install flow.

Verify the opt-in works on at least one fresh device before promoting.

---

## Step 6 — Promote to closed testing

Google now requires **20 testers active for 14 days in closed testing**
before a Production rollout is allowed (policy introduced 2023-11).
Plan the calendar around this gate.

1. Play Console → **Testing → Closed testing → Create track**.
2. Promote the internal-testing release to the new closed track.
3. Recruit ≥ 20 active testers (the same opt-in pattern from Step 5).
4. Wait the full 14 days while collecting feedback. The clock is
   wall-clock; testers can install/uninstall but the listing must stay
   live with ≥ 12 opt-ins active most days.
5. After the gate is met, Play Console unlocks the **Promote to
   production** action.

For EAS auto-submit during this phase, switch the submit profile track:
edit `apps/bidder-app/eas.json`, set the `preview` submit profile's
`android.track` to `internal` (already there) and use the `production`
submit profile only after the gate passes.

---

## Step 7 — Production rollout

After closed testing graduates:

1. Play Console → **Release → Production → Create new release**.
2. Promote the AAB from closed testing (or upload a fresh build).
3. Release notes.
4. **Save → Review release**.
5. Google review: typically 1–3 days for a first production submission,
   sometimes a few hours for subsequent releases.
6. **Roll out to production** → the app is public on the Play Store.

Future production releases via EAS:

```powershell
cd C:\Users\jmacl\Projects\auction-platform\apps\bidder-app
npx eas build --platform android --profile production --auto-submit
```

`auto-submit` reads the `submit.production.android` block in `eas.json`,
uses the service account JSON, and uploads to the production track with
`releaseStatus: draft` so a human still clicks the final **Review →
Roll out** in Play Console (intentional — guards against accidental
prod pushes).

---

## Where you will get the SHA-256 fingerprint

The placeholder in
`apps/operator-web/src/app/.well-known/assetlinks.json/route.ts` must be
replaced with the real fingerprint or Android App Links auto-verify will
fail and `https://clovrbid.com/l/{token}` taps will fall back to Chrome
(the web flow works, but loses the in-app UX).

After the first AAB is uploaded:

1. Play Console → ClovrBid → **Setup → App integrity**.
2. Scroll to **App signing → App signing key certificate**.
3. Copy the **SHA-256 certificate fingerprint** value (it looks like
   `AB:CD:EF:01:23:...`, 32 hex pairs separated by colons).
4. Edit
   `apps/operator-web/src/app/.well-known/assetlinks.json/route.ts` and
   replace `PLACEHOLDER_SHA256` with the value.
5. Commit, push, redeploy operator-web (the standard deploy script).
6. Verify the deploy with:
   - Visit `https://clovrbid.com/.well-known/assetlinks.json` in a
     browser — content should match the route handler output and the
     fingerprint should be the real one.
   - On a tester device:
     `adb shell pm verify-app-links --re-verify com.cluerholdings.auctionplatform`
     should return `Domain verification state: clovrbid.com: verified`.

If the upload key and app-signing key differ (or during a key rotation),
list both fingerprints in the `sha256_cert_fingerprints` array.

---

## Quick reference

| Artifact                                          | Location                                                                   |
|---------------------------------------------------|----------------------------------------------------------------------------|
| EAS build/submit profiles                         | `apps/bidder-app/eas.json`                                                 |
| Android-specific Expo config                      | `apps/bidder-app/app.config.ts` (`android` block)                          |
| Android App Links route                           | `apps/operator-web/src/app/.well-known/assetlinks.json/route.ts`           |
| iOS Universal Links route (sibling)               | `apps/operator-web/src/app/.well-known/apple-app-site-association/route.ts`|
| Service account JSON (gitignored)                 | `.secrets/google-play-service-account.json`                                |
| EAS token                                         | `apps/bidder-app/.env` → `EXPO_TOKEN=...`                                  |
