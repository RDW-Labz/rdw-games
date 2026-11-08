# June-4 Feedback Triage + Next Plan — 2026-06-04

Companion to `LIVE-TEST-FEEDBACK-STATUS-2026-06-04.md` (the item catalog) and the operator's
drafted `PATCH-importer-multi-vendor-and-bidder-sku-coverage-2026-06-04.md`.

Built from a 6-agent triage workflow (`june4-triage-plan`) + live prod queries. The tester
(Harrison) was testing the **OLD app build** while this session was shipping #206–#215, so a
large share of his report is already fixed and just needs a relaunch. This doc separates
**already-shipped** from **genuinely-still-broken** and plans the latter.

---

## 0. Prod facts pulled this turn (ground truth)

| Fact | Value | Implication |
|---|---|---|
| BinGo `import_rows` | **18,933 pending** + 13 lotted | Manifests ARE imported — matching logic is the problem, not missing data |
| Wayfair identifier columns populated | `tracking_number` 17,682 · `model` 18,933 · **`upc/asin/fnsku/lpn/external_code/pallet_id` = 0** | Scanned product SKUs have **no queryable column** |
| Wayfair SKUs live only in | `import_rows.raw_data` JSONB (`ProductSKU`, `SiteSKU`, `ManufactureSKU`, `CatalogID`, `ItemNumber`) | Stranded — matcher never reads `raw_data` |
| Won lots w/ put-away bin | **14 / 14** have `intake_bin_id` | Location DATA exists → location bug is display-only |
| BinGo `collect_sales_tax` | **false** (`stripe_tax_acknowledged_at` set) | $1.15 no-tax is correct; tax is opt-in + unbuilt (task #40) |
| BinGo `contact_email` | **jmacluer@gmail.com** | The personal email Harrison saw in customer areas |
| BinGo `auto_relist_mode` | **'auto'** (12 unsold lots) | "→ Review" = flip this to `'review'` (Settings → Auto-relist) |

---

## 1. What shipped this session (#206–#215)

| PR | What | Ships via | June-4 item |
|---|---|---|---|
| #206 | Maestro both-app launch smoke + screenshot gate | CI | — |
| #207 | Store-readiness (assetlinks SHA, iOS privacy manifest) | CI | — |
| #208 | Amazon category aliases mig 0184 + `--live` backfill (5,951 lots) | data | A4 category filter |
| #210 | 🔴 invoice "Not Found" (phantom `refunded_cents`) | bidder OTA | invoice-not-found |
| #211 | web `/profile/pickup` lists NULL-`fulfillment_method` wins | CF deploy | J1 browser pickup |
| #209 | pickup mode-gating (C1/C2) + builder carryover buckets (B7) | bidder OTA + CF | C1/C2, B7 |
| #212 | pre-stickered bind no longer silently skippable | staff OTA | J4 QR-bind |
| #213 | single-scan pre-stickered lotting (Option B) | staff OTA | J4 QR-bind |
| #214 | BRN→BIN display across lot surfaces (`lotDisplayCode`) | bidder+staff OTA | BRN-display |
| #215 | BRN on put-away/checkout result rows + Recent Lots (mig 0185) | staff OTA | BRN-display |

Plus the **pickup-location fix** (`944e1b8`, confirmed an ancestor of `master`): `bidder-app/pickup/[id].tsx`
+ `field-mobile/checkout/pickup-verify.tsx` now read `lots.intake_bin_id → bins.code` and show
"On shelf · {bin}" instead of "not staged". **In the OTAs already.**

---

## 2. Triage — every June-4 item

### ✅ Already shipped — tester force-quits + relaunches onto today's OTA
| Item | By | Vector |
|---|---|---|
| Invoice/receipt "Invoice Not Found" (app) | #210 | bidder OTA |
| Newly-assigned QR "does not exist" at put-away | #212 + #213 | staff OTA |
| Recent Lots shows BIN not BRN | #214 + #215 | staff OTA |
| **Item warehouse location → mobile pickup + staff receipt scan** ("Not Staged") | `944e1b8` | bidder + staff OTA |
| App shows staging slots in counter/self-serve mode (C1/C2) | #209 | bidder OTA |
| A4 category filter returned nothing | #208 (backfill) | server data — no app action |

### 🌐 Shipped but needs the Cloudflare web deploy (relaunch ≠ enough)
| Item | By |
|---|---|
| Browser "Pickup shows Browse Auctions" (J1) | #211 |
| Builder carryover Unsold/Unpicked filters (B7) | #209 |

### ⚙️ Runtime toggle (no code)
| Item | Action |
|---|---|
| **Carryover → Review** (B4/B5/B8) | Flip BinGo `auto_relist_mode` `'auto'`→`'review'` in **Settings → Auto-relist**. Today 12 unsold lots auto-carry; Review queues them for manual decide. |
| Sales tax wanted | Flip `collect_sales_tax` true — **BUT see §3, tax is $0 until task #40 is built.** |
| Support email | Set BinGo `contact_email` to a real support address (operator profile). |

### ❌ Genuinely still broken — needs new code (see §3)
1. **Web pickup-DETAIL location** (`/profile/pickup/[id]`) — never had it; the mobile/staff fix didn't touch web.
2. **Manifest matching** — Wayfair SKUs unstorable + unprobed (the operator's importer plan).
3. **Bidding requires force-close/refresh** — bidder lot screen has no resume/reconnect.
4. **Stock photos not auto-loading** (web-lookup path skips image enrichment).

### ℹ️ Not a bug / by design
- **Sales tax $0** — `collect_sales_tax=false`; real Stripe Tax unbuilt (task #40). Flipping the flag alone still yields $0.

### 🔭 Previously known, still open (not in #206–#215)
- **A2** web "You're highest bidder" false-positive on proxy-outbid (spawned task).
- **D1** product-ID recognition accuracy (pallet → only 2 right) — `domain-lotting` backlog.

---

## 3. Still-broken work streams (prioritized)

### P1 — Manifest matching (the tester's #1 functional blocker + the operator's importer plan)
**Root cause (confirmed both ends):**
- Importer **drops SKUs**: `commitImport` (`apps/operator-web/src/app/(operator)/imports/actions.ts:436-469`) INSERT omits `sku`; `importRowSchema:27` accepts it, `ImportWizard` HEADER_PATTERNS:170 collapses ProductSKU/SiteSKU/ManufactureSKU → one `sku` → discarded. No `*_sku` column exists (`database.types.ts:1095-1131`). SKUs survive only in `raw_data`.
- Matcher **doesn't probe SKUs**: live `find_import_row_by_scan` (mig **0163**, not 0160) probes `tracking_number/lpn/fnsku/asin/upc/external_code/pallet_id` only, `status='pending'`.
- Net: SKU scans always miss; only tracking scans match (the "2"); once matched a row flips `pending→lotted` (mig 0153) so it's one-shot → later "0".

**Fix (= operator's importer plan + a backfill):**
1. Migration: `ALTER TABLE import_rows ADD COLUMN product_sku/site_sku/manufacture_sku TEXT` + indexes.
2. Extend `find_import_row_by_scan` (mig 0163 body) to probe the 3 new columns.
3. Importer: split the 3 SKU headers into the 3 fields (`ImportWizard` HEADER_PATTERNS + `buildCommitRow`) and write them in the `actions.ts` INSERT; regen `database.types.ts`.
4. **Backfill 18,933 existing rows** from `raw_data` → new columns (no re-import).
5. (Operator plan streams) vendor adapters in `packages/import-shapes/`, multi-field bidder search, CDN allowlist, deduper. Use the operator's `build-deduped-manifest-import.mjs` + `wayfair-deduped-netnew.xlsx` (6,121 net-new) for the re-import path.
**Effort:** L (migrations 0186/0187/0188 per the operator's plan). **Ship:** CF deploy (importer) + server-side matcher migration (no app change needed for matching itself).

### P1 — Web pickup-detail location (last location gap)
**Root cause:** `apps/operator-web/src/app/profile/pickup/[id]/page.tsx:118-128` selects only warehouse name/address — no `invoice_lots/lots/intake_bin`. The render (`:179-455`) has no per-item list.
**Fix:** add `invoice_lots(lot_id, lots(title, lot_code, sticker_code, intake_bin_id, intake_bin:bins!lots_intake_bin_id_fkey(code)))` to the query + an Items section showing `lotDisplayCode` + "On shelf · {bin}" (mirror `bidder-app/pickup/[id].tsx:167,345,1081`). Optional: same on web receipt `profile/invoices/[id]/page.tsx:371-381`. RLS already allows it (`bins_bidder_read`, mig 0094/0133). **Effort:** M. **Ship:** CF deploy.

### P2 — Bidding requires force-close/refresh
**Root cause:** `apps/bidder-app/app/lot/[id].tsx` — bid sheet gated on `lot.status==='live'` (`:1291`); `lot` stays `null` if the one-shot `.single()` fetch (`:1141`) errors (error is swallowed); `useFocusEffect` (`:1127`) does NOT re-run on iOS background→foreground; `.subscribe()` (`:1234`) has no status callback (CHANNEL_ERROR/TIMED_OUT swallowed). No `AppState` wiring anywhere in the app; `supabase.auth.startAutoRefresh()` (RN-required) not called → stale token on resume. Browse survives only because it 25s-polls.
**Fix:** (a) `packages/supabase-client/src/client.ts` — global `AppState` → `start/stopAutoRefresh()`; (b) `lot/[id].tsx` — on `AppState 'active'` refetch lot + re-subscribe; (c) `.subscribe((status)=>…)` re-subscribe on error; (d) destructure `error` on the fetch + show retry instead of infinite spinner. **Effort:** M. **Ship:** bidder OTA. *(Highest-value reliability fix — affects every live auction.)*

### P3 — Stock photos not auto-loading
**Root cause:** web-lookup path `api/lottr/enrich-lot/route.ts:102-142` calls `productToCandidate` but never `enrichImages()`; the 187k catalog scrape has 0 `image_urls`, so text populates but `stockPhotos=[]`; `apply-enrichment` only writes a photo when `stockPhotos.length>0`. (AI-photo-scan + bulk-import paths DO enrich — only this path is gapped.)
**Fix:** in `enrich-lot/route.ts`, if `candidate.stockPhotos.length===0` call `enrichImages({brand,model,title,upc})` and merge before returning (mirror `identification.ts:354`). **Effort:** M. **Ship:** CF deploy.

### P4 — Low / enhancements
- **Support email:** set BinGo `contact_email`; consider a platform-support fallback in customer-facing copy. **S.**
- **Sales tax:** product decision — leave off, or build task #40 (real `stripe.tax.calculations`). Flipping the flag alone = still $0. **L if built.**
- **App one-tap bidding** (match browser's Current/Next/Place + quick-bid) + **"You're winning" badge** (native + web). Enhancements. **M.**
- **A2** web proxy-outbid false banner (`BidWidget.tsx` needs `current_leader_id===me` guard). **S.**

---

## 4. Recommended execution order
1. **Tell Harrison to relaunch** (clears 6 items instantly) + **CF deploy** if not already (J1/B7) + **flip auto_relist_mode→review** + set **contact_email**. *(zero/near-zero code)*
2. **Bidding resume/reconnect** (P2) — bidder OTA. Highest reliability ROI.
3. **Web pickup-detail location** (P1) — CF deploy. Closes the last location gap.
4. **Manifest matching + importer multi-SKU** (P1, the operator's plan) — migration + importer + backfill 18,933 rows. Biggest functional win for lotting.
5. **Stock photos** (P3) + **support email/A2** (P4) — fold in.
6. Defer: real sales tax (task #40), D1 recognition accuracy, app bidding-UX polish — product calls.

## 5. Ship-vector cheat sheet
- **bidder OTA:** bidding resume (P2), any bidder-app change.
- **CF deploy:** web pickup-detail (P1), importer multi-SKU (P1), stock-photo enrich (P3), web A2.
- **migration (0186+):** import_rows SKU columns + matcher + backfill.
- **runtime (no code):** relaunch, auto_relist_mode→review, contact_email, collect_sales_tax decision.
