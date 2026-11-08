# Critical Batch Plan — 2026-06-02 (payments + lotting + app-visibility regressions)

**Context.** Owner reported a set of broken/regressed behaviors with screenshots and asked: *"dig + plan… the critical stuff needs fixed, like not today our payments failed… I don't want to regress if that is stuff to do with the operator choices and what we set up."* Three read-only investigators were dispatched to ground this plan against actual source/migrations/RLS. This doc is the synthesis.

**Bottom line up front:** Only **ONE** reported issue is an actual recent code regression (batch-intake SQL, from mig 0143). The payment failure was an **operator-flag activation** exposing a latent bug, NOT a discovery regression. Two "issues" are **not code at all** — a stale mobile OTA build + an auction genuinely closing. None of our discovery/QuickLot work (#147–#176) broke payments or invoices.

---

## TL;DR — 6 issues mapped

| # | Reported symptom | Root cause | Regression? | Fix vehicle | Effort | Priority |
|---|---|---|---|---|---|---|
| 1 | Payment retry/charge fails | `automatic_tax` (invalid PI param) passed to `paymentIntents.create`, gated on operator `collect_sales_tax` (just enabled on BinGo) | **No** — latent bug exposed by enabling an operator flag | CF (**PR #178, shipped**) | S | **P0 ✅** |
| 2 | Batch intake "column reference 'code' is ambiguous" | `batch_intake_lot_to_bin` has bare `SELECT code INTO …` colliding with `RETURNS TABLE(... code ...)` OUT param | **Yes** — introduced by mig 0143, carried into 0145 | migration `0175` `CREATE OR REPLACE` | S | **P0** |
| 3 | Pre-stickered QR "created OK" but "doesn't exist" on re-scan | `single.tsx` resolver has no `sticker_code` branch; `LOT_CODE_RE` matches `PNK…` and dead-ends | No — longstanding gap since `sticker_code` (mig 0141) shipped | OTA (`single.tsx`) | S–M | **P1** |
| 4 | App shows no invoices; browser shows them | Stale **preview-channel** TestFlight build — #149 invoices screen + #167 pagination never pushed to `preview` | **No code bug** — OTA-delivery gap | OTA to **both** channels (+ build if runtime mismatch) | S | **P0** |
| 5 | Test Auction.4 "no auctions" in browser, lots visible; app button does nothing | Auction is `status='closed'`; every auctions-discovery surface filters `scheduled`/`live` only | No — by-design filter meeting closed data-state (0174 closed it faster) | CF (web) + OTA (app) **if** we want closed auctions reachable | S (web) / M (app) | **P2 (product decision)** |
| 6 | Multi-card on file; changing card "removed" old one | One PM per bidder (`default_payment_method_id` overwrite). Old PM stays on Stripe but unreferenced — not detached | No — never built | CF (list/delete/set-primary routes) + OTA (UI) | M | **P2** |
| 7 | Auto-block bidding while invoice unpaid | `place_bid` blocks `no_payment_method` + `unpaid_fees`, but **not** during `payment_failed_grace` | No — gap | migration (`place_bid` re-create) + OTA (reason copy) | M | **P1** |
| 8 | Reword dunning copy ("keep items OR keep bidding; relisting fee") | Mobile has date+amount already; web receipt missing `relist_fee_cents` + "keep bidding" wording | No — copy gap | OTA (mobile) + CF (web, add policy fetch) | S / S–M | **P1** |

*(6 reported items expand to 8 because reports 2 and 3 each bundled multiple asks.)*

---

## "Did we regress?" — direct answer to the owner's fear

You did **not** regress payments or invoices via the discovery/QuickLot work. Specifically:

- **Payments (P0):** broke because **BinGo's `collect_sales_tax` operator setting was turned on**, which activated a code path (`automatic_tax` on a PaymentIntent) that was always invalid but never executed while the flag was off. The fix removes the bad param and **keeps your `collect_sales_tax` setting exactly as you set it** — when we wire real Stripe Tax later it'll just work. Your operator config is preserved.
- **App invoices empty (P0):** your phone is running an **old TestFlight JS bundle** (the `preview` channel) from before the invoices screen shipped (#149, 6/1). The browser hits live prod, so it shows them. Not a regression — a delivery gap. Fix = push the OTA to the `preview` channel too (per our own rule that OTAs must hit both channels).
- **Test Auction.4 "no auctions" (P2):** the auction **closed** (its end window elapsed). Every "browse auctions" surface intentionally lists only live/scheduled — so a closed auction drops out of the list while its lots stay reachable by direct link. Migration 0174 (today) closes elapsed auctions faster, which made this visible sooner — working as designed, not broken.
- **Batch intake SQL (P0):** this **is** a real regression — but from the **W10 intake-outcome refactor (mig 0143, ~5/25)**, not from this week's discovery work. It added two unqualified `SELECT code INTO …` lookups that collide with the function's `code` OUT param. Fix below.

No proposed fix removes an operator setting. Preserved verbatim: `operators.collect_sales_tax`, `operators.auto_charge_grace_hours`, `operator_policies.relist_fee_cents`, `operator_policies.refund_window_post_pickup_hours`, `auctions.soft_close_minutes`.

---

## Detail + exact fixes

### Issue 1 — Payments (P0) ✅ SHIPPING (PR #178)
- **Files:** `apps/operator-web/src/lib/cron/auto-charge-drain.ts:391`, `apps/operator-web/src/app/api/invoices/[id]/payment-intent/route.ts:268`.
- **Change:** `...(enableTax ? { automatic_tax: { enabled: true }, shipping: taxShipping } : {})` → `...(enableTax ? { shipping: taxShipping } : {})`.
- **Follow-up (P3):** when real sales tax is wanted, compute via Stripe **Tax Calculation API** (`stripe.tax.calculations.create`) and pass the resulting amount, not `automatic_tax`. The `stripe-tax.ts` header comment is now stale (says "flag off until 4242 verify") — update when tax is properly built. Tracked as task #40.

### Issue 2 — Batch intake "column reference 'code' is ambiguous" (P0)
- **Live def:** `packages/db/migrations/0145_requalify_batch_intake_lot_code.sql` (`batch_intake_lot_to_bin(TEXT[], UUID)`).
- **Cause:** `RETURNS TABLE(… code TEXT …)` OUT param collides with two bare reads — `:103` `SELECT code INTO v_op_code FROM operators…` (fires on **every** batch call, before the loop) and `:199` `SELECT code INTO v_old_bin_code FROM bins…`. PL/pgSQL `variable_conflict=error` → throws.
- **Origin:** mig `0143_intake_outcome_codes.sql` (W10 refactor) added these; 0142/0145 hotfixes only chased `lot_code`, missed `code`.
- **Fix (preferred):** new forward migration `0175_fix_batch_intake_ambiguous_code.sql` = `CREATE OR REPLACE` of the function with `#variable_conflict use_column` as the first body line — identical signature, no lock churn, matches how `intake_lot_to_bin` was fixed in mig 0160 (`:310`). Server-only, **not** an OTA.
- **Bonus:** fixing this restores batch/shelf `sticker_code` resolution (the SQL ladder already supports it at 0145:122-124).

### Issue 3 — Pre-stickered sticker code not resolvable on re-scan (P1)
- **Persistence works:** `PreStickeredScanner.tsx:136-147` — non-UUID `PNK4860473` → `claim_sticker_code` writes `lots.sticker_code = '{op.code}:PNK4860473'` (mig 0141). Bind succeeds → "created successfully."
- **Lookup gap:** `apps/field-mobile/app/(staff)/put-away/single.tsx:184-228` hand-rolls a PostgREST query with **no `sticker_code` branch**; worse, `LOT_CODE_RE = /^[A-Z]{2,4}-?\d{4,10}$/` (`:45`) matches `PNK4860473` → queries `lot_code` (miss, real codes have a dash) → `external_code` (miss, value only in `sticker_code`) → "Lot not found." Comment at `:63` claims it resolves sticker_code but never did.
- **Fix:** OTA `single.tsx` to call the shared server resolver `supabase.rpc('_find_lot_by_scan', { p_candidates: [rawScanned] })` (mig 0160, granted to `authenticated`) — pass the **raw** code (no colon; SQL builds `{op.code}:raw`). Push to **both** `preview` + `production` channels.

### Issue 4 — App shows no invoices, browser does (P0)
- App query (`apps/bidder-app/app/profile/invoices.tsx:88-96`) and web query (`apps/operator-web/src/app/profile/invoices/page.tsx:78-85`) are functionally identical (web adds only cosmetic `grace_until`); RLS identical (`invoices_self_read`, mig 0133:344). **No code bug.**
- **Cause:** invoices screen shipped **#149 (6/1)** + #167 pagination; the TestFlight build runs the **`preview`** channel (`eas.json:43-46`, runtime pinned to `appVersion 0.1.1`). Per `feedback_ota_both_branches.md`, an OTA pushed only to `production` never reaches it → device runs pre-#149 JS (empty/old screen).
- **Fix:** re-publish current bundle to **both** channels (S, OTA). If runtime-version mismatch blocks OTA, cut a fresh `preview` TestFlight **build**.
- **Confirm first:** `eas channel:list`/`branch:list` for bidder; confirm app + browser are the **same** auth identity.

### Issue 5 — Test Auction.4 empty auctions view (P2, product decision)
- **Web** `apps/operator-web/src/app/(public)/browse/page.tsx:101-110` and **app** `apps/bidder-app/app/(tabs)/index.tsx:286-290` both filter `in('status',['scheduled','live'])`. Closed auction → not listed. Lots stay reachable (RLS allows reading closed auctions/won lots; #175 made closed deep-links render instead of 404). App has no `/auction/[id]` route — the "Auctions" rail card only sets a lot-grid filter, so no card = "button does nothing."
- **Confirm first:** `select status, closed_at, last_lot_ends_at, ends_at from auctions where title ilike 'Test Auction.4'` → expect `closed`. If still live/scheduled, the cause shifts to lifecycle-not-run (different fix).
- **Decision needed (owner):** should **recently-closed** auctions be reachable from the auctions view?
  - **A) Yes, show "Results/Closed":** web add `'closed'` + badge (S, CF); app add a `/auction/[id]` results screen or include closed in rail (M, OTA).
  - **B) No, working as designed:** closed auctions aren't "live" discovery; lots remain reachable via direct link / Past wins. No code change.

### Issue 6 — Multiple cards on file (P2)
- **Today:** one card; `POST /api/bidder/payment-method:201-204` overwrites `bidders.default_payment_method_id`. The old card is **not detached** (no `paymentMethods.detach` call) — it stays on the Stripe customer, just unreferenced by our single DB column (so it vanishes from UI but is recoverable). Source of truth for charges is that DB column (auto-charge `:378`, `place_bid` gate, manual PI uses PaymentSheet picker).
- **Fix:** `GET /api/bidder/payment-methods` (list from Stripe, mark primary = the DB column); reuse `POST` as "set primary" (every charge path already reads the column → instant effect, zero charge-path change); new `DELETE` → `paymentMethods.detach` (block detaching primary). App UI: list + radio-primary + delete in `apps/bidder-app/app/profile/payment-method.tsx`; mirror web `CardSetupForm.tsx`. **Don't** touch `invoice_settings.default_payment_method` writes. M overall (S backend, M mobile).

### Issue 7 — Auto-block bidding on unpaid invoice (P1)
- **Today:** `place_bid` (mig `0111:96-114`) blocks `no_payment_method` + `unpaid_fees_cents > 0`. The `unpaid_fees` charge only lands **after** grace expires + relist. So **during the 48h `payment_failed_grace` window the bidder can still bid** — the exact gap.
- **Fix:** new migration re-creating `place_bid` (preserve 0111 advisory-lock + 0084 shill/identity + 0104 §A/§B body **verbatim** — no-shortcuts rule) adding a guard: block when bidder has any invoice in `payment_failed_grace`, returning reason `unpaid_invoice`. Add `unpaid_invoice` to bidder-app reason map (`lot/[id].tsx:84-96`, dispatcher `:1086-1094`) + proactive banner.
- **Policy decision (owner):** does a grace invoice at **Operator A block bidding at Operator B**? Existing `unpaid_fees` gate is **global** (bidder-row aggregate); blocking grace globally is more consistent, per-operator is gentler. Recommend: **grace-only**, and match the existing global behavior unless you want per-operator. (Grace window length stays operator-config `auto_charge_grace_hours` — do not regress.)

### Issue 8 — Dunning copy rewrite (P1)
- Desired wording: *"Payment failed — update your payment method by {date} to keep your items or to keep bidding. After {date}, lots are relisted; to bid again you'll pay a relisting fee of {amount}."*
- **Mobile** `apps/bidder-app/app/invoice/[id].tsx:909-913` — `{date}` (`grace_until`) + `{amount}` (`operatorPolicy.relist_fee_cents`) already available → reword only (S, OTA).
- **Web** `apps/operator-web/src/app/profile/invoices/[id]/page.tsx:522-531` — missing `relist_fee_cents` (not in query `:171-179`) and "keep bidding" wording → add `operator_policies` fetch (anon-readable, mobile already does) + reword (S–M, CF).
- **Preserve:** both surfaces branch on `relist_fee_cents > 0` to drop the fee line when fee is 0 — keep that branch; never hardcode "$5".

---

## Sequenced execution (recommended)

**Wave 0 — P0, in flight now:**
1. ✅ **Payments** (PR #178) — merge → CF deploy → verify a charge succeeds.
2. **Batch intake SQL** — write mig `0175`, dry-run → `--live` → re-inspect. Server-only, unblocks all batch/shelf put-away.
3. **App invoices OTA** — verify channel state, re-publish to **both** channels (and/or fresh `preview` build).

**Wave 1 — P1 (after P0 verified):**
4. **Single-scan sticker resolver** (OTA `single.tsx` → `_find_lot_by_scan`).
5. **Dunning copy** (OTA mobile + CF web w/ policy fetch).
6. **Block bidding on grace invoice** (migration + OTA reason copy) — needs the per-operator-vs-global decision.

**Wave 2 — P2 (product decisions first):**
7. **Closed-auction reachability** (Issue 5 decision A/B).
8. **Multiple cards on file** (Issue 6, M).

---

## Owner decisions needed (3)
1. **Issue 5:** should recently-closed auctions appear in the "browse auctions" view (with a Results badge), or stay hidden (lots reachable by link only)?
2. **Issue 7:** block bidding on an unpaid grace invoice **globally** (across all operators, matches current `unpaid_fees`) or **per-operator**?
3. **Issue 6:** confirm multi-card + primary-selection is wanted now (M effort) vs deferred.

## Operator-config preserved (do not regress)
`collect_sales_tax` · `auto_charge_grace_hours` · `relist_fee_cents` · `refund_window_post_pickup_hours` · `soft_close_minutes`.
