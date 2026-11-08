# Refunds before pickup — read-only breakdown (2026-10-15)

**Scope:** invoice lines refunded before they were handed over, on BinGo
invoices created in the 84 days to 2026-10-15. Read-only aggregates from prod
via `apply-migration.yml mode=query`. Queries and raw results:
`docs/state/revenue/queries/r1.sql/.json` and `r2.sql/.json`. Staff are shown
as the first 6 hex characters of md5(user/worker id), never by name. To match a
hash to a person, run `SELECT id FROM workers WHERE left(md5(id::text),6)='…'`.

## Headline

| | Value |
|---|---|
| Lines refunded before pickup | **2,428** of 20,340 sold lines (11.9%) |
| Hammer refunded on them | **$32,296** (plus the 15% premium and 9.5% tax refunded with it) |
| Lines with a refund reason recorded | 2,422 (99.8%). **Correction:** my earlier "0 reasons" was wrong. I read the wrong key; the reason is in `after_state->>'sub_reason'` |
| Staff accounts that issued them | **1** (`ab8728` issued 2,422; 6 have no item audit row, most likely the resolve-missing path in mig 0336) |
| Warehouse | All Harrison (1 Dodge City line). See the warning below |

## 1. By reason: the reason exists but can't be trusted

| Reason picked | Lines | Hammer | Has a note | Note says missing | Note says broken | Counter marked missing |
|---|---|---|---|---|---|---|
| defective_item | 1,444 | $21,944 | 523 | 59 | 130 | 15 |
| wrong_item | 685 | $5,591 | 9 | 0 | 0 | **499** |
| other | 221 | $3,795 | 220 | 38 | 47 | 1 |
| damaged_in_transit | 72 | $945 | 7 | 0 | 5 | 0 |
| (no item audit) | 6 | $21 | — | — | — | 6 |

Why the reason can't be trusted:

- **Each screen pre-selects a reason.** The staff app's refund sheet starts on
  `defective_item` (`apps/field-mobile/components/RefundItemsSheet.tsx:146`).
  The console's Refund button starts on `wrong_item`
  (`apps/operator-web/src/app/(operator)/invoices/[id]/RefundButton.tsx:41`).
  A refund made without touching the picker gets the default. 921 of the 1,444
  "defective" refunds have no note at all.
- **"Missing" has no reason of its own.** The console labels `wrong_item` as
  "Wrong / missing item". 499 of the 685 `wrong_item` refunds are items the
  counter had already marked missing (`pickup_lot_outcomes.outcome='missing'`).
- **"Defective" before pickup is mostly something else.** The customer never
  had these items. Of the 523 defective refunds with a note, 59 notes say the
  item was missing and 130 say it was broken.
- **Notes give the best signal**, but they're optional except for "Other".
  Across the 759 notes: broken/damaged 182, parts/incomplete 166, missing/can't
  find 97, wrong or not as described 75, not working 25, customer request 7.

Best estimate of the real split (ESTIMATE): **at least 521 missing** (counter
outcome) plus some of the 97 notes that say missing; **about 350 broken or
incomplete** (from notes); and about **1,400 with no usable reason** (default
reason, no note).

## 2. By warehouse

All but one line is Harrison, by the invoice's auction (`r2.by_wh_invoice`).

**Warning for anyone repeating this:** don't attribute a refunded lot to a
warehouse through `lots.auction_id`. After a refund that column is cleared
(1,346 lots) or points at a later auction (1,082). Through the lot, 1,346
refunds show "no warehouse" and a false 61.5% rate. Use `invoices.auction_id`.

## 3. By category (categories with 100+ sold lines)

| Category | Refunded | Sold | Rate | Hammer refunded |
|---|---|---|---|---|
| Home & Kitchen › Furniture | 78 | 234 | **33.3%** | $516 |
| Furniture | 628 | 3,086 | **20.3%** | $9,655 |
| Other | 1,029 | 8,591 | 12.0% | $15,266 |
| Bedding & Linens | 23 | 219 | 10.5% | $190 |
| Appliances | 39 | 383 | 10.2% | $883 |
| Tools & Hardware | 75 | 770 | 9.7% | $598 |
| Electronics | 89 | 958 | 9.3% | $1,003 |
| Home & Garden | 199 | 2,191 | 9.1% | $2,077 |
| Health & Beauty | 15 | 479 | 3.1% | $88 |

Furniture is a third of refunded dollars at twice the average rate. That fits
"parts/incomplete" and "broken": flat-pack boxes opened, hardware missing.

## 4. By history of the lot

| Lot was | Refunded | Sold | Rate |
|---|---|---|---|
| First listing | 1,793 | 17,870 | 10.0% |
| Desk relist | 536 | 2,034 | **26.4%** |
| Human relot | 99 | 436 | **22.7%** |

A relisted item is 2.6× as likely to be refunded before pickup. A relist puts
an item back on sale without anyone confirming it is still on the shelf and
whole. That is the gap mig 0345 and the Missing Items report (#516, #518)
started closing.

## 5. By who handled it

**Who refunded:** one account issued every item refund (`ab8728`). If that is
a shared office login, the reason quality is one person's habit, not the
team's.

**Who lotted** (first listings only, so relists don't skew it; 80+ sold lines,
split furniture / not furniture):

| Lotter | Not furniture: refunded / sold (rate) | Furniture: refunded / sold (rate) |
|---|---|---|
| c482d0 | 165 / 777 (**21.2%**) | — |
| 9f5373 | 159 / 979 (16.2%) | 206 / 1,054 (19.5%) |
| df069f | 60 / 403 (14.9%) | 36 / 147 (24.5%) |
| 8ac030 | 83 / 647 (12.8%) | — |
| 8cc74a | 69 / 617 (11.2%) | 27 / 197 (13.7%) |
| dc17df | 81 / 986 (8.2%) | 13 / 98 (13.3%) |
| b29d65 | 68 / 1,015 (6.7%) | — |
| 0138df | 54 / 779 (6.9%) | — |
| (no worker PIN) | 443 / 7,416 (6.0%) | 155 / 858 (18.1%) |
| d5169f | 11 / 239 (4.6%) | — |

**Read this as a lead, not a verdict.** Lotters work different loads and
vendors, and load quality wasn't controlled for. c482d0 at 21% against a
6–8% median is worth one conversation and a look at which loads they lotted.
The "no worker PIN" group is lots with `lotted_by_worker` empty. I didn't
check why (made before PINs, mig 0281, or made without one).

## 6. By timing

From invoice to refund: under 1 day 609; 1–3 days 823; **3–7 days 940**;
over 7 days 56. Most refunds come when the customer arrives (or the office
catches up), not at close. Week of 2026-09-07 spiked to 455 (vs ~190 most
weeks). That week isn't explained here.

## What would make this answerable next time

A refund reason that is chosen, not defaulted, and has a value for "missing".
See `docs/plans/PROPOSAL-refund-reason-required-2026-10-15.md`.
