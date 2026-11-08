# 02 — $2.99 Handling Fee

**Lane:** A · **Money:** yes (Braden's go) · **Needs:** 01

## Goal
Charge a $2.99 handling fee on every invoice for non-members. Bidder Pass and Pro members pay nothing. The fee is there to push people toward Bidder Pass.

## Rules
- $2.99 per invoice (editable in admin). One fee per invoice, no matter how many lots.
- Waived when `has_perk(user, 'no_handling_fee')` is true **at the moment the invoice is created**. Trialing counts.
- **Not taxed.** Admin toggle "Tax the handling fee", default **off**.
- Full invoice refund → fee refunded too. Partial refund → fee kept.
- Only invoices created after switch-on get the fee. No back-charging.
- **Don't change how invoices are grouped.** No new invoices just to add fees.

## Build
1. Line item "Handling fee — $2.99" on the invoice, receipts, staff pickup screens and admin invoice view.
2. Next to the fee: "Free with Bidder Pass →" (join link, scope 01).
3. Disclose it before anyone bids:
   - Auction terms page.
   - Small line on lot page / bid confirm: "+$2.99 handling fee per invoice (free with Bidder Pass)".
4. Members see "Handling fee — waived (Bidder Pass)". This shows them the value.
5. Tag revenue `handling_fee`. Also count **waived** fees for the Revenue page.
6. Admin: fee amount, tax toggle, on/off.

## Confirm first
- Exactly when and where invoices get created (per auction close? per day? per pickup?).
- Invoice and line-item tables, how tax is figured per location, existing fees (buyer's premium, etc.).
- The card charge job (runs around closing, 18:00–22:00) and how it reads invoice totals.
- Every screen that shows an invoice total: customer app, website, staff app pickup, admin, receipts and emails.

## Done when
- Tests:
  - Non-member gets one fee per invoice.
  - Member and trial users get it waived.
  - Full refund returns the fee; partial refund keeps it.
  - Tax toggle off = fee untaxed.
- Sandbox charge for an invoice with the fee matches the invoice total to the cent.
- Flag off = invoices identical to today.

## Ship
Braden's go only. Deploy 09:00–16:00, never 18:00–22:00. Watch the first closing night's charges. Rollback = flag off (new invoices stop getting the fee).
