# Prod verification — 2026-07-29

Answers the deciding question in `HANDOFF-prod-verify-2026-07-29.md` (branch
`claude/new-session-h7v29d`, PR #219) against prod `npwseclcxcatjhgjrtwe`
(`bingo-auctions`, ACTIVE_HEALTHY, pg 17.6.1.127), reached via the Supabase MCP
server.

**Verdict: Task 2B. The guard was correct. Mig 0294 will NOT unblock Jared's
five pairs — and, on current data, will not unblock anything at all.**

> **Shipped anyway (owner decision).** PR #219 merged as `424a81c`; mig 0294
> applied to prod 2026-07-29 02:27:39Z; `deploy-cloudflare.yml` run
> `30416923603` succeeded. See "Post-deploy verification" below — **the release
> gate did not pass on first run, and four phantom lots were pulled from live
> auctions as a result.**

---

## Task 1 — the five pairs

All five came back `0/2` (neither side stickered) and `direct_line = false`.

| title | lots | stickers | statuses | stickered | direct_line |
|---|---|---|---|---|---|
| (“Broken Base  good Sink with hardware”) Napoles Utility Sink Cabinet… | BIN-002437, BIN-002569 | NULL, NULL | in_inventory ×2 | 0/2 | false |
| (INCOMPLETE) Heiki Storage Loft Bed with Desk and Stairs | BIN-002565, BIN-002622 | NULL, NULL | in_inventory ×2 | 0/2 | false |
| Kylan Professional Nail Desk with Dust Collector… | BIN-002567, BIN-002624 | NULL, NULL | in_inventory ×2 | 0/2 | false |
| Tevrat 5 Drawers 31.1 W Dresser | BIN-002571, BIN-002629 | NULL, NULL | in_inventory ×2 | 0/2 | false |
| This Living Room Exclusive Nesting Side Table Set… | BIN-002570, BIN-002627 | NULL, NULL | in_inventory ×2 | 0/2 | false |

Per the handoff's decision table, `0/2` → **Task 2B**: distinctness is
unprovable, the guard stays, and this was never a regression for these items.

### Lineage shape — not what the table anticipated

`direct_line = false` everywhere, so these are **siblings**, not relist twins in
a parent→child line. Each pair is two children of one common ancestor:

| pair | common ancestor | ancestor status |
|---|---|---|
| BIN-002437 / BIN-002569 | PNK4996305 (via BIN-000340 on the 002437 side) | canceled |
| BIN-002565 / BIN-002622 | TEA3822650 | canceled |
| BIN-002567 / BIN-002624 | BRN4351203 | canceled |
| BIN-002570 / BIN-002627 | PNK4858937 | canceled |
| BIN-002571 / BIN-002629 | **BRN4379513** | **live, on auction, 7 bids, $7.00, ends 2026-07-30 23:00Z** |

No lot anywhere in these lineages carries a sticker — not the children, not the
parents, not the grandparents.

### What actually blocks them, under both 0288 and 0294

For the four canceled-ancestor pairs, neither sibling is `scheduled`/`live`, so
the *first* lot of a selection assigns fine and flips to `scheduled`. The
*second* then sees its now-active sibling and is refused. Since the RPC is one
transaction, the whole selection aborts. 0294 changes nothing here: its
collateral clause refuses when `v_lot.sticker_code IS NULL OR
other.sticker_code IS NULL`, and both are NULL.

BIN-002571 / BIN-002629 are worse — their ancestor BRN4379513 is live on an
auction right now, so 0294 clause (a) refuses them **unconditionally**, sticker
or not.

---

## The finding that goes beyond the handoff

0294's relaxation is not merely unhelpful for these five pairs. **It cannot fire
on any lot in prod today, and never has been able to.**

| measure | value |
|---|---|
| lots total / with sticker | 10,854 / 5,449 (50.2%) |
| **active** lots with sticker | 1,413 / 1,529 (**92%**) |
| root-groups holding >1 live-or-inventory lot | 18 (44 lots) |
| …of those, groups with **≥2 stickered members** | **0** |
| multi-member lineage roots in **all prod history** | 1,078 |
| …of those, roots with **≥2 stickered members** | **0** |

Stickers are in heavy use (92% of active lots), so this is not "the feature is
unused". It is structural, and it follows from the very mechanism 0294 is built
on: `relist_lot_into_auction` **moves** the sticker off the source and onto the
child. Within one lineage the sticker is therefore conserved — at most one
member can hold it. Two independently-stickered boxes are two separate intakes
with **different roots**, so they never share a lineage and never reach the
guard in the first place.

So the condition 0294 calls "proof of distinctness" — two stickered members of
one lineage — is unreachable by construction. 0 for 1,078 across all history.

**Consequence:** 0294 part A is a correct, safe, strict relaxation, but on
current data it is a no-op. Shipping it will not change what Jared can post.
Do not report the P0 as fixed.

---

## The real fix

Unchanged from the handoff: the **Duplicate Lot Button**. Lotting cannot express
"I received N identical items", so quantity>1 keeps arriving as a relist of one
parent, producing unstickered siblings that are — correctly — indistinguishable
from the same box listed twice. Not started; design before code.

A cheaper interim option worth considering: since two boxes only become provably
distinct by each holding a sticker, and relist *moves* rather than *copies* the
sticker, the quantity>1 path needs to mint a **new** sticker per unit at lotting
rather than inherit one. That is the same root issue, stated as data rather than
UI.

---

## Verification caveat, confirmed empirically

`duplicate_lot_audit()` is `SECURITY DEFINER` and early-returns when
`auth.uid()` is NULL. Confirmed on prod: **`auth.uid() IS NULL` is true from the
MCP connection**, so the function returns zero rows regardless of state. A zero
from an unauthenticated MCP session proves nothing and must not be used as the
release gate. Any post-migration verification has to run with a real operator
identity (via the app, or by setting `request.jwt.claims`).

---

## Cheap wins — done, and blocked

### Done: mig 0273 recovered (this branch, `0295_…`)

`_schema_migrations` records `0273_putaway_location_regardless_of_status.sql`
applied 2026-07-16 19:32:46Z by `runner@runnervm3jd5f`, with no such file in the
repo. Three RPCs carry live `0273` markers and differ from the repo's newest
definitions (0250 / 0252), so a from-scratch rebuild silently reinstated a
status gate prod removed two weeks ago.

`0295_recover_putaway_location_regardless_of_status.sql` re-commits
`intake_lot_to_bin`, `batch_intake_lot_to_bin` and `confirm_move_lot_to_bin`
transcribed verbatim from prod via `pg_get_functiondef`.

**Verified byte-exact.** Applied to a local pg16 against minimal stubs, then
compared `md5(pg_get_functiondef(oid))` local vs prod — all three match:

| function | md5 (local == prod) |
|---|---|
| `batch_intake_lot_to_bin` | `864251bb7e9560b5e3440aeddc927573` |
| `confirm_move_lot_to_bin` | `d6de517e99308f61c7aaf08c1b062139` |
| `intake_lot_to_bin` | `aa3399877623685cde63533fe5aa9235` |

So 0295 is a true no-op against prod and a real repair for any clean rebuild.
Numbered 0295 because 0294 is claimed by the open PR #219.

### Migration ledger drift

Prod has **0273, 0274, 0275, 0276** applied; the repo jumps 0272 → 0277. Four
missing, not three. 0274's and 0275/0276's observable behaviour was later
re-established by 0291 and 0285/0290 respectively, so only 0273 was a live
rebuild hazard — now closed. 0274–0276 remain uncommitted history.

Likely source of the "unexplained second project ref": `scripts/apply-migrations.js`
carries `xgsujdzicnjenhqihovk` in its usage comment (line ~24) as the example
`SUPABASE_PROJECT_REF`. It is a stale doc string, not a live target.

### Done: Harrison Square location pinned

`warehouses.square_location_id` was NULL for all three warehouses. Set Harrison
(`ce9646af-…`) to `LH36T6WADKGV7`.

Behaviourally a no-op — verified in
`apps/operator-web/src/lib/cron/auto-charge-drain.ts:236` that a warehouse
absent from the map falls back to the `SQUARE_LOCATION_ID` env var, which is
already that value. It removes the silent env dependency.

### Blocked: Dodge City

Still NULL — the Square location ID was never supplied. **Lower urgency than the
handoff implies: Dodge City currently holds 0 lots**, so nothing is
mis-attributing yet. Harrison holds 10,325. Fill it before Kansas inventory
lands.

### Correction: marketing campaigns are NOT all disabled

The handoff says "5 seeded, all disabled". Prod disagrees — **4 of 5 are
`enabled = true`**:

| slug | enabled |
|---|---|
| `first_bid_nudge` | **true** |
| `outbid_comeback` | **true** |
| `second_purchase` | **true** |
| `win_back` | **true** |
| `sms_optin_push` | false |

Two **manual** runs were recorded 2026-07-28 17:56Z — `outbid_comeback`
(89 recipients) and `first_bid_nudge` (257 recipients), both with
`skipped_reason = NULL`. But `marketing_campaign_sends` is **empty (0 rows)**,
so whether ~346 emails actually reached bidders is unresolved. Worth settling
before anything else is turned on, since the "needs owner go-ahead" gate the
handoff assumed was in place is not.

### Twilio — unchanged conclusion, refreshed numbers

| measure | value |
|---|---|
| `notifications_outbox` rows | 29,915 |
| ever SMS'd (`smsed_at`) | **0** |
| ever emailed (`emailed_at`) | 29,906 |
| bidders | 644 |
| `sms_enabled` | **2** |
| with a phone number | 432 |

Run `sms_optin_push` (the one disabled campaign) before enabling SMS.

---

## Post-deploy verification (2026-07-29)

Mig 0294 applied and confirmed on prod — `lot_lineage_chain` created,
`lots_one_active_relist_child` re-keyed with `sticker_code IS NULL`,
`assign_lots_to_auction` using the chain, `duplicate_lot_audit` carrying
`same_root_distinct_units`. Cloudflare deploy `30416923603` succeeded.

`duplicate_lot_audit()` was then run **with a real operator identity** —
`set_config('request.jwt.claims', '{"sub":"<admin uuid>"}', true)`, with
`auth.uid()` echoed back in the result to prove the identity took. Without this
the function returns zero rows and the gate is meaningless.

### The gate did not pass

| kind | required | first run | after remediation |
|---|---|---|---|
| `same_root_active` | 0 | **3** | **3** (open) |
| `sold_and_collected_still_live` | 0 | **4** | **0** ✅ |
| `stale_cancel_stamp` | 0 | 0 | 0 |
| `ghost_parent_on_auction` | 0 | 0 | 0 |
| `multi_active_child` | — | 4 | **4** (open) |
| `same_root_distinct_units` | non-zero iff 2/2 | 0 | 0 — as predicted, it cannot fire |

### Four phantom lots pulled from live auctions

`sold_and_collected_still_live` is the highest-severity kind the audit can emit:
an active listing for an item a buyer has already **paid for and physically
collected**. Four were scheduled on auctions closing 2026-08-01 and 08-03.

| lot | auction | closes | bids | collected sibling | picked up |
|---|---|---|---|---|---|
| BIN-002057 | Oops... I Bid Again | Aug 1 | 0 | BIN-000258 | 2026-07-13 |
| BIN-002566 | Cart Before The Horse | Aug 3 | 0 | BIN-002404 | 2026-07-22 |
| BIN-002625 | Cart Before The Horse | Aug 3 | 0 | BIN-002248 | 2026-07-22 |
| BIN-001585 | Don't Cry Tomorrow | Aug 3 | 1 | BIN-000295 | 2026-07-11 |

Confirmed as phantoms, not quantity>1: in every pair the **collected sibling
holds the sticker** (e.g. `BIN:BRN4371909`, matching the shared parent's lot
code), the still-listed lot has **none**, and both share an `import_row_id`.
Under the same sticker-conservation argument, the unstickered survivor is the
same physical box.

All four canceled via `admin_cancel_lot` (2026-07-29 02:38:12Z) with reason
`Phantom lot: sibling already paid for and physically collected …`.
`p_force = true` was needed only for BIN-001585, which had one bid — the RPC
voids open bids pre-close with no charge. Re-running the audit confirms
`sold_and_collected_still_live = 0`.

**Bidder to notify:** `sanlkelly@yahoo.com` (bidder `490db94c-…`) had a $1.00
bid on BIN-001585, now voided by the cancel. Not yet contacted.

This defect predates today — check F is reproduced verbatim from 0290, so 0294
neither caused nor fixed it. It went unseen because no prior session could
reach prod, and an unauthenticated audit call reports zero.

### Still open — needs a decision

Two kinds remain non-zero and are the same hazard one step earlier.

`same_root_active` (3) — a live lot and a scheduled lot sharing a root, at
least one unstickered:

| root | lots |
|---|---|
| BRN4380172 | BIN-002573 [live] no-sticker + BIN-005578 [scheduled] |
| BRN4380385 | BIN-002564 [live] no-sticker + BIN-005550 [scheduled] |
| PNK4860371 | BIN-002633 [live] no-sticker + BIN-005983 [scheduled] no-sticker |

`multi_active_child` (4) — two of these have a sibling that has already **won**
but not yet been collected, which is precisely the state that becomes a
`sold_and_collected_still_live` the moment the buyer picks up:

| root | lots |
|---|---|
| PNK4859184 | BIN-002576 [live] + BIN-003092 [**won**] |
| PNK4996305 | BIN-002626 [live] + BIN-003083 [**won**] |
| BRN4380172 | BIN-002458 [relisted] + BIN-002573 [live] |
| BRN4380385 | BIN-002405 [relisted] + BIN-002564 [live] |

Unlike the four pulled above, nothing here is collected yet and the live lots
are actively taking bids, so cancelling is a live-auction intervention rather
than a clear phantom cleanup. Left for an explicit call.
