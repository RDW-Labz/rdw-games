# App Store + Play Store Submission Playbook

Step-by-step guide to submitting ClovrBid bidder app to Apple App Store and Google Play Console from your laptop.

**Before you start:** Both scripts default to DRY-RUN mode. Add `--live` to make actual API calls.

---

## Prerequisites

### Apple App Store (iOS)

Required files + setup:
- `✓ .secrets/AuthKey_25M83P99J8.p8` — ASC API key (257-byte PKCS#8 PEM)
- `✓ TestFlight build processed by Apple` — wait 5–10 min after EAS build completes
- `✓ v1.0 PREPARE_FOR_SUBMISSION app version` — create manually in ASC if needed
- Environment variables: none (all loaded from config)

### Google Play Store (Android)

Required files + setup:
- `? .secrets/google-play-service-account.json` — **MISSING — you must create this**
- `? AAB file` — either built locally or downloaded from EAS
- `? Play Console account + app listing` — **MISSING — you must create this**
- Environment variables: none (all loaded from service account key)

---

## Step 1 — Prepare Your Environment

### iOS only: Verify ASC API key exists

```powershell
cd C:\Users\jmacl\Projects\auction-platform
ls -la .secrets/AuthKey_25M83P99J8.p8
```

Output should show a 257-byte file dated May 13, 2024. If missing, contact Michael (owns the ASC account).

### Android only: Create Google Play service account (ONE-TIME SETUP)

If `.secrets/google-play-service-account.json` doesn't exist:

1. Open [Google Cloud Console](https://console.cloud.google.com/)
2. Pick (or create) a project: `clovrbid-prod`
3. **IAM & Admin → Service accounts → Create service account**
   - Name: `eas-android-publish`
   - Grant role: **Service Account User**
   - Click **Done**
4. On the service account row, click **Manage keys → Add key → Create new key → JSON**
5. Download the JSON file, move to:
   ```powershell
   C:\Users\jmacl\Projects\auction-platform\.secrets\google-play-service-account.json
   ```
6. Grant Play Console permissions:
   - Play Console → **Settings → API access**
   - Find the service account by email
   - Click **Grant access** → select ClovrBid app
   - Permission: **Release manager**
   - **Invite**

Wait 5–10 minutes for permissions to propagate.

### Android only: Have an AAB ready

If you haven't built one yet:

```powershell
cd C:\Users\jmacl\Projects\auction-platform\apps\bidder-app
npx eas build --platform android --profile production --non-interactive
# Wait ~20 min for build to finish
# Download .aab from EAS dashboard, save to ~/Downloads/app.aab (or keep in build output)
```

---

## Step 2 — Dry-Run Both Scripts

Always test before going live.

### iOS: Test the submission flow (no changes yet)

```powershell
cd C:\Users\jmacl\Projects\auction-platform
node scripts/submit-ios-app-store.mjs --app both
```

**Expected output:**
```
[DRY-RUN] would find latest TestFlight build...
[DRY-RUN] PATCH /v1/appStoreVersions/{versionId}/relationships/build
[DRY-RUN] Would attach build #42 to version 1.0
```

No errors = you're ready for `--live`.

### Android: Test the submission flow (no changes yet)

```powershell
cd C:\Users\jmacl\Projects\auction-platform
node scripts/submit-android-play-store.mjs --track internal
```

**Expected output:**
```
[DRY-RUN] POST /applications/com.cluerholdings.auctionplatform/edits
[DRY-RUN] Would upload AAB to edit DRY_RUN_EDIT_ID
[DRY-RUN] Would promote to "internal" track
```

No errors = you're ready for `--live`.

---

## Step 3 — Submit to App Store (iOS)

### 3a. Attach latest TestFlight build + submit for review

```powershell
cd C:\Users\jmacl\Projects\auction-platform
node scripts/submit-ios-app-store.mjs --app both --auto-submit --live
```

This:
1. Finds the latest TestFlight build for each app
2. Attaches it to the v1.0 PREPARE_FOR_SUBMISSION version
3. Submits both apps for review

**Next steps in ASC (manual):**
- Monitor [App Store Connect](https://appstoreconnect.apple.com/) for review status
- Apple review typically takes 24–48 hours
- You'll get email when status changes
- If rejected, fix issues and re-run the script with the same build (idempotent)

### 3b. If you want to attach a specific build number

```powershell
cd C:\Users\jmacl\Projects\auction-platform
node scripts/submit-ios-app-store.mjs --app bidder --build 42 --auto-submit --live
```

---

## Step 4 — Submit to Play Store (Android)

### 4a. Upload AAB to internal testing track (REQUIRED FIRST)

```powershell
cd C:\Users\jmacl\Projects\auction-platform
node scripts/submit-android-play-store.mjs --track internal --live
```

This:
1. Uploads the AAB to Play Console
2. Creates a release in the "internal" testing track with status `draft`
3. Your testers can opt-in to the internal testing track to install

**After this step:**
- Log into [Play Console](https://play.google.com/console/)
- Find **Release → Testing → Internal testing**
- Confirm the AAB is there with version code 1
- Testers opt-in via the invite link and can install

Wait ≥ 1 week with ≥ 12 active internal testers before promoting to production.

### 4b. Promote to closed (beta) testing after 1+ week

```powershell
cd C:\Users\jmacl\Projects\auction-platform
node scripts/submit-android-play-store.mjs --track beta --live
```

**Google's requirements:**
- ≥ 20 testers active in closed testing for 14 consecutive days

Once the gate is met, Play Console unlocks **Promote to production**.

### 4c. Promote to production (final)

```powershell
cd C:\Users\jmacl\Projects\auction-platform
node scripts/submit-android-play-store.mjs --track production --live
```

This:
1. Creates a draft production release with the AAB
2. Google review: typically 1–3 hours
3. Once approved, you'll see **Roll out to production** button in Play Console

---

## Step 5 — Monitor Review Status

### iOS — App Store Connect

After submitting:

```
https://appstoreconnect.apple.com/
  → Select app (ClovrBid or ClovrBid Staff)
  → Version
  → Check "Status" column (e.g., "In Review", "Approved", "Rejected")
```

**Common statuses:**
- `Ready for Sale` — Already live
- `In Review` — Apple is reviewing
- `Rejected` — Fix issues and resubmit with same build
- `Approved` — Ready to go live (manual action in ASC)

### Android — Play Console

After submitting:

```
https://play.google.com/console/
  → ClovrBid → Release → Production/Beta/Internal
  → View release details
  → Status: "Draft" → "Approved" → "Live"
```

---

## Flags Reference

### iOS Script

```
--app bidder|staff|both     Which app to submit (default: both)
--build NN                  Specific build number (default: latest)
--auto-submit               Actually submit for review (default: just attach)
--live                      Make API calls (default: dry-run)
--verbose                   Show full API responses
```

### Android Script

```
--bundle PATH               Path to .aab file (auto-resolved if not provided)
--track internal|alpha|beta|production   Which track (default: internal)
--release-notes PATH        Path to release notes file (default: docs/STORE_METADATA.md)
--live                      Make API calls (default: dry-run)
--verbose                   Show full API responses
```

---

## Troubleshooting

### iOS

**"No builds found for app 6767012532"**
- EAS build not done yet, or build hasn't been processed by Apple
- Wait 5–10 minutes after `eas build` finishes, then retry

**"No PREPARE_FOR_SUBMISSION version found"**
- Manually create v1.0 in ASC and save to PREPARE_FOR_SUBMISSION state
- Or ask Michael to set this up once per app

**"Build already attached (idempotent)"**
- Expected when resubmitting with the same build number
- Safe to ignore — this just means the build was already attached earlier

### Android

**"Service account JSON not found"**
- Complete Step 1 setup to create the service account and download the key
- File must be at `.secrets/google-play-service-account.json`

**"No AAB file found"**
- Run `eas build --platform android --profile production --non-interactive` in `apps/bidder-app/`
- Or manually provide `--bundle /path/to/app.aab`

**"Play API 400: Invalid version code"**
- Google already has this version code in the store
- Increment the version code in `eas.json` → `android.versionCode`
- Rebuild and retry

### Both

**API returns 401 Unauthorized**
- Service account key invalid or expired
- For iOS: check `.secrets/AuthKey_25M83P99J8.p8` exists and is readable
- For Android: regenerate the service account key in Google Cloud Console

**"This was a DRY-RUN" message**
- You forgot `--live`
- Add it to actually make changes: `... --live`

---

## Env Vars (Optional, rarely needed)

Both scripts auto-load environment if you have these set:

| Var | Used for | Where |
|-----|----------|-------|
| `EXPO_TOKEN` | EAS build lookup (iOS) | `.env` or shell |
| (none required) | Service account (Android) | loaded from JSON file |

---

## Files Referenced

| File | Purpose |
|------|---------|
| `.secrets/AuthKey_25M83P99J8.p8` | ASC API key (iOS) |
| `.secrets/google-play-service-account.json` | Play API service account (Android) |
| `docs/STORE_METADATA.md` | App description + release notes (both) |
| `docs/APP_REVIEWER_NOTES.md` | Reviewer credentials + test instructions |
| `apps/bidder-app/eas.json` | Build profiles + ASC config |
| `scripts/submit-ios-app-store.mjs` | iOS submission script |
| `scripts/submit-android-play-store.mjs` | Android submission script |

---

## Quick Reference

### Full submission flow (both stores, production)

```powershell
# Dry-run everything first
cd C:\Users\jmacl\Projects\auction-platform

# iOS
node scripts/submit-ios-app-store.mjs --app both
# Android
node scripts/submit-android-play-store.mjs --track internal

# If dry-runs look good, go live
node scripts/submit-ios-app-store.mjs --app both --auto-submit --live
node scripts/submit-android-play-store.mjs --track internal --live
```

---

**Questions?** Check the header comments in each script or review `docs/ANDROID_RELEASE.md` for platform-specific context.
