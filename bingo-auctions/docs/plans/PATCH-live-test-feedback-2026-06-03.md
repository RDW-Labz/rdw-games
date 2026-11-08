# PATCH PLAN — Live-Test Feedback (Harrison, 2026-06-03)

**Status:** 🟡 DRAFT FOR REVIEW — no implementation until approved (red-team stress test to follow)
**Source:** Operator live test (Harrison, AR warehouse, Wed Jun 3) + 4 read-only investigation lanes against `master` ≈ deployed prod.
**Companion doc:** `docs/plans/PLAN-operator-memberships-2026-06-03.md` (PR #189) — overlaps flagged throughout.

---

## 0. TL;DR

Tester reported ~15 items. After verifying each against code (not taking feedback as concrete), the real picture:

- **4 HIGH** — 1 catalog-wide data bug, 1 operator-control gap (the "100→107" auto-carry), 1 pickup-location bug, 1 stale demo-data issue.
- **9 MEDIUM** — contained UI/query/copy fixes + the inventory-review design cluster.
- **5 LOW / defensive / policy.**
- **1 NON-BUG** (closed-auction "still active at 10:51" = expected reconciliation lag).
- **2 VERIFIED WORKING** — bid-extension (<3 min) ✅ and Clover Rush ✅ (red-team must confirm no regression).
- **✅ Regression all-clear:** none of the closed/expired-auction complaints are caused by this session's "Recently closed" / `close_at→ends_at` work. That work is correct; a codebase grep for `auction.close_at` returns zero hits.

**Biggest wins, fastest:** the category filter (H1) and "Tested" label (M1) are catalog-wide customer-facing bugs with *tiny* fixes (one a data backfill, one a one-line label). The auto-carry review gate (H2) is the operator's top ask and is a clean, additive change.

---

## 1. Master triage

| ID | Issue | Sev | Type | Effort | Membership/fulfillment overlap |
|----|-------|-----|------|--------|-------------------------------|
| **H1** | Category filter returns nothing (mobile **+ web**) — migrated lots have `category_id = NULL` | HIGH | **Data** | M (backfill) | — |
| **H2** | Unsold **+** unpicked-up lots auto-carry into next auction, no review gate ("100→107") | HIGH | Design + migration | L | Perk 1/2 change *when* a lot becomes relistable |
| **H3** | Pickup screen shows "Coming soon" not item location (reads staging, not put-away bin) | HIGH | Code (mobile+staff) + RLS | M | Must NOT write `bin_assignments` (collides w/ "stage & prep" perk) |
| **H4** | Demo auction "ClovrBid Demo … App Review" stuck "Upcoming", opens 5/26 | HIGH | **Data** (+ seed fix) | S | seed script also flagged in membership plan §9 |
| **M1** | "Tested" condition shown on furniture | MED | Code (1-line, web) | XS | — |
| **M2** | Closed lots still in web `/browse?view=lots` | MED | Code (query) | S | — |
| **M3** | Winning-bid indicator laggy after placing bid | MED | Code (mobile) | S | — |
| **M4** | No countdown on web item-detail page | MED | Code (web) | S | adjacent to `close_at→ends_at`, NOT caused by it |
| **M5** | counter_pickup: no "staff scans your QR to finish" clarity | MED | Copy | XS | fulfillment pickup_mode |
| **M6** | Bidder can't find refund/return entry (dispute link only on staged lots) | MED | Code/UX | S–M | refunds on destination charges (membership §6) |
| **M7** | No Available / Unsold / Unpicked-Up inventory filters; builder can't see carryover | MED | Design + code | M | shares the Unpicked deadline w/ Perk 1/2 |
| **M8** | Auction count has no provenance split (newly-added vs carried-over) | MED | Code | S | — |
| **M9** | Worklist is read-only; cron drains it before staff can act | MED | Code | M | pairs with H2 review mode |
| **L1** | Mobile badge says "UPCOMING" for an elapsed `scheduled` auction | LOW | Code (guard) | XS | — |
| **L2** | Closed auction visible ~1 min after close | NON-BUG | Document | — | expected 60s cron + 10-min grace |
| **L3** | Relist lot-code: new vs reused? | POLICY | Decision + label | XS | — |
| **L4** | Lots can be inserted with `close_at = NULL` → auction never closes | LOW | Migration guard | S | root cause of H4 |
| **L5** | Mobile `/auction/[id]` results lot query has no status filter | LOW | Code (defensive) | XS | new screen this session |

---

## 2. Bundles & sequencing (lowest-risk first)

### Bundle A — Data fixes (no/low code, highest impact) — **do first**
- **H1 category backfill**, **H4 demo auction**. Data ops → dry-run → inspect → `--live` → re-inspect (CLAUDE.md money/data rule). No app deploy needed for H1's data fix.

### Bundle B — Quick frontend fixes (low-risk, ship fast)
- **M1** "Tested"→"Good", **M2** web browse filter, **M4** web detail countdown, **M3** winning banner, **M5** counter copy, **L1** badge guard. All small, isolated, no schema.

### Bundle C — Pickup / fulfillment (medium; coordinate with membership "stage & prep")
- **H3** pickup location, **M6** refund discoverability.

### Bundle D — Inventory-carryover review (the operator's top ask; coordinate with membership grace/pickup perks)
- **H2** review gate, **M7** inventory filters + source-aware builder, **M9** actionable worklist, **M8** provenance count, **L3** relist-code label.

### Bundle E — Defensive hardening (fold into the above or a small standalone PR)
- **L4** `close_at` NOT-NULL-on-attach guard, **L5** mobile results status guard, **L2** document the close lag.

---

## 3. Detail — HIGH

### H1 · Category filter returns nothing (mobile + web) — DATA
- **Root cause:** migrated BidFTA lots have `lots.category_id = NULL`. Their categories are numeric-prefixed ("6400 home decor"); `resolve_category_id()` (`0033_migration_tracking_and_resolver.sql:90,108-118`) does word-substring alias matching against a Lowe's/Wayfair-tuned `category_aliases` seed and returns NULL on no-match → intake writes NULL (`0059_manifest_intake_unified.sql:294`). The mobile filter `query.in('category_id', ids)` (`apps/bidder-app/app/(tabs)/index.tsx:661-664`) and web (`browse/page.tsx:223,377`) then match nothing; "All" works because it skips the predicate.
- **Confirm first (one query):** `select count(*) total, count(category_id) with_cat from lots where status in ('scheduled','live');` — expect `with_cat ≪ total`.
- **Fix:** backfill `lots.category_id` — (1) seed BidFTA-vocabulary `category_aliases` (numeric-prefixed) + re-run `resolve_category_ids_batch` over migrated rows [deterministic, fast], then (2) AI classifier for stragglers. Fixes **both** platforms at once (same column).
- 🛑 **Don't break:** dry-run the backfill; re-test web `/browse` + `/category/[slug]` and mobile chips. No app-code change required.

### H2 · Auto-carry of unsold + unpicked-up, no review gate ("100→107") — DESIGN
- **Root cause:** `auto_relist_unsold_lots()` (`0097_auto_relist.sql:218`, pg_cron every 10 min) mints `unsold` lots **directly into the next draft/scheduled auction** as `status='draft'`, bypassing the builder's `in_inventory` pool. `auto_relist_enabled DEFAULT TRUE` (`0097:35`). Both no-show/forfeit (`auto_mark_pickup_no_show` → `won→unsold`, `0166:133`) and grace-expiry (`grace-expiry.ts:159` → `unsold`) feed the same pipe. Auction detail (`auctions/[id]/page.tsx:105-154`) shows a total with no carryover provenance → the 100→107 surprise.
- **Fix (lowest blast radius):** add operator setting **`auto_relist_mode ∈ {auto, review, off}`** (extend `operators` + `settings/AutoRelistForm.tsx` + `saveAutoRelistSettings`). In `review`, the cron leaves lots in `unsold` and surfaces them in an actionable queue (M9) instead of minting. Relist then happens on staff click via the existing safe `relistLot` action (`lots/[id]/actions.ts:250`).
- 🛑 **Don't break:** ONLY gate the *consumer* (`auto_relist_unsold_lots`, additive branch on the existing `auto_relist_enabled` gate). Do NOT touch the *producers* — `finalize_scheduled_no_bid_lots` (0129), the no-show lot-routing (0166), grace-expiry lot-routing — they correctly land lots in `unsold`.
- 🔗 **Membership overlap:** Perk 1 (extended pickup) + Perk 2 (extra grace) change *when* a won lot becomes `no_show`/`unsold`→relistable. The Unpicked-Up queue/filter must read the **same per-bidder deadline** the crons use (compute in the cron, never read a fixed window). Reconcile with PLAN §7.

### H3 · Pickup "Coming soon" instead of item location — CODE + RLS
- **Root cause:** `apps/bidder-app/app/pickup/[id].tsx` derives item location ONLY from checkout-time staging (`bin_assignments`, query `:276-277`; "Coming soon" at `:978` when `status==='unstaged'`). Harrison runs **`counter_pickup`** ("collect from shelves") where staff never stage → every lot is permanently location-less. The lot's *actual* physical location is `lots.intake_bin_id` (set at put-away/intake, `0142_split_intake_rpcs.sql:160`) — which the screen never reads.
- **Fix (read-path only):** extend the invoice/lots query to fetch `lots.intake_bin_id` + joined `bins(code,…)`; fall back `bin_code = bin_assignments.bins.code ?? intake_bin's code`. Mode-aware copy: counter/self-serve shows the storage bin immediately ("On shelf B-04 — collect it"); reserve "Coming soon" for `staff_assisted`. Apply the same fallback to staff `pickup-verify.tsx:384-399`.
- 🛑 **Don't break / critical:** **Do NOT fix this by writing `bin_assignments` rows** — that collides with the membership "stage & prep" perk (which proactively writes `staged` rows) and the `'unstaged'` enum convention (no such enum value; "no row" = unstaged). This is a **read** change only.
- 🛑 **RLS check:** confirm bidders can read `lots.intake_bin_id` + the `bins` row for their won lots (today `bins` is read filtered by `warehouse_id`, `:236`). If `bins` RLS is operator-scoped, add a bidder/anon read policy mirroring the floor-plan grants — verify before shipping.
- 🔗 **Membership overlap:** PLAN §7-Perk3 / §13 already document the staging-vs-storage distinction; coordinate so the location read-path and the stage&prep write-path stay distinct.

### H4 · Demo auction stuck "Upcoming" (opens 5/26) — DATA (+ seed fix)
- **Root cause:** `scripts/seed-app-reviewer-fixtures.mjs` inserts the demo auction `status='scheduled'`, `starts_at=now()`, `ends_at=now()+30d`, and lots **without `close_at`** (`:257-294`). NULL `close_at` makes the lots invisible to `open_due_lots`/`finalize_*` crons → no lot ever opens/closes → `advance_auction_lifecycle` never promotes the auction → it shows "Upcoming" forever with the *seed-time* `starts_at` (~5/26). It was previously slated for hard-delete (`docs/state/PATCH-browse-launch-blockers-2026-05-26.md:75-108`).
- ⚠️ **DECISION (see §5):** Apple reviewers *need* a working demo auction, so a blind hard-delete is risky while review is active.
- **Fix:** per the decision — either (b) fix the seed to set `lots.close_at` + a rolling future window so it presents coherently, or (c) keep the demo operator out of the *public* storefront (visible only to reviewer accounts). Plus **L4** guard so attached lots can never have NULL `close_at` again.

---

## 4. Detail — MEDIUM / LOW

| ID | Root cause (file:line) | Fix | Don't-break |
|----|------------------------|-----|-------------|
| **M1** | Web `LotCard.tsx:101` maps enum `good → 'TESTED'` (+ dead `tested:` row `:96`). Mobile already maps `good→'GOOD'`. Enum can't hold "tested". | `good: 'GOOD'`; delete dead `tested:` row | Grep Maestro/e2e for a "TESTED" pill assertion + browse-audit doc |
| **M2** | Web `browse/page.tsx:374-381` `loadLots` (+ `fetchStorefrontLotCounts :221`) lacks the lot-status + `close_at>now` filters mobile/home have | add `.in('status',['scheduled','live'])` + `.or('close_at.gt.${now},close_at.is.null')` | match mobile exactly (`(tabs)/index.tsx:643-645`) |
| **M3** | `lot/[id].tsx:1807` `onPlaced` discards RPC `current_leader_id`; banner waits for realtime echo | consume result → optimistic `setLot({winner_bidder_id})` | don't unconditionally green-banner (prior fixed bug); update `prevWinnerRef` to avoid spurious haptic; proxy-outbid stays correct |
| **M4** | `LotCountdown` rendered only on cards, never on `/lot/[code]` (static timestamps `:691,894`; `BidWidget.tsx:312`) | add `LotCountdown` island to detail (lot `close_at`) | guard `close_at` null for scheduled lots; **NOT a `close_at→ends_at` regression** (lots still use `close_at`) |
| **M5** | counter_pickup branch (`pickup/[id].tsx:512`) renders QR + slots but no completion CTA/explanation | add copy: "Show this QR at the counter — staff scan it to complete. No app action needed." | copy-only |
| **M6** | "Report a problem"/dispute link only on `staged`/`picked_up` lots (`pickup/[id].tsx:980`) → never shows in counter_pickup; no bidder refund-request UI by design | surface dispute/refund entry on bidder invoice screen gated by `refund_window_post_pickup_hours` (already fetched) | a *true* bidder refund queue = larger (new `refund_jobs` producer + RLS + destination-charge `reverse_transfer`/`refund_application_fee`) → see decision §5 |
| **M7** | Inventory page buckets are intake-axis (In auction/In inventory/Not put away, `lotting/inventory/page.tsx:74`); no sell-axis filters; builder/`assign_lots_to_auction` filter strictly `in_inventory` (`0030:112`) | add Available/Unsold/Unpicked-Up filters; make builder source-aware (loosen status guard or route via `relist_lot_into_auction`) | the status-guard loosening is the trickiest regression point — gate carefully |
| **M8** | `auctions/[id]/page.tsx:105-154` total count, no provenance | split Newly-added / Carried-over / Forfeited-return via `relisted_from_lot_id` (non-null = carried) + pickup join; show on builder commit too | — |
| **M9** | `/worklist` is read-only (`page.tsx:50`); cron drains it every 10 min | add inline Relist-into-[auction]/Pull/Dispose (`relistLot`, `mark_lot_disposed` exist); pair with H2 `review` mode | only useful WITH H2 (else cron empties it) |
| **L1** | Mobile badge `status==='live'?'LIVE':'UPCOMING'` (`(tabs)/index.tsx:1681`), no past-`ends_at` guard | treat `scheduled` + `COALESCE(last_lot_ends_at,ends_at)<now` as not-Upcoming | mostly resolved by fixing H4 data |
| **L2** | `advance_auction_lifecycle` 60s cadence + 10-min grace branch (`0174:96`); per-lot finalize is 5s | **NON-BUG** — document expected lag; optionally tighten cadence | don't over-tighten (cron cost) |
| **L3** | `relist_lot_into_auction` always mints new code via `next_lot_code` (`0097:153`) | **keep always-new** (protects invoice/bid FK lineage); add "will create CLR-00XXX (was CLR-00YYY)" label | reusing the old code breaks `invoice_lots` FK design — push back |
| **L4** | `lots.close_at` nullable since `0021:93`; seed exploits it → stuck auctions | migration: forbid NULL `close_at` for lots with non-null `auction_id` (or default from `auction.ends_at` on attach) | additive CHECK/trigger; verify no legitimate NULL-on-attach path |
| **L5** | Mobile `auction/[id].tsx:210-217` results query: `auction_id` + `deleted_at` only, no status filter | add status filter (safe today — only reached from closed rail — but defensive) | new screen this session |

**Verified working (red-team must confirm no regression):** ✅ bid-extension (<3 min remaining extends close time) · ✅ Clover Rush time-based behavior.

---

## 5. Decisions for you (before implementation)

1. **Demo auction (H4)** — Apple reviewers need it; real users shouldn't see a stuck/broken one. **(a)** hard-delete from prod (risky during active review), **(b)** fix seed → coherent rolling-window upcoming auction, **(c)** keep the demo operator out of the *public* storefront (reviewer-only). **Recommend (c)** (or (b) if simpler short-term).
2. **Auto-relist default mode (H2)** — should new operators default to `auto`, `review`, or `off`? **Recommend `review`** (matches your "manual control" goal); at minimum set the first operator to `review`.
3. **Relist lot-code (L3)** — keep **always-new** (recommended; protects lineage) vs reuse old code (breaks FK design). Confirm.
4. **Refund scope (M6)** — start by **surfacing the existing dispute flow** more broadly (small), or build a true bidder refund-request queue now (larger; touches destination-charge refunds — coordinate with membership §6)? **Recommend dispute-surface first.**
5. **Category backfill method (H1)** — alias-seed + resolver re-run (deterministic) first, AI classifier for stragglers? **Recommend yes (both, in that order).**

---

## 6. Cross-cutting overlaps with the Memberships plan (PR #189)

- **H3 ↔ "stage & prep" perk:** location fix is a *read* of `intake_bin_id`; the perk is a *write* of `staged` `bin_assignments`. Keep distinct — don't let the location fix create staging rows.
- **H2/M7/M9 ↔ Perk 1 (extended pickup) + Perk 2 (extra grace):** these perks move the no-show/grace deadline per-bidder, which changes *when* a lot becomes relistable. The Unpicked-Up queue/filter must read the same per-bidder deadline the crons compute (PLAN §7 guardrails: compute in cron, never write `auctions.pickup_ends_at`).
- **§13 shipping landmine (reconfirmed by Lane 3):** `auto_mark_pickup_no_show` has no `fulfillment_method='pickup'` filter — before shipping launches, add it or paid ship-orders get no-show'd + relisted. Track in the shipping epic.
- **Seed script (H4):** the membership plan §9 already lists `seed-app-reviewer-fixtures.mjs` for update — fold the `close_at` fix into that same edit.

---

## 7. Next step
Red-team stress test across **this patch plan + the memberships plan together** (Stripe/money, migration safety, RLS, cron regressions, the H3 RLS gap, the H2 producer/consumer split). Then implement bundle-by-bundle, lowest-risk first, dry-running every data op.

---

## Appendix — file:line index
**Pickup/location/refund:** `apps/bidder-app/app/pickup/[id].tsx:140-156,276-302,512,588,904,971-979`; staff `apps/field-mobile/app/(staff)/checkout/pickup-verify.tsx:384-399`; `stage.tsx:151-159`; `put-away/single.tsx`; intake `packages/db/migrations/0142_split_intake_rpcs.sql:160`; `0165_pickup_mode_taxonomy.sql:62-171`; refund `0159_refund_jobs.sql`, `api/invoices/[id]/refund-items/route.ts`; dispute `apps/bidder-app/app/dispute/new.tsx`.
**Lifecycle:** crons `0125_open_due_lots.sql`, `0129_finalize_scheduled_no_bid.sql`, `0174_auction_draft_lot_close.sql:34-127`; web `(public)/browse/page.tsx:101-167,374-381`; `(public)/auction/[id]/page.tsx:170`; mobile `(tabs)/index.tsx:296-300,643-645,1635-1681`; `auction/[id].tsx:210-217,266`; seed `scripts/seed-app-reviewer-fixtures.mjs:229-294`.
**Carryover:** `0097_auto_relist.sql:35,106,153,218`, `0146_lots_disposal_flag.sql`; `auto_mark_pickup_no_show` `0166_pickup_forfeit.sql:133`; `grace-expiry.ts:159`; builder `(operator)/auctions/[id]/builder/{AuctionBuilder.tsx,actions.ts}`; assign `0030_auction_stagger_and_assign_rpc.sql:112`; inventory `(operator)/lotting/inventory/page.tsx:74-182`; worklist `(operator)/worklist/page.tsx`; relist `(operator)/lots/[id]/actions.ts:250`; settings `(operator)/settings/AutoRelistForm.tsx`.
**Display bugs:** web `(public)/_components/LotCard.tsx:96,101`; mobile `packages/domain-bidding/src/components/LotCard.tsx:99,108`; condition enum `0001_init.sql:23,202`; normalizer `0062_intake_condition_normalize.sql:64-67`; winning banner `apps/bidder-app/app/lot/[id].tsx:1270,1431,1807` + `PlaceBidSheet.tsx:226,248`; category resolver `0033_migration_tracking_and_resolver.sql:90,118` + filter `(tabs)/index.tsx:661-664`; countdown `(public)/_components/LotCountdown.tsx` + `(public)/lot/[code]/page.tsx`.
