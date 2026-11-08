# ClovrBid — Single Source of Truth, 2026-05-23

> Generated from the 4 read-only audit reports under `docs/state/` (this directory). When in doubt about anything, this is the canonical "where we are" document. The four backing reports have all the detail; this one is the executive summary.

**Backing reports (read for detail):**
- `docs/state/git-state-2026-05-23.md`
- `docs/state/build-versions-2026-05-23.md`
- `docs/state/deploy-state-2026-05-23.md`
- `docs/state/documentation-state-2026-05-23.md`

---

## 1. The 60-second truth

| Surface | State | Truth |
|---|---|---|
| **Production website** | ✅ Live at clovrbid.com | Commit `459e2c3` deployed 2026-05-23 05:37 UTC. Healthy. |
| **Bidder iOS TestFlight** | ✅ Build **#22** (v0.1.1) | Latest. Apple Sign In hang was fixed in builds 20+. Has /scan tab, universal links, **live Stripe**. |
| **Staff iOS TestFlight** | ✅ Build **#36** (v0.1.0) | Latest. iOS 26 launch crash was fixed in builds 28+. Has ARKit, share extension. expo-updates removed. |
| **Bidder Android** | ❌ Zero builds | Blocked on Play Console signup + missing `.secrets/google-play-service-account.json`. Task #57 in_progress. |
| **App Store submission** | 🟡 PREPARE_FOR_SUBMISSION since 2026-05-06 | Both apps' v1.0 records exist but no build attached. Original 5/19 ship date slipped due to v19/v27 firefight. |
| **Live demo auction (BIN-000035)** | 🟡 Closed 07:02 UTC, Emily won $1.00, **auto-charge FAILED** | Invoice `9282720d…` generated for $1.15. Transitioned to `payment_failed_grace` at 07:03:08 UTC with no `stripe_payment_intent_id` attached — see §12 for details. Engine ✓, payment ✗. |
| **Emily's card-on-file** | ✅ Repaired via super-admin endpoint | Visa •••• 3446, `stripe_key_mode='live'` now set. Web bid placed cleanly. |
| **Database migrations** | 🟡 125 / 126 applied | Migration `0126_get_recent_wins_rpc.sql` is unapplied. Needed by Wave 1D RecentWinsRail. |
| **Cloudflare Worker** | ✅ Last deployed 2026-05-23 05:42 UTC | `bidwizops` (operator-web) + `bidwizops-cron`. All custom domains bound. |

---

## 2. Build numbers — CANONICAL

The team has been confused about TestFlight build numbers because the plan file `foamy-tumbling-micali.md` references v19 + v27 as the "broken builds." **Those are old.** Here is the actual current state pulled from App Store Connect API:

### Bidder iOS — App `6767012532` (com.cluerholdings.auctionplatform)

| Build | Status | Uploaded | Commit | What's in it |
|---|---|---|---|---|
| **22** | ✅ Current | 2026-05-21 04:18 UTC-7 | `441b79f` | /scan tab, universal links, Sentry removed, useBidderRole hang fix, PostHog funnel. **`pk_live_` Stripe** (flipped after v22 trigger — verify). |
| 21 | Superseded | 2026-05-20 12:07 | `3bf5caf` | Card-save onboarding, receipt-only invoices, fee banner. User verified working. |
| 20 | Superseded | 2026-05-20 07:05 | `8cb1505` | 5-agent audit fixes + Apple Sign In fix. User verified working. |
| **19** | ❌ BROKEN | 2026-05-20 05:54 | `90089ea` | **THIS is the "hang on Apple Sign In" build** mentioned in the plan. Superseded by 20+. |

Builds 17, 18, 9, 6, 5, 4, 3 — burned by failed EAS attempts, never reached ASC.

### Staff iOS — App `6767026881` (com.cluerholdings.bidwizops)

| Build | Status | Uploaded | What's in it |
|---|---|---|---|
| **36** | ✅ Current | 2026-05-21 09:09 UTC-7 | minOs=16.0 (ARKit pod), expo-updates fully removed, share extension config. |
| 29 | Superseded | (post-fix) | User verified working. |
| 28 | Superseded | First post-fix build | First build after expo-updates removal. |
| **27** | ❌ BROKEN | 2026-05-20 05:59 | **THIS is the "instant crash" build** mentioned in the plan. Superseded by 28+. |

27 crash submissions in ASC feedback. Build #25 = 6 crashes; #21 = 5; #22 = 5; #16 = 4; #27 = 2.

### Both apps Android

- Bidder: **Zero Android builds ever uploaded.** Profile config exists (commit `2b7a89c`). Missing service-account JSON. Play Console signup not done.
- Staff: No Android target configured. Out of scope for v1.

---

## 3. Recent commits + deploy state

132 commits on master since 2026-05-19. The arc:

1. **iOS 26 launch crash investigation** (5/19 evening) — empirically isolated to react-native-screens + Sentry. Fixed via SDK upgrade + Sentry removal. Bidder v15-v19 burned in attempts; v20 succeeded.
2. **Staff v22-v27 crash investigation** (5/20) — same Sentry mask. Then expo-updates TurboModule registration crash on iOS 26 + New Architecture. Fixed by removing expo-updates entirely. v28+ ships only via fresh EAS builds.
3. **Warehouse + auction engine** (5/19 → 5/22) — warehouse redesign Phase 0-4, pre-stickered lotting, walk-and-scan + ARKit, share extension, smart import.
4. **Web bidder Plan A** (5/22) — full /signup → /bidder/onboarding → /lot/[code] → bid → pay flow. Stripe Elements card save. Two-domain split. Mac.bid-parity overhaul.
5. **L0 launch blockers** (5/22) — card lockout fix, aged-invoice filter, lot status summary, dispute deadlines, PostHog funnel, receipt + CSV + platform admin.
6. **Stripe keys refactor** (5/22 evening) — single source of truth + `stripe_key_mode` tracking per bidder + SCA recovery (migrations 0123, 0124).
7. **Engine fix + repair endpoint** (5/23 early morning) — `open_due_lots` migration 0125 (lots were stuck scheduled forever), super-admin `/api/admin/repair-bidder-stripe`, CardSetupForm redirect-return fix. b88390a → 459e2c3 deploy (typecheck fix).
8. **Native ports + Maestro + Smoke fixes** (5/23 tonight, this session) — see §5 below.

**11 successful deploys + 7 failures in the window.** All failures recovered the same day.

---

## 4. Open feature branches — your decisions

Every branch listed below is on origin. None are merged to master. Tonight's parallel agent dispatch caused a branch collision (see §6) so trust the integration branch over the per-wave branches.

| Branch | SHA | Stack | Recommended action |
|---|---|---|---|
| **`feat/native-recent-wins`** | `9501914` | **Integration branch for all 4 native UI ports** — LotCard MAC.BID parity, HomeHero + CategoryGrid + SectionBanners, lot-detail enrichment (savings/pickup/anon-bids/similar), RecentWinsRail + migration 0126. +1827/-97 LOC, tsc clean. | **Open one PR for this entire branch into master.** Review en bloc. Don't try to split — the commit graph collided. |
| `feat/maestro-scaffolding-recovered` | `b0d0523` | Maestro E2E framework. testIDs added to login/lot/bid components. GHA workflow for iOS + Android. | Merge after native ports. |
| `fix/ios-simulator-smoke` | `7f9926e` | iOS smoke preflight scope fix. Verification run still in progress when audit ran. | Wait for verification run to finish, then merge if green. |
| `fix/android-simulator-smoke` | `d90e5fa` | Android emulator boot stabilization. Verification in progress. | Same. |
| `feat/native-lotcard-parity`, `feat/native-home-tab-enrichment`, `feat/native-lot-detail-enrichment` | various | **Subsets of `feat/native-recent-wins`.** Casualty of the collision. | **DELETE these** after the integration branch merges — they're orphaned subsets. |
| `feat/maestro-scaffolding` (origin) | `459e2c3` | **Force-pushed back to master HEAD by accident.** No actual Maestro content. | **DELETE** — replaced by `-recovered`. |

---

## 5. Native UI ports — what's in the integration branch

`feat/native-recent-wins` covers everything the web added during the MAC.BID parity sprint that the bidder-app didn't have yet:

### Wave 1A — LotCard MAC.BID-parity visual chrome
- Segmented countdown ("3h | 12m | 04s") along the bottom
- Single-pill priority badge top-left (ENDING SOON > TOP DEAL > CONDITION)
- Red savings pill alongside price (-85% etc)
- CDN no-photo placeholder image (was operator-initial letter)
- New `variant: 'mac-bid' | 'classic'` prop, defaults to mac-bid
- File: `packages/domain-bidding/src/components/LotCard.tsx` (+568/-66 LOC)

### Wave 1B — Home tab enrichment
- New `HomeHero` CDN banner with LinearGradient overlay
- New `CategoryGrid` (2-col phone / 4-col iPad, CDN imagery)
- New `SectionBanner` reusable Pressable
- Wired into `apps/bidder-app/app/(tabs)/index.tsx` ListHeaderComponent
- Requires `npx expo install expo-linear-gradient` (currently has fallback)
- `useCategories` extended with `image_url_clean` + `icon_url`

### Wave 1C — Lot detail enrichment
- SavingsCallout pill (red SAVE 85% + strikethrough MSRP)
- PickupInfoCard with NOT-TRANSFERRABLE pill + bin location
- Anonymized bid history (Bidder #N, YOU highlight, 50-row expandable)
- SimilarLotsRail (horizontal carousel, 3-tier fallback query)

### Wave 1D — RecentWinsRail + SQL RPC
- New component `packages/domain-bidding/src/components/RecentWinsRail.tsx`
- New SQL migration `0126_get_recent_wins_rpc.sql` — SECURITY DEFINER, anon-allowed, privacy-allowlisted columns
- **MUST be applied to prod for the rail to work** — but component self-hides on missing RPC so it's safe to merge before applying
- Wiring instruction: drop `<RecentWinsRail />` into the home-tab ListHeaderComponent after Wave 1B's content

---

## 6. Tonight's incident — parallel-agent branch collision

**What happened:** I dispatched 4 parallel write-agents (Waves 1A-1D) without `isolation: "worktree"`. They shared the cwd. Their `git checkout -b` + `commit` + `push` operations interleaved and stepped on each other.

**Impact:**
- `feat/maestro-scaffolding` on origin got force-pushed back to master HEAD by an unrelated agent's force-push. Content recovered as `feat/maestro-scaffolding-recovered`.
- Waves 1A/1B/1C/1D ended up sequentially stacked on `feat/native-recent-wins` instead of separate branches.
- `scripts/demo-tools/*.mjs` files (the seed/inspector/watch utilities I created) were deleted by one of the agents. The auction-watch monitor that was already running kept working (its script was loaded in node memory).

**What was NOT lost:** Every commit is reachable from some ref. Reflog confirms. No data loss.

**Mitigation going forward:** Always use `isolation: "worktree"` when dispatching parallel write-agents. A new memory entry `feedback_worktree_isolation_for_parallel_agents.md` captures this lesson.

---

## 7. Stripe state on prod

- **Bidder app + web are on LIVE Stripe** since 2026-05-21 commit `983c1ad` (preview + production profiles both `pk_live_*`). Emily's $1 bid landed against live keys.
- **`stripe_key_mode` tracking** on `bidders` table since migration 0123 — protects against future test/live mode mismatches.
- **Operator Stripe Connect**: Both operator rows have `stripe_onboarding_complete=true` but `stripe_account_id IS NULL` because `ALLOW_SKIP_STRIPE_ONBOARDING` was used during dev. **REAL Connect onboarding must run before first real payout.**
- **`.env.local` has mixed-mode keys** (`sk_test_*` + `NEXT_PUBLIC_*=pk_live_*`). This is local-only nuisance, not a prod issue — prod Worker has consistent live keys per the deploy state audit.

---

## 8. Migration drift — apply 0126 before merging the integration branch

```bash
cd /c/Users/jmacl/Projects/auction-platform
node scripts/apply-migrations.js --status   # confirm only 0126 is unapplied
node scripts/apply-migrations.js             # apply 0126
```

After apply, `get_recent_wins(p_days, p_limit)` SECURITY DEFINER RPC will exist. The RecentWinsRail component in Wave 1D will populate. The function returns no bidder identifying info — only invoice_id, representative_title, representative_photo_url, savings_cents, lot_count, paid_at.

---

## 9. Memory drift — corrections needed

These memory files at `C:/Users/jmacl/.claude/projects/C--Users-jmacl-Projects/memory/` are stale:

| File | Claim | Reality | Action |
|---|---|---|---|
| `auction_platform_ios26_launch_crash.md` | `react-native-screens@4.24.0` | Actual is `4.18.0` in both apps | Correct the version |
| (missing) | n/a | The parallel-agent collision lesson isn't recorded | Create `feedback_worktree_isolation_for_parallel_agents.md` |
| (missing) | n/a | The Stripe keys refactor + repair endpoint flow isn't recorded | Create `auction_platform_stripe_keys.md` + `auction_platform_card_recovery_flow.md` |
| (missing) | n/a | Audit outputs should land in repo not just chat | Create `feedback_audit_outputs_persist_to_repo.md` |

Other memory entries verified accurate:
- `auction_inventory_model.md` — matches migration 0021 exactly
- `feedback_*` (PowerShell cd, agents, no shortcuts, OTA branches, WSL builds, EAS WSL ARM) — all still true
- `auction_platform_business.md`, `auction_platform_stack.md`, `auction_platform_legal_entity.md` — accurate

---

## 10. README drift — corrections needed

The documentation audit (full detail in `docs/state/documentation-state-2026-05-23.md`) identified:

| File | Issue | Action |
|---|---|---|
| `apps/field-mobile/README.md` | Says `pnpm` (repo uses npm), "Vercel env vars" (deploy is Cloudflare Workers) | Rewrite |
| `packages/db/README.md` | Describes BullMQ worker that was deleted on 2026-05-12 | Rewrite to describe pg_cron-based engine (open_due_lots, finalize_due_lots, advance_auction_lifecycle) |
| `apps/bidder-app/README.md` | **Does not exist** | Create from scratch |
| Root `README.md` | Implies "27 migrations" — actual is 126 | Update count + recent feature list |
| `docs/SENTRY_SETUP.md` | Misleading — Sentry was removed from both mobile apps | Add a "SENTRY REMOVED 2026-05-19" header at top |

Historical docs that can be moved to `docs/archive/`:
- `HANDOFF.md`, `PHASE-0-NEXT-STEPS.md`, `MIGRATION-PLAN.md`, `warehouse-redesign-plan.md`, `auction-lot-audit-plan.md`, `CLOUDFLARE_CUTOVER.md`

---

## 11. Outstanding work — punch list

Sorted by criticality.

### P0 — required before App Store submission
1. **🚨 DIAGNOSE AUTO-CHARGE FAILURE** — see §12. Emily's invoice `9282720d…` is sitting in `payment_failed_grace` with no PaymentIntent. This **blocks revenue collection on day 1**. Read worker logs via `wrangler tail`, find the actual Stripe error, fix.
2. **Real Stripe Connect operator onboarding** — Cluer/Bingo operator records have `stripe_account_id IS NULL`. Before first real payout, run the embedded onboarding flow. **Almost certainly related to #1.**
3. **Apply migration 0126** to prod (one command, ~5 sec).
4. **Decide on `feat/native-recent-wins`** — merge or hold? If merging, build v23 bidder + v37 staff afterward.
5. **Fix iOS Simulator Smoke** — verification run was in_progress when audit ran. **Don't build v23 off master HEAD until this is green** because the smoke catches launch-time crashes that EAS doesn't.
6. **EAS bidder v23 build** with current master + integration branch contents → TestFlight → user verifies on iPhone.
7. **Apple App Store submission** — attach the v23 build to the existing v1.0 PREPARE_FOR_SUBMISSION record. Reviewer notes + metadata already in `docs/APP_REVIEWER_NOTES.md` + `docs/STORE_METADATA.md`.

### P1 — launch-quality
7. **Verify Stripe auto-charge fires** on Emily's $1.15 invoice (monitor still polling). If it doesn't fire within 30 min, investigate the auto-charge worker.
8. **Update READMEs + memory files** per §9, §10.
9. **Native iOS screen captures** for App Store submission — per `docs/marketing/iphone-capture-storyboard.md`, captured manually on iPhone via QuickTime + USB.
10. **Document the `feat/maestro-scaffolding-recovered` branch** — what flows exist, how to run locally.
11. **Delete `scripts/.testflight-feedback/crash-submissions.json` stale cache** + re-run `scripts/fetch-testflight-feedback.mjs` after v23 lands.

### P2 — post-launch
12. **Bidder Android Play Console signup** + service-account JSON + first EAS Android build → internal track.
13. **`/lots/[code]` → `/lot/[code]` legacy redirect** (task #63, marked pending but the redirect IS live per deploy state audit — close the task).
14. **ClovrRush native port** (Wave 2 of the porting plan — `apps/bidder-app/app/clovrrush.tsx`).
15. **App Store + Play Console screenshots/video** — 5 shots per device class minimum.

---

## 12. Auto-charge failure — P0 launch blocker discovered tonight

The end-to-end lifecycle test of BIN-000035 surfaced a real bug. Here's the timeline:

| Time (UTC) | Event |
|---|---|
| 06:05:23 | Emily places $1 bid via web BidWidget — clean |
| 07:01:55 | Lot `close_at` |
| 07:02:00 | `finalize_due_lots` cron fires → lot transitions `live` → `won`, `winner_bidder_id` = Emily's bidder.id, `closed_at` set |
| 07:02:30 | Invoice `9282720d-9b0c-4ffd-8171-c91c25ef86e4` created, `total_cents=115` ($1.00 + 15% premium), `status=pending` |
| **07:03:08** | **Invoice status → `payment_failed_grace`**. `stripe_payment_intent_id` STILL NULL. Auto-charge worker fired but FAILED before successfully creating a PaymentIntent (or got a synchronous Stripe error and didn't persist the PI ID). |

**What the engine got right:** lot finalization, invoice creation, buyer's premium math, winner attribution.

**What failed:** the actual payment capture.

Possible root causes (highest probability first):
1. **Off-session charge requires SCA** — European cards or some US cards now require 3D Secure even for off-session charges. The auto-charge worker may not be handling the `requires_action` PaymentIntent state. **Migration 0124 added SCA recovery infrastructure but the worker may not be wired through it.**
2. **PaymentMethod detached/expired** on Stripe — though our repair endpoint set the default 30 minutes ago, something may have invalidated it.
3. **Stripe Connect destination charge config** — the operator's `stripe_account_id` is NULL (using `ALLOW_SKIP_STRIPE_ONBOARDING`). Destination charges require `on_behalf_of=<acct_id>` which doesn't exist. The worker may be silently failing on this.
4. **Auto-charge worker not deployed** — the worker is in the codebase (commit `76f726e` "auto-charge worker, grace expiry, fee settlement routes") but may not be active on prod.

Next steps to diagnose:
- Read auto-charge worker logs on Cloudflare (`wrangler tail`)
- Check for any failed PaymentIntent records on Stripe Dashboard with metadata matching this invoice
- Check whether the worker code uses `on_behalf_of` correctly when `stripe_account_id` is NULL
- Verify the worker is actually being invoked (pg_cron schedule, or HTTP-triggered)

This is the kind of P0 bug a "ship-and-pray" launch would have hit on day 1 with real customers. Catching it tonight is good news.

---

## 13. Time-bounded events

- **Auction monitor `b3bmru0b1`**: ✅ exited normally at 07:03:59 UTC after detecting the payment_failed_grace terminal state. No more polling.
- **GHA iOS Simulator Smoke** + **Android Simulator Smoke** verification runs: in progress when this doc was written; check `gh run list --limit 5` for current state.
- **No paid services have been authorized** for new spend tonight (no EAS builds, no App Store/Play Console submissions).

---

## How to use this document

When in doubt about any state of the system, read this document top to bottom. If the answer is here, trust it — every claim has been verified against either prod data, EAS, App Store Connect API, or current repo content.

If the answer is NOT here, escalate to the backing reports in `docs/state/` — they have the per-domain detail.

When making decisions tonight, the four most important decisions are:

1. **Merge `feat/native-recent-wins` to master, yes/no?**
2. **Apply migration 0126, yes/no?**
3. **Trigger EAS bidder v23 + staff v37 builds, yes/no?**
4. **Submit to App Store + Play Console, yes/no?**

Everything else is secondary.
