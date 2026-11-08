# Google Play billing (full-game unlock)

Putt Drop sells a single non-consumable in-app product, **`unlock_full`** (“Unlock full game”), through Google Play on Android. The web build and non-Android platforms never enable billing; they keep the honest unavailable offer (Restore purchases still present, explaining it works in the Android app).

## Stack

- **Plugin:** [cordova-plugin-purchase](https://github.com/j3k0/cordova-plugin-purchase) **13.18.0** (MIT), wired by `npx cap sync android`.
- **Play Billing Library:** **9.0.0** (declared by the plugin’s `plugin.xml`).
- **App code:** `src/platform/billing.ts` (store integration), `src/platform/save.ts` (cached `unlocked` flag), `src/game/UnlockScene.ts` (offer UI).

There is **no receipt validator** and **no server**: the app never sets `store.validator` and does not use Iaptic. Entitlement is `store.owned('unlock_full')` from the Play Billing client.

## When the offer appears (paid-catalog gate)

The game ships **holes 1-12 only, all free**, so today there is nothing to sell. The single gate is
`fullGameOnSale(totalHoles)` in `src/progress.ts` (`paidHoleCount(total) > 0`, i.e. the level list
has holes 13+). While it is false, Unlock shows "Not on sale yet" with Keep playing free holes as
the primary action, and Hole select shows no Full game button. **The real store offer appears
automatically once holes 13+ are added to the level list** (and Google Play billing is connected
with a price for `unlock_full`). No code change is needed to turn it on.

## Purchase flow

1. **Boot** seeds entitlement from the cached save flag, then calls `initBilling()`. Billing
   initializes only when `Capacitor.getPlatform() === "android"` and `window.CdvPurchase` exists
   (after `deviceready`, waited up to 12 s). Boot waits at most 4 s for Play, then continues with
   the cache; a later answer from Play still updates and persists the flag.
2. `unlock_full` is registered as `NON_CONSUMABLE` on `Platform.GOOGLE_PLAY`.
3. If `store.initialize()` returns any error (offline, Play missing, product not set up), billing
   counts as **unavailable**: no price, no buy button, and the cached flag is **not** changed.
4. **Unlock** shows the store-formatted price (`product.pricing.price`), e.g. "Unlock full game ·
   $2.99". The price is never hardcoded.
5. Tapping it runs `product.getOffer().order()`. Cancel shows "Purchase cancelled."; an error shows
   "Purchase didn't complete. Try again." (if Play says the item is already owned, it unlocks
   instead of selling twice).
6. On **`approved`** the app calls **`transaction.finish()`**, which **acknowledges** the purchase.
   Google Play refunds purchases that are not acknowledged within three days:
   <https://developer.android.com/google/play/billing/integrate#process> (Play docs: acknowledge
   "within three days so that the purchase isn't automatically refunded").
7. **Pending** purchases (e.g. cash payment): Google Play reports them as `initiated` with
   `isPending`. The app shows "Purchase pending" and does **not** unlock; `store.owned()` is false
   for pending transactions. When payment completes Play sends `approved`, the app calls
   `finish()` and unlocks, even if that happens on a later launch.
8. **Restore purchases** is always on the Unlock screen. On Android with Play connected it calls
   `store.restorePurchases()` and shows "Full game restored" / "No purchase found on this Google
   account" / "Couldn't reach Google Play...". Where Play billing can't exist (web, iPhone browser)
   it says "Restore works in the Android app from Google Play."; on Android with Play unreachable
   it says "Couldn't reach Google Play. Try again when it's available."

## Entitlement and refunds

- Entitlement = `store.owned("unlock_full")` as reported by the Play Billing client. The cached
  `unlocked` flag in `src/platform/save.ts` mirrors it.
- On every launch (once Play connected without errors) the app refreshes from Play. If Play no
  longer reports the purchase (refund, void, chargeback, different account), the flag is set to
  false and holes 13+ **re-lock**. Holes 1-12 always stay playable.
- **Offline launch** (or any Play connection error) uses the last cached flag.

## No validator, no server

The app never sets `store.validator` and never uses the Iaptic class or iaptic.com.
`tests/no-validator.test.ts` fails if anything under `src/` does. Trade-off: purchase receipts are
not verified server-side; this keeps "no data collected by the developer" true.

## Play Console prerequisites

Before a purchase can work (none of these can be done or verified from this repo):

1. App created with package **`com.rdwlabz.puttdrop`**.
2. A build that contains billing (this plugin) uploaded to the **internal** track (or higher).
   Play only lets you create in-app products after such an upload.
3. In-app product **`unlock_full`** ("Unlock full game") created, **active**, one-time,
   with a price (owner decision: $2.99 USD; the app only ever displays Play's localized price).
4. **License testers** added (Play Console -> Settings -> License testing) and opted in to the
   internal track, so test purchases are not charged. Test both "Test card, always approves" and
   "Slow test card" (pending -> approved) and a refund from Order management (re-lock on next
   launch).

## Android permissions (merged AAB)

The committed app manifest declares **no** `uses-permission`. The merged release manifest is
expected to contain exactly the list in `android/merged-permissions.expected.txt`; CI dumps the
signed AAB with a sha256-pinned bundletool 1.17.2 (`dump manifest`) and fails on any difference.

| Permission | From | Reason |
|------------|------|--------|
| `com.android.vending.BILLING` | Play Billing Library 9.0.0 (and the plugin's `plugin.xml`) | Google Play Billing |
| `android.permission.INTERNET` | Play Billing Library 9.0.0 -> `com.google.android.datatransport:transport-backend-cct:3.1.8` | Billing Library's own diagnostic logging transport to Google |
| `android.permission.ACCESS_NETWORK_STATE` | same datatransport dependency (`transport-runtime`, `transport-backend-cct`) | schedules that logging upload |
| `android.permission.VIBRATE` | `@capacitor/haptics` | haptics (already merged before billing) |
| `com.rdwlabz.puttdrop.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` | `androidx.core` >= 1.9 | app-private signature permission for non-exported receivers |

**INTERNET is new with billing.** It was verified, not guessed: the
`billing-9.0.0.pom` declares compile dependencies on `transport-backend-cct:3.1.8` and
`transport-runtime:3.1.8`, whose AAR manifests declare INTERNET / ACCESS_NETWORK_STATE. The game
code itself makes no network requests. Removing these with `tools:node="remove"` is possible but
changes Google's library behavior; that is an owner decision (and the Play Data safety answer for
the Billing Library's own logging should be checked by the owner).
