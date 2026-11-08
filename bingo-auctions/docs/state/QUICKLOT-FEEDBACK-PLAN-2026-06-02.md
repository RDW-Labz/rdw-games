# ClovrBid QuickLot Feedback + Auction-Stuck-LIVE — Fix Plan

**Source:** Jared DeMeyer (Harrison / RDB) field-test report, 2026-06-02 + 3 screenshots (camera-flash error, "Not signed in as staff" modal, Auctions list with Test Auction.2 stuck LIVE).
**Method:** 5 read-only investigators grounded every item against current `origin/master` code (file:line) and reconciled against already-shipped work; synthesized into batches. No code written yet — plan for owner approval.

## 1. TL;DR

- **Two P0s are blocking RDB warehouse staff on iPads TODAY and ship by OTA in one small hotfix:** (a) every camera capture path hardcodes `flash: 'auto'`, which vision-camera *throws* on no-flash iPads — staff literally cannot attach a photo, only Skip; and (b) the raw native error (`device.hasFlash`/`device.hasTorch`) is shown verbatim to warehouse employees. Both are pure JS/bundle fixes (stop requesting an unavailable flash).
- **A separate confirmed bug** fires a bare "Not signed in as staff" modal mid-QuickLot: `useOperatorRole()` re-validates over the network on every token refresh and treats transient `getUser()`/`operator_users` failures as "not staff." OTA-fixable, no migration.
- **The "auction stuck LIVE 23h" bug is unrelated to QuickLot and ships as a DB migration:** `advance_auction_lifecycle()` only closes auctions that have ≥1 *currently-existing* lot row; a zero-lot test auction can never auto-close. Confirm with the exact prod query below, then add a time-based empty-auction close.
- **Core product tension:** QuickLot is "fast by design" (<2s/lot, auto-create on a match), but Jared wants a "Review Listing before save" gate for Title/Description/MSRP/Starting Bid/Photos/Notes. The fully-editable `EditableCandidateCard` already exists and is wired into *every other* creation path — QuickLot is the only one that skips it. **Recommended resolution: an optional per-session "Review before save" toggle (default OFF)**, mirroring the existing `takePhotoAfterScan` toggle precedent. Rapid-fire stays fast; accuracy-minded staff opt in. ~80% of the work already exists.
- **Much of Jared's report (no-match workflow, in-app research tools, Done-lag) is ALREADY SHIPPED in origin/master** (PRs #128/#129/#136/#71/#75/#139). His iPad is almost certainly on a stale OTA/TestFlight build. **Verify his build version via ASC API first** before rebuilding anything. Note: the local checkout is on `fix/wayfair-token-match` whose uncommitted working tree *reverts* #128/#129 and deletes `manual.tsx` — stash/abandon it before it re-lands on master.

## 2. Severity-ranked item table

| # | Item | Sev | Bug? | Already shipped? | Fix (1 line) | Files | Effort | Vehicle |
|---|------|-----|------|------------------|--------------|-------|--------|---------|
| 1 | QuickLot photo-after-scan `flash:'auto'` throws → blocks ALL photo capture on no-flash iPads (the screenshot P0) | P0 | Yes | No | Gate flash on `device.hasFlash`, default `'off'` via shared `safeFlash()` helper | `quick.tsx:686-716,694-695`; `lib/vision-camera.ts:117-119` | S | OTA |
| 2 | "Identify with AI" path has identical hardcoded `flash:'auto'` (2nd instance) | P0 | Yes | No | Same `safeFlash()` at the AI capture call | `quick.tsx:738-786,744-745` | S | OTA |
| 3 | Same `flash:'auto'` in 4 other screens (photo AI scan, pickup-verify refund, stage checkout, worklist add-photo) | P1 | Yes | No | Route all 5 capture sites through `safeFlash()`; hide flash toggle when `!hasFlash` | `photo.tsx:160,195-196`; `pickup-verify.tsx:689-690`; `stage.tsx:102-103`; `worklist/[id].tsx:108,121-122`; `CameraFlashButton.tsx:33-95` | M | OTA |
| 4 | Developer-speak error copy (`device.hasFlash`) passed verbatim to staff | P1 | Yes | Partial (RPC copy humanized, not camera) | Add `translateCaptureError()`; never display raw `err.message` for capture | `quick.tsx:709-715,780-782,490-492`; `photo.tsx:225-228`; `lib/vision-camera.ts:117-127` | S | OTA |
| 5 | `useOperatorRole()` flips off 'staff' on transient `getUser()`/`operator_users` failure during token refresh → false modal | P1 | Yes | No | Fail-open on error, fail-closed only on confirmed null; prefer `getSession()` | `operator-role.ts:29-77,36,42-46,60-69`; `client.ts:25-32` | S | OTA |
| 6 | QuickLot action guards show scary dead-end "Not signed in" modal, swallow the scan | P2 | Yes | No | Re-check session inline before alerting; fail open + retry, not bare OK | `quick.tsx:311-316,607-614`; `photo.tsx:457-462` | S | OTA |
| 7 | Same transient-null pattern in sibling hooks `useRole`/`useBidderRole` | P2 | Yes | No | Extract one hardened role-resolution helper shared by all 3 hooks | `role.ts:39-58`; `bidder-role.ts:43`; `operator-role.ts:35-58` | M | OTA |
| 8 | Matched/manifest QuickLot auto-creates lot on 2s timer with no editable review (Jared's headline ask, items 1+2+9) | P1 | No | Partial (no-match gate + card exist; matched path unfixed) | Add optional `reviewBeforeSave` toggle; reuse `EditableCandidateCard` as a pre-save gate | `quick.tsx:518,560,676,313`; `EditableCandidateCard.tsx:98`; `scan.tsx:434`; `SessionContext.tsx:89`; `PhotoToggleRow.tsx:23` | M | OTA |
| 9 | `manual.tsx` ("Create Custom Listing") missing Description, Starting Bid, Notes; can't seed from a match | P2 | No | New in #128 | Render `EditableCandidateCard` inline for matched-review; bring `manual.tsx` to parity | `manual.tsx:102,186,372` | S | OTA |
| 10 | Partial-item "Notes" have no persisted column — `create_draft_lot` drops `candidate.notes` | P2 | Yes | Partial (Description field exists) | Map notes → Description (free, OTA) OR migration adds `lots.staff_notes` + `p_notes` | `persistence.ts:205,248`; `EditableCandidateCard.tsx:365,477` | S | OTA (or migration) |
| 11 | Reserve set in a Quick Lot review card won't persist — `create_draft_lot` has no reserve param | P2 | No | Partial (`reserve_cents` col + worklist UPDATE pattern exist, mig 0140) | Mirror worklist follow-up UPDATE, or hide Reserve in QuickLot variant | `EditableCandidateCard.tsx:321`; `persistence.ts:248`; `quick.tsx:346` | S | OTA |
| 12 | Stale-build risk: Jared's iPad may predate no-match gate + `manual.tsx` | P1 | No | N/A (process) | Verify build via ASC API; ship fresh OTA to BOTH preview + production | `app.config.ts:1`; `eas.json:1` | S | OTA |
| 13 | Item 3 — No-match workflow already offers explicit 3-button picker (not auto-save) | P2 | No | **Yes (#128/#129/#136)** | No code; OTA only. Optional: relabel "Cancel scan"→"Scan another"; surface web-lookup on card | `quick.tsx:521,1351,982`; `manual.tsx:90`; `_layout.tsx:43` | S | OTA |
| 14 | Item 4 — In-app research tools already exist (Google Shopping/Amazon/eBay + URL scraper) | P2 | No | **Yes (#75/#139/#145)** | No code; OTA only. Optional: add Walmart/Target engine buttons | `web.tsx:187,111,56`; `quick.tsx:968` | S | OTA |
| 15 | Item 7 — Done-lag (~500ms) already fixed via fire-and-forget enrich + overlays | P2 | No | **Yes (#71)** | No code; OTA only — confirm iPad has commit 938081d | `quick.tsx:343,407,447,715,934,949` | S | OTA |
| 16 | **Auction PRIMARY ROOT CAUSE:** `live→closed` gated on `EXISTS(lots)`; zero-lot auction never closes | P1 | Yes | No | Add time-based empty-auction close branch + one-shot catch-up | `0096_auction_lifecycle.sql:97-122,106-107`; `0001_init.sql:21,171` | S | migration |
| 17 | How Test Auction.2 reached LIVE empty (mechanism, ranked) — scopes the fix | P2 | No | Partial (0129 covers scheduled-no-bid w/ non-null close_at) | Run confirm query; if a `NULL close_at` scheduled lot, add NULL-close_at guard | `0096:79-95,110`; `0125:51-71`; `0129:86-94`; `0111:269` | S | migration |
| 18 | Operator-web "Ends" column shows first-lot `ends_at`, not `last_lot_ends_at` — amplifies confusion | P2 | Yes | No | Select + render `COALESCE(last_lot_ends_at, ends_at)` | `auctions/page.tsx:34,88-90` | S | web |

## 3. Ship batches, in order

### Batch 1 — P0 OTA hotfix (ship immediately)

These block staff on no-flash iPads RIGHT NOW and are confirmed live in current master (not stale-OTA artifacts). All small, OTA-shippable, independent of the bigger rework.

**1a. Camera-flash unblock (items 1, 2, 3 — P0/P1).** Root cause: `flash` is hardcoded/defaulted to `'auto'` (a non-`'off'` value), and vision-camera's native photo path (`CameraSession+Photo.swift:70-79`) rejects with `.flashNotAvailable` whenever `flash != 'off'` and `device.hasFlash == false`. There is zero capability check anywhere in app code.
- Add a central helper to `apps/field-mobile/lib/vision-camera.ts`: `safeFlash(device, desired): 'on'|'off'|'auto' => device?.hasFlash ? desired : 'off'`.
- Route **all 5 capture sites** through it so flash silently degrades to `'off'` on no-flash hardware (capture then simply succeeds with no flash):
  - `quick.tsx:694-695` (photo-after-scan) and `quick.tsx:744-745` (AI identify) — **the two P0s**.
  - `photo.tsx:195-196`, `pickup-verify.tsx:689-690` (refund evidence), `stage.tsx:102-103` (checkout), `worklist/[id].tsx:121-122` (add-photo) — the P1 long-tail; fix now to prevent regression.
- Gate every `CameraFlashButton type='photo'` render on `device?.hasFlash` (`CameraFlashButton.tsx:33-95`) so the toggle is hidden when there's no flash hardware.
- **No native rebuild** — we are choosing not to *request* the unavailable flash, a pure JS/bundle change.

**1b. Friendly capture error copy (item 4 — P1).** Add `translateCaptureError(err)` to `lib/vision-camera.ts` mapping known vision-camera codes to employee copy with a generic fallback; apply at `quick.tsx:711, 781, 492` and `photo.tsx:227`. **Never** concatenate/display `(err as Error).message` for camera failures. Recommended copy: generic capture failure → "Couldn't take the photo. Hold steady and tap the photo button again, or tap Skip to save the lot without a photo." (After 1a lands, the flash error effectively never fires — this is defense-in-depth.)

**1c. False "Not signed in as staff" modal (items 5, 6 — P1/P2).** Root cause in `packages/supabase-client/src/operator-role.ts:29-77`: `checkRole()` re-runs on every `onAuthStateChange` (line 67) including periodic `TOKEN_REFRESHED` (`autoRefreshToken:true`, `client.ts:28`); `getUser()` (line 36) is a network round-trip that can transiently return `{user:null}`, and the `operator_users` query (lines 42-46) destructures only `{data}` and silently ignores `error` — both produce `data:null` → false downgrade off 'staff'.
- In `checkRole()`: capture `error` from **both** calls. **Fail closed only on confirmed null, fail open on error** — if `userErr`/`staffErr` is set, do NOT downgrade (early-return without `setState`, or a `{kind:'stale'}` callers treat as still-staff). Only set `'unauthenticated'` when `getUser` succeeds with `user===null`; only set `'not_staff'` when the query succeeds with `data===null`.
- Prefer `getSession()` (local, no network — already used at `_layout.tsx:77`/`session.ts:30`) for the authed check; a refreshed token must never present as logged-out.
- At the guards (`quick.tsx:311-316` createLot, `607-614` processCode): re-check `getSession()` inline before alerting; fail open + silent retry when a session exists; only show an actionable ("Reconnecting…"/Retry) modal when no session is confirmed. Keep `photo.tsx:459-462` consistent.
- **Do NOT regress the 2026-05-20 fix** (comment `operator-role.ts:60-65`) that added the re-run for freshly-invited staff — keep the re-check, just make it error-aware.
- **Defer** the shared-helper refactor for `useRole`/`useBidderRole` (item 7) to Batch 2 if speed matters; the `operator-role.ts` fix alone resolves the reported symptom.

### Batch 2 — P1 gaps (genuinely still missing)

After investigation, **most of Jared's items 3/4/7 are already shipped** (see §4). The only genuinely-missing P1 work is:

- **Item 8 (matched-path review gate)** — this is the big rework; it gets its own Batch 3.
- **Item 7 (shared role-resolution helper)** — optional follow-up to Batch 1c. Extract one hardened helper (fail-open-on-error, fail-closed-only-on-confirmed-null, `getSession()` authed check) shared by `useOperatorRole`/`useRole`/`useBidderRole`. Both OTA, no migration. Ship Batch 1c minimal first, then this.
- **Item 12 (stale-build verification)** — process, not code. Verify Jared's Staff app build (ASC API key `25M83P99J8`, Staff app `6767026881`) against master's `app.config.ts` version. If older, ship a fresh Staff TestFlight build / republish OTA to **both** preview and production channels (per memory `feedback_ota_both_branches`).

Optional UX polish surfaced by investigation (low priority, OTA): relabel no-match "Cancel scan" → "Scan another item" (`quick.tsx:1351`); render the already-wired `onWebLookup` button inside the no-match card; add Walmart/Target buttons to `web.tsx:187` `openExternal`.

### Batch 3 — Review/Edit screen (the big item — Jared's headline ask)

**What's already true:** the no-match path no longer auto-saves (PRs #128/#136 — explicit 3-button picker + `manual.tsx`). The **matched/manifest** path is what's still unfixed: `startConfirmation()` (`quick.tsx:518-567`) schedules `setTimeout(() => createLot(...), 2000)` (L560-563); tapping just skips the wait. Nothing is editable pre-save except sticky condition chips + a starting-bid override.

**The work is wiring, not building.** `apps/field-mobile/features/lotting/EditableCandidateCard.tsx` already exposes Title, Brand, Model, UPC, Category, Condition, MSRP, Starting Bid, Reserve, Description (placeholder literally reads "missing parts, damage…"), and Photos, with `candidateToEditable()`/`editableToCandidate()` round-trip helpers. It is already the scan→review→Save gate in `scan.tsx` (L434-465), `photo.tsx`, `index.tsx`, and `worklist/[id].tsx`. QuickLot is the *only* path that skips it (~80% built).

**Design / insertion point:**
1. Add `reviewBeforeSave: boolean` to `LottingSession` (`SessionContext.tsx:89`, mirroring `takePhotoAfterScan`) + a `PhotoToggleRow`-style toggle in the `quick.tsx` header band.
2. When ON: in `startConfirmation`, extend the existing `noMatch` timer-suppression (L526-541) to also cover `reviewBeforeSave` for the matched path. On tap-to-save (or a "Review" button), push a review state rendering `<EditableCandidateCard value={candidateToEditable(candidate, sessionDefaults)} … />` with a button row identical in shape to `scan.tsx:434-465`: **Save Lot / Edit / Scan Different Item / Create Custom Listing**. Save calls `editableToCandidate → createLot`. Reuse existing handlers: "Scan Different Item" = `discardConfirmation` (L610-614); "Create Custom Listing" = `onCreateManual` → `/lotting/manual` (L981-991).
3. When OFF: keep today's 2s auto-create so "fast by design" is preserved.

**Field-persistence gaps to resolve as part of this (items 9/10/11):**
- **Notes (item 10):** lowest-friction is Description-as-notes — `create_draft_lot` already persists `p_description` and the Description placeholder already invites condition/damage notes, so partial-item notes land in `lots.description` with **zero schema change**. (`candidate.notes` is dropped today — `persistence.ts:248-270` has no `p_notes`; `editableToCandidate` hardcodes `notes:''`.) A separate internal staff-only field requires a migration (`lots.staff_notes` + `p_notes` param).
- **Reserve (item 11):** `create_draft_lot` has no `p_reserve_cents` (TODO at `persistence.ts:484-487`). Either hide Reserve in the QuickLot review variant (it's NOT in Jared's explicit ask), or mirror worklist's follow-up `UPDATE lots SET reserve_cents` after `createDraftLotFromCandidate` returns (mig 0140 pattern).
- **`manual.tsx` parity (item 9):** for matched-review, render `EditableCandidateCard` inline (don't route through `manual.tsx`, which can't be seeded from a match and lacks Description/Starting Bid/Notes). Optionally refactor `manual.tsx` to also use `EditableCandidateCard` for DRY.

**Owner product-decision options (must pick before implementing):**
- **(a) Optional toggle, default OFF [recommended]** — rapid-fire stays <2s; Jared opts in. Mirrors `takePhotoAfterScan`.
- **(b) Optional toggle, default ON** — accuracy-first, but slows the default flow.
- **(c) Always-on gate** — kills the speed advantage and arguably makes QuickLot redundant with `scan.tsx`.

### Batch 4 — Auction lifecycle fix (separate from QuickLot; ships as a migration)

**Root cause (single predicate, confirmed in code):** `advance_auction_lifecycle()` — the only function that flips `auctions.status` live→closed — gates its close branch on `EXISTS (SELECT 1 FROM lots WHERE auction_id = a.id)` (`packages/db/migrations/0096_auction_lifecycle.sql:106-107`). The header comment (`0096:98-99`) makes this deliberate: "Empty auctions never auto-close." The predicate reads only child-lot terminal states (`0096:110`) and **never** reads `ends_at`/`last_lot_ends_at`/wall-clock. So a zero-lot auction (Test Auction.2 was a 5-min test with no real lots) can never auto-close — the `EXISTS` guard is false every 60s tick. The "Ends Jun 1 1:00 PM" column renders `ends_at` (a display field the engine never consults, documented as "first lot close" at `0001_init.sql:171`), explaining the 23h gap.

**STEP 1 — Confirm in prod FIRST (read-only).** Run via the `inspect-operator-state.mjs` PostgREST pattern using `SUPABASE_SERVICE_ROLE_KEY` from `.env.migrations.local`:
```sql
select id, title, status, starts_at, ends_at, last_lot_ends_at, closed_at, canceled_at
from auctions where title = 'Test Auction.2';

select count(*) as lot_count,
       count(*) filter (where status not in ('won','unsold','canceled','relisted')) as non_terminal
from lots where auction_id = '<that id>';
```
Expected to confirm: `status='live'`, `closed_at IS NULL`, `lot_count=0`.

**STEP 2 — Scope the fix on the result (do NOT build both branches blindly):**
- **If `lot_count=0`** → the empty-auction time fallback below is the complete fix. (Note: scheduled→live also requires a live/won lot — `0096:79-95` — so the auction had ≥1 lot at promotion, then it was hard-deleted or all lots went terminal-then-deleted, reverting to the zero-lot state.)
- **If `lot_count>0` AND `non_terminal>0`** (e.g. a `scheduled` lot with `close_at IS NULL` that `finalize_scheduled_no_bid_lots` never sees — it requires `close_at<=now()` at `0129:86-94` — or a `draft` lot under a live auction) → ALSO add a NULL-`close_at` guard / draft-lot reconciliation.

**STEP 3 — Migration fix (`CREATE OR REPLACE` the function):** add a 3rd UPDATE branch closing auctions `WHERE status IN ('scheduled','live') AND NOT EXISTS(any lot) AND COALESCE(last_lot_ends_at, ends_at) < now() - interval '<grace>'`. Leave the existing all-lots-terminal branch unchanged for the normal case. End the migration with a one-shot catch-up `SELECT advance_auction_lifecycle();` (mirrors `0125:108-119`) to immediately close Test Auction.2 and any other stuck rows.

**STEP 4 — (separate, web, low priority) "Ends" column honesty (item 18):** in `apps/operator-web/src/app/(operator)/auctions/page.tsx`, also select `last_lot_ends_at` (query at L34) and render `COALESCE(last_lot_ends_at, ends_at)` (L88-90). Pure web change; fixing the engine makes the stuck row disappear, this just makes the column honest.

**Not fixed by existing work:** migrations 0125 (`open_due_lots`) and 0129 (`finalize_scheduled_no_bid_lots`) operate on *lot* rows; neither adds a path to close a zero-lot auction. This is server-side SQL, still broken in master — no OTA relevance.

## 4. Already shipped — verify device build first

These were confirmed present in **origin/master** by investigation; do NOT rebuild. Recommend confirming Jared's Staff app build number / `runtimeVersion` (ASC API, Staff app `6767026881`) **before** scheduling any of his items, since `runtimeVersion.policy='appVersion'` means OTAs only reach matching app-version builds.

- **Item 3 — No-match workflow (explicit next-steps, no auto-save on miss):** 3-button picker (Identify with AI / Create manual lot / Cancel scan) in `quick.tsx:1351`; `manual.tsx` (661 lines, prefills code) registered in `_layout.tsx:43`. Shipped PR #128 (`915b715`) + #129 (`da2bc48`) + #136 (`b2f6ae3`).
- **Item 4 — In-app research tools:** `web.tsx` has Google Shopping/Amazon/eBay launch buttons (`openExternal`, L187) + a paste-a-URL scraper (`/api/lottr/scrape-url`, L111) that auto-fills title/MSRP/photo/description. Shipped PR #75 (`56f3352`) + #139 (`47724dc`) + #145. (Gap vs Jared's mental model: Walmart not yet an engine.)
- **Item 7 — Done-lag (~500ms):** `createLot` fast-path resets the camera the instant the RPC commits; photo upload, stock-photo mirror, `product_lookups` write, success haptic all fire-and-forget (`quick.tsx:407,447,715`); "Looking up…"/"Creating lot…" overlays (L934/L949). Shipped PR #71 (`938081d`).
- **No-match half of the headline review ask (item 8):** the *no-match* auto-save was already removed (PRs #128/#136). Only the **matched/manifest** auto-save remains (Batch 3).
- **`EditableCandidateCard`** with all of Jared's requested fields already exists and is wired into `scan.tsx`/`photo.tsx`/`index.tsx`/`worklist/[id].tsx` — only QuickLot wiring is missing.

**Repo hygiene (do before any of the above):** the local checkout is on branch `fix/wayfair-token-match` whose **uncommitted working tree reverts #128/#129 and deletes `manual.tsx`** (`-111` lines incl. removal of `onCreateManual`/`onCancelScan`). Stash/abandon it before it accidentally re-lands on master. Per memory `feedback_check_wip_before_worktree`, run `git status --short` before dispatching any worktree agents.

## 5. Owner decisions needed

- **Review/Edit gate (item 8) — the central decision:** (a) optional "Review before save" toggle default-OFF [recommended], (b) optional default-ON, or (c) always-on gate (kills speed advantage). Confirm before implementing Batch 3.
- **Partial-item Notes (item 10):** is a single bidder-visible Description sufficient [recommended, OTA-only/free], or is a separate internal staff-only notes field required (needs migration: `lots.staff_notes` + `p_notes`)?
- **Reserve in QuickLot review card (item 11):** expose Reserve at all? It's NOT in Jared's explicit ask. If yes → accept the follow-up-UPDATE pattern; if no → hide that one field in the QuickLot variant.
- **`manual.tsx` ("Create Custom Listing") shape (item 9):** reuse `EditableCandidateCard` for full field parity + DRY [recommended], or keep a deliberately-slim form?
- **No-match polish (items 13/14):** relabel "Cancel scan" → "Scan another item"? Surface the web-lookup button on the no-match card? Add Walmart (and Target) research-engine buttons?
- **Stale-build verification (item 12):** approve verifying Jared's exact Staff build via ASC API before scheduling work, to avoid rebuilding already-shipped behavior.
- **Auction empty-close (item 16):** (a) grace window before time-based empty-auction close (suggest 10 min past `COALESCE(last_lot_ends_at, ends_at)`); (b) terminal state for an empty past-end auction — `'closed'` [recommended, matches analytics intent] vs `'canceled'`; (c) confirm there's no product reason to keep empty auctions LIVE indefinitely (operator still curating).
- **Hard-delete policy (item 17):** is hard-deleting lots from a live auction an allowed operator action? If yes, the empty-auction close fallback is mandatory, not optional.
- **"Ends" column semantics (item 18):** show auction end (`last_lot_ends_at`), or show both first/last endpoints with labels?

## 6. Recommended sequence + rough effort

| Order | Work | Sev | Effort | Vehicle | Gate |
|-------|------|-----|--------|---------|------|
| 0 | Repo hygiene: stash/abandon `fix/wayfair-token-match` working-tree revert; `git status --short` | — | XS | — | Before any field-mobile work |
| 1 | **Batch 1 OTA hotfix:** `safeFlash()` across 5 sites + `CameraFlashButton` gate (1a) + `translateCaptureError` (1b) + `operator-role.ts` fail-open + guard re-check (1c) | P0/P1 | S–M | OTA (both channels) | Ship TODAY |
| 2 | Verify Jared's Staff build via ASC API (item 12); if stale, push fresh OTA so #128/#129/#136/#71/#75 reach him | P1 | S | OTA | After Batch 1 |
| 3 | **Batch 4 confirm query** against Test Auction.2 (read-only), then lifecycle migration + one-shot catch-up (items 16/17); web "Ends" column (item 18) | P1 | S | migration + web | Independent — can run parallel to 1/2 |
| 4 | Shared role-resolution helper refactor (item 7) | P2 | M | OTA | After Batch 1c lands |
| 5 | **Batch 3 Review/Edit gate** (item 8) + field-persistence (9/10/11) — *blocked on owner decision* | P1 | M | OTA | After owner picks (a)/(b)/(c) |
| 6 | Optional polish: "Scan another" relabel, web-lookup-on-card, Walmart/Target engines (items 13/14) | P2 | S | OTA | Anytime, low priority |

**Totals:** Batch 1 (S–M, ~½–1 day) unblocks staff and is the priority. Batch 4 (S) is independent server-side and can proceed in parallel after the prod confirm query. Batch 3 (M) is the only substantial build and is gated on the owner's toggle decision, but reuses ~80% existing UI. Everything except the auction lifecycle (migration) and the "Ends" column (web) ships by OTA to **both preview and production** channels.
