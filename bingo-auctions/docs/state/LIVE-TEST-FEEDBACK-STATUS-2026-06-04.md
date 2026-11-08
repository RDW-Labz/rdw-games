# Live-Test Feedback — Fixed vs Not (verified 2026-06-04)

Cross-reference of the team's 2026-06-03 ClovrBid testing feedback against the **actual
code on `origin/master`** (HEAD `8a75836`). Each item was verified by reading the real
implementation + an adversarial skeptic pass (18-agent workflow). Plan-of-record was
`docs/plans/PATCH-live-test-feedback-2026-06-03.md` (+ red-team `docs/audits/redteam-plans-2026-06-03.md`).

## Tally
- **FIXED: 18** · **Already-working / non-bug: 4** · **PARTIAL: 1** · **NOT FIXED: 3**

## ⚠️ Must-know (read these first)
1. **C1 "remove staging" + C2 "remove pickup time slots" → NOT done, and they CONTRADICT yesterday's shipped design.** Yesterday's plan deliberately *kept* staging (item H3: "do NOT remove — it collides with the membership **stage & prep** perk") and only added clarifying copy to the pickup-slot screen (M5). So this is a **direction reversal that also touches a paid membership feature** — a product decision, not a quick fix.
2. **B7 (Available/Unsold/Unpicked-Up filters during auction building) is PARTIAL.** The 3-way split exists for *viewing* on the inventory page, but you still **cannot selectively ADD** Unsold/Unpicked-Up lots while building an auction (the builder + assign RPC only accept `in_inventory`). Carryover re-enters only via relist/cron.
3. **D1 (product-identification accuracy) → NOT done** — the AI recognition pipeline is byte-identical to pre-test; it wasn't in yesterday's plan (separate backlog).
4. **A2 has a web-only bug (newly found):** the native app correctly shows "you're winning," but the **web** bid widget tells a bidder "You're the highest bidder" even on a proxy-outbid (it doesn't compare `current_leader_id`). Real false-positive.
5. **Three "FIXED" items need a one-time prod/runtime step to actually take effect** (code is correct, data/rollout isn't automatic) — see Runtime caveats.

## Bidder / Web app
| # | Item | Status | Evidence / What's left |
|---|---|---|---|
| A1 | "Tested" condition on listings | ✅ FIXED | `lot_condition` enum has no `tested`; importer maps "TESTED"→`good` (0062); web LotCard `good→'GOOD'` + dead `tested` row removed (2782394). *Left:* a dead "Tested" **filter pill** still exists (always 0 results) — separate, optional cleanup. |
| A2 | Winning-bid visibility | ✅ FIXED (native) / ⚠️ web bug | Native: sticky green "✓ You're the high bidder" banner, optimistic from `current_leader_id`, proxy-outbid guarded (`lot/[id].tsx`, `PlaceBidSheet`). **Web `BidWidget` falsely toasts "highest bidder" on proxy-outbid** — needs the same `current_leader_id===me` guard. |
| A3 | Expired demo auction still "Upcoming" (web) | ✅ FIXED | `browse/page.tsx` excludes `operators.is_demo` in all 5 storefront loaders; seed sets `is_demo`+`is_reviewer`; RLS 0181 for mobile. *Runtime:* seed must have run in prod + 60s cache cycle. |
| A4 | Category filter returns nothing (mobile) | ✅ FIXED | Root cause: `bulk_import_lots` never set `category_id` → fixed forward in mig **0178** + reader matches parent/children. *Runtime:* `backfill-lot-categories.mjs --live` must run to fix already-imported NULL rows. |
| A5 | No countdown on web item-detail | ✅ FIXED | `lot/[code]/page.tsx` renders `<LotCountdown>` from `lot.close_at`, 1 Hz, null-guarded (2782394). |
| A6 | Bid extension (<3 min extends) | ✅ WORKING | `place_bid` (0176) soft-close: `now()+soft_close_minutes` (default 3) extends + flags `was_extended`. No regression. |
| A7 | Clover Rush | ✅ WORKING | `(public)/clovrrush/*` 2-min window single source of truth + realtime reconcile + 15s re-poll. |

## Post-auction / unsold / auction-building
| # | Item | Status | Evidence / What's left |
|---|---|---|---|
| B1 | Closed auction still shown ~1 min after close | ✅ WORKING (non-bug) | Expected `advance_auction_lifecycle` 60s cron cadence (documented L2). No storefront query treats it as live. |
| B2 | Mobile auction status inconsistent post-close | ✅ WORKING (non-bug) | Same 60s lag; every mobile query is `status` + `close_at`-scoped; elapsed-scheduled badge now reads "ENDED" (2782394). |
| B3 | Closed lots still in web Browse | ✅ FIXED | `browse` lots query + facet counts now carry `status IN(scheduled,live)` + `close_at>now||null` (M2, 2782394). |
| B4 | Unsold auto carry-forward w/o review | ✅ FIXED | mig **0180** `operators.auto_relist_mode` (auto/review/off); cron mints only for `auto`; new operators default `review`. *Caveat below.* |
| B5 | Unpicked-up items same review path | ✅ FIXED | No-show cron routes won→`unsold` (0183) → same 0180 gate + `/worklist` forfeited bucket + relist/pull/dispose actions. |
| B6 | Manual lot selection when building | ✅ FIXED | Full Auction Builder: per-lot checkboxes, search/sort/category, "Add N as #x-#y" → `assign_lots_to_auction` (a1ecbc3). |
| B7 | Available/Unsold/Unpicked-Up filters **during creation** | 🟡 PARTIAL | 3-way split exists on the **inventory page** for viewing, but builder + assign RPC only accept `in_inventory` → can't selectively *add* unsold/unpicked-up while building (Part 2 of M7, not done). |
| B8 | Count discrepancy (100→107) | ✅ FIXED | Root cause gated by 0180 `review` mode + **provenance strip** on auction detail shows Newly/Carried/Forfeited split. *Caveat below.* |
| B9 | Pre-publish reporting (new vs unsold vs unpicked) | ✅ FIXED | Provenance breakdown on `auctions/[id]/page.tsx` via `relisted_from_lot_id` + no-show join (labels: Newly-added / Carried-over / Forfeited-return). |
| B10 | Re-list lot-number clarity | ✅ FIXED | Always mints a NEW code; relist surfaces show "mints a new lot code (was {code})" + post-relist "Created X (was Y)" (a1ecbc3). |

## Pickup & checkout
| # | Item | Status | Evidence / What's left |
|---|---|---|---|
| C1 | Remove staging workflow | ❌ NOT FIXED | Staging fully intact (staff `stage.tsx`, `bin_assignments`, bidder staged badges). Yesterday's H3 deliberately kept it; the membership **stage & prep** perk now depends on it. **Product decision / reversal.** |
| C2 | Remove pickup time slots | ❌ NOT FIXED | `PickupScheduler` slot picker still rendered (counter + staff-assisted); operator pickup-hours slot editor still live; slot RPCs/columns intact. M5 only added copy. Needs removal + a migration. |
| C3 | Wrong location (lock codes) on checkout | ✅ FIXED | No "lock code" namespace exists (tester's phrasing); checkout now reads `lots.intake_bin_id→bins.code` (944e1b8) — same as inventory. Pre-fix it read only the null staging bin. |
| C4 | Checkout shows put-away location | ✅ FIXED | Staff checkout + bidder pickup + inventory dashboard all read the same `intake_bin_id→code`. *Minor:* checkout shows bare bin code; dashboard adds aisle/bay. |
| C5 | Location mapping disconnect | ✅ FIXED | Closed at data source; bidder RLS verified to allow reading the put-away bin for unstaged counter-pickup lots. |

## Lotting & inventory
| # | Item | Status | Evidence / What's left |
|---|---|---|---|
| D1 | Product-ID accuracy (pallet → 2 correct) | ❌ NOT FIXED | `domain-lotting` recognition/lookup is byte-identical to pre-test; nothing landed after the live test; not in yesterday's plan. Open backlog. |
| D2 | iPad photo blocked without flash | ✅ FIXED | `safeFlash()` degrades to `'off'` across 7 capture sites + hides the flash control on no-flash devices (PR #171, OTA). |
| D3 | QR "assigned" but "does not exist" at put-away | ✅ FIXED | Was a put-away **resolver** gap, not a save failure: `single.tsx` added the `sticker_code` lane + server `_find_lot_by_scan` probes `qr_token`+`sticker_code` (0160). *Cosmetic:* batch list lacks a sticker_code name-preview branch (commit still succeeds). |
| D4 | QR put-away validation (attached/searchable/locatable) | ✅ FIXED | All three confirmed; covered by `intake_lot_to_bin.regression.test.ts` T2/T3 (gated behind `INTAKE_LOT_REGRESSION=1`). |

## Runtime caveats (code is correct; these are one-time data/rollout steps)
- **A4 category filter:** run `node scripts/backfill-lot-categories.mjs --live` so *already-imported* lots get a `category_id` (new imports are fixed by code).
- **A3 demo-auction hide:** confirm the app-reviewer seed actually ran in prod (`operators.is_demo=TRUE`) and the 60s storefront cache cycled.
- **B4 / B5 / B8 carryover review:** mig 0180 backfilled **all existing operators (incl. the live-test one) to `auto_relist_mode='auto'`**, so they **still auto-carry** until an admin switches to **Review** in Settings → Auto-relist. Only *new* operators default to Review.

## Recommended next actions
1. **Decide staging/slots (C1+C2):** these reverse yesterday's design and touch the paid stage-&-prep perk. Confirm the intent before any code change.
2. **Finish B7 Part 2:** make the builder/bulk-assign source-aware so Unsold/Unpicked-Up are selectable during auction creation.
3. **Fix A2 web false-positive** (proxy-outbid "highest bidder" toast) in `BidWidget.tsx`.
4. **Run the A4 backfill + flip the live-test operator to Review** (B4) so the test environment matches the new behavior.
5. **D1 product-ID accuracy:** scope as its own task (prompt/escalation/lookup-catalog work).
