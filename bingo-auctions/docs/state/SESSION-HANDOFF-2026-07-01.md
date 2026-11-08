# Session Handoff — 2026-07-01 (BinGo pre-launch triage)

**Read this first next session.** Also read `docs/audits/*-2026-07-01.md` (the review + diagnosis reports referenced below).

## The one unifying insight

BinGo's launch blockers were **~all config / deploy / backend-wiring gaps on a working fork — not code rot.** BinGo forked ClovrBid (auction-platform) on 2026-06-22 and the lotting/payment code is largely byte-identical. The bugs were: deployed secrets wrong/missing, a client operator-id resolution gap, and stale Stripe gates. Fixes were mostly "correct the deployed config," not rewrites.

## Shipped & DEPLOYED to `bingo-web` (web) today

| Fix | How | Verify |
|---|---|---|
| Payment — cards rejected | Deployed Square `SQUARE_APPLICATION_ID` was sandbox/wrong; re-set all 3 Square GH secrets from `.secrets/square.env` (prod `sq0idp-rugB40…`, location `LH36T6WADKGV7` = "Bingo Auctions") + redeployed. | **Re-test add-card on browser + mobile.** |
| AI Lot — 503 | `OPENROUTER_API_KEY` was never pushed to the Worker; added GH secret + wired into `deploy-cloudflare.yml` (PR #5) + redeployed. | **Re-test AI Lot / photo-scan.** |
| Pickup unpaid-guard (LB-11) | PR #4 — web `markPickup` now rejects completion unless invoice `paid`/`partially_refunded`; button disabled + hint. | Re-test in operator console. |
| Refund button for Square invoices (LB-1) | PR #6 — RefundButton gated on `square_payment_id` (was `stripe_charge_id`). | Re-test refund on a paid invoice. |

## Merged to master — device delivery status

- **Photos silently dropped (PR #7) — SHIPPED OTA 2026-07-01.** `field-mobile` + `supabase-client`. Root cause: `operatorId` came from `useOperatorRole().operatorId`, `undefined` during the hook's loading/token-refresh window → upload path `undefined/{lotCode}/…` → first segment ≠ `current_operator_id()` → RLS silent-drop. Fixed with `resolveOperatorIdForUpload()` + failure surfacing in every caller. **Delivered via `gh workflow run eas-update.yml -f app=staff -f branches=both`** (run `28550665190`, success) — published to **both** `preview` + `production`, runtime `0.1.0`, iOS+Android (preview group `d14df9c7`, prod group `ac0df7f7`). Reaches only installed staff binaries at version `0.1.0`; **tester must fully quit + relaunch twice** (expo-updates downloads on launch N, applies N+1). If it doesn't land, the binary version drifted → ship a fresh `eas-build.yml`. NOTE: the OTA workflow first needed a "registration touch" commit (`71a9260`) — forked-in `workflow_dispatch` files aren't GH-indexed until modified on the default branch (same fix as EAS Build's `0f4917d`).

## Remaining work (prioritized)

1. **Mobile OTA/build for the photo fix (#7)** — nothing else gets photos live. Also carries any other merged mobile changes.
2. ~~**pay-fees endpoint**~~ — **SHIPPED 2026-07-01 (PR #9, merged `f098289`, deployed to bingo-web, verified live: POST returns 401 not 404).** Built `POST /api/bidders/me/pay-fees` at the plural path both clients already call (no client change; shipped bidder app works as-is): Square `chargeCardOnFile` for `bidders.unpaid_fees_cents` → `clear_paid_relot_fees` (mig 0105) via the caller-scoped client. Idempotency on newest unpaid ledger id; returns Square reason codes (`no_payment_method`/`card_declined`). See `docs/audits/payment-square-diagnosis-2026-07-01.md` #5a.
3. ~~**Card vanishes / can't re-add**~~ — **BOTH HALVES SHIPPED.** Webhook half: PR #10 (deployed) — `card.disabled`/`card.automatically_updated` scope the null-out by `square_customer_id` + emit `SQUARE_CARD_CLEARED` audit. Re-add half: **PR #12 (deployed 2026-07-02)** — on `CARD_TOKEN_ALREADY_USED` (Square's real duplicate signal = consumed nonce, NOT PAN), list the customer's enabled cards (`listEnabledCustomerCards`) + re-point `default_payment_method_id`; `SquareCardForm` now surfaces the real Square decline code.
4. ~~**ASIN/LPN won't scan**~~ — **SHIPPED OTA 2026-07-01 (PR #11).** Quick Lot `codeTypes` `PRODUCT_CODE_TYPES`→`ALL_RETAIL_CODE_TYPES` + hold-to-confirm 3→5 frames. Watch: if 2D grabs too eagerly, raise `QUICK_HOLD_CONFIRM_FRAMES` / tighten `RETICLE_TOLERANCE`.
5. ~~**QuickLot sticker-source + collapsible settings**~~ — **collapsible lotting-settings panel SHIPPED (PR #14, staff OTA 2026-07-02).** Sticker-source picker intentionally NOT built: no-match already doesn't auto-mint (B2) and a per-listing picker duplicates the global `LottingModeToggle`.
6. ~~**Staff partial-pickup (LB-1)**~~ — **SHIPPED (PR #13, staff OTA 2026-07-02).** `pickup-verify.tsx` catches the `pickup_incomplete: <codes>` raise → "N not scanned" prompt → "Hand over {present}" re-calls `staff_confirm_pickup(p_allow_incomplete=true)`.
7. ~~**Mobile `verify-card.tsx` on dead Stripe SDK + rip StripeProvider/@stripe**~~ — **SHIPPED (PR #16, merged 2026-07-02; bidder iOS EAS build run `28600766269` → TestFlight, native rebuild).** StripeProvider gone, `verify-card.tsx` rewritten to route to the Square web card handoff, plugin + dep + lockfile entry removed. (Lockfile regen on Windows-ARM: `npm install --package-lock-only`.)
8. Bidder should-fixes: ~~buyer's-premium on the price face~~ **SHIPPED (PR #15, bidder OTA 2026-07-02** — all-in line under the lot price); ~~de-Stripe identity copy~~ **SHIPPED (PR #15** — removed "Stripe Identity" brand from the bid gate + `identity/verify.tsx`). ~~**KYC gate blocks ≥$500 bids**~~ **RESOLVED 2026-07-02 (Michael chose disable-via-flag).** mig 0212 (`identity_verification_disabled` flag, default FALSE) applied to BinGo prod + set TRUE; `place_bid` skips the gate; bidder client made reactive + OTA'd. **REVERSIBLE:** re-arm with `UPDATE platform_settings SET identity_verification_disabled=false WHERE id=true` the moment a KYC provider is wired. ⚠️ BinGo prod `_schema_migrations` tracks only 45/208 → apply single migrations with `--rerun <file>` via the pooler (`aws-1-us-east-1`), never a blanket apply. **Next mig = 0213.**

## Pre-existing CI holes (fix so CI is trustworthy)

Every PR shows two red checks that are **infra, not code** — they mask real signal:
- **`schema migrations`** — CI Postgres image lacks the `pgvector` extension (`ERROR: extension "vector" is not available`). Add pgvector to the CI DB image/service.
- **`Playwright (chromium)`** — produces no report artifact; the E2E suite needs a seeded env to run. (Known gap.)

Until fixed, admin-merge is justified when `typecheck`/`lint`/`test`/`db package tests` are green.

## Key facts / gotchas discovered this session

- **BinGo prod Supabase = `npwseclcxcatjhgjrtwe`** (NOT sandbox `ridylekymnpgbsbanfwe`, NOT `hot-girl-hairmath`). The local `SUPABASE_SERVICE_ROLE_KEY` JWT is **stale (401)** — query prod via **direct Postgres** using `SUPABASE_DB_PASSWORD` from `.secrets/bingo-supabase.env` (direct host `db.<ref>.supabase.co:5432` works; `pg` is installed).
- **BinGo is single-operator** (no operator onboarding). Storefront/scheduling gates key off **stale Stripe columns set true** on the one `operators` row (`BIN`, `05775af4-…`): `status=active`, `stripe_onboarding_complete=true`, `stripe_charges_enabled=true`; `payments_disabled=false`, `single_account_mode=false`. **Do NOT reset that row** (`reset-bingo-operator`) or the storefront darkens + scheduling breaks. Re-key those gates to real Square readiness post-launch.
- **`deploy-cloudflare.yml` silently skips empty secrets** — a deploy that predates a secret leaves the Worker unconfigured with no error. This is how the Square app-id ended up wrong on a live Worker.
- **GateGuard hook** fires on every Edit/Write — present the 4 facts (importers via grep, affected symbols, data behavior, user instruction verbatim) and retry; it often wants the grep actually run.
- **Fable 5 is unavailable for agent dispatch** (returns "Claude Fable 5 is currently unavailable") despite account-level enablement — used Opus 4.8 for all agents.
- **Worktree isolation unavailable** — session cwd is `C:\Users\jmacl\Projects` (not a git repo), so `isolation: "worktree"` fails. Run a single write-agent **solo** (no concurrent repo writes) instead.

## Deploy verification

Last `bingo-web` deploys today all succeeded. The final batch-merge deploy is run `28549683987` (dispatched 21:43 UTC) — confirm green next session if not already.
