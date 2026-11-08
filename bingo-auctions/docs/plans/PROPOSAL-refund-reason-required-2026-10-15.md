# PROPOSAL — make staff choose a refund reason, and give "missing" its own

**Status:** proposal only, not built. Part of the Missing Items work.
**Date:** 2026-10-15
**Needs:** Braden (go/no-go), Jared (it adds a tap to a floor screen).
**Evidence:** `docs/audits/refunds-before-pickup-2026-10-15.md`

## Problem (with numbers)

In 84 days, 2,428 items ($32,296 hammer) were refunded before the customer got
them. Every refund already stores a reason, but the reason isn't reliable:

1. **Pre-selected reason.** The staff app sheet starts on "Defective item"
   (`apps/field-mobile/components/RefundItemsSheet.tsx:146`). The console starts
   on "Wrong / missing item" (`.../invoices/[id]/RefundButton.tsx:41`).
   1,444 refunds say "defective", and 921 of those have no note.
2. **No "missing" reason.** Missing is folded into `wrong_item`. 499 of the 685
   `wrong_item` refunds were items the counter had already marked missing.
3. **Note optional** except for "Other". The notes we do have are the only
   reliable signal (broken 182, parts/incomplete 166, missing 97).

So the question "how much of the $32k is lost stock, how much broken, how much
mis-described?" can't be answered from the data.

## Change

### 1. No pre-selected reason (both screens)

The reason picker starts empty, and Refund stays disabled until a reason is
chosen. Same rule in the staff app sheet and the console button.

### 2. New reason list (same on both screens)

| Value sent | Label staff see | When |
|---|---|---|
| `missing` *(new)* | Missing — can't find it | Not on its shelf / not in the building |
| `broken_in_warehouse` *(new)* | Broken or incomplete (found that way) | Found it, but it's damaged or missing parts |
| `defective_item` | Customer rejected it at the counter | Customer saw it and won't take it |
| `wrong_item` | Wrong item pulled / not as described | Listing doesn't match the item |
| `other` | Other (note required) | Anything else |

`damaged_in_transit` stays accepted by the server (older app builds send it)
but drops off the list. BinGo doesn't ship.

### 3. A short note is required for "broken" and "other"

One line, e.g. "box opened, no hardware". "Missing" needs no note: the
Missing Items report already records where the item was last seen.

### 4. Server accepts old and new values

`apps/operator-web/src/app/api/invoices/[id]/refund-items/route.ts:54` widens
its `z.enum` to include `missing` and `broken_in_warehouse`. It **keeps**
accepting the four current values, so staff phones still on an older OTA keep
refunding exactly as today. Nothing is ever rejected that is accepted now.

### 5. (Optional, separate decision) "Missing" feeds the Missing Items rule

Today an item counts as missing for mig 0345's relist block and the Missing
Items report (#518) only when the **counter** marked it missing
(`pickup_lot_outcomes.outcome='missing'`). A refund with reason `missing` for
a lot with no counter outcome could write that row too, so the item can't be
relisted until it's found. This changes what the Auction Builder lets staff
relist, so it should be decided on its own. Recommend: **not in the first
change.**

## What does NOT change

- Refund amounts, Square calls, who can refund, refund windows: untouched.
- No database migration. `sub_reason` is checked only by the route's `z.enum`
  and stored inside `operator_audit_log.after_state` (JSON). The
  `refund_reason` Postgres enum belongs to the Stripe-era `refund_jobs` table,
  which this route no longer writes.
- Customer screens: none. Checked: nothing outside the two pickers and the
  route reads `sub_reason` (`git grep sub_reason`, 2026-10-15), and
  `lib/refund-copy.ts` never mentions a reason.

## Cost to the floor

One required tap per refund (about 29 a day at the last 84 days' rate), plus a
one-line note on broken/other. That's a floor-process change, so Jared signs
off before it's built.

## Files a build would touch (estimate)

| File | Change |
|---|---|
| `apps/operator-web/src/app/api/invoices/[id]/refund-items/route.ts` | widen `z.enum`; require `reason_note` for `broken_in_warehouse` |
| `apps/operator-web/src/app/(operator)/invoices/[id]/RefundButton.tsx` | empty default, new list, disable until chosen |
| `apps/field-mobile/components/RefundItemsSheet.tsx` | same |
| tests next to each | old values still accepted; no-reason blocked in UI; note rule |

## How we'd know it worked (read after 14 days)

```sql
-- share of pre-pickup item refunds whose reason was chosen from the new list
SELECT after_state->>'sub_reason' r, count(*)
FROM operator_audit_log
WHERE action_type='invoice.refund_item' AND created_at >= '<ship date>'
GROUP BY 1;
```

Success: `missing` + `broken_in_warehouse` + `wrong_item` + `defective_item`
are each a believable share. "Defective" no longer covers 59% of refunds by
itself, and fewer than 10% are "other" without a useful note.

## Shipping

Staff-only screens: per Rule 9, staff app OTA and console deploy after 18:00
CT, one at a time. Server first (it only widens what's accepted), then the
console, then the staff app OTA. Rollback: revert the UI. The widened server
enum is harmless to leave in place.
