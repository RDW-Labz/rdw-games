# Runbook — turning on bounty payouts to RDW

**Links, in the order to click them (all verified reachable 2026-11-02):**

| # | Step | Link |
| --- | --- | --- |
| 1 | HackerOne account (business) | https://hackerone.com/users/sign_up |
| 2 | HackerOne sign-in (once created) | https://hackerone.com/users/sign_in |
| 3 | Bugcrowd account | https://bugcrowd.com/user/sign_up |
| 4 | Bugcrowd sign-in | https://login.bugcrowd.com/signin |
| 5 | First report target — EPAM | https://bugcrowd.com/engagements/epam-mbb-og |
| 6 | Second report target — eToro ($15k max) | https://bugcrowd.com/engagements/etoro-mbb-og |
| 7 | Third report target — GitHub | https://hackerone.com/github |
| 8 | SquareHub (invoices / payments) | https://clutechremote.taild609ec.ts.net/invoices |
| 9 | W-9 (fillable, IRS) | https://www.irs.gov/pub/irs-pdf/fw9.pdf |

Registration is **one-time**; after it, the only thing that repeats is filing, and that runs from the
automation browser once the login is saved in the vault.

Order matters only in one place: the payment method must match the tax form, so open the bank account
before you touch HackerOne. Everything here is done by you; nothing below needs a password or tax ID
in a chat window.

## 1. Bank account (do this first)

Open or designate a **business checking account in the legal name RDW**. Whatever name is on that
account is what goes in the platform's account-holder field, and it must match the W-9 exactly — a
mismatch is the most common reason a payout is held.

Collect, from the bank's own paperwork:

- exact legal name on the account
- ABA routing number
- account number
- the address the bank has for the entity

## 2. HackerOne account (the largest paying pool in our data)

1. Sign up at hackerone.com using `security@rdwlabz.com`.
2. Set the profile to **business account** — self-identify, legal name *RDW*, jurisdiction Arkansas,
   trading name *RDW Labz*.
3. **Settings → Rewards and Payments → Payment Setup**, in this order:
   - identity verification (Veriff), as authorised representative of the entity — 12-month validity
   - payment method: **Bank Transfer → company**, account-holder = the name from step 1, plus routing
     and account numbers. Minimums: $50 local, $100 SWIFT.
   - tax form: **W-9, corporation**, with RDW's EIN
4. Confirm the status page shows all three green. A submitted finding earns nothing until it does.

PayPal is a valid fallback, but only a **business** PayPal registered to RDW. A personal account is a
policy violation — *"using a third-party account is prohibited and monitored"* — not a shortcut.

## 3. What is already done on this side

- Detection and scope data: `programs.py` (2,138 bounty-eligible apex domains across 605 paying
  programmes) + `dangling.py`, sweeping daily on cron.
- Disclosures and outreach go out from `security@rdwlabz.com` (Resend, delivered, tracked in
  `sent.json` / `outreach/sent.json`).
- Client revenue does not depend on any of this: the $1,500 audit and $750 monitoring links are live
  on the RDW Square location today (see `PAYOUTS.md`).

## 4. When the first award lands

Record it in `PAYMENTS.md` under a `## Collected` heading — platform, programme, finding class, amount,
date, and the payout reference. That log is what turns "we do this" into a track record you can show a
client.
