# Staff-App Quick Lot Testing Recap — Triage & Plan (2026-06-08)

Source: warehouse team testing recap (Quick Lot, today's build). Investigated against
`master` @ `e61d6fc` via 4 parallel agents + live prod grounding. All file:line refs are
current master. **This is a plan — nothing implemented yet.**

Build is "significantly better": matching works, lots create, QR assign works, put-away
works, titles save on good matches. Remaining work is workflow/quality, not core function.

---

## Confirmed root causes (the meat)

### 1. No-match silently mints "Quick lot — <code>" junk  ·  P0  ·  M  ·  mobile OTA
- **Cause:** `quick.tsx:660-664` synthesizes a bare candidate in **pre-stickered/lpn modes** so `noMatch` is never true → the 2s auto-create timer (`:710-731`) makes a bare lot and binds the scan as its sticker. (`generate` mode already shows an explicit picker.)
- **Fix:** compute `noMatch = candidate === null` directly (drop the mode-conditional synthesis); route ALL no-match scans to an explicit card: **"No Match Found" → [Scan Another Item] / [Create Custom Listing]**. Handlers already exist (`onCancelScan` → discard; `onCreateManual` → `/lotting/manual` with prefilled code). Matched fast-path untouched.
- **Pre-sticker reconciliation:** `manual.tsx` already re-binds the sticker after a real lot is created (`:248-255`), so binding isn't lost. To avoid a redundant 2nd scan in the common "scan = the sticker" case, pass the scanned code through as `prefilledSticker` and pre-bind it. (This sub-item is the only non-trivial part.)
- **Risk:** must still guarantee the sticker binds (else put-away dead-ends at "Lot not found"). Network-error path now shows "No Match" instead of silent create — confirm acceptable.

### 2. "Photo Capture After Scan" never launches  ·  P1  ·  S–M  ·  mobile OTA
- **Cause (primary):** `quick.tsx:681` forces `awaitingPhoto=false` whenever **Review mode** is on (`reviewMatched`), and the review card has **no photo capture** — so "Photo after scan" + "Review before save" silently conflict. Testers were very likely in Review mode.
- **Fix:** Option A (recommended) — add photo capture to the review card (this *is* part of #3, so build together). Option B (minimal) — make the two toggles mutually exclusive with a hint.
- **Confirm with team:** was "Save mode: Review" selected during the test? Determines the fix path. Secondary suspect (if Review was OFF): camera unmount race — `captureAndCreate` surfaces `photoError` if `cameraRef` is null.

### 3. Full listing-review preview before finalize  ·  P3  ·  L  ·  mobile OTA
- **State:** `EditableCandidateCard` already has **9 of 11** requested fields (title, description, brand, model, category, condition, MSRP, starting bid, +web-lookup). **Gaps: add manual photos + reorder photos** (currently delete-only, `EditableCandidateCard.tsx:114-165`).
- **Fix:** add "Add photo" to the review card (also fixes #2), multi-photo upload-before-save (local `file://` URIs must upload to `lot-photos` bucket before `createLot`), and reorder UI (`photo_urls[0]` is the hero thumbnail — order matters).
- **Recommendation:** keep **opt-in** (Review toggle), do NOT force as default — the screen's whole point is <2s rapid-fire. Consider merging the two toggles into one "Save mode: Fast / Review (+photos)".

### 4. Matched items show "No photos yet"  ·  P0  ·  S  ·  shared (persistence)
- **Cause:** `createDraftLotFromCandidate` (`persistence.ts`) **never enqueues an `image_enrichment_job`**. The `lots` half of the enrichment design (`PATCH-universal-web-scraper-and-enrichment-2026-05-30.md:135-136`) was never shipped — only the `import_rows` half (#141). So a matched **mobile** lot with no manifest photo is never enriched → "No photos yet" forever. Affects ALL mobile create paths (Quick/Photo/Manual).
- **Fix:** in the existing fire-and-forget `enrich()` thunk (`persistence.ts:363`), enqueue one idempotent `image_enrichment_jobs` row (`target_table='lots'`, `target_id=lotId`, `status='pending'`). The drain (`image-enrichment-drain.ts`) already handles `target_table='lots'`. Backfill already-created matched lots (extend `scripts/backfill-image-enrichment-jobs.mjs`).
- **Pre-impl check:** the drain reads/writes `lots.photo_url` (singular) but mobile writes `lots.photo_urls` (array). Verify/reconcile this column mismatch or the enriched URL lands where the UI ignores it (cf. task #139). May bump to M.
- **Note:** Wayfair manifests legitimately have no photos (placeholders), already handled. This fix targets UPC/catalog + future-enrichable matches.

### 5. Lots stay "Pending Intake Into Inventory" after put-away  ·  P1  ·  M  ·  no DB change
- **NOT a code defect in the flip** — `intake_lot_to_bin` (mig 0160) and `batch_intake_lot_to_bin` (mig 0185) DO set `status='in_inventory'` + `intake_at` + `intake_bin_id`. Live data: today's BIN-000158..167 are all `pending_intake` except one `in_inventory` → only one put-away actually completed.
- **Two real causes:** (a) put-away returns a non-success reason that's easy to miss mid-scan — bin not found (typed "Right-2-10" != exact `bins.code`), `not_lotted_yet`, or `pending_move`; (b) **the "assign to bin" trap** — `assign_lot_to_bin` (mig 0147, the *pickup-staging* RPC) writes a `bin_assignments` row but does **NOT** touch `lots.status`. A lot can be "in a bin" yet still `pending_intake`.
- **Fix:** harden put-away failure visibility (persistent error banner + error haptic + bin-code autocomplete that only accepts real `bins.code`); disambiguate the two "bin" actions in UI copy. **No DB change.**
- **Confirm:** did testers use Put-Away → Single/Batch/Shelf, or Check Out → Stage? **Do NOT** make `assign_lot_to_bin` flip status — corrupts the won→pickup lifecycle.

### 6. Timestamps show ~5h ahead (10:46 AM -> 3:34 PM)  ·  P0  ·  M  ·  CF deploy
- **Cause:** operator-web pages render UTC `timestamptz` via bare `new Date(x).toLocaleString()` (no `timeZone`). On the Cloudflare Worker SSR runtime (process TZ = UTC) it prints UTC as local. DB is correct.
- **Fix already exists:** `apps/operator-web/src/lib/datetime.ts` → `formatInTimeZone()` + `warehouseTimezone()` (source = `warehouses.timezone`, NOT NULL IANA). ~12 pages still use the bare pattern — the reported one is the **ops activity feed** (`ops/page.tsx:334`), plus `lots/[id]`, inventory table, loads, dashboard, pickups, disputes, imports, settlements. Route them through the helper.
- **Do NOT** add `operators.timezone` (warehouses.timezone is the established source) or use browser TZ (SSR has none). 1-2 queries need a `warehouses(timezone)` embed.

---

## UX polish (low risk, mobile OTA)

| # | Item | Cause / fix | Effort | Pri |
|---|---|---|---|---|
| 7 | **Description field hard to find** | Last field in review card (`EditableCandidateCard.tsx:367-380`); move it directly under Title. Not present in rapid-fire mode by design. | S | P2 |
| 8 | **Keyboard won't dismiss** | No `KeyboardAvoidingView`; decimal-pad inputs have no Done key (`quick.tsx:1367`). Add `keyboardDismissMode="on-drag"` + `Keyboard.dismiss` on scroll, optional iOS `InputAccessoryView` Done bar. | S | P2 |
| 9 | **Recent Lots not clickable** | Inline `View` rows (`quick.tsx:1486-1526`), header says 20 shows 8. `lotId` already stored; edit route `/worklist/[id]` exists. Wrap in `Pressable` -> `router.push`, reduce to 5, fix count. Enables the 2-box-set workflow. | S | P2 |
| 10 | **Sticker Skip too open** | Skip in `PreStickeredScanner` `confirmSkip`. Gate to manager+ via existing `hasOperatorRole(role,'manager')` (already used `quick.tsx:1226`); thread a `canSkip` prop through 4 call sites (quick/photo/scan/web). | M | P1 |

---

## External / not-a-bug

- **Stripe Connect gate** ("Complete Stripe Connect onboarding before scheduling a live auction") — **correct behavior.** The platform `acct_1TaMSs` + BinGo connected account are risk-restricted/`rejected.fraud` (separate 2026-06-08 incident, appeal in flight). Not a Quick Lot bug. See `auction_platform_stripe_flagged_incident.md`.

---

## Proposed rollout (batches)

**Batch A — P0, ship first (stops junk + restores trust):**
- #1 No-match 3-option (mobile OTA)
- #4 Enrichment enqueue for mobile lots + backfill (verify photo_url/photo_urls first)
- #6 Timezone display fix (CF deploy)

**Batch B — P1 workflow:**
- #5 Put-away failure visibility + bin-code autocomplete + copy
- #10 Sticker-skip manager gate
- #2 Photo-capture conflict (confirm toggle state; likely folds into Batch C/D)

**Batch C — P2 UX polish (one OTA):**
- #7 Description position · #8 Keyboard dismiss · #9 Recent Lots clickable

**Batch D — P3 feature:**
- #3 Full listing-review preview (photo add/reorder) — keep opt-in; absorbs #2.

## Open questions for the team (gate Batches B/C/D)
1. During the test, was **"Save mode: Review"** on? (decides #2 fix path)
2. Put-away via **Put-Away → Single/Batch/Shelf**, or **Check Out → Stage**? (confirms #5 root cause)
3. For a pre-stickered **no-match**, keep a one-tap "create blank lot & bind" option, or fully replace with "Create Custom Listing"? (scopes #1)
