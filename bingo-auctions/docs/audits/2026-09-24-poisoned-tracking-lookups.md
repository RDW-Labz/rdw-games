# Poisoned catalog entries keyed by FedEx tracking numbers — 2026-09-24

Read-only investigation against prod. Fix: #381 (lookup route refuses carrier
codes). Cleanup: migration 0372. Full rows: `2026-09-24-poisoned-tracking-lookups.json`.

## What
`product_lookups` held **16 rows keyed by a tracking number on a BinGo manifest
row** (`import_rows.tracking_number`). 13 hold products Sonar invented from the
tracking number (source `openrouter:perplexity:sonar+url-fetch`); 3 are empty.
Cached 2026-07-16 → 2026-09-05. 14 of the 16 fail the GS1 check digit; 2
(`538157106950`, `533501372036`) pass it by chance.

Cause: `looksLikeUpc` (domain-lotting) tests length only, so a 12-digit tracking
number that missed the manifest went to Sonar as a UPC; the route's non-GTIN
guard ran after that call.

## Lots created from them — YES, at least two
A lot keeps no reference to the catalog row and these lots store no UPC, so the
link is by title, MSRP and timing:

| Lot | Created (UTC) | vs. cache row | MSRP | Status | Manifest says the box is |
|---|---|---|---|---|---|
| BIN-004899 "Duralast Canister Vent Valve Solenoid PV529" | 2026-07-23 18:00:26 | 41 s after `529620018069` was cached | $84.99 (= cache) | relisted | Set Of 2 Modern Dining Chairs |
| BIN-008511 (relist of the above) | 2026-08-11 14:39 | — | $84.99 | **won** | same |
| BIN-007713 "Esazn Metal Raised Garden Bed" | 2026-08-05 16:44:51 | same minute as `533500043962` | $68.39 (= cache) | pending_intake | Coffee Table Legs |
| BIN-010931 (same title) | 2026-08-17 16:47 | — | $68.39 | canceled | same |

All four were lotted by the same staff account. The manifest row for
`529620018069` was separately lotted as "Set Of 2 Modern Dining Chairs", so that
box may be two lots. None has a UPC; `lots.upc` never held a tracking number
(0 rows), which is why a UPC check alone missed them.

## Needs a person (not done here)
- **BIN-008511 is won** under a car-part title: find what the winner was sold and
  what was in the box (a lot titled "Duralast…" vs the manifest's dining chairs).
- **BIN-007713** (pending_intake): check the physical item before it is listed.
- Whether one box became two lots (BIN-004899 and the manifest lot).
- Other invented lots may exist from tracking numbers that are not on any
  manifest; this audit only covers tracking numbers found on a manifest row.
