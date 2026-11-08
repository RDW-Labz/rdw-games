# ASC App Privacy Runbook (Headless via fastlane spaceauth)

> **Why this exists:** Apple's App Store Connect JWT API does NOT expose the
> `/v1/appDataUsages` endpoints. The endpoints DO exist but are only reachable
> via session-cookie auth (Apple ID + 2FA). This runbook documents the
> minimum-friction headless path: one interactive `spaceauth` per ~30 days,
> then fully automated CI uploads of the privacy manifest.

## Status (2026-05-24)

| App | App ID | Privacy state |
|-----|--------|---------------|
| ClovrBid Bidder | 6767012532 | not published |
| ClovrBid Staff  | 6767026881 | not published |

## The privacy manifest we want to publish

Both apps collect the same data, but linked-to-user is different per surface.
This is the source of truth; `scripts/upload-privacy-fastlane.sh` reads it.

```json
{
  "data_collected": [
    {
      "category": "Contact Info",
      "fields": ["Email Address", "Name"],
      "linked_to_user": true,
      "used_for_tracking": false,
      "purposes": ["App Functionality"]
    },
    {
      "category": "Identifiers",
      "fields": ["User ID"],
      "linked_to_user": true,
      "used_for_tracking": false,
      "purposes": ["App Functionality"]
    },
    {
      "category": "Financial Info",
      "fields": ["Payment Info"],
      "linked_to_user": true,
      "used_for_tracking": false,
      "purposes": ["App Functionality"],
      "notes": "Stripe stores card; ClovrBid never sees raw PAN. Declared per Apple guidance."
    },
    {
      "category": "Usage Data",
      "fields": ["Product Interaction"],
      "linked_to_user": false,
      "used_for_tracking": false,
      "purposes": ["Analytics"],
      "notes": "PostHog events captured without identifiable PII once analytics_anonymize feature flag is wired."
    }
  ],
  "data_not_collected": [
    "Crash Data — @sentry/react-native fully removed 2026-05-19 from both apps; verify by greping 'Sentry' in apps/bidder-app and apps/field-mobile.",
    "Location, Health, Browsing History, Search History, Photos/Videos, Audio, Files, Diagnostics, Sensitive Info, Contacts, Other."
  ]
}
```

## One-time bootstrap (do this ONCE on the Mac mini or any non-CI machine)

```bash
# 1. Install fastlane (one-time)
gem install fastlane

# 2. Generate session cookie — opens browser, prompts 2FA, outputs FASTLANE_SESSION env value
fastlane spaceauth -u jmacluer@gmail.com

# 3. Generate an app-specific password at https://account.apple.com (Security → App-Specific Passwords)
#    Name it 'fastlane-ASC-headless'. Save the 16-char output.

# 4. Push both to GitHub repo secrets (1 ASC + 1 cookie + 1 app-specific pw):
gh secret set FASTLANE_SESSION --body "<session-from-step-2>"
gh secret set FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD --body "<password-from-step-3>"

# Done. Cookie persists for ~24 months. Re-run step 2 when fastlane errors mention "session expired".
```

## CI invocation (every privacy change)

The script `scripts/upload-privacy-fastlane.sh` does the actual upload:

```bash
# In .github/workflows/asc-publish-privacy.yml
- env:
    FASTLANE_SESSION: ${{ secrets.FASTLANE_SESSION }}
    FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD: ${{ secrets.FASTLANE_APPLE_APPLICATION_SPECIFIC_PASSWORD }}
    ASC_APP_ID: 6767026881
  run: bash scripts/upload-privacy-fastlane.sh
```

## Last-resort: ASC web dashboard

If `spaceauth` keeps failing (account recovery, 2FA reset etc.), you can publish
once via https://appstoreconnect.apple.com/apps/6767026881/distribution/privacy.
Per memory `feedback_headless_always.md` this is the LAST resort, not the first.

## Why this isn't worse than it sounds

- Cookie lasts ~24 months
- Once published, the privacy declarations persist across versions
- Only changes require re-publish — so for v1.0 launch this is a single one-shot setup

