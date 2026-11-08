# Maestro E2E Flows

Maestro drives iOS Simulator and Android Emulator via accessibility APIs. No Appium. No WebDriver. Just YAML.

## Quick start

```bash
# Install Maestro (macOS / Linux)
curl -fsSL https://get.maestro.mobile.dev | bash

# Run the bidder-app smoke flow (from repo root)
maestro test e2e/maestro/bidder-app/00-smoke-launch.yaml

# Run the field-mobile smoke flow
maestro test e2e/maestro/field-mobile/00-smoke-launch.yaml

# Run the full bid flow (needs live Supabase + seeded test account)
BIDDER_EMAIL=bidder@test.local BIDDER_PASSWORD=TestPass1! \
  maestro test e2e/maestro/bidder-app/01-bid-flow.yaml
```

Or from inside an app directory:

```bash
cd apps/bidder-app && npm run maestro:smoke
cd apps/field-mobile && npm run maestro:smoke
```

## Flow inventory

| File | App | Scope | CI? |
|---|---|---|---|
| `bidder-app/00-smoke-launch.yaml` | bidder-app | Launch + assert login screen | Yes |
| `bidder-app/01-bid-flow.yaml` | bidder-app | Sign-in → browse → bid → high-bidder | Manual (Maestro Cloud when ready) |
| `field-mobile/00-smoke-launch.yaml` | field-mobile | Launch + assert staff login screen | Yes |
| `bidder-app/screenshots/01-home.yaml` | bidder-app | App Store screenshot — browse grid | `workflow_dispatch` only |
| `bidder-app/screenshots/02-lot-detail.yaml` | bidder-app | App Store screenshot — lot detail | `workflow_dispatch` only |
| `bidder-app/screenshots/03-bid-placed.yaml` | bidder-app | App Store screenshot — high-bidder banner | `workflow_dispatch` only |
| `bidder-app/screenshots/04-pickup.yaml` | bidder-app | App Store screenshot — pickup tab | `workflow_dispatch` only |
| `field-mobile/screenshots/01-lotting-hub.yaml` | field-mobile | App Store screenshot — lotting hub | `workflow_dispatch` only |
| `field-mobile/screenshots/02-checkout-verify.yaml` | field-mobile | App Store screenshot — checkout pickup-verify | `workflow_dispatch` only |

## testID naming convention

| Element | testID |
|---|---|
| Sign-in email input (bidder) | `signin-email-input` |
| Sign-in password input (bidder) | `signin-password-input` |
| Sign-in button (bidder) | `signin-submit` |
| Browse screen container | `browse-screen` |
| Lot card (per lot code) | `lot-card-{lotCode}` |
| Bid amount input | `bid-amount-input` |
| Place bid button | `place-bid-button` |
| High-bidder banner | `high-bidder-banner` |
| Staff login email input | `staff-signin-email-input` |
| Staff login password input | `staff-signin-password-input` |
| Staff login button | `staff-signin-submit` |
| Lot grid loaded sentinel | `lot-grid-loaded` |
| Savings callout | `savings-callout` |
| Pickup info card | `pickup-info-card` |
| Refund policy section (lot detail) | `refund-policy-section` |
| Pickup tab button | `tab-pickup` |
| Pickup screen root | `pickup-screen` |
| Invoice list loaded sentinel | `invoice-list-loaded` |
| Bin staging count badge | `bin-staging-count` |
| Staff home screen root | `staff-home-screen` |
| Lotting hub tab button | `tab-lotting-hub` |
| Checkout tab button | `tab-checkout` |
| First checkout session row | `checkout-session-row-first` |
| Pickup-verify screen root | `pickup-verify-screen` |
| Refund policy banner (field-mobile) | `refund-policy-banner` |

Prefer `testID` selectors for interactive elements and `assertVisible: text:` for headings and status copy. This keeps flows readable and decoupled from layout changes.

## App Store screenshot flows

Screenshot flows live in `bidder-app/screenshots/` and `field-mobile/screenshots/`. They require a live Supabase connection with seeded test data. See `e2e/maestro/screenshots/README.md` for:

- Required simulator sizes (Apple's three mandatory resolutions)
- How to seed test data before a screenshot run
- How to download CI artifacts after a `workflow_dispatch` run
- Post-capture framing and polish notes

## CI wiring

The smoke-launch flows run in `.github/workflows/maestro.yml` on every push to `main` that touches the mobile apps or their shared packages. The bid flow is wired to `workflow_dispatch` only — it requires a live Supabase environment and Maestro Cloud for reliable execution.

## Full setup docs

See `docs/qa/maestro-setup.md` for install instructions, Windows/WSL notes, credential management, and Maestro Cloud onboarding.
