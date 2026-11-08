# 08 — Bidder Pass 7-Day Free Trial

**Lane:** A · **Money:** yes (Braden's go) · **Needs:** 01

## Goal
When someone adds their first card, offer Bidder Pass free for 7 days. Many people who say yes keep it. **They must clearly say yes.** No silent auto-enroll.
Why: charges without a clear yes cause chargebacks, and enough chargebacks get Square to freeze the account, which stops closing-night charges. Visa/Mastercard rules and state auto-renewal laws require a clear yes, a reminder before the first charge and an easy cancel.

## Flow
1. The customer saves their **first card** (every place a card is first saved: signup, checkout, account).
2. The card saves first. Then the offer screen:
   - Big button: **"Start my free 7 days"**
   - Smaller: **"No thanks"**
   - Right under them, plain text: "Free for 7 days, then $9.99/month + tax. Cancel anytime in Account > Membership."
3. Nothing is pre-checked. "No thanks" finishes normally with no repeat nagging that session.
4. Yes → status `trialing`, full Bidder Pass perks right away (no fee, no ads, sneak peek).
5. **Day 5** (2 days before the charge): push + email "Your free trial ends in 2 days. $9.99/month after. Cancel in one tap →".
6. **Day 7:** charge $9.99 + tax → receipt email with a cancel link. Then monthly.
7. Cancel during the trial → no charge, perks end when the trial ends.

## Rules
- **One trial per account AND per card** (Square card fingerprint). The same card on a new account gets no trial.
- Trial converts to the **monthly** plan. Yearly is offered on the account page.
- **Save proof of consent:** user, time, screen, exact text shown, button tapped. Needed to win disputes.
- Admin (Memberships page): trial on/off, length, reminder day. Text edits get a version number.

## Confirm first
- Every screen where a card gets saved for the first time (app + website).
- Whether Square gives a card fingerprint so the same card can be spotted across accounts.
- The billing path from scope 01 (trial phase support).
- Push and email providers.

## Done when
- Tests:
  - Offer shows only on first card.
  - Yes → trialing with perks.
  - No → nothing changes.
  - Second trial blocked by account and by card.
  - Reminder fires on day 5.
  - Charge on day 7.
  - Cancel during trial = $0.
- Consent record saved for every yes.
- Revenue tagged `bidder_pass`. Revenue page shows trials started, converted and canceled.

## Ship
Braden's go. Customer app never 18:00–22:00. Rollback = flag off (offer disappears; existing trials finish normally).
