# 03 — Ads Platform (Business Ads, Boost, Admin Ads Page)

**Lane:** B · **Money:** billing + boost parts (Braden's go) · **Needs:** 01 for "no ads" check; 04 for boost-cancel ad credit

## Goal
Local businesses pay monthly to show ads inside BinGo. To bidders the ads look like lot cards. Bidder Pass and Pro members never see ads. Admin controls everything.

## How an ad looks
- Built like a lot card: image, title, description, link to the business. Small **"Sponsored"** tag.
- **No bid button.** Tap = opens the business link with `utm_source=bingo&utm_medium=app_ad`, through our own redirect so taps get counted.
- **Store ads in their own tables, not the lots table.** For staff it feels like adding a lot, but an ad can never be bid on, invoiced or charged. It never shows up in Auction Builder, inventory, exports, auction counts or price index data.

## Tiers
All prices, discounts and spacing are set in admin.

| Tier | Grid | Search | Lot page | Top-of-grid spot |
|---|---|---|---|---|
| Basic | ✓ | – | – | – |
| Plus | ✓ | ✓ | ✓ | – |
| Featured | ✓ | ✓ | ✓ | ✓ (rotates among Featured ads, next one each page load) |

- Terms: monthly, a discount for longer terms, and an **annual package for Basic and Plus**.
- Spacing: about every **12th card** in grid and search. Lot page: one sponsored card under the lot info. Swipe feed: about every 20th swipe (scope 09).
- **Server-side:** users with `no_ads` get zero ads from the API. Not just hidden in the UI.

## Business signup (both ways)
1. **Staff-sent link:** staff create the business in admin and send a Square card link. The business enters its own card. Staff never see card numbers.
2. **Self-signup page** on the website (`/advertise`): tiers and prices, terms, the business form (name, contact, ad image, description, link), Square card entry.
- Every new ad goes to an **approval queue**. **First charge happens when staff approve.** Rejected = never charged.
- No category is blocked. Staff approve each ad. Note: vape or alcohol ads may raise the app's age rating in the App Store and Google Play.

## Billing
- Auto-charge the card monthly or annually (Square). Tag revenue `ad_subscription`.
- **Card fails → ad pauses right away.** Staff get an alert. The ad resumes when payment clears.
- Cancel → the ad runs to the end of the paid period.
- Price change in admin → applies to **everyone at next billing, after a notice** (default 30 days, editable).

## Boost
All numbers editable in admin.
- One-time **$100**. Lasts **2 hours**. While boosted: **gold highlight** and shows about every **4th card** instead of every 12th (swipe feed: more often too, see 09).
- **One boost at a time.** Boosts run only **8am–10pm**.
- **One booking calendar:** the business sees open 2-hour slots and either picks one, or taps **"next open slot"** to join the line. Paying holds the slot.
  - Before paying they see their estimated start time.
  - When a boost ends, the next one in line starts automatically. The business gets a text or email when it goes live.
- Cancel before the boost starts → **ad credit only**, no card refund. Uses scope 04's balance ledger with owner = business. Credit applies to the next ad charge or boost. Until 04 merges, boost cancel stays turned off.
- A boost needs an active (not paused) ad.
- Tag revenue `ad_boost`.

## Stats
Internal only, shown on the admin Ads page. No emailed reports.
- Impressions (each time the ad renders for a viewer; repeat renders within 30s don't count), unique viewers, taps, tap rate.
- Per ad, per business, per day and month.
- **Raw counts only. No multipliers or adjusted numbers, ever.** Staff may share these real numbers with a business that asks.

## Admin Ads page (full control)
- **Businesses:** add, edit, pause, cancel; card status, payment history, disputes, ad credit balance.
- **Ads:** upload or edit the image, title, description and link; approve or reject; pause or resume; start and end dates; tier.
- **Tiers and prices:** monthly, longer-term discounts, annual packages, notice period.
- **Placement:** spacing for grid, search and feed; lot page on/off; Featured rotation.
- **Boost:** price, length, highlight on/off, boosted spacing, boost hours; calendar view and line (reorder, remove, convert to credit).
- **Stats and revenue:** per ad, business, tier and month; boost revenue.
- **Change log** on every edit (who, what, when, why). Price changes and credits follow the shared-login rule.

## Phases (each its own PR)
- **A.** Ad tables + admin Ads page + approval queue + manual "payment received" logging. Display in grid, search, top spot and lot page with "Sponsored" tag. Members see none. Stats. *(Starts earning with staff-entered ads.)*
- **B.** Square auto-billing, staff card link, `/advertise` self-signup. *(Braden's go.)*
- **C.** Boost calendar, line, auto-start, alerts. *(Braden's go.)*
- **D.** Boost cancel → ad credit *(after 04)*.

## Confirm first
- Lot card component(s) in the customer app and website. Grid, search and lot page rendering, and pagination.
- Image upload/storage used for lot photos (reuse it).
- Square APIs available (Customers, Cards, Subscriptions, Payments, Web Payments SDK on the website).
- Admin roles; push, text and email providers.

## Done when
- Members and trial users get zero ads from the API (tested).
- An ad can't be bid on, invoiced, exported or counted as a lot (tested).
- Sandbox: approve → first charge; card fail → instant pause; boost line auto-advances; only one boost live at a time; boosts never start outside 8am–10pm.
- Stats match raw event counts exactly.

## Ship
Website/admin 09:00–16:00. Customer-app parts never 18:00–22:00. Rollback = flag off (all ads vanish, billing stops).
