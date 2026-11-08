# Platform State — fresh-eyes verification audit, 2026-06-06

**Method:** independent re-verification of everything shipped over the last several days, from a
clean `origin/master` checkout (commit `2e38a59`, the signature-pad #242 tip) + live prod probes +
store APIs. Four read-only audit agents (June-4 reconciliation, test coverage, app↔web parity,
signature-pad correctness) + manual prod/Stripe/ASC/Play probes. Nothing here is assumed — each
verdict is code- or API-verified.

This audit deliberately separates **objective bugs** (fix unconditionally) from **product decisions**
(owner's call — several of the June-4/5 "recommendations" are opinions, not defects).

---

## 1. Release state — where the code actually is

| Surface | State | Fixes delivered? |
|---|---|---|
| **Web (Cloudflare)** | master tip `2e38a59` deployed; Deploy CF + CI green | ✅ all web fixes live |
| **iOS — TestFlight** | Bidder build **#42** (06-02), Staff **#54** (05-28), both VALID | ✅ June-5/6 JS fixes ride on top via OTA |
| **iOS — App Store v1.0** | **REJECTED (parked)** for *both* apps | ⚠️ public release is rejected; beta unaffected |
| **Android — Play** | Bidder prod **vc12 / 0.1.1** completed; Staff **vc3 / 0.1.0** completed | ✅ OTA covers JS fixes |
| **OTA (EAS Update)** | Bidder + Staff pushed to **both** `preview` + `production` branches, green | ✅ reaches TestFlight (preview) + store builds |

**Flag:** iOS App Store v1.0 is in REJECTED state for bidder *and* staff. Beta testing is unaffected
(TestFlight builds are VALID), but if/when a public iOS launch is intended, the rejection reason needs
to be pulled and cleared. Not a beta blocker.

---

## 2. Prod schema — verified live (Supabase `xgsujdzicnjenhqihovk`)

All four June-5 migrations applied + self-marked:

- `0191_bid_count_human_only.sql` ✅
- `0192_relist_carryover_sticker.sql` ✅
- `0193_checkout_policy_columns.sql` ✅ (`require_identity_check`, `identity_check_threshold_cents`, `require_signature` all present on `operator_policies`)
- `0194_configurable_bid_increments.sql` ✅ — `bid_increment_schedule` on both `operators` + `auctions`; `min_bid_increment_cents(current_cents bigint, schedule jsonb)` is the **only** signature (the ambiguous 1-arg overload was successfully dropped).

---

## 3. June-5 items — re-verified as actually fixed in master

| Item | Re-verified verdict | Evidence |
|---|---|---|
| BIDCOUNT-1 (bid count double-write) | ✅ trigger sole writer, counts `is_auto=false` | mig 0191 live; parity assertions in `bid_count_human_only.regression.test.ts` |
| BID-3 configurable increments | ✅ live; SQL↔client values byte-identical | `min_bid_increment_cents.sql` ≡ `bidding.test.ts` (verified literal match) |
| RELIST-2 sticker/qr carryover | ✅ live in `relist_lot_into_auction` (mig 0192) | (untested — see §5) |
| CHK-01/02/03 policy gates | ✅ wired in `pickup-verify.tsx` | thresholds inclusive, cents-correct |
| CHK-04 refund auth | ✅ absolute API_BASE + bearer + aal-decode | (untested — see §5) |
| BID-1/BID-2 bid model parity | ✅ both surfaces one-tap quick-bid + max/proxy | `lot/[id].tsx:1997`, `BidWidget.tsx:576` |
| PICKUP-LOC-1 location display | ✅ shown in ALL modes incl. staff_assisted | `pickup/[id].tsx:1084` "Stored at · {bin}" |
| WEB-NAV watchlist/my-bids | ✅ dedicated `/profile/watchlist` + `/profile/my-bids` | classification matches mobile |
| "You're winning" (web) | ✅ prominent pill (was a June-4 ask too) | `BidWidget.tsx:457-485` |
| Bidding force-close/refresh | ✅ AppState foreground re-subscribe + salted channel + retry | `lot/[id].tsx:1299-1305` |
| Signature pad (#242) | ✅ SHIP-SAFE (adversarial re-review) | PNG capture guarded, fallback to strokes, no un-audited path |

---

## 4. June-4 items — reconciliation (these were never formally triaged)

| # | Item | Verdict | Evidence | Class |
|---|---|---|---|---|
| 1 | Sales tax not applied | 🧭 DECISION | charge = `subtotal + buyer_premium` only; `invoices.tax_cents` exists but never written; `collect_sales_tax` flag hidden+false (`stripe-tax.ts:28`). PI built at `payment-intent/route.ts:249`, `auto-charge-drain.ts:442`. Connected acct has **active AR tax registration**; 0/100 bidders have an address on file. | **Decision, not a bug** |
| 2 | Stock photos not auto-loading even when product info found | 🟡 PARTIAL | Auto-enrich fires ONLY on import path (`imports/actions.ts:556`). QuickLot/manual lots never enqueue; on-demand `enrich-lot/route.ts` returns a candidate **without persisting the image** → exactly the "description shows, photo doesn't" symptom. (Import→lot mapping itself is correct: `0032:144`.) | Defer to **owner's active lotting rework** |
| 3 | Personal email in customer-facing areas | ✅ FIXED | `support@clovrbid.com` everywhere customer-facing; `legal@clovrbid.com` on legal; `no-reply@clovrbid.com` FROM. Personal emails only in internal config (`eas.json` appleId, server-only `SUPER_ADMIN_EMAIL`). | Resolved |
| 4 | Manifest match low hit-rate | 🧭 DECISION | `find_import_row_by_scan` (mig 0160) — exact-column match across 7 ids (tracking→lpn→fnsku→asin→upc→external→pallet), first wins. Correct but narrow (no fuzzy/title match). | Owner reworking |
| 5 | "You are winning" web badge | ✅ FIXED | `BidWidget.tsx:457` green "✓ You're winning" / red "⚡ Outbid" pill | Resolved |
| 6 | Bidding force-close (mobile) | ✅ FIXED | foreground re-subscribe + retry, no never-clearing loading gate | Resolved |

---

## 5. NEW findings this audit surfaced (actionable)

### Bugs / UX gaps
- **[MED] Buyer's-premium % invisible on mobile pre-bid.** Web shows "Buyer's premium: X%" on the lot
  page (`(public)/lot/[code]/page.tsx:562`); mobile shows it *nowhere* before the invoice. This is a
  fee-surprise and a real app↔web inconsistency. Fix: add the premium % to the mobile lot screen
  (operator-terms card, `lot/[id].tsx:2160`).
- **[MED] Web invoice omits the Shipping line.** Mobile itemizes Shipping when `shipping_cents>0`
  (`invoice/[id].tsx:799`); the web receipt (`profile/invoices/[id]/page.tsx:382-452`) never renders
  it → a shipped order's web total won't reconcile against line items. Fix: add a Shipping row.
- **[LOW] Signature silently dropped on search-fallback path.** If `require_signature=true` and the
  invoice is loaded via the search fallback (not QR), and no `pickups` row exists, the signature write
  is skipped but checkout still completes (`pickup-verify.tsx:1242`). Pre-existing edge (not introduced
  by #242). Fix: block + surface error when `require_signature && !pickupRow`.

### Test coverage gaps ("did we test what we shipped?" — honest answer)
- **[HIGH] CHK-04 refund / `requireAAL2ForAdmin` aal-decode-from-bearer is untested** — this is an
  auth-bypass surface and has zero coverage. Highest-priority backfill.
- **[MED] Manual-checkout route untested**; **CHK-01/02/03 policy gates untested**; **RELIST-2
  carryover untested**.
- **[MED] Real DB regression suites don't run in CI.** `bid_count`, `intake`, `catalog-seed` vitest
  suites carry real assertions but are gated behind env flags (`BID_COUNT_REGRESSION=1` etc.) and CI
  only runs the always-on smoke stub → **a regression could merge green.**
- **[LOW] `min_bid_increment_cents.sql` parity test is orphaned from CI** — only the TS half auto-runs;
  the SQL half is never executed in any workflow, so SQL↔client parity could silently drift. Cheap
  fix: add one psql step to the `schema-check` job.

✅ **Verified-good:** the BID-3 SQL↔client parity values are byte-identical today; the signature pad,
manual-checkout server route, and policy gating are correctness-clean (SHIP-SAFE).

---

## 6. Decisions for the owner (bugs vs opinions)

The June-4/5 reports mixed defects with the lead manager's *recommendations*. The defects are fixed
(§3). These remain **owner calls**, not bugs to silently implement:

1. **Sales tax strategy** — charges are bid + buyer's premium only, no tax line (deliberate, flagged
   off after the `automatic_tax` incident). Decide: build the Stripe Tax Calculation API path
   (task #40) for the operator-MOR model, or accept "no tax at launch." *Do not re-add `automatic_tax`.*
2. **Auto-enrich scope** — should QuickLot/manual lots + the on-demand "enrich" flow auto-persist
   stock photos like the import path does? (Belongs in the lotting rework already in progress.)
3. **Manifest match breadth** — exact-column-only is correct but narrow; add fuzzy/title fallback?
   (Owner already reworking.)
4. **iOS public launch** — App Store v1.0 is REJECTED/parked. Pull the rejection reason only if a
   public iOS release (beyond TestFlight) is the near-term goal.

---

## 7. Recommended next actions (ranked, none started without go)

| Pri | Action | Effort | Ship vector |
|---|---|---|---|
| 1 | Backfill CHK-04 auth test (aal-decode-from-bearer) | S | test-only PR |
| 2 | Add buyer's-premium % to mobile lot screen | S | OTA |
| 3 | Add Shipping line to web invoice | S | CF deploy |
| 4 | Wire `min_bid_increment_cents.sql` + a CI job that runs the gated DB suites | M | CI PR |
| 5 | Guard signature-dropped search-fallback edge | S | OTA |
| 6 | Backfill RELIST-2 + manual-checkout + policy-gate tests | M | test-only PR |

Items 2/3/5 are forward-only behavior fixes; 1/4/6 are pure test/CI hardening. The §6 decisions block
the tax + enrichment + manifest work until the owner calls them.
