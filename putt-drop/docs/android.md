# Android (Capacitor)

Putt Drop ships as a signed Android App Bundle (`com.rdwlabz.puttdrop`) built from the Capacitor `android/` project and the production web bundle in `build/web`.

## CI build (recommended)

The workflow [`.github/workflows/build-android.yml`](../.github/workflows/build-android.yml) runs on `workflow_dispatch` and on pull requests that touch Android-related paths.

1. `npm ci`, `npm run build` (TypeScript, Vite production build, `check-bundle`)
2. `npx cap sync android`
3. `./gradlew :app:bundleRelease` with `-PversionCode` / `-PversionName`
4. Signature verification, then artifact `putt-drop-aab` (7-day retention)

**Signing credentials (names only):**

| Kind | Name |
|------|------|
| Secret | `ANDROID_KEYSTORE_B64` (PKCS#12 upload key, base64) |
| Secret | `ANDROID_KEYSTORE_PASSWORD` |
| Secret | `ANDROID_KEY_PASSWORD` |
| Variable | `ANDROID_KEY_ALIAS` |

The workflow decodes the keystore into `$RUNNER_TEMP`, sets `SHIP_KEYSTORE_PATH` / `SHIP_KEYSTORE_PASSWORD` / `SHIP_KEY_ALIAS` / `SHIP_KEY_PASSWORD` for Gradle (see `android/app/build.gradle`), and deletes the key file in an `always()` step.

If any of these are missing (e.g. a fork), the job **fails** with a clear message instead of emitting an unsigned release bundle.

### Version code rules

- `versionCode` is an integer that **must increase for every upload** to Google Play (same bundle id). Play rejects equal or lower codes.
- `versionName` is the user-visible string (CI defaults to `package.json` `version` on pull requests).
- Pass both to Gradle: `-PversionCode=N -PversionName=x.y.z`.

## Local build (Java + Android SDK required)

This worktree is often used on machines without the Android SDK. When you have **JDK 21** and the **Android SDK** (API 36):

```bash
nvm use    # Node 22 per .nvmrc
npm ci
npm run build
npx cap sync android
cd android
export SHIP_KEYSTORE_PATH=/path/to/upload.p12
export SHIP_KEYSTORE_PASSWORD=...
export SHIP_KEY_ALIAS=...
export SHIP_KEY_PASSWORD=...
./gradlew :app:bundleRelease -PversionCode=1 -PversionName=0.0.1
```

Output: `android/app/build/outputs/bundle/release/app-release.aab`.

Regenerate launcher icons after art changes: `node scripts/make-icons.mjs`.

## ship-pipeline

[`ship.config.yml`](../ship.config.yml) points the pipeline at `dist/android/putt-drop.aab` with `publish: false` until release is intentional. The orchestrator repo wires `ship.yml`; this game repo only declares config.

## Permissions

The game is offline; the committed app manifest declares **no** `uses-permission` entries (including no `INTERNET`). Google Play Billing uses the Play Store app over IPC.

The merged release manifest gains permissions from libraries: `com.android.vending.BILLING`, plus `INTERNET` and `ACCESS_NETWORK_STATE` from the Play Billing Library's datatransport logging dependency (the game code makes no network requests), alongside `VIBRATE` (haptics) and androidx.core's app-private `DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION`. The exact list is `android/merged-permissions.expected.txt`; CI dumps the signed AAB with bundletool and fails on any difference. Reasons: [billing.md](billing.md).
