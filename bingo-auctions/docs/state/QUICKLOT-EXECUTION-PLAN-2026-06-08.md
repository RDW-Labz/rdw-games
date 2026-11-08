# Quick Lot — Execution Plan (2026-06-08)

Consolidates `FEEDBACK-TRIAGE-2026-06-08.md` + two round-2 deep dives (photo capture,
web import). Ordered for execution **after the next compaction**. All file:line refs vs
`master` @ `613d006`. A fresh session should be able to execute straight from this doc.

## Answers from the team (incorporated)
- **Photo (#2):** the camera DOES reach the add-photo step, but there's **no clear way to take the photo** — QuickLot uses a text "Add photo" button below a small preview; every other lotting screen has a real shutter. -> build a shared shutter.
- **Put-away (#5):** which path staff used is unknown -> harden **both** the failure-visibility AND the intake-vs-stage confusion.
- **Create Custom Listing (#1/#3):** must pull product data **from the web**; the current one-click-import + upload-URL features are "shaky at best" -> harden them + wire the existing AI fallback.

---

## BATCH A — P0, unblocked. Start here post-compact.

### A1 - Image enrichment for mobile-created lots (#4) - S
- **Gap:** `packages/domain-lotting/src/persistence.ts` `createDraftLotFromCandidate` (RPC commit ~:341, fire-and-forget `enrich()` thunk ~:363) **never enqueues** an `image_enrichment_jobs` row for the new lot. Only `commitImport` enqueues (`import_rows`). Drain already handles `target_table='lots'`.
- **PRE-FLIGHT (decide first):** drain reads/writes `lots.photo_url` (singular) but mobile writes `lots.photo_urls[]`. Confirm which column the inventory thumbnail reads (task #139 moved it to `photo_urls`). Reconcile: either drain writes `photo_urls[]`, or keep a scalar mirror. Do NOT ship A1 until this is settled, or enriched URLs land in an ignored column.
- **Build:** idempotent `image_enrichment_jobs` upsert (`onConflict:'target_table,target_id'`, `target_table='lots'`, `operator_id`) inside `enrich()`. Backfill existing matched lots — extend `scripts/backfill-image-enrichment-jobs.mjs` with a `lots` variant.
- **Vector:** persistence ships in the mobile OTA bundle; drain is server-side (CF). Backfill = node script.

### A2 - Timezone display (#6) - M
- **Cause:** ~12 operator-web pages render UTC via bare `new Date(x).toLocaleString()`; on the UTC Worker runtime -> shows UTC as local (~5h ahead). Reported instance: `ops/page.tsx:334` activity feed.
- **Fix exists:** `apps/operator-web/src/lib/datetime.ts` -> `formatInTimeZone()` + `warehouseTimezone()` (source `warehouses.timezone`, NOT NULL IANA). Route these pages through it: `ops/page.tsx` (:334,:442), `lots/[id]/page.tsx` (:273,:343,:453,:252), `lotting/inventory/InventoryTable.tsx` (:436-438), `loads/page.tsx:287`, `dashboard/page.tsx:432`, `pickups/page.tsx:110`, `disputes/page.tsx` + `disputes/[id]`, `imports/page.tsx` + `imports/[id]`, `settlements/page.tsx`, `bidders/[id]`, `admin/operators/[id]`.
- 1-2 queries (ops activity feed, lot timeline) need a `warehouses(timezone)` embed added. **Do NOT** add `operators.timezone` or use browser TZ (SSR).
- **Vector:** CF deploy.

---

## BATCH B — the reported pain + quick wins

### B1 - Shared `CameraCaptureSheet` (#2 photo; foundation for #3) - M
- **Build** `apps/field-mobile/features/camera/CameraCaptureSheet.tsx`: full-bleed live viewfinder + **large circular shutter** (a11y "Take photo", reuse `photo.tsx:200` `shutterLockRef` mutex) + multi-photo **thumbnail strip** (delete badge + long-press reorder; reuse `EditableCandidateCard` `photoClearBtn` styling :582) + **labeled** permission/empty states. Composes existing `useBackCamera`, `useTapToFocus`, `CameraFlashButton`, `safeFlash`, `TAKE_PHOTO_OPTIONS`, `translateCaptureError` (in `features/camera/*` + `lib/vision-camera.ts`).
- **Replace** QuickLot's text buttons (`quick.tsx:1736-1763`, capture via `captureAndCreate:879`) with the sheet -> directly fixes "no clear way to take the photo." Precedent to copy: `worklist/[id].tsx:429-500` (already ~90% the pattern).
- **Vector:** OTA.

### B2 - No-match -> explicit choices (#1) - M
- `quick.tsx:660-664`: drop the mode-conditional bare-candidate synthesis; compute `noMatch = candidate === null`. ConfirmationCard no-match section (`:1650-1732`): **"No Match Found"** -> **[Scan Another Item]** (`onCancelScan`) / **[Create Custom Listing]** (`onCreateManual` -> `manual.tsx`).
- **Pre-sticker reconciliation:** pass the scanned code to `manual.tsx` as `prefilledSticker`; pre-bind after create (manual.tsx already re-binds at `:248-255`) to avoid a redundant 2nd scan. Must still guarantee binding (put-away dead-end risk).
- **Vector:** OTA. (Routes into the Batch-D Create-Custom-Listing autofill.)

### B3 - Web-import data-loss bug fixes - S (quick wins, do with B2)
- `apps/field-mobile/app/(staff)/lotting/web.tsx:92-107` reads only `prefilledUrl`/`scrapeError` — also read **`prefilledData`** (Share-Extension success payload) + **`prefilledTitle`/`prefilledCode`** (from `EditableCandidateCard.tsx:357-359`) and hydrate the form. Fixes silent data loss on the Share-Extension and review-card "Try web lookup" paths.
- `features/lotting/handleShareIntent.ts:52-57,99`: response shape drift — rename `json.source` -> `json.host` (scrape-url returns `host`, `route.ts:56`).
- **Vector:** OTA.

---

## BATCH C — workflow + UX

### C1 - Put-away clarity (#5) - M, NO DB change
- Intake RPCs (`intake_lot_to_bin` mig 0160, `batch_intake_lot_to_bin` mig 0185) **do** flip `status->in_inventory`. Lots stay `pending_intake` because put-away didn't complete (bad bin code / `not_lotted_yet` / `pending_move`) OR the **stage-vs-intake trap** (`assign_lot_to_bin` mig 0147 writes `bin_assignments`, never touches `lots.status`).
- Harden `put-away/{single,batch,shelf-scan}.tsx`: persistent error banner + error haptic on non-success reasons; bin-code autocomplete that only accepts real `bins.code`; disambiguate intake-vs-stage copy. **Do NOT** make `assign_lot_to_bin` flip status (corrupts won->pickup).

### C2 - Sticker-skip manager gate (#10) - M
- `PreStickeredScanner` `confirmSkip`: add `canSkip` prop = `hasOperatorRole(role,'manager')` (pattern already at `quick.tsx:1226`). Thread through all 4 call sites (quick/photo/scan/web). Default `false`.

### C3 - UX polish - S each (one OTA)
- **#7** Description: move the field in `EditableCandidateCard.tsx:367-380` to directly under Title (`:182`).
- **#8** Keyboard: add `keyboardDismissMode="on-drag"` + `Keyboard.dismiss` on `quick.tsx:1067` ScrollView; optional iOS `InputAccessoryView` Done bar on decimal-pad inputs.
- **#9** Recent Lots: wrap rows (`quick.tsx:1496`) in `Pressable` -> `router.push('/worklist/'+entry.lotId)` (guard `!!lotId`); slice to 5; fix the count label.

---

## BATCH D — web-import robustness + Create Custom Listing + review preview

### D1 - Wire AI fallback into the paste-URL path - L (highest web-import impact)
- The robust scraper **already exists**: `packages/domain-lotting/src/lookup/*` — `fetchOpenRouterLookup` (Sonar finds an alternate, non-blocked retailer product page) -> `url-fetcher.ts` server-fetches + parses JSON-LD (UA rotation, per-host pacing, Amazon/eBay guard). 92% MSRP / 80% image hit-rate, ~$0.003-0.06/call. Never connected to paste-URL.
- Add server glue in `apps/operator-web/src/app/api/lottr/scrape-url/route.ts`: on block/empty, call `fetchOpenRouterLookup` (extract ASIN/UPC/title first). Add `?allowAiFallback=1` so the mobile client makes ONE request (OPENROUTER key is Worker-side; mobile must not call it directly).

### D2 - Scraper hardening - S
- Reconcile the allowlist (`route.ts:72-88`) with the documented block-list (`url-fetcher.ts:71-114`): drop/redirect Amazon/eBay/AliExpress/Alibaba to the AI path.
- Add `AbortSignal.timeout(8000)` + 2-try backoff (reuse `llm.ts:402-415`) + stronger UA/`Sec-Fetch-*` profile (reuse `url-fetcher.ts:39-49,243-250`).
- Detect false-success: all of title/price/image empty (or title `"Imported product"`) -> return `ok:false`/`needs_fallback` so the client escalates instead of showing an empty "success" form.

### D3 - Create Custom Listing URL-autofill - M
- `manual.tsx`: add a top "Paste product URL -> Autofill" block (above Title `:372`). Two-stage with explicit progress: "Reading the page..." (scrape) -> on block/empty "Site blocks direct reads — searching the web..." (AI fallback) -> fill or "enter manually." Per-field "autofilled" affordance; price/condition always verify-me; never blocks manual entry.

### D4 - Full listing-review preview (#3) - L, keep opt-in
- `EditableCandidateCard` + `CameraCaptureSheet`: add an "+ Add photo" tile to the photo strip (`:115-165`), multi-photo + long-press reorder (`photo_urls[0]` = hero thumbnail). Multi-photo **upload-before-save**: local `file://` URIs must upload to the `lot-photos` bucket (reuse `quick.tsx:581` `uploadImageFromUri`) before `createLot`. Do NOT force as default (protects the <2s rapid path); consider merging Photo+Review toggles into one "Save mode: Fast / Review (+photos)".

---

## Ship vectors summary
- **Mobile OTA** (field-mobile JS): A1(persistence), B1, B2, B3, C2, C3, D3, D4.
- **CF deploy** (operator-web): A2, D1, D2.
- **Server-side already**: the enrichment drain (A1 consumer).
- **Scripts**: A1 backfill.
- OTA must target BOTH `preview` + `production` channels (memory `feedback_ota_both_branches`).

## Pre-flight checks before coding
1. **A1:** resolve `lots.photo_url` (scalar) vs `photo_urls[]` — which does the inventory thumbnail read? (cf task #139). Reconcile before enqueueing.
2. **D1:** confirm `OPENROUTER_API_KEY` is a Worker secret (it is) and `domain-lotting/src/lookup/*` is importable from the scrape-url route (server bundle).
3. Local checkout `C:\Users\jmacl\Projects\auction-platform` is ~150 commits behind master — build every fix in a fresh worktree off `origin/master`.

## Open item still pending (separate incident)
- Stripe platform `acct_1TaMSs` + BinGo connected account are risk-restricted/`rejected.fraud`; appeal forms (platform + BinGo) must be submitted in the Dashboard. The "Complete Stripe Connect onboarding before scheduling a live auction" gate is correct behavior. See `auction_platform_stripe_flagged_incident.md`. Not part of this Quick Lot plan.
