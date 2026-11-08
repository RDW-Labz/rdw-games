# iOS app — TestFlight build

The app is one `WKWebView` around the same 401-file collection the browser tests
play. Nothing is downloaded at runtime, there is no analytics, no account and no
network code: once installed it plays with the radio off.

```
ios/
  project.yml                 XcodeGen spec (the .xcodeproj is generated, never committed)
  Info.plist                  offline app, dark launch screen, no ATS exceptions
  ExportOptions.plist         app-store-connect export; teamID rewritten by CI
  Sources/AOMGApp.swift       SwiftUI @main
  Sources/GameShellView.swift WKWebView host + outbound-link handling
  Sources/BundleSchemeHandler.swift  serves the bundle over a private aomg:// origin
  web/                        GENERATED — the collection, copied from dist/
  Resources/Assets.xcassets/  GENERATED — 1024 icon, launch colour, accent
```

`web/` and the asset catalogue are gitignored on purpose: they are derived. Stage
them from the tested build before generating the project.

## Why a custom `aomg://` scheme instead of `file://`

`WKWebView` treats every `file://` document as its own opaque origin. That splits
`localStorage` per game (saves would silently vanish when you switch titles) and
makes media playback from file URLs unreliable. Serving the bundle through a
`WKURLSchemeHandler` gives the app one ordinary origin — the same behaviour the
web build has — while still reading only from the app bundle. The handler also
answers `Range` requests so `<audio>` seeking works.

## Build it locally (Linux, no Xcode)

```sh
npm run build          # catalog check + invariants + vendor re-hash + stage dist/
npm run ios:stage      # copy dist/ → ios/web, render the 1024 icon
npm run ios:check      # payload is byte-identical to dist/, plist is offline-clean
```

`ios:check` verifies everything that can be verified without Apple tooling. It
cannot compile Swift — that happens on the macOS runner (or a Mac).

## Build it on a Mac (what Braden runs)

```sh
cd ios
export APPLE_TEAM_ID=<10-character team id>
brew install xcodegen
xcodegen generate
xcodebuild archive -project AwesomeOfflineGames.xcodeproj -scheme AwesomeOfflineGames \
  -configuration Release -destination 'generic/platform=iOS' \
  -archivePath build/AOMG.xcarchive -allowProvisioningUpdates
open build/AOMG.xcarchive      # Organizer → Distribute App → App Store Connect → Upload
```

Automatic signing with `APPLE_TEAM_ID` in the environment is enough: Xcode picks
the App Store distribution profile and creates the certificate if the account has
one available. Then in App Store Connect → TestFlight, add Michael's Apple ID to
**Internal Testing** — internal builds need no Beta App Review, they just take a
few minutes to finish processing.

## Build it from CI (no Mac in the room)

`.github/workflows/ios.yml` has two jobs:

- **payload** — runs on every push, no Apple account needed: builds, stages,
  verifies the payload is the tested collection, uploads it as an artifact.
- **testflight** — runs only when the App Store Connect secrets exist: generates
  the project with XcodeGen, archives, exports the IPA, uploads with `altool`.

Secrets to add (Settings → Secrets and variables → Actions). Generate the API key
in App Store Connect → Users and Access → Integrations → App Store Connect API,
role **App Manager**:

| Secret | What it is |
|---|---|
| `APPLE_TEAM_ID` | 10-character team id from developer.apple.com → Membership |
| `APPLE_API_KEY_ID` | the key's ID, e.g. `2X9ABCD3EF` |
| `APPLE_API_ISSUER` | the issuer UUID shown above the key list |
| `APPLE_API_KEY` | the `.p8` file contents, base64 (`base64 -i AuthKey_XXX.p8 \| pbcopy`) |
| `IOS_DIST_CERT_P12` | *optional* — base64 `.p12` if you want a fixed distribution cert instead of Xcode creating one |
| `IOS_DIST_CERT_PASSWORD` | *optional* — password for that `.p12` |

Without the four required secrets the workflow stays green and prints
`TestFlight upload skipped`, so nothing breaks while the account is being set up.

Set them from a machine that is logged in to `gh` (values come from the portal, never
from chat):

```sh
gh secret set APPLE_TEAM_ID   -R RDW-Labz/awesome-offline-mobile-games
gh secret set APPLE_API_KEY_ID -R RDW-Labz/awesome-offline-mobile-games
gh secret set APPLE_API_ISSUER -R RDW-Labz/awesome-offline-mobile-games
base64 -i AuthKey_XXXXXXXXXX.p8 | gh secret set APPLE_API_KEY -R RDW-Labz/awesome-offline-mobile-games
gh workflow run ios.yml -R RDW-Labz/awesome-offline-mobile-games    # now uploads
```

The bundle id is `com.rdwlabz.awesomeofflinegames` — it has to exist as an App ID
in the developer portal (automatic signing creates it on first archive), and the
app record has to be created once in App Store Connect before the first upload is
accepted.

## Testing it on a plane

1. Install the TestFlight build on the phone while on wifi; launch it once so the
   shell and games are unpacked into the app container.
2. Turn on airplane mode and play. The app makes no network requests at all — the
   `net` chip in the shell header is the offline indicator, and
   `tests/offline.mjs` proves the same in a browser with the network cut.

Saves live in `localStorage` on the app's origin and survive relaunches; the
shell's SAVES panel still exports them as JSON.

## Without an Apple account

The web build installs as a PWA: open the site in Safari on the phone, Share →
Add to Home Screen, launch it once (the service worker pre-caches all 401 files),
then airplane mode. Same offline behaviour without TestFlight — the only thing you
lose is having it in the App Store listing.
