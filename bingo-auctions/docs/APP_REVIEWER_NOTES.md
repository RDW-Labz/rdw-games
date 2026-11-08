# App Reviewer Notes — paste into ASC "App Review Information"

For Apple App Reviewers (and Google Play reviewers) to test ClovrBid bidder app.

These credentials are PERMANENT. The demo auction extends 30 days from each
re-seed; re-run `node scripts/seed-app-reviewer-fixtures.mjs` monthly to refresh.

---

## Credentials

**Reviewer bidder account:**
```
Email:    reviewer@clovrbid.com
Password: ReviewMe2026Clovr!
```

This account is identity-verified (so the reviewer can bid above the $500
threshold without going through Stripe Identity), age-verified
(birth_date = 1990-01-01), and has a clean bid history.

**Demo operator** (for reference — reviewer doesn't need to log into this):
- Business name: **Demo Auctioneer**
- Operator code: **DEMO**
- Lot codes will appear as `DEMO-000001`, `DEMO-000002`, etc.

---

## Demo auction

A persistent auction titled **"ClovrBid Demo Auction — App Review"** runs at
all times on the demo operator. Three lots are always live, all in scheduled
status when the auction opens.

| Lot | Title | MSRP | Starting bid | Condition |
|---|---|---|---|---|
| DEMO-000001 | Stanley FATMAX 25ft Tape Measure | $29.99 | $1.00 | Open Box |
| DEMO-000002 | Sony WH-1000XM4 Wireless Headphones | $349.99 | $5.00 | Appears New |
| DEMO-000003 | KitchenAid Artisan 5-Quart Stand Mixer (Empire Red) | $449.99 | $20.00 | Open Box |

The auction closes 30 days after each re-seed. If the reviewer arrives near
the close window, re-run the seed script to extend.

---

## Apple App Review Information block (paste verbatim)

```
ClovrBid is a multi-tenant online auction marketplace for PHYSICAL goods sold
by independent auction businesses ("operators"). This app is the bidder-facing
interface; operators use a separate web console at https://clovrbid.com to run
their auctions.

To review the bidder experience:

1. Open the app, tap "Sign in" and use:
     Email:    reviewer@clovrbid.com
     Password: ReviewMe2026Clovr!

2. The app opens to a live test auction operated by "Demo Auctioneer." This
   auction runs persistently with three lots — a tape measure, headphones,
   and a stand mixer.

3. Tap any lot to view detail. Tap "Place Bid", enter a max bid amount, tap
   confirm.

4. THE FIRST BID YOU PLACE will trigger an operator-policy acceptance modal —
   tap "I have read and agree" to continue. This is per-operator T&C
   consent which is required because each operator on ClovrBid sets their
   own policies (payment window, pickup, refund posture, shipping). The
   acceptance is recorded with timestamp + IP + user-agent for audit.

5. PAYMENT FLOW (test mode):
   - When you win a lot, tap "Pay Invoice"
   - Stripe Connect Standard with destination charges: the operator is the
     merchant of record (not ClovrBid). Use Stripe test card:
       4242 4242 4242 4242
       Any future expiry, any CVC, any ZIP
   - The payment will succeed and the invoice will be marked paid

6. ACCOUNT DELETION (Apple Guideline 5.1.1(v)):
   - Profile tab → bottom of screen → "Delete account"
   - You must type your email to confirm
   - Tap the red destructive button
   - The account is permanently inaccessible afterward; auth.users is
     tombstoned, bidders row is anonymized, watchlist + saved searches +
     subscriptions are deleted. Settled bid history is retained anonymized
     for 7-year tax compliance (US 1099-K reporting requirement).

GUIDELINE 3.1.1 NOTE (in-app purchase):
ClovrBid sells PHYSICAL GOODS through a marketplace, not digital goods. We
use Stripe Connect Standard with destination charges — each operator is the
merchant of record for transactions in their auctions, ClovrBid takes a
platform fee from the operator side via Stripe's application_fee_amount.
This is the same model as eBay, StockX, Mercari, Poshmark, and Whatnot. No
digital goods, no subscriptions inside the bidder app, no IAP — bidders pay
operators directly for physical items they'll pick up locally.

GUIDELINE 4.8 NOTE (Sign in with Apple):
Apple Sign-In is wired and required as the third-party login option
alongside Sign in with Google.

PROHIBITED ITEMS:
Firearms, drugs, alcohol, tobacco, hazardous materials, counterfeits, and
items requiring federal license to transfer are all prohibited (see Schedule
A at https://clovrbid.com/legal/prohibited-items). Operators agree to
these restrictions as part of their Operator Agreement.

If you have any questions please email michael@cluerholdings.com or
legal@clovrbid.com.

Operated by GOLD RUN LLC, Arkansas.
```

---

## Refresh the demo auction

To extend the auction by another 30 days (run monthly):

```bash
node scripts/seed-app-reviewer-fixtures.mjs
```

The script is idempotent — it deletes the previous demo auction + lots and
recreates fresh ones, but preserves the operator + reviewer accounts.

---

## Reviewer's path doesn't need

- Real money: Stripe test card works (4242 4242 4242 4242).
- Apple Sign-In: optional; the email/password path is the primary fallback.
- Real identity verification: the reviewer is pre-flagged as
  `identity_verified_at = now()` so the $500 threshold doesn't trigger
  Stripe Identity.
- Real address: the demo operator's warehouse is fake (Demo Street, Demo
  City, AR). The pickup screen will show this address; no real pickup will
  ever happen.
