# App Store Screenshot Flows

Maestro YAML flows that capture iOS screenshots at Apple-required resolutions
for App Store submission. The flows live in the app-specific subdirectories:

| Flow | App | Screen |
|---|---|---|
| `bidder-app/screenshots/01-home.yaml` | bidder-app | Browse / home grid |
| `bidder-app/screenshots/02-lot-detail.yaml` | bidder-app | Lot detail (SavingsCallout + PickupInfoCard + refund policy) |
| `bidder-app/screenshots/03-bid-placed.yaml` | bidder-app | High-bidder banner after placing a bid |
| `bidder-app/screenshots/04-pickup.yaml` | bidder-app | Pickup tab with invoice + bin-staging counts |
| `field-mobile/screenshots/01-lotting-hub.yaml` | field-mobile | Lotting hub with LottingModeToggle |
| `field-mobile/screenshots/02-checkout-verify.yaml` | field-mobile | Checkout pickup-verify + refund policy banner |

---

## Apple required resolutions

| Device | Resolution | Required? |
|---|---|---|
| iPhone 6.7" (14 Pro Max / 15 Pro Max) | 1290 x 2796 | Yes |
| iPhone 6.5" (11 Pro Max) | 1242 x 2688 | Yes |
| iPhone 5.5" (8 Plus) | 1242 x 2208 | Yes |
| iPad 12.9" | 2048 x 2732 | Optional |

You must run the full set of flows once per simulator size. Each run
produces a `screenshots/` directory of PNGs named after the flow's
`takeScreenshot` value.

---

## Running locally

### 1. Install Maestro

```bash
# macOS / Linux
curl -fsSL https://get.maestro.mobile.dev | bash
```

Minimum version: **1.39.0** (matches the CI pin).

### 2. Boot a simulator at the correct resolution

Open Xcode > Devices and Simulators (or use `xcrun simctl`) and boot a
simulator whose resolution matches one of the Apple required sizes above.

```bash
# List available simulators
xcrun simctl list devices available

# Boot a specific UDID
xcrun simctl boot <UDID>

# Open Simulator.app so the window renders at native scale
open -a Simulator
```

For consistent screenshots, set the simulator window to **100% scale**
(Window > Physical Size in Simulator.app) and disable the on-screen
keyboard if it would obscure UI.

Recommended simulator name mapping:

| Apple slot | Simulator to create in Xcode |
|---|---|
| 6.7" (1290 x 2796) | iPhone 16 Pro Max (or 15 Pro Max) |
| 6.5" (1242 x 2688) | iPhone 11 Pro Max |
| 5.5" (1242 x 2208) | iPhone 8 Plus |
| iPad 12.9" | iPad Pro (12.9-inch, 6th generation) |

### 3. Install the app on the simulator

Either install a Release .app built locally or via EAS:

```bash
# Local build (from repo root)
cd apps/bidder-app
npx expo run:ios --configuration Release --simulator "iPhone 16 Pro Max"
```

### 4. Seed test data

The screenshot flows require seeded Supabase data. Run the seed scripts
before each screenshot session:

```bash
node scripts/demo-tools/seed-smoke-lots.mjs        # lots for home + bid flows
node scripts/demo-tools/seed-pickup-invoice.mjs    # paid invoice for pickup tab
node scripts/demo-tools/seed-staff-account.mjs     # staff account for field-mobile
node scripts/demo-tools/seed-checkout-session.mjs  # active checkout for pickup-verify
```

### 5. Run all bidder-app screenshot flows

```bash
BIDDER_EMAIL=bidder@test.local \
BIDDER_PASSWORD=TestPass1! \
BIDDER_PICKUP_EMAIL=pickup@test.local \
BIDDER_PICKUP_PASSWORD=TestPass1! \
  maestro test e2e/maestro/bidder-app/screenshots/
```

Maestro runs flows in directory order (01, 02, 03, 04). Screenshots land in
`./screenshots/` relative to where you invoke the command unless you override
`--output-dir`.

### 6. Run all field-mobile screenshot flows

```bash
STAFF_EMAIL=staff@test.local \
STAFF_PASSWORD=TestPass1! \
  maestro test e2e/maestro/field-mobile/screenshots/
```

### 7. Repeat for each simulator size

Boot each target simulator, re-install the app at native scale, and re-run
the flows. Rename the output directory after each run to avoid overwriting:

```bash
mv screenshots screenshots-6.7in
# boot 6.5" simulator, re-run…
mv screenshots screenshots-6.5in
# etc.
```

---

## CI artifacts

The `Maestro Screenshots` job in `.github/workflows/maestro.yml` runs the
screenshot flows after the smoke and bid-flow validators pass on `workflow_dispatch`.

Screenshots are uploaded as GHA artifacts named:

```
ios-app-store-screenshots-iphone-16-pro-max
ios-app-store-screenshots-iphone-11-pro-max
ios-app-store-screenshots-iphone-8-plus
```

To download after a CI run:

1. Go to **Actions** in the GitHub repo.
2. Click the relevant `Maestro Screenshots` workflow run.
3. Scroll to **Artifacts** at the bottom.
4. Download the ZIP for each device size.

The job does **not** fail CI if screenshots are imperfect — it always uploads
whatever was captured. This allows iterating on visual polish without blocking
the build.

---

## Post-capture polish

Raw simulator screenshots are pixel-perfect but typically need:

- **Device frame** — wrap in a device mockup (Figma, Apple Frames app, or
  fastlane `frameit`).
- **Background / copy overlay** — add a background color and short marketing
  copy above the device frame in Figma or Photoshop.
- **Localization** — if submitting multiple locales, run flows with locale-
  appropriate seed data and capture separately.

Apple accepts raw simulator screenshots without frames, but framed screenshots
typically convert better on the listing page.

---

## New testIDs needed

Several flows reference testIDs that do not yet exist in the app code. Before
running the screenshot flows end-to-end, add these testIDs:

| testID | Component / file |
|---|---|
| `lot-grid-loaded` | LotGrid — set after first page of lots renders |
| `savings-callout` | `SavingsCallout` component |
| `pickup-info-card` | `PickupInfoCard` component |
| `refund-policy-section` | Lot detail refund policy block |
| `tab-pickup` | Pickup tab button in bidder-app tab bar |
| `pickup-screen` | Root view of `(tabs)/pickup.tsx` |
| `invoice-list-loaded` | InvoiceList — set after first page resolves |
| `bin-staging-count` | `BinStagingBadge` component |
| `staff-home-screen` | Post-auth landing screen in field-mobile |
| `tab-lotting-hub` | Lotting Hub tab button in field-mobile tab bar |
| `tab-checkout` | Checkout tab button in field-mobile tab bar |
| `checkout-session-row-first` | First `CheckoutSessionRow` in checkout list |
| `pickup-verify-screen` | Root view of `checkout/pickup-verify.tsx` |
| `refund-policy-banner` | `RefundPolicyBanner` component in field-mobile |

See also the master testID table in `e2e/maestro/README.md`.
