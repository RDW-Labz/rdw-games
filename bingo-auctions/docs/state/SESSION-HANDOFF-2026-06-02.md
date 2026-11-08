# Session Handoff — 2026-06-02 (discovery + QuickLot field-feedback + lifecycle fixes)

**Read first.** Durable record of what shipped today + what's left, so work resumes cold. Source of truth over chat. Companion docs: `QUICKLOT-FEEDBACK-PLAN-2026-06-02.md` (the 18-item QuickLot triage + 4 batches) · `docs/audits/discovery-findability-2026-06-02.md` (the discovery audit).

---

## ✅ Shipped + LIVE in prod today (PRs #147–#176, 30 merged)

**Discovery / findability (D-A → D-D) — COMPLETE, all deployed**
- #166 mobile-web: phone search icon + category drawer (existing mobile drawer wired) + 2-col lot grid + browse `deleted_at` filter.
- #167 app: "Live auctions" rail → filtered browse, watchlist heart on LotCard, cursor pagination (replaced silent `.limit(200)`).
- #168 homepage: "Ending soon" lot rail (brochure→marketplace), clickable RecentWins cards, sitemap `/category/[slug]`.
- #175 web-tail: **closed auctions render instead of 404** (shared/returning links) + browse empty-state CTA (was a dead `?view=auctions` link).
- #176 app D-D: scan **tap-to-start** (camera no longer eager on tab focus), search↔scan cross-link, above-grid category chips.

**QuickLot — Jared DeMeyer (RDB) field report, addressed end-to-end**
- #171 **P0**: camera-flash unblock — every `takePhoto` hardcoded `flash:'auto'`, which vision-camera rejects on no-flash iPads → staff couldn't attach photos. New `safeFlash(device, …)` across all 7 capture sites + friendly `translateCaptureError`. ALSO fixed false **"Not signed in as staff"** modal (`useOperatorRole` now fails-open on transient token-refresh blips). OTA'd to staff.
- #173 optional **Review-before-save** gate (default OFF; reuses `EditableCandidateCard`). OTA'd to staff.
- Already-shipped (Jared likely on a stale build): no-match 3-button picker (#128/#129/#136), in-app research tools (#75/#139), Done-lag fix (#71).

**Auction lifecycle**
- #170 (mig 0174): auctions stuck **LIVE** forever — `advance_auction_lifecycle()` required ALL lots terminal, but leftover **draft** lots (never published) have no close path. Added a window-gated branch closing scheduled/live auctions whose `COALESCE(last_lot_ends_at, ends_at)` is >10 min past once every NON-draft lot is terminal. Prod-verified: Test Auction.2 closed. (Confirm query proved the cause was draft lots, NOT empty auctions — first hypothesis was wrong.)

**Bidder UX / payments / pickup (Wave 1+2, #147–#164)**
- Payments: #153 schedule-gate (block auctions until Stripe charges enabled), #154/#155 declined-invoice payment recovery (web+app), #156 staff customer-search (mig 0173).
- Pickup: #150 app pickup overhaul, #151 web pickup parity, #158 pickup-mode taxonomy + `counter_pickup` (mig 0165), #157 floor-plan publisher (mig 0170), #163 forfeit escalation (mig 0166).
- Bidder: #148 receipt TZ crash, #149 invoices screen, #152 notifications tab + RLS (mig 0164), #160 past-wins, #161 browse warehouse filter, #162 notif fan-out (mig 0167), #164 web parity (notifs/saved-searches/identity).

**Infra / fixes**
- #165 mig 0165 constraint-ordering prod hotfix · #169 CI Node heap→6 GB (CF build OOM) · #172 homepage mobile horizontal-scroll regression (from #166 nav — hid wordmark <480px) · #174 + this doc.

**Migrations applied to prod today:** 0163, 0164, 0165, 0166, 0167, 0170, 0173, 0174.

---

## 🔑 Key learnings / gotchas (durable — these burned cycles)

- **operator-web E2E targets DEPLOYED PROD, not the PR build** (`apps/operator-web/playwright.config.ts` baseURL = `https://clovrbid.com`, runs *after* the deploy step). So a web fix shows **red on its own PR** until merged + deployed — admin-merge the PR (CI failure is the not-yet-deployed prod) then verify on the post-deploy E2E run. typecheck/lint/test DO run on the PR build (real signal).
- **`overflow-x: clip/hidden` does NOT reduce `documentElement.scrollWidth`** — to pass an overflow assertion you must make the element actually fit, not clip it. The nav overflow was the logo wordmark (167px) pushing the flexShrink:0 auth cluster to 475px; hiding the wordmark <480px got it to 344.
- **CI diagnostic pattern that cracked the overflow**: temporarily add a `console.log(JSON.stringify(offenders))` in the failing e2e test, push, read the GHA log — CI's real browser names the element when local browser tooling is sandboxed.
- **EAS OTA `--message` breaks on double-quotes**: a commit subject containing `"..."` shell-breaks `eas update --message "<subject>"`. Pass `-f message="quote-free text"` to the workflow.
- **Constraint-tightening + data-remap migrations must DROP→UPDATE→ADD** (mig 0165); CI's empty test DB never catches data-violation ordering.
- **Worktree isolation can't auto-create** when the harness cwd is outside the repo — create worktrees explicitly (`git worktree add -b … origin/master` from inside a worktree) and dispatch background agents into them by absolute path. One agent got a partial checkout missing the `(public)` tree and edited the wrong worktree — recover with `git stash` → `checkout -b … origin/master` → `stash pop`.

---

## 🔝 What's LEFT (prioritized; nothing blocking field staff)

**Owner-requested feature (biggest):**
- **S5b — universal scan → "on auction OR add to watchlist"** + preorder watchlist. Touches prod DB (migs 0168/0169 + `operators.watchlist_notify_method`). NOT built. PLAN first (read-only investigation → grounded plan → build + migrate on approval). Open sub-decisions: preorder semantics, notify-method.

**Medium:**
- **S9** — web pickup-DETAIL parity: lot photos + bin codes + item count + print stylesheet on `/profile/pickup/[id]` (operator-web/CF, no mig).
- **S14 D4–D11** — remaining web-parity pages (web my-bids/watchlist/my-stats/profile-edit/Pro-sub/lot-detail-realtime) + ClovrRush on the app + app filter count-badges.
- **S15 notif mediums** — E4 "you lost" push · E5 closing-soon→active bidders · E6 operator no-show alert · E7 refund email+SMS · E9 `new_auction_live`.
- **Cluster F foot-guns** — F2 auction-form operator defaults · F3 pickup-hours cross-validation · F5 timezone dropdown · F8 enrichment DLQ alert.

**Discovery / QuickLot polish tail (all OTA/CF, no mig, low-risk):**
- ClovrRush-on-mobile (deferred — must NOT re-break nav width; put it INSIDE the mobile drawer, not the nav row).
- QuickLot: shared role-resolution helper refactor (`useOperatorRole`/`useRole`/`useBidderRole`), "Cancel scan"→"Scan another item" relabel, Walmart/Target research engines.
- `how-it-works` route move into `(public)` (gets nav/search); `charge.dispute.created`→`evidence_due_by`; A3 mobile my-bids grace countdown; S14 profile NavCard links.

**Owner-side (non-code, you):** reject 2 dead probe Connect accounts (`acct_1TaP60Pn`, `acct_1TaOcfPj`) · delete 2 scratch warehouses (Test, Test Test) · verify Jared's Staff TestFlight build is current (so the camera/no-match/research OTAs reach him; `runtimeVersion.policy='appVersion'`).

**Parked (audit-deferred — decide if wanted):** confirm_pickup time-gate · storage fees · 48-hr return window · companion/delegate pickup · bulk-verify bin-scan bypass.

---

## 🧹 Cleanup state
- 20 merged `wt-*` worktrees pruned mid-session; 6 skipped (had untracked/WIP files — not force-deleted). Remaining today's worktrees (`wt-batch3`, `wt-dd`, `wt-discweb`) can be pruned now that #173/#175/#176 merged.
- Enrichment drain: confirm `done > 0` as it reaches the NULL-photo `import_rows`.

## Hard constraints (CLAUDE.md)
PowerShell + `cd C:\Users\jmacl\Projects\auction-platform` first · prod Stripe = `acct_1TaMSs` only · `stripe-best-practices` skill before Stripe work · worktree isolation for parallel write-agents · prod migs dry-run→`--live`→verify · OTA JS-only, BOTH preview+production channels, don't touch in-review iOS #41/#54 · no attribution trailer · stage by name (no `git add -A`) · super-admin `jmacluer@gmail.com` · Supabase project `xgsujdzicnjenhqihovk` · the main checkout (`fix/wayfair-token-match`) belongs to a PARALLEL session — leave untouched.
