# 04 — Balance: Prepaid Wallet + Store Credit

**Lane:** A · **Money:** yes (Braden's go) · **Needs:** 01 (revenue tagging) · **Used by:** 03 (ad credit)

## Goal
One balance system for two kinds of money:
- **Wallet cash:** money the customer loads. $1 in = $1 balance. Refundable to their card.
- **Store credit:** given instead of a card refund, with a +10% bonus. Can't be cashed out.

## Ledger (the core)
- **Extend the existing `bidder_credits` ledger (migration 0229). There is no second ledger and no replacement table.**
  Wallet cash and store credit are row types/buckets in that same append-only ledger, using additive columns
  (new tables or columns only — never a change to existing rows or history).
- Existing rows and spend behavior stay: `applyCreditToInvoice` in
  `apps/operator-web/src/lib/cron/auto-charge-drain.ts` applies credit before the card charge, and the 0270
  refund split (`refunded_cash_cents` / `refunded_credit_cents`, `refund_return`) still records returned credit.
- Row fields to add on `bidder_credits`: owner (customer or business), bucket (`cash` | `credit`), amount in cents (+/−),
  reason (`wallet_load`, `refund_as_credit`, `credit_bonus`, `spend`, `cash_out`, `adjustment`, `boost_cancel_credit`),
  references (invoice, Square payment/refund), actor (staff/system), note. Keep the existing reason values and
  exactly-once indexes intact.
- **Design checkpoint — buckets vs. one-spend-per-invoice:** `0229` includes
  `bidder_credits_one_spend_per_invoice` (one `spend` row per invoice). Two buckets spending on one invoice must
  not break that guarantee. Before implementation, decide and record how the bucket rows and that index coexist
  (for example, one `spend` row that records its cash/credit split, versus relaxing the index) and how legacy
  single-credit behavior is preserved. Whichever is chosen must keep retries and concurrent charges free of
  duplicate or missing debits.
- **Never edit or delete a row.** Corrections are new rows.
- Balance = sum per owner per bucket.
- Balances **never expire**.
- Wallet loads are **money we hold, not revenue**. Never tag them as revenue.

## Wallet
- Load $25 / $50 / $100 / custom. **Max balance $500.** Min load default $10. All editable in admin.
- Paid through Square (sandbox for tests).
- **Cash out:** on request, unused wallet cash goes back to the original card. The customer taps "Request refund" and it lands in a staff queue. Staff approve, and it refunds against the original Square payment(s). If too old for Square to refund, staff handle it by hand.

## Store credit
- When issuing a refund, **staff pick**: "Refund to card" or "Store credit (+10%)". The bonus % is editable in admin.
- $20 refund as credit = $20 `refund_as_credit` + $2 `credit_bonus` rows.
- Heads up for staff: a card payer who wanted their money back may dispute credit with their bank. Switch to a card refund if they push back.
- Shared-login rule: refunds and credits need manager PIN + typed staff name + reason.

## Spending
- At charge time: **store credit first → wallet cash → card** for the rest.
- Invoice shows "Paid with store credit $X / wallet $Y / card $Z".

## Build
1. Extend the existing ledger (`bidder_credits`) + balance function + tests.
2. Customer: balance on account page (credit and cash shown separately), history list, load button, request-refund button. Checkout shows the balance being used.
3. Staff/admin: refund screen with the card-or-credit choice; customer balance view; manual adjustment (reason required, logged).
4. Admin Balances page:
   - Total held (cash + credit) is the liability number for the accountant.
   - Per-customer balances.
   - Settings: bonus %, min/max load.
   - Cash-out queue.
   - Change log.
5. Business owner type for scope 03 ad credit (credit bucket only).

## Confirm first
- How refunds work today: who, from where, and how they hit Square.
- **The existing credit ledger: `bidder_credits` (0229) plus its spend path (`applyCreditToInvoice`, 0229) and refund
  split (0270).** Extend it; never create a second ledger, replace it, or leave two. Any coupon/gift-card code is
  additive input to the same ledger.
- The card charge job (closing night) and how it pays an invoice. **This change touches it, so it's the highest-risk part.**

## Done when
- Tests:
  - Spend order is credit → cash → card.
  - Max balance is enforced.
  - Credit can't be cashed out.
  - Bonus math is correct.
  - Ledger rows can't be updated or deleted (DB-level).
  - **Permanent regression:** flag off, a 10,000-cent invoice with 3,000 cents of existing `bidder_credits`
    is charged 7,000 cents — on the first attempt and on retry after a decline. Ledger history and the
    `refunded_cash_cents` / `refunded_credit_cents` split are preserved; new wallet behavior is gated separately.
- Sandbox closing-night run: mixed invoices (credit only, credit + card, card only) all charge correctly to the cent.
- Flag off = charge job behaves exactly like today.

## Ship
Braden's go. Charge-job change deploys 09:00–16:00, never 18:00–22:00. Watch the first closing night. Rollback = flag off: the charge job keeps applying existing `bidder_credits` credit and charging the remainder exactly as today, and only the new wallet features are skipped.

**Accountant:** ask about Arkansas unclaimed-property rules for old unused balances. This doesn't block the build.
