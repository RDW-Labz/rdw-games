# Tester Feedback Triage — 2026-07-03 (round 6, launch-readiness)

Tester recap: (1) iPad Add Card STILL opens the in-app Square form with
camera-scan only, no keyboard — the promised "redirect to Safari" never
happens; (2) category tiles show photos in the browser but not in the mobile
app; (3) question — should the receipt's "Report a Problem" (post-pickup
dispute) entry be configurable per operator, since BinGo's store policy is
no refunds once the customer leaves the building?

## 1. iPad Add Card — root cause found, fix in this PR

**The 2026-07-02 fix (PR #24) could never fire.** It gated the
straight-to-Safari path on `Platform.isPad` — but `app.config.ts` sets
`ios.supportsTablet: false`, so iPads run the iPhone binary in
**compatibility mode**, where iOS reports the *phone* interface idiom and
`Platform.isPad` is `false` on every iPad. The redirect branch was dead code
on the exact device class it was written for. (This also explains why the
in-app SFSafariViewController shows the same scan-only behavior there — the
whole app is a scaled iPhone app on that iPad.)

**Fix (`apps/bidder-app/app/profile/payment-method.tsx`):** detect iPad
hardware via `expo-device` (`Device.modelId` / `modelName` come from
`utsname.machine` — returns "iPad13,x" regardless of idiom), falling back to
`Platform.isPad`. expo-device was already a dependency, so the change is
JS-only → **OTA-able, no native build**.

**Delivery:** merge → run `EAS Update (OTA)` for the bidder app → tester
force-quits and relaunches twice, then Add Card should bounce straight out
to real Safari (which they confirmed works). The manual
"Keyboard not working? Open in Safari instead" link remains as belt and
suspenders.

## 2. Mobile category tiles — already fixed, OTA'd today; needs relaunch ×2

PR #32 (`b589cb2`, merged today 18:20 UTC) pointed the app's CategoryGrid at
the same self-hosted `/art/photo/categories/{slug}.webp` tiles the web
homepage uses (identical slug convention — web working confirms the
slug↔file mapping). The OTA carrying it went out **after** the tester's
round: run `28677655853` at 18:31–18:35 UTC, bidder app, preview +
production channels, success.

**No further code change needed.** Tester: force-quit and relaunch the app
twice (expo-updates downloads on launch N, applies on N+1). If tiles are
still navy after that, suspect binary runtime-version drift → ship a fresh
EAS build.

## 3. "Report a Problem" — already operator-configurable; set the policy to 0

The entry is not hardwired. It is gated end-to-end by
`operator_policies.refund_window_post_pickup_hours` (mig 0088; `0` = all
sales final):

| Surface | Behavior at window = 0 |
|---|---|
| Receipt (`app/invoice/[id].tsx`) | "Report a problem" block hidden entirely |
| Pickup screen (`app/pickup/[id].tsx`) | dispute entry hidden; policy banner says all sales final |
| Lot detail (`app/lot/[id].tsx`) | shows "All sales final" instead of "N-hour return window" |

**Action for BinGo (no deploy):** operator console → **Settings →
Policies → "Dispute window (days)" → set 0** → save/publish. The hint on
that field already documents this ("Set 0 to make all sales final
immediately after pickup"). BinGo prod is presumably on the 48 h default —
not verifiable from this session (no prod DB creds in this environment).

Note: publishing the policy takes effect immediately for bidder-facing
gating; the app reads the latest published `operator_policies` version at
screen load.

## Reply for the tester

1. **iPad Add Card**: real bug, found and fixed — the previous fix checked a
   flag iOS never sets for this app on iPads. After the next update notice,
   force-quit + relaunch twice; Add Card will open in real Safari.
2. **Category tiles**: the fix shipped over-the-air this afternoon, likely
   after your test. Force-quit + relaunch the app twice and the photo tiles
   should appear.
3. **Report a Problem**: great catch — it's already a per-operator setting.
   We'll set BinGo's dispute window to 0 ("all sales final"), which removes
   the Report a Problem option from receipts entirely and shows "All sales
   final" on lot pages instead.
