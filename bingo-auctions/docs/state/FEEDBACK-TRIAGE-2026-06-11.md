# Tester Recap Triage — 2026-06-11 (Test Auction 0.11)

Source: team-member testing recap + 5 screenshots. Investigated with 5 parallel
read-only agents against `origin/master @ 9a26fbf` in clean worktree
`ap-wt-0611`. This doc = root causes + file:line + batched execution plan.

**Headline:** the "browser works, app shows almost nothing" split was NOT a stale
build — it was a one-row data bug (BinGo `operators.status='pending'`). Several
findings are real code bugs on current master; two are stale-bundle; two need a
Michael product decision; the rest are scoped enhancements.

---

## DONE this session

| ID | Finding | Root cause | Fix | Status |
|----|---------|-----------|-----|--------|
| **APP-VIS** (P0) | Auction not visible in app; app search finds nothing; browser shows it immediately. Uninstall/reinstall no change. My Bids + Winning DO sync. | Bidder app uses the RLS client. Policy `operators_public_read_active` (mig 0002/0133) only lets a bidder read an `operators` row when `status='active'`. The app feed + search embed `operators(...)` and **drop any row whose operator embed is null** (`bidder-app/app/(tabs)/index.tsx:325-332, 804`). BinGo was `status='pending'` (left by `reset-bingo-operator.mjs` during Stripe re-onboarding; never flipped back). Browser uses service-role (RLS-bypassed) → still shows it. My Bids works because it never embeds `operators`. | `UPDATE operators SET status='active' WHERE code='BIN'` via new `scripts/activate-bingo-operator.mjs` (dry-run + `--live`). | ✅ **applied to prod** — verified `status=active`. Apps pick up on next ~25s poll. |

**Latent footgun (do not forget):** ANY operator in `status='pending'` (common
now — Stripe paused, operators sit pre-onboarding) is invisible in both mobile
apps but visible on web. Defensive options for the backlog: (a) make the app
tolerate a null operator embed (render with a fallback operator label instead of
dropping the row), and/or (b) broaden `operators_public_read_active` to expose
`'pending'` operators' public fields. Until then, run `activate-bingo-operator.mjs`
for each test operator.

---

## P0 — real code bugs, ship ASAP (web; no device dependency)

### WEB-RSC — My Bids + Watchlist both "Something went wrong" (Sentry 2003465969, 3797200032)
- **This is a regression from #273.** Adding `'use client'` to `apps/operator-web/src/app/profile/_lib/bids.tsx:21` turned its pure helpers into client-reference proxies. The **server** pages then call them at render time and throw:
  - `profile/my-bids/page.tsx:99` → `classifyBid(...)`
  - `profile/watchlist/page.tsx:73` → `all.filter(isWatchlistRowVisible)`
- #273 fixed the watchlist *data* (`!inner`→LEFT join) but introduced this boundary crash — that's why watchlist STILL errors. My Bids was collateral damage (it imports the same module).
- **Fix (one change resolves both):** move `WatchlistRemoveButton` into its own `'use client'` file and **remove `'use client'` from `bids.tsx`** (restores the #239 architecture; `BidItem`/`WatchlistItem` are plain render fns). Alternative: extract `classifyBid` + `isWatchlistRowVisible` + `CLOSED_STATUSES` + `formatMoney` into a non-client `_lib/bid-helpers.ts`.
- Delivery: operator-web → CF deploy.

### THUMB — broken lot-card thumbnails in browse (full image fine on detail page)
- `apps/operator-web/src/app/(public)/_components/LotCard.tsx:318-324` renders the photo with `next/image <Image>` **without `unoptimized`**, routing through `/_next/image` — which is dead on Cloudflare Workers (`@opennextjs/cloudflare`, no image-resizing binding). Every card thumbnail 404s/500s. The detail page uses raw `<img>` so it works. Same component's *placeholder* branch already has `unoptimized`; this is a lone omission (every other `next/image` in the app sets it).
- **Fix:** add `unoptimized` to the photo `<Image>` (one prop).
- Delivery: operator-web → CF deploy.

### ASSIGN-SQL — Inventory → "Assign to Auction" → `column "status" is of type lot_status but expression is of type text`
- `packages/db/migrations/0135_db_tuning_p1.sql:86` — `bulk_assign_lot_numbers` sets `status = p_status` where `p_status` is declared `TEXT` and `lots.status` is the `lot_status` enum. Postgres won't implicitly coerce a *text-typed value* (vs an untyped literal) into an enum on UPDATE → error.
- Inventory "Assign N" footer (`lotting/inventory/actions.ts:142` → `bulk_assign_lot_numbers`) hits this. The Auction Builder "Add to auction" works because it uses a *different* RPC (`assign_lots_to_auction`) with a literal `status='scheduled'` that coerces fine. (An assign only *appears* to succeed when the selection is all-ineligible → early `{ok:true, assigned:0}` before the RPC.)
- **Fix:** new migration `0201_*` = `CREATE OR REPLACE FUNCTION bulk_assign_lot_numbers(...)` identical to 0135 except line 86 → `status = p_status::lot_status;`. Signature unchanged → TS caller untouched.
- Delivery: migration → apply to prod. (Highest on master = `0200_relist_uuid_ossp_fix.sql`, so this is **0201**. Track B's unmerged draft `0200_single_account_mode` renumbers when/if it merges.)

---

## P1 — real code bugs, staff app (field-mobile; needs OTA and/or fresh build)

### SCANNER-LOOP — "Token not found" storm after "Verify Another Pickup" → force-close
- `apps/field-mobile/app/(staff)/checkout/pickup-verify.tsx:497-504` — the token QR scanner's `onCodeScanned` fires ~10×/sec with only a `busy`/`step` guard; **no per-scan dedup/cooldown** (unlike Quick Lot's `pushHoldConfirm`). After `reset()` re-arms the camera (`:1395`, `:1451`), an in-frame/partial QR re-decodes every frame; failed lookups (`:526`) stack `Alert.alert` modals ~every 100ms → freeze.
- **Fix:** add last-scanned-value + cooldown ref; set a scan-lock synchronously at the top of the callback and clear it only on Alert dismiss; brief post-`reset()` inactive window.

### BIDDER-BLANK — bidder name empty on "2 of 5 — Confirm identity"
- `pickup-verify.tsx:1529` renders `{invoice.bidder_name ?? invoice.bidder_email}`. `??` only falls through on null, so an empty-string `display_name` with empty email → blank label. (Screenshot shows label present, value empty.)
- **Fix:** `{invoice.bidder_name || invoice.bidder_email || 'Bidder (no name on file)'}` (use `||`). Also confirm the actual bidder row isn't all-empty (data check).

---

## P2 — checkout integrity (tester marked CRITICAL; nuanced)

### CHK-QR — "item lot QR won't scan; bin QR validates / toggles items"
- **Partly working-as-designed:** on master, item verification at pickup is done by **scanning the BIN QR**, which must match the lot's expected `bin_id` (`pickup-verify.tsx:957, 965`), then sets the lot `checked:true` (check-only, no toggle). There is **no lot-sticker-scan path** — but the tester *expects* to scan each item's own lot QR.
- The "bin QR wrongly toggles" behavior cannot happen on master (bin must match + check-only) → that part is a **stale pre-W6 bundle** artifact.
- **Decision (see Decisions):** add a lot-QR-to-checkbox verify path (matches tester's mental model — scan the item's sticker to check it off), AND/OR sharpen the on-screen "scan the bin" copy. Recommend adding lot-QR verify.

---

## Stale-bundle items — resolved by fresh builds (NOT code changes)

Master code is current/correct for these; the team's installed TestFlight bundles
predate the fixes. All recent `eas-update` OTA runs succeeded (rtv: staff `0.1.0`,
bidder `0.1.1`), but two cycles of identical "old app" symptoms means we should
**stop trusting OTA reach and cut fresh `eas build`s** so everyone installs a
current native bundle.

- Staff app showing pre-#272 pickup flow.
- Bidder app pickup "Coming Soon" location + "staging workflow" — string lives in `bidder-app/app/pickup/[id].tsx:836,1094`; master is mode-aware. Either stale bundle OR missing data (lot has no staging/intake bin → per-lot "Coming soon"; or `warehouses` address columns blank). Verify the specific lot's `intake_bin_id` + warehouse address.
- **"Completed pickups still appear active"** — NOT yet root-caused (Rule 1: needs a look at the bidder-app active-pickups query filter). Likely a status filter gap; investigate before claiming fixed.

**Action:** dispatch `eas-build.yml` for staff + bidder (preview channel → TestFlight), carrying P1 fixes natively. Confirm exact installed build via ASC before/after.

---

## Decisions needed (Michael)

1. **Refund permissions / staff logins.** Today: per-lot refund gate = role ∈ {admin, manager} (`api/invoices/[id]/refund-items/route.ts:135`); out-of-window = super-admin only (`:212`). Tester asks: can managers/cashiers refund? Shared vs individual staff logins? (Individual logins are a prerequisite for a real role matrix + audit/accountability.)
2. **Auction preview visibility.** Scheduled-auction lots currently show publicly with live-looking countdowns + a mounted bid widget (`lot/[code]/page.tsx:694, 955`), confusing bidders. Options:
   - **A** — hide scheduled lots entirely (kills upcoming-auction discovery + pre-bid watchlisting).
   - **B (recommended)** — keep the auction visible as "Upcoming" but gate the countdown + bid widget on `live`/`now()>=starts_at`; scheduled lots show "Bidding opens {time}". Touches `(public)/browse/page.tsx`, `page.tsx`, `auction/[id]/page.tsx`, `lot/[code]/page.tsx` + the bidder-app mirror `(tabs)/index.tsx`.
3. **CHK-QR** — add lot-sticker scan verification (recommended) or just clarify the bin-scan UX?

---

## Backlog (scoped, not blocking)

| ID | Item | Scope |
|----|------|-------|
| BIN-SEARCH-1 | Inventory tab: search by bin location | resolve typed bin code → bin ids → `.in('intake_bin_id', …)`. `lotting/inventory/page.tsx`, ~1 file |
| BIN-SEARCH-2 | Auction Builder: search by bin location | add `intake_bin_id`+bin code to `builder/page.tsx` query/type + `AuctionBuilder.tsx:119` haystack. ~2 files |
| BIN-SEARCH-3 | Staff iPad: scan bin QR → list its contents | new `(staff)/layout/bins/contents.tsx`: resolve bin by qr_token → lots by `intake_bin_id` (+auction). ~2-3 files, no migration |
| WATCHLIST-BULK | Bidder watchlist: remove-all-closed / multi-select | bidder app; web watchlist also |
| BIN-QR-PRINT | "Dashboard wants to print all" | per-bin print already exists (`warehouses/[id]/bins/BinsTable.tsx:247-395`); setup-hub "QR labels" step links to print-all GET (`warehouses/[id]/page.tsx:123`). Point it at the Bins page. ~1 file. (operator-web is current on prod, so this is the real cause, not a stale deploy.) |
| OP-VIS-DEFENSE | App tolerate null operator embed OR RLS expose pending operators | prevents the APP-VIS footgun recurring |
| PICKUP-SYNC | "Completed pickups still active" — investigate bidder active-pickups query | TBD after investigation |

---

## Proposed execution batches

- **Batch 1 (web P0):** WEB-RSC + THUMB → one operator-web PR → CF deploy. Restores My Bids, Watchlist, all browse thumbnails.
- **Batch 2 (SQL P0):** ASSIGN-SQL → migration 0201 → apply to prod. Unblocks Inventory→Assign.
- **Batch 3 (staff P1):** SCANNER-LOOP + BIDDER-BLANK (+ CHK-QR lot-scan if approved) → field-mobile PR.
- **Batch 4 (mobile delivery):** fresh `eas build` staff + bidder → TestFlight. Clears all stale-bundle symptoms + carries Batch 3.
- **Batch 5 (decision-gated):** preview-visibility (A/B) + refund-roles, after Michael decides.
- **Backlog:** as above.
