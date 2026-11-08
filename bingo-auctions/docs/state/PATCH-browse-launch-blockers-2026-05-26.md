# Update Patch — Bidder Browse Launch Blockers (2026-05-26)

Self-contained handoff for a fresh session. Derived from a read-only UI/UX
audit of the bidder browse experience (web + native) benchmarked against
mac.bid and nellis. Goal: bidders can browse auctions as easily as those
competitors before launch. **No code or prod changes have been made yet —
this patch is the spec to execute.**

Backing audit (chat-only, not persisted): native + web browse agents +
competitor capture. The pre-existing `docs/audits/ui-ux-cross-platform-audit-2026-05-23-browser.md`
is the older baseline.

## Ship order

- **PR 1 — no data dependency, ship first:** Blocker 1 (lots-first landing) + Blocker 2 (live grid).
- **PR 2 — linked, both touch warehouse/city path:** Blocker 3 (location filter) + Demo-data hard-delete.
- **Adjacent (separate workstream, NOT in these PRs):** operator-onboarding config wizard.

---

## Blocker 1 — Lots-first landing

Bidder must see buyable lots immediately (mac.bid/nellis both dump you into the lot firehose). Today web defaults to the Auctions tab and native buries the grid under ~5 promo sections.

### Web
- **File:** `apps/operator-web/src/app/(public)/browse/page.tsx`
- `isLotsMode()` (line ~465) returns `false` with no params → Auctions is the default. Flip default to Lots, keep Auctions reachable via `?view=auctions`:
  - Add as first clause: `if (sp.view === 'auctions') return false;`
  - Then keep existing truthy triggers; final fallthrough returns `true`.
- Update stale subhead "Browse anywhere; bid in the app" (~line 678).
- Confirm `BrowseHeader` toggle highlights Lots when defaulted.
- **Effort:** S · **Risk:** low.

### Native (DECISION LOCKED: full reorder)
- **File:** `apps/bidder-app/app/(tabs)/index.tsx` — home + grid are ONE FlatList. Promo header = `HomeTabHeader` (lines ~1204-1289) wired as `ListHeaderComponent` (~line 1043); grid data = lots (~1022-1038).
- Reorder so the lot grid sits directly under **Hero + CategoryGrid + the search/sort/filter bar**. Move `RecentWinsRail`, the 3 `SectionBanner`s, and "Recently viewed" into a `ListFooterComponent` (below the grid). Marketing stays; it stops blocking inventory.
- **Effort:** M · **Risk:** low-med (visual reshuffle).

---

## Blocker 2 — Live grid

### Web (countdown is FROZEN — the real problem)
- **File:** `apps/operator-web/src/app/(public)/_components/LotCard.tsx` — server component; `CountdownPill` + footer time use SSR `Date.now()` (line ~382), rendered at line ~449. Seconds never move on `/browse`, `/category`, `/clovrrush`.
- Extract a new `'use client'` component `LotCountdown.tsx` taking `closeAt`, ticking via `useState` + `setInterval(1000)`, reusing the existing `formatSegmentedTime` logic. LotCard stays a server component and renders `<LotCountdown closeAt={lot.close_at} />` at line ~449. Only the pill becomes a client island (minimal JS/card).
- **Price/bid_count staleness (same tier, optional):** add a 30s `router.refresh()` on the lots view — copy the pattern already in `apps/operator-web/src/app/(public)/clovrrush/ClovrRushClient.tsx:252-259`.
- **Effort:** S-M · **Risk:** low.

### Native (timers ALREADY tick — only data is stale)
- The 1Hz countdown already works: `setNow(Date.now())` at `index.tsx:605-608` fans out to all cards. Do NOT rebuild the countdown.
- Gap is stale price/bid_count: `load()` (lines ~476-598) runs once on focus, no re-poll.
- Add focused polling: `setInterval(() => load(), 25000)` inside a `useFocusEffect` so it only runs while the Browse tab is visible (battery-safe). Lot-detail keeps its websocket; the grid uses cheap polling.
- **Effort:** S · **Risk:** low.

---

## Blocker 3 — Location / pickup filter

**Data model (verified):** `lots.warehouse_id → warehouses.city, state` (`0001_init.sql:113`). Auctions also carry `warehouse_id`. The browse queries just never join it. Data dependency for real cities is satisfied by operator onboarding (see Adjacent).

### Web
- **File:** `browse/page.tsx` `loadLots` (line ~341): add `warehouses!inner(city, state)` to the `.select(...)`; when `?city=` is set, filter `.eq('warehouses.city', city)` (PostgREST embedded filter w/ inner join).
- **File:** `(public)/layout.tsx:195-197` — nav `CityPicker` exists but does NOT feed browse. Wire it to set `?city=`; have `isLotsMode` treat `city` as a lots trigger.
- **File:** `_components/FilterRail.tsx` — add a "Pickup location" section (city list) so it's also in the filter panel.
- City options source: `CityPicker` is fed by `cities` prop from `(public)/layout.tsx`; `CityPicker` component itself is `apps/operator-web/src/app/home-client.tsx:414`. Ensure the cities query (and browse `loadLots`) filter to `operators.status='active'` so dropped/demo operators don't appear.
- **Effort:** M · **Risk:** med (embedded filter + city data quality).

### Native
- **File:** `index.tsx` load query (lines ~476-483): add `warehouses(city, state)` to the `.select(...)` (alongside the existing `operators(...)` embed).
- Add a "Pickup location" section to the filter bottom sheet — mirror the existing category/condition sections (~lines 761-942) — and filter on the selected city.
- **Effort:** M · **Risk:** med.

---

## Demo / test data — HARD DELETE (DECISION LOCKED) — prod, destructive

⚠️ Destructive prod operation. Do the verification step FIRST. Use the live
service-role key path per `CLAUDE.md`; dry-run/inspect before `--live`.

Live rows found 2026-05-26:

| Type | Name | ID | Action |
|---|---|---|---|
| Operator | Demo Auctioneer (`DEMO`) | `99999999-9999-9999-9999-999999999999` | **DELETE** |
| Warehouse | Demo Warehouse ("Demo City") | `88888888-8888-8888-8888-888888888888` | **DELETE** |
| Lots | `DEMO-0000xx` (lot_code prefix `DEMO`) | — | **DELETE** |
| Warehouse | BinGo "Test Test" | `960f3789-9eb4-4806-aeba-6c6c2cd494b8` | Consolidate → Harrison (NOT delete blindly — reassign any attached lots first) |
| Warehouse | BinGo "Test" | `92ac7803-812f-4c00-b4ee-f3e9bbea4965` | Consolidate → Harrison (same) |
| Warehouse | BinGo "Harrison" (Harrison, AR) | `ce9646af-55b5-412b-bff1-b86a5cdd8b54` | **KEEP** — the one real warehouse |

### Step 1 — Verify before deleting (read-only)
- Confirm NO real bids / invoices / pickups point at demo lots (the Demo Auctioneer's lots). Emily's launch test bid was against BinGo `BIN-000035`, not demo — but verify.
- Count lots/auctions under the demo operator + warehouse.

### Step 2 — Delete in FK order
`auctions.warehouse_id` and `lots.warehouse_id` are `ON DELETE RESTRICT`
(`0001_init.sql`), so the warehouse can't go until its lots/auctions do. Order:
1. demo bids (if any) → demo invoices/pickups (if any)
2. demo lots (`lot_code` LIKE `DEMO-%` / `operator_id = 99999999…`)
3. demo auctions (under demo operator/warehouse)
4. demo warehouse `88888888…`
5. demo operator `99999999…` (+ any `operator_users` rows)

### Step 3 — BinGo junk warehouses
- For `960f3789…` ("Test Test") and `92ac7803…` ("Test"): query for attached lots/auctions; reassign to `ce9646af…` ("Harrison") or delete only if empty.

### Step 4 — Confirm
- Re-run the `cities` query + load `/browse` → "Demo City" gone, demo lots gone, only Harrison shows.

---

## Adjacent — Operator-onboarding config (SEPARATE workstream, not in PR 1/2)

Owner confirmed operators set location + policies at onboarding. Most fields
ALREADY have DB columns — onboarding is a UI-capture job, not a schema build:

| Field | Existing column | Status |
|---|---|---|
| Location (city/state/address) | `warehouses.city/state/address_line1` (NOT NULL) | ✅ exists |
| Buyer premium | `operators.default_buyer_premium_bps` (1500=15%) + per-auction `auctions.buyer_premium_bps` | ✅ exists |
| Pickup times | `warehouses.pickup_hours` (JSONB) | ✅ exists |
| Forfeit / grace / relist | `0144` cols: `no_show_forfeit_threshold`, `auto_charge_grace_hours`, `pickup_grace_extension_hours`, `auto_flag_disposal_at_strikes`; `relisted` lot status exists | ✅ exists |
| Refund policy terms | not confirmed | ❓ verify — may need a new column |

Action for that workstream: build/extend the operator onboarding wizard to
capture these into the existing columns; add a `refund_policy` text field only
if the verification shows none exists.

---

## Verification checklist (post-implementation)

- [ ] Web `/browse` with no params lands on **Lots**, grid visible above the fold.
- [ ] Native Browse tab: lot grid sits directly under Hero/CategoryGrid/search bar; banners below.
- [ ] Web lot-card countdowns **tick** on `/browse` and `/clovrrush`.
- [ ] Native grid prices/bid counts refresh ~25s while focused.
- [ ] City filter works on web + native; only real cities listed.
- [ ] "Demo City" + DEMO-0000xx lots absent everywhere; only Harrison shows.
- [ ] No orphaned lots/auctions after warehouse consolidation.
