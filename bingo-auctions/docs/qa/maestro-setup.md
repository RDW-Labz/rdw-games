# Maestro E2E Setup

Maestro is a mobile UI testing framework that drives iOS Simulator and Android Emulator via accessibility APIs (no Appium, no WebDriver). It reads YAML flow files and matches views by `testID`, visible text, or accessibility label.

## Install Maestro CLI

**macOS / Linux**

```bash
curl -fsSL https://get.maestro.mobile.dev | bash
```

Restart your shell (or `source ~/.zshrc`) after install so `maestro` is on your `$PATH`.

**Windows (WSL only)**

Maestro's CLI is a JVM tool but its iOS driver requires macOS and its Android driver requires ADB. On Windows you must run Maestro inside WSL:

```powershell
# Open a WSL terminal (Ubuntu recommended), then:
curl -fsSL https://get.maestro.mobile.dev | bash
```

Do NOT install Maestro in PowerShell or Git Bash — the iOS driver will never work there. Android flows work from WSL if ADB is forwarded to WSL via `adb -a nodaemon server` from Windows.

**Verify install**

```bash
maestro --version
# Expected: Maestro v1.x.x
```

Maestro requires Java 11+. On macOS it uses whatever `java` is on your `$PATH` (Homebrew OpenJDK or Xcode-bundled JDK both work).

## Prerequisites per platform

### iOS

- macOS only (Maestro's iOS driver uses XCTest under the hood via idb).
- Xcode installed and `xcode-select` pointing to it.
- An iOS Simulator already booted OR Maestro will boot the default one.
- The app must be installed on the simulator (use `xcrun simctl install` or an EAS local build).

### Android

- ADB connected to a running emulator or physical device.
- `ANDROID_HOME` set to your Android SDK root.
- The APK must be installed on the emulator (`adb install`).

## Project flow structure

```
e2e/maestro/
  bidder-app/
    00-smoke-launch.yaml   # Launch + assert home tab renders (CI gate)
    01-bid-flow.yaml       # Full sign-in → browse → bid happy path (manual / Maestro Cloud)
  field-mobile/
    00-smoke-launch.yaml   # Launch + assert login screen renders (CI gate)
README.md                  # Quick-start for this directory
```

## Running flows locally

From the repo root on **macOS**:

```bash
# Bidder-app smoke (just launches and checks the browse tab)
maestro test e2e/maestro/bidder-app/00-smoke-launch.yaml

# Full bid flow (requires a booted sim with the app AND real/seeded Supabase creds)
BIDDER_EMAIL=bidder@test.local BIDDER_PASSWORD=TestPass1! \
  maestro test e2e/maestro/bidder-app/01-bid-flow.yaml

# Field-mobile smoke
maestro test e2e/maestro/field-mobile/00-smoke-launch.yaml
```

Or use the package.json shortcuts from each app directory:

```bash
cd apps/bidder-app && npm run maestro:smoke
cd apps/field-mobile && npm run maestro:smoke
```

## Credentials for the bid flow

The bid flow reads credentials from environment variables so secrets are never committed:

| Variable | Purpose |
|---|---|
| `BIDDER_EMAIL` | Seeded test bidder email (e.g. `bidder@test.local`) |
| `BIDDER_PASSWORD` | Seeded test bidder password |

Create a local override file that is gitignored:

```bash
# .env.maestro.local  (already in .gitignore — never commit)
BIDDER_EMAIL=bidder@test.local
BIDDER_PASSWORD=TestPass1!
```

Pass them on the CLI or export before running:

```bash
export $(cat .env.maestro.local | xargs)
maestro test e2e/maestro/bidder-app/01-bid-flow.yaml
```

## testID naming convention

All Maestro testIDs in this repo follow a kebab-case scheme:

| Component | testID |
|---|---|
| Sign-in email field | `signin-email-input` |
| Sign-in password field | `signin-password-input` |
| Sign-in submit button | `signin-submit` |
| Browse tab container | `browse-screen` |
| Lot card (per lot code) | `lot-card-{lotCode}` e.g. `lot-card-BIN-000035` |
| Bid amount input | `bid-amount-input` |
| Place bid button | `place-bid-button` |
| High-bidder banner | `high-bidder-banner` |
| Staff login email field | `staff-signin-email-input` |
| Staff login password field | `staff-signin-password-input` |
| Staff login submit button | `staff-signin-submit` |
| Staff login screen title | `staff-login-title` |

Maestro can also match visible text (`assertVisible: "Sign in"`) which is used for assertions that don't need a brittle selector. Prefer `testID` for interactive elements (inputs, buttons) and visible text for page-level assertions.

## Adding new flows

1. Create a YAML file under `e2e/maestro/<app-name>/`.
2. Number flows sequentially: `02-watchlist-flow.yaml`, `03-payment-flow.yaml`, etc.
3. Use `testID` selectors for inputs and buttons; use `assertVisible` for text headings.
4. If the flow needs credentials, gate them behind `${ENV_VAR}` interpolation.
5. Update `e2e/maestro/README.md` with a one-line description of the new flow.

## Maestro Cloud (paid — for the full bid flow in CI)

The bid flow (`01-bid-flow.yaml`) requires a live Supabase connection and a seeded test account. Running this in CI reliably requires Maestro Cloud, which:

- Manages simulators/emulators as ephemeral build artifacts.
- Handles video recording, screenshots, and test reports.
- Integrates with GitHub Actions via the `mobile-dev-inc/action-maestro-cloud` action.

Until Maestro Cloud is provisioned, run `01-bid-flow.yaml` **manually** from your Mac before every release:

```bash
export BIDDER_EMAIL=bidder@test.local
export BIDDER_PASSWORD=TestPass1!
maestro test e2e/maestro/bidder-app/01-bid-flow.yaml
```

The smoke-launch flows (`00-smoke-launch.yaml`) run in CI without Maestro Cloud because they only assert the app boots and shows a specific screen — no live network needed.

## Troubleshooting

**`maestro test` hangs at "Waiting for the app to launch"**
- The app is not installed on the simulator. Run `expo run:ios` or install from an EAS local build first.
- The simulator is not booted. Open Simulator.app manually or `xcrun simctl boot <udid>`.

**`Element not found: testID=signin-email-input`**
- Make sure you ran `npm run build` or the Metro bundler is serving the latest JS bundle.
- The screen may not have rendered yet — increase the `timeout` on the `tapOn` step.

**Android: `Unable to find ADB`**
- Set `ANDROID_HOME` and ensure `$ANDROID_HOME/platform-tools` is on `$PATH`.
- On WSL: run `adb devices` from Windows first to start the server, then bridge into WSL.
