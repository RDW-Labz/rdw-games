# ClovrBid Tester Feedback Triage — June 5, 2026

**Method:** 8 parallel read-only investigators over master tip `b9f15ac` + adversarial verify pass on every bug + dependency/burial critic (15 agents, 1.85M tokens). All root causes cited to `file:line`. Server-side claims confirmed against **live prod** via Supabase Management API (project `xgsujdzicnjenhqihovk`). Code source of truth: worktree `auction-platform-wt-land` (master tip; the main checkout is 133 commits behind on an unrelated WIP branch).

**Adversarial verify changed three conclusions** — see CHK-1 (camera theory overturned), INV-1 (reframed as OTA-delivery, not code), BIDCOUNT-1 (mechanism corrected to double-write via live data).

---

## Severity-ranked summary

| ID | Sev | Type | Title | Root cause confirmed? | Needs owner decision? |
|----|-----|------|-------|----|----|
| **CHK-04** | 🔴 critical | bug | In-checkout staff **refund is 100% broken** (relative URL + no auth bearer) | ✅ confirmed | no |
| **INV-1** | 🔴 critical | regression | App **"Invoice Not Found"** — already FIXED in code (#210); **OTA-delivery** gap | ✅ confirmed (code) | verify delivery |
| **CHK-1** | 🔴 critical | bug | Item-verification scanner dead | ❌ **OVERTURNED — cause unknown** | needs device repro |
| **BIDCOUNT-1** | 🟠 high | bug | Bid count **off-by-one double-write** (3 vs 1) | ✅ confirmed + live data | minor (semantic) |
| **RELIST-2** | 🟠 high | bug | Relisted lots **drop sticker/QR** → unscannable (25/25 live) | ✅ confirmed + live | yes (move-forward) |
| **QR-2** | 🟠 high | bug | Quick Lot **silently swallows** sticker-bind failures | ✅ confirmed | no |
| **QR-1** | 🟠 high | bug | UUID QR writes only `qr_token`, never a human label → display stuck on `lot_code` | ✅ confirmed | yes (display model) |
| **PICKUP-LOC-1** | 🟠 high | bug/regr | Mobile pickup **hides shelf location** in `staff_assisted` (web shows it) | ✅ confirmed (code) | yes (framing) + disambiguate |
| **BID-1** | 🟠 high | enhancement | App vs web bidding inconsistent; #231 created **double bid surface** on mobile | ✅ confirmed | yes |
| **CHK-03** | 🟠 high | enhancement | **No manual-checkout** fallback (W6-P1 removed it) | ✅ confirmed | yes (guardrails) |
| **BID-2** | 🟡 med | enhancement | Web bid confirm shows premium/total (mobile already clean) | ✅ confirmed | yes (legal?) |
| **BID-3** | 🟡 med | enhancement | **Configurable bid increments** (operator-tiered) | n/a (net-new) | yes (scope) |
| **CHK-01** | 🟡 med | enhancement | Identity-verify **not gateable** (no policy column) | ✅ confirmed | yes (threshold) |
| **CHK-2** | 🟡 med | enhancement | "Scan Bin" copy — handler actually validates a **bin**, not a lot | ✅ confirmed | yes (rename vs re-point) |
| **CHK-06** | 🟡 med | question | Pickup QR is **static** (good for print) + web-QR/staff-scanner **parity risk** | ✅ static confirmed; parity unverified | confirm intent |
| **WEB-NAV-1/2/3** | 🟡 med | enhancement | No dedicated web **Watch List / My Bids / Winning** nav | ✅ confirmed | yes (placement) |
| **RELIST-1** | 🟡 med | question | Carryover semantics (answered below) | ✅ confirmed | reporting follow-up |
| INV-2, INV-3, QR-3, QR-4, PICKUP-LOC-2, CHK-02, CHK-05, BID/WEB-NAV-4 | low | mixed | hardening / parity / already-OK | mostly | — |

---

## CRITICAL

### CHK-04 — In-checkout staff refund is non-functional (the tester's "no refund option")
- **Root cause (confirmed):** `RefundItemsSheet.tsx:238` calls `fetch(`/api/invoices/${id}/refund-items`)` — a **relative URL** (no `API_BASE`; RN has no document origin → network error) **and** sends no `Authorization` header, while `api/invoices/[id]/refund-items/route.ts:91` authenticates via cookie `getUser()` + `operator_users.role IN (admin,manager)` + AAL2. A bare RN fetch carries neither → 401/403 even if the URL resolved. Fails closed (no money risk) but the feature is dead.
- **Blast radius:** `RefundItemsSheet.tsx` (mobile) + `refund-items/route.ts` (must become bearer-aware). The refund **money path** (`refund_jobs` → Stripe destination-charge refund) is correct and untouched — only the enqueue entrypoint is broken. AAL2 caveat: a mobile admin session may not satisfy `requireAAL2ForAdmin` → may de-facto restrict mobile refunds to `manager` role.
- **Regression link:** shipped broken in PR-C / #130. **Fix:** use `API_BASE` from `(staff)/_layout.tsx:17` + `Authorization: Bearer <supabase access_token>` (mirror `lottr-client.ts:107-116`); make the route accept a bearer token. Effort **M**. No product decision.

### INV-1 — "Invoice Not Found" is already fixed in code; this is an OTA-delivery gap
- **Root cause (confirmed):** the bidder invoice screen selected a phantom `invoices.refunded_cents` column → PostgREST 400'd the whole query → `.single()` null → "Invoice not found" for **every** receipt. Web never selected it (web worked — matches the report). **Fixed on master by `c55f2ee` / PR #210 (merged Jun 4 12:54)** — `refunded_cents` removed, `.single()`→`.maybeSingle()`. Current `invoice/[id].tsx:201-218` is correct.
- **Why testers still saw it (Jun 5):** delivery. The fix ships via bidder OTA only. Two hazards: `runtimeVersion.policy:'appVersion'` (`app.config.ts:155`, version `0.1.1`) means an OTA lands only on version-matched binaries; and the TestFlight build runs the **`preview`** channel (memory `feedback_ota_both_branches`).
- **Action (no code):** the June-5 OTA shipped (`eas-update.yml app=both branches=both` at `b9f15ac`, run `27027918060` = success) **contains c55f2ee on both channels** — so this should be resolved IF the tester's binary `runtimeVersion` == `0.1.1`. **Verify the tester's installed build/runtime; if skewed, a fresh build is required.** Add a regression test asserting the bidder invoice select column-list matches the live `invoices` schema.

### CHK-1 — Item-verification scanner dead — ROOT CAUSE NOT FOUND (theory overturned)
- The investigator proposed "two `<Camera>` instances fight over one device." **The verifier refuted it:** the primary path (tap "Scan bin QR" on a lot) mounts **exactly one** camera (`unknownScanMode=false`, token/refund cameras gated out by step) — structurally identical to the working token step and `put-away/single.tsx`, so it should acquire the session and fire `onCodeScanned`. The two-camera collision is a **real but narrower latent bug** (bin-scan + "unknown item" scan can both mount; setters never cross-clear) that can't explain a uniformly dead scanner on the first ordinary scan.
- **The actual cause is still unknown** and cannot be found from source alone. Per memory `feedback_pull_real_telemetry_before_hypothesizing`: **need a real device repro** (warehouse iPad) — capture whether `onCodeScanned` ever fires, the `supportsMultiCamSessions` value, and the exact step state. Do NOT ship a speculative fix. (Also: the cited reference `picker/stage.tsx` does not exist — dir was restructured away; only `put-away/single.tsx` corroborates the one-camera pattern.)

---

## HIGH

### BIDCOUNT-1 — bid_count double-writes (off-by-one), proven on live data
- **Two writers both mutate `bid_count`:**
  - `place_bid` (live mig 0176): `bid_count = bid_count + CASE WHEN v_auto_bid_id IS NOT NULL THEN 2 ELSE 1 END`
  - `sync_lot_bid_count` trigger (mig 0101, AFTER INSERT on `bids`): `bid_count = (SELECT count(*) FROM bids WHERE lot_id = v_lot_id)`
- **Live proof:** lot `BRN4371782` has exactly **1 bid row** (`amount 100, is_auto=false`) yet `bid_count=2`. The trigger set it to `count(*)=1`, then place_bid's UPDATE added `+1` → `2`. Across 12 sampled lots `bid_count = real_rows + 1` uniformly (the `+1`/`+2` from the **last** place_bid call stacked on top of the trigger's recompute). This is a **double-write off-by-one**, NOT merely "counts proxy rows."
- **Why the agent's fix would fail:** changing *both* writers (place_bid→+1, trigger→count(is_auto=false)) still leaves *both* writing → still double-counts.
- **Correct fix:** make the **trigger the single source of truth** — `count(*) ... WHERE lot_id = v_lot_id AND is_auto = false` — and **delete the manual `bid_count` increment from `place_bid`** entirely. Backfill: `UPDATE lots SET bid_count = (SELECT count(*) FROM bids b WHERE b.lot_id = lots.id AND b.is_auto = false)`. The `cancel_auction` `bid_count > 0` auth guard stays safe (every human bid still inserts a non-auto row). New `place_bid` migration must coordinate with BID-3 (same function). Effort **M**.
- **Blast radius:** `bid_count` is read raw on every surface — web lot page + BidWidget, bidder lot detail, `LotCard` 🔥 badge, **bidder "Most contested" sort** (`(tabs)/index.tsx`), and the cancel/delete auth guard. Single DB-layer fix → all surfaces inherit it.

### RELIST-2 — relisted lots lose their physical sticker/QR (live: 25/25)
- **Root cause (confirmed):** the live `relist_lot_into_auction` (mig **0099**, not the cited 0097) mints a fresh `lot_code` and copies `intake_bin_id` forward but its INSERT **omits `sticker_code` and `qr_token`**. The new row gets `sticker_code=NULL` + a fresh default `qr_token`. The physical box still bears the original label, which now resolves to the `status='relisted'` **source** row — which live `intake_lot_to_bin` (mig **0143**) rejects with `lot_not_in_intake_state`.
- **Live proof:** of 25 relist children, **25 have NULL `sticker_code`**. Every relisted item is unscannable by its existing physical label at put-away AND checkout.
- **Fix (needs decision):** inside the relist transaction **MOVE** `sticker_code`+`qr_token` from source → new row (clear source first — the global UNIQUE partial index on `sticker_code` (0141) forbids a copy). Effort **L**. Decision: move-forward (recommended; keeps `/l/<uuid>` pointing at the live lot) vs require re-sticker.

### QR-2 — Quick Lot silently swallows sticker-bind failures
- **Root cause (confirmed):** `quick.tsx:533-545` auto-binds the creation scan; on `bind.ok === false` (already-used, lot-has-different-sticker, raw-contains-colon, RLS/network) it **surfaces no error** — silently opens the PreStickeredScanner modal. If staff dismiss it, the lot has NULL `sticker_code` → at put-away the physical scan dead-ends at "Lot not found." `single.tsx:234-238` documents this exact recurring field report.
- **Live context:** binding *does* work for some lots (`BIN-000143/132/131` carry `BIN:xxx`), but 10 recent BinGo lots have NULL sticker + unrotated QR — consistent with either generate-mode or swallowed failures.
- **Fix (no decision):** surface `ok:false` reasons in the toast; assert persistence post-bind; add a create→claim→intake regression test. Effort **M**.

### QR-1 — UUID pre-sticker QR never writes a human label
- **Root cause (confirmed):** `bindStickerToLot.ts:71-73` routes a UUID scan to `claim_prestickered_qr`, which updates **only** `qr_token` (mig 0110), leaving `sticker_code` NULL. `lotDisplayCode = stickerLabel(sticker_code) ?? lot_code` (shared `lots.ts:41`) → display stays on the minted `lot_code` (`BIN-000132`). The lot IS scannable by `qr_token`, but the **display** never changes — the tester's "keeps referencing the generated BIN code." Partly by design (a 36-char UUID is a worse label than `BIN-000132`).
- **Decision:** (a) keep showing `lot_code` for UUID stickers [current], (b) mirror the UUID into `sticker_code`, or (c) print `lot_code` onto the ClovrBid sticker so physical + display agree. **Recommend (c)** — settle the `sticker_code` semantic once (ties to RELIST-2 + QR-4). Effort **M**.

### PICKUP-LOC-1 — mobile hides shelf location in staff_assisted (web doesn't)
- **Root cause (confirmed):** `bidder-app/app/pickup/[id].tsx:1000` `showBinCode = mode === 'counter_pickup' || 'self_serve_floor_plan'` — `staff_assisted` excluded → renders staging copy ("Ready for pickup"/"Coming soon"). Data IS fetched (`bin_code` at :345). Web (`profile/pickup/[id]/page.tsx:354`) shows `On shelf · {bin}` with **no mode gate**. #216 fixed web only; a June-4 triage doc wrongly marked mobile "already shipped."
- **Disambiguation needed:** recent won lots sampled live are `counter_pickup` + `has_bin=true` → those would **already** show location on a current build. So the tester's lots are either in a `staff_assisted` warehouse (this gate) OR they're on a stale bidder build. **Need the tester's won-lot ids.** Either way the fix (show location in all modes, mode-appropriate framing) is correct and safe. Effort **S**, bidder OTA (both channels).

### BID-1 — app/web bidding inconsistent; #231 created a double bid surface
- **Root cause (confirmed):** increment math is identical (`packages/shared/bidding.ts`). The divergence is presentation: web = pre-seeded input + single "Quick bid"; mobile = empty manual input + `Min/+$1/+$5/+$10` chips (`PlaceBidSheet`) **AND** a standalone one-tap "Quick bid" (`lot/[id].tsx:1956`) stacked together. #231 added the one-tap on top of the existing chips. The standalone path also doesn't fire `track('bid_placed')` analytics → half of mobile bids are analytically invisible.
- **Fix (needs decision):** converge mobile onto the web model (Current/Next/Place). `PlaceBidSheet` is shared in `domain-bidding` — grep before editing; keep `beforeBid` policy + identity gates on the surviving path. Effort **M**.

### CHK-03 — no manual-checkout fallback
- **Root cause (confirmed):** W6-P1 deliberately removed the manual checkbox; the per-lot checkbox can only be flipped by a successful bin scan (`pickup-verify.tsx:1257`), and confirm requires ≥1 checked lot. Damaged/unreadable QR, never-staged lot, or camera failure → staff cannot complete handoff. The bidder-QR step already has a non-camera fallback (customer search), proving the pattern is wanted.
- **Fix (needs decision):** gated "Manual checkout (QR unreadable)" per lot → confirm modal + reason code + audit-log write; reuse `staff_confirm_pickup` (already lot_code-based). Decision: require manager role? Effort **M**. (Note: collides with CHK-1/CHK-2 — same file/region; single owner.)

---

## MEDIUM / LOW (condensed)

- **BID-2** (med): remove `EffectiveTotalLine` (premium + "charged total") from web `BidWidget.tsx:653-673`; mobile already clean. Server invoice math untouched. Decision: also drop the passive "Buyer's premium: X%" header line? (legal/transparency call). Effort **S**.
- **BID-3** (med, **L**): increment ladder is one hardcoded global SQL fn `min_bid_increment_cents(current)`. Make it schedule-aware via `operators.bid_increment_schedule JSONB NULL` (+ optional per-auction override), NULL = current ladder (back-compat). **Read in 4 lock-step places** (place_bid SQL, shared client mirror, web BidWidget, mobile PlaceBidSheet) — the client mirror is the silent danger. Custom max bids need no change. Apply to new auctions only. Scoped, do not build whole feature blind.
- **CHK-01** (med): identity-verify is an unconditional visual step with **no `operator_policies` column** to gate it; no `high_value`/`cage` concept exists on lots. Add `require_identity_check` + `identity_check_threshold_cents` columns (defaults preserve current behavior). Decision: per-lot vs per-invoice threshold; is "cage" a real attribute?
- **CHK-2** (med): "Scan bin"/"Scan bin QR" copy is wrong, BUT `onBinScan` genuinely validates a **bin** `qr_token` against the lot's expected `bin_id` — a copy-only rename would mislabel a still-bin-based check. Decision: copy-only, or re-point the handler to scan the **lot** label (matches #214/#215 BRN direction). If the latter, do it inside CHK-1's refactor.
- **CHK-06** (med, question): pickup QR is **static, no expiry** (good for printed sheets — matches the tester's own "stay usable" ask). **Parity risk (unverified):** mobile QR encodes `bidder_check_in_token`, web QR encodes `invoice.id`, and the staff scanner resolves by token — so the **web-printed pickup QR may be unscannable by staff**. Worth a live scan test. Recommend keep QR static.
- **WEB-NAV-1/2/3/4** (med): web has no dedicated Watch List / My Bids / Winning nav — buried as truncated `/profile` sections (`.limit(10)`/30-day cap). Build full pages mirroring `/profile/past-wins`; **nest under `/profile/*`** (inherits the middleware auth gate; top-level routes would 404 anon users). "Winning" = a `?f=leading` filter of My Bids, not a separate data source. Nav width budget is tight (390px overflow guard) — prefer a "My account" dropdown or hamburger. Effort **M**.
- **RELIST-1** (answered): every relist mints a **new `lot_code`**, applies to **`unsold` only** (forfeited/unpicked-up go to `forfeited`, not relisted), linked via `lots.relisted_from_lot_id`, source flipped to `status='relisted'`. **Reporting:** filter `status NOT IN ('relisted')` to avoid double-counting inventory/GMV. (1 live child also carried over `bid_count` — see BIDCOUNT-1 open Q.)
- **CHK-02** (low): signature is **already skippable** ("Skip signature — confirm now" on two steps). Optional: `operator_policies.require_signature` to remove it standard-wide.
- **CHK-05** (low): browser pickup page has no per-item print checkbox; extract items into a client component + `@media print`.
- **INV-2/INV-3, QR-3, QR-4, PICKUP-LOC-2** (low): observability hardening, RLS parity, dual client/server resolution coupling, Recent-strip display parity, and the diagnostic "is the tester's lot bin populated."

---

## What recent additions BURIED / left half-wired (owner's explicit concern)

1. **Relist drops physical identity** — `sticker_code`/`qr_token` added later (0141) than the relist helper (0099); the helper was never updated → 25 live lots unscannable. (RELIST-2)
2. **UUID pre-sticker lane has no display path** — #214/#215 "show BRN everywhere" only reads `sticker_code`; the older UUID/`qr_token` lane (0110) was buried → UUID lots show `lot_code`. (QR-1)
3. **Pickup location fixed on web, never wired on mobile** — #216 web-only; mobile `staff_assisted` still gated off; a June-4 doc wrongly marked it shipped. (PICKUP-LOC-1)
4. **#231 duplicated the mobile bid surface** — one-tap added on top of `PlaceBidSheet` chips; the new path skips `bid_placed` analytics → half of mobile bids invisible. (BID-1)
5. **Put-away resolution asymmetry** — `single.tsx` has a client `sticker_code` fallback; `batch`/`shelf-scan` rely on the server lane. Any new client pre-resolver without the fallback silently regresses one screen. (QR-2/QR-3)
6. **Pickup QR encodes different values per surface** — mobile=token, web=invoice.id; staff scanner only resolves the token. (CHK-06)

---

## Dependencies & conflicts (do NOT parallelize these)

- **`pickup-verify.tsx` 5-way collision** — CHK-1, CHK-2, CHK-03, CHK-01, CHK-02 all edit this one file; CHK-1/2/3 overlap the verify-render region. **Single owner, single branch.**
- **Shared intake RPC** — RELIST-2, QR-2, QR-3 all converge on `intake_lot_to_bin`/`batch_intake_lot_to_bin` (mig 0143). One owner for the resolution change. RELIST-2 must settle first (it changes which row the lanes resolve).
- **`lots.sticker_code` / `lotDisplayCode`** — QR-1, QR-4, RELIST-2 read/write the same column + shared helper. Decide the `sticker_code` semantic once.
- **`place_bid` + `bidding.ts`** — BIDCOUNT-1 and BID-3 both rewrite the live `place_bid` + client mirror. Land coherently or the second migration clobbers the first.
- **Web bid presentation** — BID-1, BID-2, BID-3 all edit `BidWidget.tsx`/`page.tsx` (+ shared `PlaceBidSheet`). Sequence or single-own.
- **`operator_policies` migration** — CHK-01 + CHK-02 need the same additive column migration (versioned table → columns need DB defaults). One migration.

## Recommended sequence

- **STEP 0 (blocking, evidence):** device repro for CHK-1 (no proven cause); tester's won-lot ids + bidder build version for PICKUP-LOC-1/INV-1; *(QR-2/RELIST-2/BIDCOUNT-1 evidence already gathered live above).*
- **STEP 1 — INV-1:** verify the Jun-5 OTA reached the tester's runtime; rebuild only if version-skewed. *(no code)*
- **STEP 2 — CHK-04:** fix refund URL+bearer + route bearer-aware. *(confirmed, self-contained, parallel-safe)*
- **STEP 3 — BIDCOUNT-1:** trigger sole-authority (`is_auto=false`) + drop place_bid increment + backfill. *(confirmed; coordinate with BID-3)*
- **STEP 4 — `pickup-verify.tsx` cluster (one owner):** CHK-1 (only after device repro) → CHK-03 → CHK-2.
- **STEP 5 — RELIST-2 then QR-2/QR-3:** move sticker/qr forward on relist, then surface bind failures + validate client/server lock-step.
- **STEP 6 — QR-1:** display/labeling, after RELIST-2 settles `sticker_code` semantics.
- **STEP 7 — enhancements:** PICKUP-LOC-1, BID-1/BID-2, WEB-NAV, CHK-01/02, BID-3 (largest), CHK-05.

## Open product decisions for the owner

1. **Bid count semantic** — recommend "distinct human bids" (`is_auto=false` count). Confirm.
2. **RELIST-2** — move sticker/QR forward to the relisted lot (recommend yes)?
3. **QR-1** — print `lot_code` onto the ClovrBid sticker so physical + display agree (recommend), or surface the UUID?
4. **PICKUP-LOC-1** — show shelf location to `staff_assisted` bidders (recommend yes, "Stored at · {bin}" framing)?
5. **Identity/signature (CHK-01/02)** — gate identity by per-invoice total or per-lot? Remove signature from standard flow?
6. **Manual checkout (CHK-03)** — require manager role + reason code?
7. **Configurable increments (BID-3)** — build now, and where does the schedule live (operators vs per-auction)?
8. **Web nav (WEB-NAV)** — three tabs vs one "My account" dropdown; nested `/profile/*` (recommended).
