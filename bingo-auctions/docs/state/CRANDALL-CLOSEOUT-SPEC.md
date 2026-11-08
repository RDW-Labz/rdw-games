# Crandall closeout: build spec

Status: spec only, no code. Each item is its own PR, shipped in this order, one at a time.
Written 2026-10-12. Scope from Jared; design agreed with Braden: **the warehouse is the event**.
Updated 2026-10-12 with Jared's answers (see "Decisions").

Pickup address: 119 East Crandall Avenue, Harrison, AR 72601.

## Decisions (Jared, 2026-10-12)

| Question | Answer | What it means for the build |
|---|---|---|
| Auction shape | One 2-day auction, Thu–Fri; pickup Sat–Sun | One auction at Crandall; `pickup_starts_at` = Sat open, `pickup_ends_at` = Sun close |
| Unclaimed lots | Forfeit, relist at main (today's behaviour) | No new code. The notice must say so. One staff step: see item 7 |
| Shipping | Pickup only | Already true: `operators.offers_shipping = false` for BinGo (prod, read 2026-10-12). Pickup mode is a different setting (how the counter hands items over), not shipping |
| Sales tax | Same as main | `tax_rate_bps` NULL → inherits operator 950 (9.50%), same as Harrison |
| Square | Reuse main location | `square_location_id = LH36T6WADKGV7`, same as Harrison |

Notice text (Jared's wording, plus the forfeit line):

> SPECIAL OFF-SITE AUCTION — Pickup at 119 East Crandall Avenue, Harrison, AR 72601. Saturday–Sunday pickup only. Items not picked up by Sunday close are forfeited and relisted.

## The one rule

A warehouse with no `customer_notice` behaves exactly as it does today. Every new
screen element, email line and gate in this spec is switched on only by that
column being set. Harrison main never sets it, so normal auctions never change.

## What already exists (no work)

| Need | Where it already lives |
|---|---|
| Location with full address and timezone | `warehouses` (`packages/db/migrations/0001_init.sql:107`) |
| Per-day pickup hours | `warehouses.pickup_hours` JSONB, console `warehouses/[id]/pickup-hours` |
| Auction at a chosen warehouse | `auctions.warehouse_id`, console `auctions/new` |
| Auction's own pickup window | `auctions.pickup_starts_at` / `pickup_ends_at` |
| Invoices never mix warehouses | invoice = one per (auction, bidder), `UNIQUE (auction_id, bidder_id)`; lot assign refuses a lot from another warehouse (`0294_lineage_guard_direct_line_only.sql:177`) |
| Address + directions on invoice and pickup pages | `profile/invoices/[id]`, `profile/pickup/[id]` (map link at `:204`), bidder-app `invoice/[id]`, `pickup/[id]` |
| Pickup sessions per warehouse | `pickup_sessions.warehouse_id` + one-open-per-(bidder, warehouse) index (`0293_location_scoping_foundation.sql:137`) |
| Pre-bid accept gate (pattern to reuse) | `(public)/lot/[code]/SellerPolicyModal.tsx`, bidder-app `lot/_OperatorPolicyModal.tsx`, `operator_policy_acceptances` |
| History kept | auctions, lots, pickups reference warehouses `ON DELETE RESTRICT`, so a warehouse with history can't be deleted |

## Build order

| # | PR | Risk | Window |
|---|---|---|---|
| 1 | Crandall warehouse row (data, no code) | Low | any |
| 2 | `warehouses`: `active`, `pickup_instructions`, `customer_notice` (mig 0406), **draft #461** | Low | any (additive) |
| 3 | Lot + auction pages show the warehouse's address, hours, instructions, map (mig 0407), **draft #462**, stacked on #461 | Med | 09–16 |
| 3b | "Crandall Sale" button + event page (auctions filtered by warehouse, notice banner) | Med | 09–16 |
| 4 | Notice must be acknowledged before first bid at that warehouse | Med | 09–16 |
| 5 | Won / paid / reminder emails, pushes, SMS carry address + window | Med | 09–16 |
| 6 | Staff: Pickups filterable by warehouse (console + staff app) | Med | after 18:00 |
| 7 | Unclaimed lots after the window | Resolved: today's behaviour, no code | — |

Rollback references used below:
- **operator-web**: rerun `deploy-cloudflare.yml` at the previous commit (~6 min; no CF token on this Mac).
- **bidder app / staff app**: republish the previous OTA update group; dry-run the rollback before shipping.
- **migration**: every one here is additive; rollback = revert the code first, then drop the new columns/table.

---

### 1. Crandall warehouse row

No code PR. Created in the console (Warehouses → New), values recorded here.

- Name `Crandall (closeout)`, address as above.
- **Timezone `America/Chicago`, set explicitly.** The column defaults to `America/New_York`; Dodge City and Springdale were left on that default (prod, 2026-10-12), which is a separate bug to fix.
- `pickup_hours`: Sat + Sun only, hours from Jared.
- `tax_rate_bps`: NULL (inherits 9.50%, same as Harrison). Decided.
- `square_location_id`: `LH36T6WADKGV7` (main Bingo location, same as Harrison). Decided.
- `pickup_mode`: `counter_pickup`, same as Harrison.
- Shipping: nothing to set; BinGo is pickup-only operator-wide.
- Bins: create through the existing bins screen so lotting works there.

Side effect to check: the warehouse appears in every warehouse picker (auction form, staff app switcher, inventory filter). Confirm `auctions/new` still makes staff pick explicitly (see comment at `auctions/new/page.tsx:46`).

Test: inspector query shows the row; staff app switcher lists it; a test auction draft can select it (then delete the draft).
Rollback: delete the row while nothing references it; afterwards, set `active=false` (needs item 2).

### 2. Warehouse columns

Migration `0406_warehouse_active_and_customer_info.sql` (built: #461):
- `active BOOLEAN NOT NULL DEFAULT true`
- `pickup_instructions TEXT` (shown to customers)
- `customer_notice TEXT` (the off-site banner; NULL = normal warehouse)

Code:
- `(operator)/warehouses/[id]/page.tsx` + new/edit actions: edit the three fields; "Deactivate" button sets `active=false`.
- Pickers hide inactive warehouses: `auctions/new/page.tsx`, `auctions/auto-build/AutoBuildForm.tsx`, `lotting/inventory/InventoryTable.tsx`, `field-mobile/features/location/WarehouseContext.tsx` + `WarehouseSwitcher.tsx`. Reports and history pages keep showing them.
- Update `packages/db` generated types.

Risk: low. Defaults keep every existing row active with no notice.
Test: migration on the prod rig; vitest for the picker filter; deactivate a test warehouse and confirm its past auctions still render.
Rollback: revert code, drop columns.

### 3. Lot and auction pages use the warehouse

New helper `apps/operator-web/src/lib/warehouse-pickup.ts` (copied into bidder-app if no shared package): given an auction's warehouse, return address, hours lines, instructions, directions URL (same Google `dir/?api=1&destination=` form as `profile/pickup/[id]/page.tsx:204`), and `isOffsite = customer_notice != null`.

Built: #462. Customers can't read `warehouses` before they hold an invoice there (`warehouses_bidder_read`), so the app reads through a new definer function `public_warehouse_pickup_info` (mig `0407`, pickup-facing columns only). The website uses the admin client. The pickup pass already has a per-warehouse switcher, so no fix was needed there.

Files:
- Web: `(public)/lot/[code]/page.tsx` (pickup info card, ~`:1303`; add `warehouses(...)` to the auction select at `:321`), `(public)/auction/[id]/page.tsx` (`PolicyCell "Pickup hours"` at `:415`).
- App: `bidder-app/app/lot/[id].tsx` (select at `:1335`, pickup block ~`:2425`), `bidder-app/app/auction/[id].tsx`.
- When `isOffsite`: show the full address, Sat–Sun window, instructions, map link instead of operator `pickup_hours_text`. Otherwise unchanged.
- Check the pickup pass (`profile/pickup-pass`, `bidder-app/app/pickup-pass.tsx`) labels each building when a customer won at both. The 07-27 audit said it didn't yet; if still true, fix it here.

Risk: medium, customer-facing.
Test: vitest for the helper (offsite vs normal); render a Harrison lot (no diff) and a Crandall test lot on web + app; screenshot both.
Rollback: operator-web redeploy; bidder OTA undo group.

### 3b. "Crandall Sale" button and page

- Web home + browse (`(public)/page.tsx`, `(public)/browse/page.tsx`) and app home (`bidder-app/app/(tabs)/index.tsx`): if any active warehouse has `customer_notice` and live/upcoming auctions, show one button "<warehouse name> Sale →". None = nothing renders.
- Page: web `(public)/sale/[warehouseId]/page.tsx`, app `bidder-app/app/sale/[id].tsx`. Contents: the notice banner, full address, map link, pickup days/hours, instructions, then that warehouse's auctions (same card list as the normal auction list, filtered by `warehouse_id`).
- The normal auction list is not touched.

Risk: medium, home page.
Test: with no notice set, home is byte-identical (snapshot); with a test warehouse notice set, button + page render; page lists only that warehouse's auctions.
Rollback: operator-web redeploy; bidder OTA undo group. Fast kill: clear `customer_notice`.

### 4. Acknowledge the notice before the first bid

- Table `warehouse_notice_acks (bidder_id, warehouse_id, acked_at)`, PK on (bidder_id, warehouse_id), RLS insert/select own rows; RPC `ack_warehouse_notice(p_warehouse_id)`.
- Web `BidWidget` / new `OffsiteNoticeModal.tsx` beside `SellerPolicyModal.tsx`; app beside `lot/_OperatorPolicyModal.tsx`. Before the first bid on a lot whose warehouse has a notice and no ack: show notice + address + window, "I understand" records the ack, then the bid proceeds. Cancel never bids.
- Runs after the existing policy gate, same pattern.
- Client-side gate only; the bid RPC is not changed. Server-side refusal is possible later if Braden wants it.

Risk: medium, sits in the bid path (UI only).
Test: vitest for the gate order (policy → notice → bid); a Harrison lot shows no modal; a Crandall test lot shows it once, never again for that customer.
Rollback: redeploy / OTA undo; the table can stay.

### 5. Notifications carry the address

- `lib/cron/email-drain.ts` (`won` ~`:216`, `payment_succeeded` ~`:238`, `pickup_ready`), `lib/cron/notifications-drain.ts` (pushes), `lib/cron/sms-drain.ts`, `lib/cron/pickup-reminders.ts`.
- When the invoice's warehouse is off-site: add the address, Sat–Sun window and map link (email), a short "Pickup at 119 E Crandall Ave, Sat–Sun" line (push/SMS). Normal invoices: unchanged text.
- Uses the item 3 helper.

Risk: medium. These run every 30 min and at auction close, so a bad template hits many customers.
Test: vitest snapshot per kind, normal vs off-site; render one off-site email to a test inbox.
Rollback: operator-web redeploy.

### 6. Staff pickups by warehouse

- Console: `(operator)/pickups/page.tsx` adds a warehouse filter (`?warehouse=`, default All); `CustomerSearch.tsx` respects it.
- Staff app: `field-mobile/app/(staff)/checkout/index.tsx`, `queue.tsx`, `stage.tsx`, `pickup-verify.tsx` read `WarehouseContext`; a filter chip defaults to All, so today's view doesn't change until staff pick one.
- Worklist: `field-mobile/app/(staff)/worklist/index.tsx` gets the same filter.

Risk: medium. Staff use these mid-task; ship after 18:00 (staff OTA lands on next morning's launch).
Test: vitest for the query filter; on the rig, a customer with lots at both buildings shows only the chosen building's lots.
Rollback: redeploy / staff OTA undo.

### 7. Unclaimed lots after the window: RESOLVED, no code

Jared: forfeit and relist at main, i.e. today's behaviour.

Today: `auto_mark_pickup_no_show()` (latest body `0351_no_show_sweep_must_not_reclaim_collected_lots.sql`) forfeits uncollected lots at `auctions.pickup_ends_at` (`pickup_grace_extension_hours = 0`), refunds per the existing flow, and sets the lots to `unsold`.

**One staff step, no code:** relisting refuses to move a lot to another warehouse (`relist_target_different_warehouse`, `0394_relot_staff_only.sql:125`). So a forfeited Crandall lot can't go straight into a Harrison auction. Staff first move it into a Harrison bin (relocate; `warehouse_id` follows the bin, `0311_relocate_follows_the_live_lot.sql:168`), then relist as normal. The items have to move physically anyway when the building closes.

Notice text includes the forfeit line (see Decisions). Set `pickup_ends_at` to Sunday's actual close so the sweep fires then, not earlier.

## Open questions for Jared

1. Exact dates and Sat/Sun pickup hours.
