# 01 — Memberships Foundation (Bidder Pass + Member Pro)

**Lane:** A (orchestrator) · **Money:** yes (Braden's go for prod billing) · **Blocks:** 02, 03 display, 05, 06 UI, 07, 08, 09

## Goal
One system that knows who gets which perk. Every other feature asks it.

## Plans
- **Bidder Pass:** $9.99/mo or $99/yr, tax added on top. Both prices editable in admin.
- **Member Pro:** already in progress ($100/mo, $50/mo for first 30 members for 6 months, cap 30 + waitlist). **Reuse its billing. Don't rebuild it.**
- Pro includes every Bidder Pass perk.

## Perks
Plan → perk map lives in a table, editable on the Memberships admin page.

| perk_key | Bidder Pass | Pro |
|---|---|---|
| `no_handling_fee` | ✓ | ✓ |
| `no_ads` | ✓ | ✓ |
| `sneak_peek` | ✓ | ✓ |
| `price_index` | – | ✓ |
| `sniper_protection` | – | ✓ |

## Build
1. **One server-side check:** `has_perk(user_id, perk_key)` → true/false. Used by RLS, APIs and both apps. The app never decides perks on its own.
2. **Statuses:**
   - `trialing` and `active` get perks.
   - `canceled` keeps perks until the paid period ends.
   - `past_due` loses perks right away (open question 1 default).
3. **Billing:** same path Member Pro uses (confirm: Square Subscriptions API or card-on-file charges). Monthly and yearly. Sandbox for every test.
4. **Where to join (all four):** checkout/invoice ("Skip this $2.99 fee — get Bidder Pass"), account/member page, signup flow, bid confirm screen (small line under the bid button).
5. **Cancel:** one tap from Account > Membership. Perks last to the end of the paid period. No partial refunds.
6. **Price changes:** apply to everyone at next billing after a notice (default 30 days, editable).
6b. **Member Pro cap + waitlist:**
   - Pro has a member cap. Default 30, editable in admin.
   - When it's full, the Pro "Join" button becomes **"Join the waitlist"**. People join in order with one tap. No card needed to join the line.
   - When a spot opens (a cancel, or admin raises the cap), the **next person in line** gets push + email: "A Member Pro spot is open — claim it within 48 hours →". The spot is held for them.
   - If they don't claim it within the hold time (default 48h, editable), it goes to the next person. They drop to the back of the line, or off it if they tap "remove me".
   - Waitlist people see their place in line on the member page.
   - The 30-member intro price ($50/mo for 6 months) stays tied to the first 30 members, as already planned.
   - Admin: the cap, the hold time, and the waitlist itself (see order, move someone up or down, remove, send the offer by hand). Every change is logged.
7. **Memberships admin page:**
   - Plans and prices (monthly/yearly), the perk map, the notice period and trial settings (scope 08).
   - Members list: plan, status, renew date. Show no more customer info than admin already shows.
   - Cancel or refund a membership (shared-login rule applies).
   - Revenue by plan per month.
   - Change log (who, what, when, why).
8. **Revenue page:** revenue per `revenue_source` per month vs BinGo's current average revenue. Every new feature reports here.

## Confirm first
- How Member Pro bills, where its status is stored and where member checks happen today.
- Feature flag system: what exists and how it's toggled per environment.
- Admin dashboard layout and roles: who can see an admin page.
- How tax is added to a Pro charge, so Bidder Pass copies it.

## Done when
- `has_perk` has tests for every perk × status (trialing, active, canceled-in-period, canceled-expired, past_due, none).
- Pro cap tests:
  - A full plan can't sell a 31st spot, even when two people tap at the same time.
  - The waitlist offers go out in order.
  - A spot held past its time moves to the next person.
- Sandbox: Bidder Pass monthly and yearly start, renew, fail and cancel all work.
- Admin page edits prices and the perk map, and every edit lands in the change log.
- Flag off = zero change for any current user.

## Ship
Flag off → admin page (09:00–16:00) → billing on Braden's go → rollback = flag off + revert PR.
