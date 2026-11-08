# Every place that switches on lot status (audit for 0475, 2026-10-28)

What a new value `refunded` does at each place. "Falls through" means the code has no case for it and shows its default. Audited with `grep` for `'won'` / `'unsold'` across the apps and packages (tests and fixtures excluded: 55 files), plus every prod SQL function whose body names those statuses (22 functions).

## Changed in this PR
| Place | Behaviour with `refunded` |
|---|---|
| `packages/shared/src/types.ts` `LotStatus` | Adds `'refunded'`. |
| `console-v2/stage-hue.ts` `lotFloorStage` | `refunded` is in the Lotting stage (back on the floor), like unsold/relisted. |
| Console lot page `lots/[id]/page.tsx` (v1 + v2) | **Back to inventory after refund** panel: manager PIN, typed name and reason (`relist_refunded_lot`). It shows for `refunded`, and for legacy `won` lots whose every line is refunded and none was picked up. Normal Relist stays unsold/relisted only. Status pills print the raw value (`refunded`). |

## Database (prod functions naming lot statuses)
| Function | Effect of `refunded` |
|---|---|
| `relist_lot_into_auction` | Refuses `refunded` (allows unsold / in_inventory / relisted / fully refunded won). **Not changed:** `relist_refunded_lot` steps the lot to `unsold` inside the same transaction first. |
| `auto_relist_unsold_lots` | Picks `unsold` only, so refunded lots **never auto-relist**. They need the PIN path. Intended. |
| `admin_cancel_lot`, `keep_lot_for_business` | Check their own allowed sets. `refunded` is not in them, so they refuse. Follow-up if the owner wants cancel or keep for refunded lots. |
| `advance_auction_lifecycle`, `finalize_lot`, `finalize_due_lots`, `finalize_scheduled_no_bid_lots`, `buy_dutch`, `buy_flat_price`, `get_lot_recent_bids` | Act on scheduled/live/won during a sale. A refunded lot is past its sale and never in an open auction, so they are not reached. |
| `build_invoices_for_auction` | Builds from `won` lots at close. Refund happens after invoicing, so not reached. |
| `auto_mark_pickup_no_show`, `undo_invoice_line_forfeit`, `invoice_lots_late_pickup_restores_won` | Act on lines that are not refunded. The 0475 trigger skips forfeited and picked-up lines, so these never meet a lot it moved. |
| `assign_lot_to_bin`, `batch_intake_lot_to_bin` | Put-away is location-only for any status, so a refunded box can be shelved. |
| `staff_inventory_counts`, `load_summary`, `builder_collected_lot_ids`, `check_collected_item_invariants`, `operator_auction_performance` | Count or report by named statuses. `refunded` is counted in none of their buckets (not as sold, not as in stock). Reports: a refunded lot drops out of "won" counts. Follow-up if the owner wants a "refunded" column. |

## Staff app (field-mobile)
| Place | Effect |
|---|---|
| `lotting/relot.tsx` | Calls `relist_lot_into_auction` directly, so it **refuses a refunded lot** ("relist_source_wrong_status") until it calls `relist_refunded_lot` with a manager PIN. **Must ship with or right after 0475** (staff window, after 18:00). |
| `layout/lots/find.tsx` | Owner panel is only fetched for `won`, so a refunded lot shows no buyer line; status prints raw. OK; the relot hint keys on child rows. |
| `worklist/index.tsx`, `worklist/[id].tsx`, `layout/bins/contents.tsx`, `features/lotting/useInventoryList.ts`, `lib/lot-as-listed.ts` | Filter or label by explicit status lists. `refunded` falls through to the raw value or is excluded from in-stock lists. Follow-up: decide whether refunded boxes appear in the inventory list. |

## Console (operator-web), other places
| Place | Effect |
|---|---|
| `lotting/inventory/page.tsx`, `lotting/inventory/v2/inventory-types.ts`, `lotting/page.tsx` | In-stock lists are explicit (`in_inventory`, `unsold`…). `refunded` is **not listed** until added. Follow-up decision: show refunded boxes in Inventory? |
| `auctions/[id]/builder/*` (AuctionBuilder, actions, page, v2 copy) | Builder candidates are `unsold`/`in_inventory`/relist children. A refunded lot is not offered until relisted through the PIN path. Intended. |
| `auctions/[id]/page.tsx`, `auctions/[id]/v2/AuctionDetailLotSummary.tsx`, `reports/actions.ts`, `reports/auctions/AuctionPerfTable.tsx`, `ops/page.tsx` | Count won/unsold per auction. A lot refunded after the auction stops counting as won. Follow-up if the reports should keep "sold then refunded". |
| `invoices/[id]/page.tsx`, `pickups/actions.ts`, `lib/pickup-override-offer.ts` | Line state comes from `invoice_lots` stamps (`refunded_at` first), not lot status, so nothing changes. |
| `lots/[id]/actions.ts`, `lots/[id]/edit/lot-edit-policy.ts` | Edit and delete allow-lists are explicit. `refunded` is not editable or deletable there, the same as `won` today. |
| `worklist/actions.ts`, `worklist/page.tsx` | Explicit lists; `refunded` is excluded. |
| `lib/auction-status.ts`, `components/console-v2/status.ts` | Label maps fall back to the raw value. |
| `lib/cron/*` (email, sms, notifications, grace-expiry, lot-categorize), `lib/email-quota.ts`, `lib/notification-offsite-load.ts`, `lib/lot-as-listed.ts` | Act on `won` at close or on notifications. Not reached by a refunded lot. |

## Bidder-facing (bidder app and public web)
**Read access (fixed in 0475, owner go 2026-10-28):** `lots_bidder_read_published` (0181) listed only scheduled/live/won/unsold/relisted, so a `refunded` lot would have vanished for every bidder, the buyer included: My Bids (`lots!inner` join) drops the win, invoice and pickup lines lose their title, auction results drop the lot. 0475 adds `refunded` to that policy, nothing else. Proof: `rls.sql` (12 cases) and `supabase176.sh`.

| Place | Effect |
|---|---|
| `bidder-app` tabs (index, my-bids, notifications, scan, watchlist), `_layout.tsx`, `auction/[id].tsx`, `lib/auction-result-status.ts` | "Won" labels key on `won`. A buyer's refunded win shows as not won (the default label), and their invoice still shows the refund. **Customer-facing:** decide whether My Bids should say "Refunded". Ship any change 09:00–16:00. |
| Public web `(public)/lot/[code]/*`, `final-call/FinalCallClient.tsx`, `profile/_lib/bids.tsx`, `profile/my-bids`, `profile/invoices/[id]`, `profile/notifications` | Same as the bidder app: the default label for an unknown status. |
