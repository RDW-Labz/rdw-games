# Launch Plan — Day Of (target: 2026-05-24)

Generated 2026-05-23 after audit synthesis. Sources:
- `docs/state/STATUS.md` (state of system)
- `docs/audits/pre-stickered-workflow-drift-2026-05-23.md`
- `docs/audits/admin-rbac-leak-2026-05-23.md`
- `docs/audits/lot-lifecycle-bugs-2026-05-23.md`
- `docs/audits/routing-nav-bugs-2026-05-23.md`
- `docs/audits/auto-charge-diagnosis-2026-05-23.md`
- User-supplied 33-issue operator console audit (in conversation)

## Corrected mental model

- **GOLD RUN LLC** — owns the ClovrBid platform overall (not an operator)
- **BinGo Auctions** — operator #1, the user's actual auction company; will go live tomorrow
- **DEMO Auctioneer** — test operator, will be hidden from launch
- Prior STATUS.md §7 claim that both operators have `stripe_account_id IS NULL` is confirmed by DB query. BinGo needs **real** Stripe Connect Standard onboarding.

## Critical findings summary

| Audit | Verdict | Action |
|---|---|---|
| Pre-stickered drift | 1 launch blocker (mig 0127), 1 OTA, 1 cosmetic | Apply fixes |
| Admin RBAC leak | NOT a code bug — likely sidebar UX confusion (super-admin who is also operator staff) | Add visual divider; verify with non-allowlist account |
| Lot lifecycle bugs #4-6 | 3 fixes in 2 files (null guards + status set) | Apply fixes |
| Routing bugs #1, #3 | One middleware fix solves both | Apply fix |
| Routing bugs #17, #19, #20 | RLS policy + sidebar entry + dashboard href | Apply fixes |
| Auto-charge failure | Operator stripe_account_id NULL — by design | Real Connect onboarding for BinGo |

## Execution phases

### Phase A — DB migrations (sequential, 5 min)
1. Apply migration `0126_get_recent_wins_rpc.sql` (already in repo, on feat/native-recent-wins)
2. Author + apply migration `0127_batch_intake_qr_token.sql` — copy qr_token branch from `intake_lot_to_bin` (mig 0103) into `batch_intake_lot_to_bin`

### Phase B — Web operator-console fixes (parallel agents, worktree isolation, ~20 min)
**Wave B1 — Routing/sidebar (1 agent):**
- `middleware.ts:288-298` — gate /auctions redirects behind `if (!user)` (fixes #1 + #3)
- `dashboard/page.tsx:337` — `/lots` → `/lotting/inventory?status=live` (#20)
- `layout.tsx` — add Fulfillment Link entry (#19)
- `layout.tsx:182` — "Print blank stickers" → "Print blank QR stickers" (#33)

**Wave B2 — Lot detail/edit (1 agent):**
- `lotting/inventory/[id]/page.tsx:107` — `Lot #${lot.lot_number}` → fall back to `lot_code` (#4)
- `lotting/inventory/[id]/page.tsx:221` — null-guard `close_at` (#5)
- `EditLotForm.tsx:40` — add `'in_inventory'`, `'pending_intake'` to allowed-pricing-edit set (#6)

**Wave B3 — RBAC clarity + Drafts (1 agent):**
- Add "Signed in as platform admin" visual divider above Platform section in layout (RBAC P2)
- Investigate Drafts table RLS for `status='pending_intake'` SELECT (#17) — DB policy patch if needed

**Wave B4 — Operator auctions page (1 agent, may need new page):**
- Check if `/auctions` operator page exists; if not, build minimal listing OR re-point sidebar link

### Phase C — Field-mobile fixes (parallel agents, worktree isolation, ~15 min)
**Wave C1 — Lotting mode persistence (1 agent):**
- `LottingModeContext.tsx:17` — add AsyncStorage persistence (`@lottr/lotting-mode/v1`)
- `lotting/index.tsx` — mount `LottingModeToggle` on the hub

### Phase D — BinGo Stripe Connect onboarding (1 agent, sequential)
1. Build a one-off script that uses `stripe.accounts.create({type: 'standard', ...})` with BinGo's real business data
2. Upsert `operators.stripe_account_id` for the BIN operator row
3. Generate `AccountLink` and surface it via DB record / direct URL for user to complete identity verification with Stripe
4. Update task #11

**This phase requires user-supplied data — see "What I need from you" below.**

### Phase E — Lower-priority audit fixes (parallel agents, worktree, ~30 min)
Bucket E1 (copy/typo cluster — 1 agent):
- #14 "Cluer" → "ClovrBid" in Settlements + Pro tier
- #15 Settlement hold days copy mismatch (90 vs "4 default")
- #25 Worker Productivity DB column names + "aintake" typo
- #26 Auto-relist pg_cron reference
- #27 TestFlight env var names
- #28 Admin display name field
- #29 Staff role badge style consistency
- #31 "Phase 2" placeholder

Bucket E2 (data rendering — 1 agent):
- #8 Billing subscription contradictory state
- #9, #10 Reports month label + forward nav
- #11 Invoice status human labels
- #12 Invoice detail title (full ID or seq number)
- #13 Lot timeline actor name (join to staff)
- #16 Lot photo black box
- #24 Source column always "—"
- #30 AI Usage linked lot links
- #32 Settings save button placement

Bucket E3 (layout overflow — 1 agent, possibly post-launch):
- #21 AI Lotting overflow
- #22 Worker Productivity overflow
- #23 Admin Operators table overflow
- #18 Warehouse Setup button feedback

### Phase F — Validation (sequential, ~15 min)
- Run `ios-simulator-smoke` workflow
- Run `android-simulator-smoke` workflow
- Run Maestro smoke flows
- Headless Playwright sweep of operator console (re-verify each fixed item from the 33-issue audit)

### Phase G — Native UI + App Store (sequential, ~30 min + EAS build time)
1. Merge `feat/native-recent-wins` into master (after migrations 0126 + 0127 are applied)
2. Trigger EAS build v23 (bidder) + v37 (staff) — **blocked on EAS auth, need user trigger from Mac or CI workflow**
3. Wait for builds to upload to App Store Connect
4. ASC API: attach v23 to the existing v1.0 PREPARE_FOR_SUBMISSION record (bidder), v37 to staff
5. Submit for review

### Phase H — Cleanup (parallel, ~5 min)
- Void Emily's invoice 9282720d (test data; no charge ever fired)
- Commit cleanup work (audit reports + demo-tools + memory updates) to chore branch + PR
- Hide DEMO operator from production lot creation flow (operator selector filter)
- Verify SUPER_ADMIN_EMAILS prod value (rotate to only `michael@cluerholdings.com` if not already)

## What I need from the user

### For Phase D (BinGo Stripe Connect):
- BinGo Auctions legal entity name
- Tax ID / EIN
- Business address (state, ZIP — Arkansas?)
- Bank account: routing + account number
- Representative SSN last 4 digits
- Business phone, business email
- MCC / industry (auctions ~ 5999 or 7299 typically)
- Average ticket size estimate
- Annual transaction volume estimate

### For Phase B3 (RBAC misperception verification):
- Confirm: are you signed in as `michael@cluerholdings.com` AND a member of `operator_users` for the BinGo operator? If yes, the "leak" is misperception and we just add the visual divider. If no, real RBAC bug + we need to repro with the actual user.

### Decisions (from STATUS.md §11, still valid):
- Decision #1: Merge `feat/native-recent-wins` into master? **(needed before bidder builds)**
- Decision #2: Apply migration 0126 to prod? **(needed for RecentWinsRail in bidder app)**
- Decision #3: Trigger EAS bidder v23 + staff v37 builds? **(EAS not on Windows — how do you want to trigger?)**
- Decision #4: Submit to App Store? **(requires #3 to complete)**

## Risks + honest realities

- **Stripe Connect verification can take hours to days** for Standard accounts. We can submit the application tonight; full activation may not complete by tomorrow morning. Workaround: have BinGo do a fast-track ID upload via Stripe Dashboard once we initiate.
- **App Store review takes 1–7 days.** "Launch tomorrow" likely means *submit* tomorrow; actual store availability follows review.
- **EAS CLI not authenticated on this Windows box** (per memory). Build trigger needs to come from a Mac OR a CI workflow that has EAS credentials.
- **All 25 lower-priority audit items may not all land**. We'll triage in Bucket E based on first-customer impression risk. Likely defer overflow-table layout fixes (#21-23) to post-launch.
- **Drafts RLS investigation** (#17) may turn up a real policy bug that needs a migration — if so, it joins Phase A.
- **Parallel agent collisions** — per memory, all parallel write-agents use `isolation: "worktree"`. Mandatory.

## Order of operations (TLDR)

1. User confirms plan + supplies BinGo data + verifies RBAC misperception
2. Apply migrations 0126 + 0127
3. Parallel B-waves (operator console fixes)
4. Parallel C-wave (field-mobile OTA)
5. Phase D (Stripe onboarding init)
6. Parallel E-buckets (lower-priority)
7. Validation (smoke + Maestro + Playwright sweep)
8. Native merge → EAS build → ASC submit
9. Cleanup + commit
