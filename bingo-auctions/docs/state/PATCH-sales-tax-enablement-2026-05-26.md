# Update Patch — Sales Tax Enablement (2026-05-26)

Self-contained handoff for a fresh session. Derived from a read-only money
audit of sales-tax handling in the codebase. **No code or prod changes made
yet — this is the spec to execute.**

## TL;DR — why the test transaction had no tax

BinGo operator has **`collect_sales_tax = false`**. The tax code is fully
wired, but the per-operator opt-in is OFF, so `automatic_tax` is never added
to the PaymentIntent → Stripe adds no tax → `tax_cents = 0` → invoice tax row
hidden. Not a bug; an un-set opt-in. **The architecture is built and the
refund/ledger math is correct — the work here is policy + config + 3 small
pre-enable code fixes, NOT building tax from scratch.**

> **Scope note:** this patch is written around BinGo (AR) as the first
> operator, but the model is multi-operator / multi-state. Read the
> "Multi-operator / multi-state" section below FIRST — it reframes Step 2 and
> Fix B as per-operator-repeatable, and flags the gating legal question
> (marketplace-facilitator status, `LAUNCH_PLAN §2.1` Decision Q1) that must be
> resolved by a tax attorney before scaling tax to operators in other states.

## Multi-operator / multi-state (read before executing)

**Architecture is already designed for this.** The code uses **destination
charges** (`transfer_data.destination` + `on_behalf_of` on both PaymentIntents)
so **each operator is the merchant of record for their own sales**. Tax is
computed against **that operator's own Stripe Tax registrations on their own
connected account**. Consequences:

- The `collect_sales_tax` flag + per-operator connected account is the correct
  multi-tenant shape. An operator in TX registers TX; one in AR registers AR.
  Each invoice's tax resolves against the right operator's account/state. The
  plumbing does not care that BinGo is AR.
- **ClovrBid/GOLD RUN does NOT register in 45 states** — the obligation is
  pushed to each operator. This is the entire reason for the destination-charge
  topology (`LAUNCH_PLAN §2.1`, Path A).

**Therefore, re-read the steps below as per-operator-repeatable, not one-off:**

- **Step 2 (Stripe Tax registration)** is an **onboarding-repeatable step run
  per operator, per state where that operator has nexus** — not a one-time
  BinGo task. It belongs in the operator-onboarding flow.
- **Fix B (origin vs destination)** must be driven by **each operator's own
  warehouse state**, never hardcoded to AR. The pickup/origin location is
  per-warehouse.

**⚠️ GATING LEGAL QUESTION — resolve before scaling tax to more states:**

- Path A assumes operator-as-MOR relieves ClovrBid of **marketplace-facilitator**
  obligations. But many states define a marketplace facilitator by *facilitating
  the sale* (listing + processing payment), NOT by who is MOR on the card
  network — so ClovrBid could still be a facilitator legally, regardless of the
  operator agreement (`LAUNCH_PLAN §2.1:171`).
- `LAUNCH_PLAN §2.1` Decision Q1 is **still an unchecked box**: the code shipped
  Path A, but the tax-attorney confirmation that Path A actually escapes MF
  status has not been recorded. **A tax attorney must bless this before
  enabling tax for operators beyond BinGo/AR.** If the answer is "ClovrBid IS a
  facilitator," the whole model flips to Path B (platform collects/remits on the
  platform account + Stripe Tax nexus monitoring + multi-state filing), which is
  a materially different build.

**Net:** the *code* scales to multi-operator/multi-state today. The *legal
posture* does not yet — it's blocked on Decision Q1. Treat BinGo/AR as the
single-operator pilot; do NOT mass-enable `collect_sales_tax` across operators
until Q1 is resolved.

## Verified current state (prod, 2026-05-26)

| Item | Value |
|---|---|
| Operator | BinGo Auctions (`BIN`) |
| `collect_sales_tax` | **false** |
| `stripe_tax_acknowledged_at` | 2026-05-24 (acknowledged) |
| `stripe_account_id` | `acct_1TaQ4DB4jGyANhBb` (Connect onboarded, charges enabled) |
| `default_buyer_premium_bps` | 1500 (15%) |

## What's already built and CORRECT (do NOT "fix" these)

| Piece | File:line | Note |
|---|---|---|
| Auto-charge PI tax gate | `apps/operator-web/src/lib/cron/auto-charge-drain.ts:265,284` | `automatic_tax:{enabled:true}` only when `collect_sales_tax` |
| Manual/PaymentSheet PI tax gate | `apps/operator-web/src/app/api/invoices/[id]/payment-intent/route.ts:229-238` | same gate, consistent |
| Canonical tax write | `apps/operator-web/src/app/api/webhooks/stripe/route.ts:175-223` | `tax_cents = pi.amount_received − pi.amount`, total recomputed (BUG-ARCH-07/08 fixed) |
| Platform fee EXCLUDES tax | `payment-intent/route.ts:195` | `saleAmountCents = total_cents − tax_cents` — tax belongs to operator/state, not ClovrBid. Correct. |
| Operator is merchant of record | both PIs: `on_behalf_of` + `transfer_data.destination` | tax uses the operator's Stripe Tax registrations, not the platform's. Correct for the legal model. |
| Opt-in UI | `(operator)/settings/policies` (toggle, `actions.ts:68`) + `(operator)/settings/stripe-tax` (acknowledgment) | exists |
| Legal posture | `legal/terms.md:94`, `legal/operator-agreement.md` §7.2 | operator collects/remits; Stripe Tax recommended not required |

## Step 0 — Policy gate (PREREQUISITE, not a code task)

BinGo is an **Arkansas auction selling tangible goods, in-person pickup** →
sales tax is almost certainly required. **Owner must confirm with whoever
handles BinGo's sales-tax filing** before enabling. Do not flip the switch on
real money without this sign-off. The rest of this patch is the technical
enablement once that decision is "yes."

## Step 1 — Pre-enable code fixes (do BEFORE turning the flag on)

### Fix A — Auto-charge needs a customer tax location (HIGH)
- **Problem:** `auto-charge-drain.ts:266-287` creates an `off_session` PI with `customer` but **no `shipping`/address**. `automatic_tax` needs a customer location. If a bidder's Stripe Customer (and saved PM billing details) have no address, enabling tax will **error at charge time → broken auto-charge**.
- **Action:**
  1. Audit existing bidders' Stripe Customers for an `address` (or saved PM `billing_details.address`). (Read-only check first — see Step 4.)
  2. Ensure bidder onboarding / card-save writes `address` onto the Stripe Customer (the SetupIntent/`ensureBidderStripeCustomer` path), so off-session charges can compute tax.
  3. Alternatively pass an explicit tax location on the PI, but customer address is the durable fix.
- **Note:** the manual PaymentSheet path (`payment-intent/route.ts`) can collect billing address in-sheet — verify `billingDetailsCollectionConfiguration` is set to collect address. The off-session auto-charge path is the real risk.

### Fix B — Origin vs destination tax treatment (HIGH — get it right)
- **Problem:** pickup is in-person at the AR warehouse. Arkansas is **origin-based** for in-state sellers. `automatic_tax` on a bare PI (no line items, no shipping) defaults to **customer-billing-address (destination)** — which may compute the wrong rate or tax out-of-state billing addresses for goods actually collected in AR.
- **Action:** configure Stripe Tax on `acct_1TaQ4D` with the **warehouse (Harrison, AR) as the origin / ship-from**, and confirm the tax behavior matches in-person-pickup rules. Validate with the tax advisor that destination = pickup location, not buyer billing. May require setting a tax location on the PI or using Stripe Tax's location rules. **Test with both an AR and an out-of-state test buyer before launch.**

### Fix C — Bidder web receipt must itemize tax (MEDIUM)
- **Problem:** `apps/operator-web/src/app/profile/invoices/[id]/page.tsx:130-136` deliberately omits `tax_cents` and folds it into "Buyer premium & fees." Sales tax should be **separately stated** on a receipt.
- **Action:** add `tax_cents` to that page's invoice query and render a dedicated "Tax" row — match the native app (`apps/bidder-app/app/invoice/[id].tsx:625`) and operator view (`apps/operator-web/src/app/(operator)/invoices/[id]/page.tsx:95`), which already itemize it.

## Step 2 — Stripe Dashboard config (manual, on the CONNECTED account)

On `acct_1TaQ4DB4jGyANhBb` (BinGo's connected account — NOT the platform acct_1TaMSs):
1. Enable **Stripe Tax**.
2. Add **AR tax registration** (nexus) + the warehouse origin address (Harrison, AR).
3. Confirm **tax-exclusive** behavior (tax added on top) — matches the webhook math (`amount_received − amount`).
4. Sign any required tax forms (per `docs/state/STACK.md:151`).
- Without a registration, `automatic_tax` returns $0 (safe no-op) — so the flag can look "on" while collecting nothing. Registration is what makes it real.

## Step 3 — Enable the opt-in

- Operator UI: `/settings/policies` → toggle **collect sales tax ON** (writes `operators.collect_sales_tax = true` via `actions.ts:68`).
- This is the ONLY data change; everything else is config/code.

## Step 4 — Verification (read-only checks + a live test)

Pre-enable read-only:
- [ ] Count bidders whose Stripe Customer has NO address (gates Fix A).
- [ ] Confirm `acct_1TaQ4D` shows Stripe Tax enabled + AR registration in Dashboard.

Post-enable live test (use `docs/e2e-stripe-4242-test.md` harness):
- [ ] Run a 4242 test win → invoice → pay. Confirm `tax_cents > 0` and `total_cents` recomputed.
- [ ] Auto-charge path: a saved-card bidder with an address on file charges cleanly with tax (no `off_session` error).
- [ ] AR buyer vs out-of-state buyer both produce the correct (origin-based) tax.
- [ ] Tax line shows on: native receipt, operator invoice, AND (after Fix C) bidder web receipt.
- [ ] Platform application fee is computed on the pre-tax amount.

## Rollback

Flip `operators.collect_sales_tax = false` → reverts to no-tax immediately for
new PIs. In-flight/paid PIs are unaffected (tax already captured canonically).

## Sequencing

Fix C is independent (ship anytime). Fixes A + B + Step 2 must land before
Step 3 on real money. Suggested order: Fix A audit → Fix A/B code+config →
Step 2 Dashboard → Fix C → Step 3 toggle → Step 4 verify.

## Audit findings (2026-05-26, via scripts/inspect-tax-readiness.mjs)

Read-only probe of LIVE Stripe (platform `acct_1TaMSs` + BinGo connected
`acct_1TaQ4D`):

1. **Step 2 is ALREADY DONE on the connected account.** The "Verified current
   state" table above only checked operator flags, not the connected account's
   tax config. `acct_1TaQ4D` shows Stripe Tax **status=active**, origin address
   **set**, and **1 active registration: US / AR / state_sales_tax**
   (active_from ~2026-05-23). The registration that makes `automatic_tax` real
   already exists — so the remaining money gates are Step 0 sign-off, Step 3
   flag, and the customer-address problem below.

2. **Fix A is bigger than "forward capture": 0 of 100 sampled bidder Stripe
   Customers have ANY address** (all 100 bidder-tagged; has_more=true). The
   card-save flow never copied the PM billing address onto the customer. The
   shipped PR fixes this GOING FORWARD, but **every existing bidder customer is
   `address=null`**. If `collect_sales_tax` flips on today, the off-session
   auto-charge PI (automatic_tax + a customer with no location, no shipping)
   would **error at charge time for existing bidders**.

   → Before enabling tax, EITHER:
   - **(a) backfill** existing customers' addresses from their saved PM's
     `billing_details` (one-time write; safe — only adds address), OR
   - **(b) set the tax location on the off-session PI explicitly** — most
     naturally the **warehouse (AR) origin**, since pickup is in person. This is
     exactly the **Fix B origin-vs-destination decision**, so it is
     **tax-advisor-gated**. For in-person AR pickup, taxing at the warehouse
     origin (b) is likely more correct than the buyer's billing address.

   Net: the existing-customer gap and the origin/destination choice are the
   same decision — resolve Fix B with the advisor, then implement (a) or (b).
   The forward-capture fix is correct either way.
