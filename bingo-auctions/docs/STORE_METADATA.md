# BinGo Auctions — App Store / Play Store Metadata

Paste-ready copy for App Store Connect (and Google Play) for BOTH apps:
the bidder app (**BinGo Auctions**) and the staff app (**BinGo Staff**).

Last updated: 2026-07-07 (full rewrite for the BinGo fork — the previous
version of this file was ClovrBid-era: wrong brand, Stripe, multi-operator).

---

# App 1 — BinGo Auctions (bidder app)

## App identity

| Field | Value |
|---|---|
| App name (iOS) | BinGo Auctions |
| Bundle ID (iOS) | `com.bingoauctions.bidder` |
| Package name (Android) | `com.bingoauctions.bidder` |
| ASC App ID | 6785655751 |
| Apple Developer Team | 73554WL25P |
| Version at submission | 0.1.1 (check ASC for the latest processed build) |
| Primary category | Shopping |
| Secondary category | Lifestyle |
| Age rating | 17+ (auction marketplace; unfiltered user-adjacent content possible) |
| Price | Free (no in-app purchases) |
| Sign-in methods | Email + password, Sign in with Apple, Sign in with Google |
| Made for Kids | NO — bidding requires 18+ (DOB collected at signup) |

## Subtitle (30 chars max — iOS only)

```
Local auctions. Real deals.
```

(27/30. Alternate: "Bid local. Win big.")

## Promotional text (170 chars — updatable without re-review)

```
Your local online auction. Bid from your phone on retail returns and overstock, win for a fraction of retail, and pick up at a BinGo warehouse near you.
```

(~152/170. Location-agnostic on purpose — new pickup locations don't require
an App Store update; promotional text is editable without re-review anyway.)

## Description (4000 chars — both stores)

```
BinGo Auctions is your local online auction. We sell real, physical goods — retail returns, shelf pulls, overstock, and general merchandise — in auctions that start at $1 and close on a schedule you can watch live from your phone.

HOW IT WORKS

• Browse hundreds of live lots with photos, condition notes, and retail-price comparisons
• Filter by category (pick as many as you like), condition, and price — or swipe through lots one at a time, full screen
• Place a max bid and let the app bid for you up to your limit
• Watch lots and get push notifications when you're outbid, when lots close soon, and when you win
• Win: your card on file is charged automatically and your invoice is ready in seconds
• Pick up locally — your Pickup Pass QR shows staff everything you've won, with a walk list ordered aisle by aisle

LOCAL PICKUP

Everything is pickup-only at a BinGo Auctions warehouse. Current locations and hours are always up to date at bingoauctions.com. Bring your Pickup Pass (in the app or on the site), and our staff will check out all your open orders in one visit.

STRAIGHT-SHOOTING RULES

• Lots are sold as-is with the condition stated on the listing — inspect before you leave
• All sales are final once you leave the warehouse
• Your card is saved securely with Square when you sign up; we never see or store card numbers
• No bidder platform fees — the hammer price plus any stated buyer's premium and sales tax is what you pay

PROHIBITED ITEMS

We don't sell firearms, drugs, alcohol, tobacco, hazardous materials, counterfeits, or anything requiring a federal license to transfer. Full list at bingoauctions.com/legal/prohibited-items.

YOUR DATA

We collect what's needed to run the auctions: your bid history, a tokenized payment method (card processing by Square), and pickup contact info. We don't sell your data and we don't share it with advertisers. Privacy Policy: bingoauctions.com/legal/privacy.

ABOUT US

BinGo Auctions is a family-run auction business based in Arkansas. Questions? support@bingoauctions.com — a real person reads every message.

Compatibility: iOS 15 or later. Internet connection required.
```

(~2,200 chars — room to grow.)

## Keywords (100 chars — iOS only)

```
auction,bid,liquidation,retail returns,overstock,deals,bargain,pallet,local,arkansas,bingo
```

(90/100. Location keywords: "local" + "arkansas" only — city names are NOT
hardcoded so new pickup locations never require a keyword update. Note:
"bingo" pulls some game-seekers, but it's the brand — the subtitle/description
make the auction context obvious.)

## What's New in This Version

```
First public release of BinGo Auctions.

• Browse and bid on hundreds of live lots starting at $1
• Full-screen swipe browsing — flip through lots like a feed
• Filter by multiple categories, condition, and price
• Max-bid proxy bidding with outbid and closing-soon notifications
• Automatic checkout the moment you win — card on file via Square
• Pickup Pass QR: one scan at the counter covers every open order

Questions or feedback? support@bingoauctions.com
```

## URLs

| Field | Value |
|---|---|
| Support URL | `https://bingoauctions.com/how-it-works` |
| Marketing URL | `https://bingoauctions.com` |
| Privacy Policy URL | `https://bingoauctions.com/legal/privacy` |
| Terms (EULA field, optional) | `https://bingoauctions.com/legal/terms` |
| Copyright | `© 2026 BinGo Auctions` |

## App Privacy disclosure form (iOS "nutrition label")

### Data linked to you

**Contact Info** — Email Address, Phone Number (optional), Physical Address (pickup contact)
→ Purpose: App Functionality (account + transactional notifications), Customer Support

**Identifiers** — User ID, Device ID (push token)
→ Purpose: App Functionality (sign-in, push notifications), Analytics

**Financial Info** — Payment Info (tokenized card via Square; we never receive card numbers)
→ Purpose: App Functionality (charging won invoices)

**Purchases** — Purchase History (bids, won lots, invoices, pickups)
→ Purpose: App Functionality, Dispute/Refund Resolution

**Usage Data** — Product Interaction
→ Purpose: Analytics (PostHog — product improvement)

**Diagnostics** — Crash Data
→ Purpose: App Functionality (first-party crash telemetry for bug fixing)

**Sensitive Info / Government ID** — NOT collected. (Stripe Identity was
removed in the Square cutover; if an ID-verification provider is added later,
update this form BEFORE shipping that build.)

### Tracking across apps/websites: **NO**

### Third parties handling data

- Square (payments — card tokenization + charges)
- Supabase (database + auth)
- PostHog (product analytics)
- Cloudflare (hosting/CDN, request logs)
- Resend (transactional email)
- Expo/EAS (build + over-the-air update delivery; push notifications)

## App Review Information (paste into ASC "Notes")

```
BinGo Auctions is the bidder app for a single online auction business
(BinGo Auctions, based in Arkansas) selling PHYSICAL goods — retail returns
and overstock — via timed online auctions with local warehouse pickup.

To review:

1. Sign in with the demo account:
     Email:    reviewer@clovrbid.com
     Password: ReviewMe2026Clovr!

2. Browse the demo auction (operator "Demo Auctioneer"). Tap any lot for
   details, or tap a lot on the Browse grid to enter full-screen swipe
   browsing. Place a bid with "Place Bid" — the first bid shows a terms
   acceptance dialog.

3. Account deletion (Guideline 5.1.1(v)): Profile tab → "Delete account" →
   type the email to confirm → the account is permanently inaccessible.

GUIDELINE 3.1.1: This app sells PHYSICAL GOODS ONLY, paid to the seller
(BinGo Auctions, the merchant of record) via Square. There are no digital
goods, subscriptions, or in-app purchases. Winning bidders pay for physical
items they pick up at the seller's warehouse — the same model as any retail
shopping app.

Questions: support@bingoauctions.com (owner-monitored).
```

### ⚠️ Reviewer-account TODOs before submitting (owner action)

1. Re-run `node scripts/inspect-*/seed-app-reviewer-fixtures.mjs --live`
   against BinGo prod so the demo auction is live and extends 30 days.
   (The script + account still use the reviewer@clovrbid.com email — that's
   fine functionally, but rename to reviewer@bingoauctions.com if you prefer
   the brand match. Update this doc + APP_REVIEWER_NOTES.md if you do.)
2. **Payments for the reviewer**: prod is Square LIVE (no test cards). Either
   (a) attach a real low-limit card to the reviewer account so a won demo lot
   charges a few cents, or (b) make sure demo-operator lots can be reviewed
   without completing payment (bidding itself never charges). Reviewers
   usually only need to SEE the bid flow — option (b) is the default; note it
   in the review notes if Apple asks about checkout.
3. Confirm the demo operator stays excluded from the public storefront
   (lib/demo-operators exclusion — already in place).

## Screenshots (iOS)

| Device | Resolution | Count |
|---|---|---|
| iPhone 6.7" | 1290 × 2796 | 3–10 (6.5" fallback accepted) |
| iPad 13" | 2064 × 2752 | only if iPad is supported — bidder app is iPhone-focused; supportsTablet false ⇒ iPad shots not required |

Suggested order (capture from the current TestFlight build):
1. Browse grid with category chips + live countdowns
2. Full-screen swipe pager on a lot (new!)
3. Lot detail mid-bid (max-bid input visible)
4. "You won" / invoice paid screen
5. Pickup Pass QR with the aisle-ordered walk list

## Google Play extras

- Short description (80 chars): `Your local online auction. Bid, win, and pick up at a BinGo warehouse.`
- Category: Shopping. Tags: Auctions, Liquidation, Local
- Feature graphic 1024×500 + icon 512×512 (brand art pack assets in repo)

---

# App 2 — BinGo Staff (warehouse app)

## App identity

| Field | Value |
|---|---|
| App name | BinGo Staff |
| Bundle ID | `com.bingoauctions.staff` |
| ASC App ID | 6785695060 |
| Version | 0.1.0 (TestFlight builds 6/7) |
| Category | Business |
| Price | Free |

## Distribution recommendation

**Don't put BinGo Staff on the public App Store.** It's a single-company
internal tool (lotting, put-away, checkout) — public listing invites
Guideline 4.2 minimal-functionality rejections and public confusion. Options,
best first:

1. **Keep it on TestFlight** (what we do today) — fine up to 100 internal /
   10,000 external testers, 90-day builds. Zero listing work.
2. **Apple Unlisted App Distribution** — a normal App Store submission plus a
   request form (developer.apple.com/support/unlisted-app-distribution). The
   app gets a private link, never appears in search. Needs the same review
   info as a public app but minimal marketing copy. Choose this when
   TestFlight expiry churn gets annoying.
3. Apple Business Manager custom app — heavier; not worth it at this size.

## If/when submitting (unlisted) — paste-ready

- Subtitle: `Warehouse tools for BinGo`
- Description:

```
BinGo Staff is the internal warehouse app for BinGo Auctions employees.
Staff use it to photograph and list inventory, put lots
away on shelves, stage won items, and check customers out at the pickup
counter (QR scan, per-item verification, signatures, partial pickups, and
missing-item reporting).

This app requires a BinGo Auctions staff account and is useless without one.
It is not intended for public use.
```

- Review notes must include a working staff demo login **scoped to the demo
  operator** (owner action: create `reviewer-staff@…` via the operator console
  before submitting; never hand Apple a real staff credential).
- App Privacy: same third parties as the bidder app minus Square; add Camera
  usage (lot photos, QR scanning) — already declared in Info.plist strings.

---

# Shared submission checklist (both apps)

- [ ] Screenshots captured from CURRENT TestFlight builds (staff 7 / bidder latest)
- [ ] Demo auction re-seeded (30-day window) and reviewer login verified
- [ ] Privacy nutrition labels filled per above (bidder) — re-check if an
      ID-verification provider gets added
- [ ] Export compliance: uses standard HTTPS only → `ITSAppUsesNonExemptEncryption=false`
      (already set in both app configs; answer "None of the algorithms" in ASC)
- [ ] Sign in with Apple enabled on `com.bingoauctions.bidder` (Guideline 4.8 —
      required because Google sign-in is offered)
- [ ] Age rating questionnaire: everything "None" except "Unrestricted Web
      Access: No", "Gambling: No" (auctions are not gambling — real goods,
      highest bidder wins; if the questionnaire asks about "contests" answer No)
- [ ] Pricing: Free, all territories = United States only (pickup-only business)
