# Audit — items collected in person, then forfeited and relisted (2026-09-14)

Read-only investigation. No prod data was changed. Every number below was read
from BinGo prod (`npwseclcxcatjhgjrtwe`) on 2026-09-14 between 14:30 and 15:00
Central through the `Apply DB Migration` workflow's `query` mode (SELECT-only).
Three passes were run: (1) whole-database counts, (2) drill-down by mechanism,
(3) concrete lot lists. Code paths were read in full for the sweep, the relist
RPC and triggers, the console, the counter session page, the field app, the
manager override, the bidder bin-scan RPC and the refund route.

## 1. The short version

| Question | Answer |
|---|---|
| Is the bug still producing new cases? | **No.** Since 0351 (09-10) zero collected lots have been flipped to unsold. Since 0355 (09-14) zero collected lots have been relisted. Sweep runs every 30 min and is healthy. |
| What caused the wave the owner saw? | Migration 0337 (08-27) made partially-collected pickups sweepable. The sweep's Step 2 then reclaimed **every** lot on the invoice, including the ones already handed over. 0351 added the per-lot guard on 09-10. **301 collected lines were reclaimed in that 14-day window; 0 before it.** |
| How much damage? | 327 collected lines forfeited in total. 197 were relisted (all from the console, `desk_relist`). 181 relist children were won by a second buyer: 93 marked MISSING at the counter, 92 refunded, **82 still open** (paid, awaiting pickup). |
| What is still exposed today? | 82 open second-buyer promises for items that already left. 19 relist children of gone items sitting `unsold` that the 0355 trigger cannot see. 3 `unsold` lots where only the customer's phone tick says "collected". 11 pending lots ticked by the customer but never confirmed by staff. |
| Is there a second mechanism? | **Yes, smaller.** Late pickups: the sweep forfeits at 18:00 with 0 grace hours; the customer collects the next morning (21 of 24 late pickups were within 24 h). Nothing flips the lot back from `unsold`, so 14 of 24 were relisted anyway and 4 resold. 0355 now blocks the relist but tells staff to "refund or put back", which is the wrong instruction for a late pickup. |

## 2. Mechanisms, with evidence

### 2a. Sweep reclaimed items already handed over (primary; fixed 09-10)

`auto_mark_pickup_no_show()` Step 2 routed **all** lots on a no-show invoice to
`unsold`, with no per-lot check (0159/0166, unchanged until 0351). Partial
pickups (`checked_in`) were outside the sweep until 0337 widened its status
filter on 08-27. From that day, every invoice where the customer took some
items and never returned for the rest lost **all** of them.

| Collected-before-forfeit lines, by forfeit date | n |
|---|---|
| before 08-27 (0337) | 0 |
| 08-27 to 09-10 (0337 live, 0351 not yet) | **301** |
| since 09-10 (0351 live) | 26, all left `won`; none flipped to unsold |

Spike days: 08-27 (88), 09-02 (48), 09-04 (51), 09-05 (31), 09-06 (25).
Forfeits happen at 18:00 Central (459 of 494), i.e. the auction pickup window
end (227 of 253 auctions end pickup at 18:00) with `pickup_grace_extension_hours = 0`
on both operators.

Of the 301 + 26 = 327: 197 relisted (`relist_origin = desk_relist`, 100%;
the human relot path and the cron produced none), 128 reset to `won` by the
owner, 2 disposed. Relists happened 1–3 days after the forfeit in 114 cases.

Deployed state verified on prod: the sweep body contains the 0351 guard
(`picked_up_at IS NULL AND refunded_at IS NULL AND NOT collected_lot_ids @> …`),
`stamp_forfeited_invoice_lines` carries the same guard, the status filter is
`('pending','scheduled','checked_in')`, `lots_block_relist_of_collected_item_trg`
and `lots_block_relist_of_missing_item_trg` are enabled, `relist_lot_into_auction`
carries 0353. Last four sweep ticks succeeded.

### 2b. Late pickup after forfeit leaves the lot `unsold` (secondary; open)

24 lines carry both `forfeited_at` and a later `picked_up_at`. Gap: 6 under
12 h, 15 between 12 and 24 h, 3 over 48 h. `staff_confirm_pickup` stamps the
line and completes the pickup but never touches `lots.status`, so the lot stays
`unsold` in the worklist and Auction Builder. 14 of the 24 were relisted after
the customer had already collected; 4 of those children were won by a second
buyer (TEA5008226, PNK4822012, PNK4998068, PNK4998075).

### 2c. Relist guards are lineage-blind (open)

`lots_block_relist_of_collected_item()` reads `invoice_lots` for
`NEW.relisted_from_lot_id` only, i.e. the **direct** parent. A child of a
collected item has no pickup stamp of its own, so relisting the child (making a
grandchild) is not blocked. 19 such children are `unsold` right now (list in §4).
The same shape applies to 0345's missing-item trigger.

### 2d. The customer's phone tick is not honored at relist time, and is not reliable (open, low)

`pickup_sessions.collected_lot_ids` is written by the bidder's own Pickup Pass.
0351 honors it in the sweep; 0355 does **not** honor it at relist. 3 `unsold`
lots are relistable on that signal alone (§4). Caution: in all 7 cases where a
second buyer actually collected a "gone" item, the parent's only signal was the
tick, never a staff stamp. Treat the tick as "check the shelf", not "gone".

### 2e. Paths that complete a pickup without stamping lines (theoretical; zero instances)

`markPickup({status:'completed'})` (console dashboard "Mark complete" and the
counter session page "Complete N paid pickups") and the legacy bidder RPC
`confirm_pickup` set `pickups.status = completed` without writing
`invoice_lots.picked_up_at`. Checked on prod: **0** completed paid pickups have
an unstamped, unrefunded line. The 370 console-completed pickups since 07-07 all
had every line already stamped by the field app. No pickup session has ever
reached `completed` (376 open, 248 of them with nothing left owed), so the
session "Complete" button is effectively unused. This is a latent gap, not a
source of the current damage.

### 2f. Console no-show / forfeit does not check the tick (open, low)

`markPickup({status:'no_show'|'forfeited'})` filters `picked_up_at`,
`refunded_at` and `missing` outcomes but not `collected_lot_ids`. All 471
forfeited pickups on prod carry a sweep audit row, so the console button has
not been used to forfeit anything; gap only.

## 3. What is protected today, and by what

| Signal that the item left | Sweep (0351) | Relist trigger (0355) | Console forfeit button |
|---|---|---|---|
| `invoice_lots.picked_up_at` (staff scan / manager override) | blocks | blocks (direct parent only) | blocks |
| `pickup_sessions.collected_lot_ids` (customer tick) | blocks | **no** | **no** |
| `pickup_lot_outcomes = collected` | no | no | no (0 rows exist) |
| `pickups.status = completed` without line stamp | n/a (completed is not swept) | **no** | n/a |
| Parent-of-parent collected | n/a | **no** | n/a |

## 4. Action lists (read from prod 2026-09-14)

### 4a. 82 open second-buyer promises for items the first buyer carried out

Every parent below has a **staff** pickup stamp. Second pickups end 09-14 to
09-19. When these customers arrive the item will not be on the shelf. Decision
for the owner: refund proactively vs. let the counter mark them missing.

BRN4361528, BRN4361602, BRN4361606, BRN4362443, BRN4362450, BRN4374037,
GRA4021075, GRA4021118, GRA4021172, GRA4122698, GRA4122979, PNK4819162,
PNK4819177, PNK4819899, PNK4820032, PNK4820044, PNK4820051, PNK4820055,
PNK4820064, PNK4820066, PNK4820079, PNK4820160, PNK4820187, PNK4820190,
PNK4820195, PNK4820227, PNK4820254, PNK4820259, PNK4822012, PNK4997301,
PNK4997302, PNK4997313, PNK4997771, PNK4998054, PNK4998077, PNK4998143,
PNK4998144, PNK4998145, PNK4998151, PNK4998164, PNK4998174, PPE3844032,
TEA3826564, TEA4840614, TEA4840626, TEA4840630, TEA4840654, TEA4840664,
TEA4840732, TEA4840738, TEA4840745, TEA5008182, TEA5008728, TEA5008777,
TEA5009103, TEA5009337, TEA5009454, TEA5009513, TEA5009626, TEA5009627,
TEA5009654, TEA5009670, TEA5009676, TEA5009706, TEA5009707, TEA5009746,
TEA5009763 (already marked missing), TEA5009764, TEA5009771, TEA5009778,
TEA5009800, TEA5009801, TEA5009813, TEA5009843, TEA5009847, TEA5009877,
TEA5010109, TEA5010153, TEA5010170, TEA5010179, TEA5010189, TEA5010192.

Six of these are `checked_in` (customer has been in once): PNK4820032,
PNK4820190, PNK4997771, PNK4998054, TEA5009513, TEA5009847.

### 4b. 19 relist children of gone items, `unsold`, relistable now (0355 cannot see them)

| Child | Parent (stamped) | Bin |
|---|---|---|
| BRN4361545 | BIN-011977 (08-29) | 5-01-02 |
| BRN4369967 | BIN-011005 (08-28) | 7-14-02 |
| BRN4383069 | BIN-010054 (08-27) | 4-16-01 |
| GRA4140959 | BIN-011255 (08-28) | 6-11-01 |
| PNK4820018 | BIN-011274 (08-30) | Right-05-07 |
| PNK4820198 | BIN-012822 (08-30) | Right-04-07 |
| PNK4820264 | BIN-013025 (09-05) | Right-04-01 |
| PNK4996722 | PNK4996722 (08-22, late pickup) | 1-15-01 |
| TEA3822773 | BIN-006059 (tick only) | 12-12-01 |
| TEA4840303 | BIN-012198 (08-30) | Right-01-07 |
| TEA4840743 | BIN-012872 (08-30) | 1-03-01 |
| TEA4840777 | BIN-013118 (09-05) | 6-15-01 |
| TEA4957214 | BIN-004521 (09-01) | 3-08-02 |
| TEA5008743 | BIN-007086 (09-06) | 9-05-01 |
| TEA5009661 | BIN-012599 (08-30) | 12-12-01 |
| TEA5009668 | BIN-012647 (09-06) | 14-11-01 |
| TEA5009700 | BIN-012001 (08-30) | 13-05-01 |
| TEA5009802 | BIN-012698 (08-30) | Right-02-05 |
| TEA5010019 | BIN-012943 (09-05) | 15-03-01 |

### 4c. 3 `unsold` lots relistable on the customer tick alone

TEA3822665 (bin 1-13-01), TEA4951205 (3-05-02), TEA4952013 (7-15-02). All
forfeited 08-27, no location event since, no staff stamp. Check the shelf.

### 4d. 11 pending lots the customer ticked, staff never confirmed

TEA5010650 (pickup ends 09-14), TEA5010317, TEA5010519, TEA5010688 (09-15),
TEA5010998 (09-18), PNK4998697, TEA4840637, TEA5009798 (09-19), plus
PNK4820622 (`checked_in`, ends 09-15). On none of these invoices has staff
stamped any sibling line. When the sweep forfeits them, 0351 will leave the lots
`won` on a forfeited pickup — safe, but invisible to every screen. Verify at the
counter.

### 4e. Second buyers who did collect a "gone" item (tick was wrong)

GRA3735867, PNK4819634, PNK4859855, PNK4997394, TEA3820935, TEA5008452,
TEA5008550. Parents were only ticked, never stamped. Nothing to do; evidence for §2d.

## 5. Recommended fixes (not applied)

| # | Change | Where | Why |
|---|---|---|---|
| 1 | Late pickup flips the lot back: when `staff_confirm_pickup` / `manager_pickup_override` stamps a line whose lot is `unsold` and has no relist child, set `lots.status = 'won'` | 0245/0304 `staff_confirm_pickup`, 0256 override | Closes §2b. Keeps the item out of the worklist and Auction Builder; 0355's "refund or put back" message stops firing on legitimate late pickups. |
| 2 | Walk the lineage in both relist triggers: check `picked_up_at` / missing outcome on every ancestor, not just the direct parent | 0345, 0355 trigger functions | Closes §2c; protects the 19 in §4b. |
| 3 | Honor the customer tick as a **soft** block at relist: raise a distinct code so the UI says "customer marked this collected on their pass, verify the shelf", clearable by Put-away scan like 0354 | 0355 trigger + relist error copy | Closes §2d without treating the tick as truth (7 false positives on record). |
| 4 | Stamp lines when a pickup is completed from the console or session page: make `markPickup('completed')` call `manager_pickup_override`-style stamping, or add a trigger on `pickups` status → `completed` that stamps open lines | `pickups/actions.ts`, or a new trigger | Closes §2e before someone starts using those buttons. |
| 5 | `markPickup('no_show'/'forfeited')` excludes lots in `collected_lot_ids` (mirror 0351) | `pickups/actions.ts` | Closes §2f. |
| 6 | Consider `pickup_grace_extension_hours` > 0 (e.g. 15 h so the 18:00 forfeit lands after the next morning's opening), or move the sweep tick | operator settings | 21 of 24 late pickups were within 24 h of the 18:00 forfeit. Owner call. |
| 7 | Surface "ticked by customer, unconfirmed" and `checked_in` / `forfeited` pickups on the console dashboard (it lists only pending, scheduled, completed, no_show) | `pickups/page.tsx` | §4d items are invisible today. |
| 8 | Close pickup sessions when nothing is owed | `completeSession` or a sweep | 248 open sessions with nothing owed; noise only. |

Fix 1 and 2 are database migrations touching checkout-adjacent behaviour:
prefer after 6 PM Central per Rule 9. Fix 4/5/7/8 are console-only.

## 6. Method

Prod is reachable read-only from any machine with repo access:

```
gh workflow run apply-migration.yml -f mode=query -f "sql=<SELECT or WITH …>"
gh run view <run-id> --log   # JSON rows after ##[endgroup]
```

Key predicates used:

```sql
-- a line the customer carried out
il.picked_up_at IS NOT NULL AND il.refunded_at IS NULL AND i.status <> 'refunded'
-- the customer's own tick
EXISTS (SELECT 1 FROM pickup_sessions ps WHERE ps.collected_lot_ids @> ARRAY[il.lot_id])
-- forfeit time (sweep writes one audit row per invoice)
(SELECT min(created_at) FROM operator_audit_log WHERE target_id = il.invoice_id AND action_type LIKE 'no_show.%')
-- relist children
lots c WHERE c.relisted_from_lot_id = il.lot_id
```

Runs: 34887427105 (pass 1 metrics), 34887735048 (deployed definitions),
34887903011, 34887958446, 34888002971, 34888055507 (pass 2), 34888496743,
34888597422, 34888328897, 34888746183 (pass 3).

## 7. Fix status (same day)

Migration `0356_collected_item_never_resold.sql` implements fixes 1, 2, 3 and 4
from §5 as table-level triggers; `pickups/actions.ts` implements fix 5.

One more finding surfaced while measuring the fix on prod: `lots_log_intake_move`
fires AFTER INSERT and the relist RPC copies `intake_bin_id` to the child, so a
relist child is born with a location event (1,757 of the last 2,041). Any guard
that treats "a location event after the pickup" as "somebody put it back" is
cleared by the relist itself. 18 of the 19 ghost children would have slipped
through. 0356 ignores a lot's own birth event; only a scan later than the row
counts.

Measured on prod with the final rule (2026-09-14, 15:20 Central):

| | n |
|---|---|
| relistable lots today (unsold / in_inventory) | 5,557 |
| would now be refused: stamped, direct parent | 3 |
| would now be refused: stamped, grandparent | 20 |
| would now be refused: customer tick (depth 0 / 1 / 2) | 3 / 1 / 1 |
| relists in the last 7 days that would have been refused | 0 |

Regression suite: `packages/db/test/collected_item_never_resold.sql`, wired into
CI. Cases: lineage guard (direct, grandparent, great-grandparent, direct insert),
the three clearances (line refund, invoice refund, later put-away scan), the
birth-event non-clearance, the customer-tick guard and its clearances, the
late-pickup restore (with and without a live child), completion stamping
(refunded, missing, left_behind, already-stamped, forfeited), and an end-to-end
replay of a partial pickup through `auto_mark_pickup_no_show()`. Verified
locally: the suite fails 14 assertions against the 0355-state database and
passes against 0356; every other SQL test in the repo still passes. Fixes 6, 7
and 8 in §5 remain open.

## 8. Monitor and reclaim guard (same day, later)

Verified against prod before implementing, all read-only through the `query` workflow (runs
34893825650, 34894046079, 34894092516, 34894133273, 34894170766, 34895115406, 34895162858,
re-runs 34895209304, 34895243446, 34895294509, reconciliation 34898001981 and the two that
followed).

| Question | Answer |
|---|---|
| Is the ops alert email alive? | Yes, and read. `ops_alert_throttle` shows sends on 08-20 and 09-01; PR #276 says the 08-20 email "prompted this PR" and shipped the same day. `OPS_ALERT_EMAIL` is not a repo secret and the deploy workflow does not push it, so the recipient is whatever was set by hand on the Worker, else `jmacluer@gmail.com`. Not readable from this machine (no Cloudflare token here). |
| Are 0357/0358 free? | Yes, on every remote branch and every open PR at 15:45 Central. |
| What happens when 0358 meets a collected lot inside the sweep? | Nothing aborts. The trigger skips that one row, records the attempt, and the rest of the tick completes. Raising instead would have killed the whole 30-minute tick every run (`cron.job` runs one `SELECT`, the function has no exception handler, verified on the deployed definition) — a silent outage in place of a silent data bug. Pinned in the new test (S2). |
| Are the counts stable? | Two independent runs 35 minutes apart, identical: A1=3, A2=203, A3=20, B1=88, B2=0, C1=0, C7=17, D1=0, T1=3, X1..X3=0; R1=137, R3=42, P1=26, P2=5; 218 flips in the 45-day timeline, all system-written at 18:00 Central. |

### 8a. 82 (§4a) vs 88 (monitor), reconciled

Neither number was wrong; they answer slightly different questions and the list moved while
being worked. Starting from the 82 codes in §4a:

| Change | n | Codes | Why |
|---|---|---|---|
| grandchildren | +3 | BRN4381951, BRN4382276, PPE3844015 | §4a walked one generation; the stamp is on the grandparent (§2c). |
| late pickups | +2 | PNK4998068, PNK4998075 | Parent forfeited 09-02 18:00, collected 18:05; §4a required the stamp before the forfeit, §2b already names these two. |
| swept, then pickup completed | +3 | BRN4369776, PNK4997993, PNK4997997 | Stamped 09-01, swept won→unsold 09-02 18:00 like the rest, then staff completed the pickup at 18:05, so §4a's forfeit-based filter lost them. Relisted `desk_relist` 09-07. |
| partially refunded invoice | +1 | PNK4820032 | In §4a. The monitor's first predicate required the second invoice to be `paid`; a `partially_refunded` invoice still owes its unrefunded lines. Fixed in 0357 before shipping. |
| refunded by staff today | −4 | TEA5009763 15:22, TEA5009746 16:10, GRA4021172 16:11, PNK4820254 16:11 | The §4a list is being actioned; two were marked missing first. |

82 + 3 + 2 + 3 + 1 − 4 = **86**, which is the committed
`docs/audits/second-buyer-promises-2026-09-14.csv` (80 pending, 6 checked in; windows end
09-14 to 09-19; $510.33 of paid lines; bidder number and id, no emails). The first export at
15:20 had 88 rows: the same set before the four refunds, minus PNK4820032.

### 8b. What shipped

- `0357_collected_item_invariant_monitor.sql`: `invariant_violations`, a shared "gone lot"
  predicate identical to 0356's, eight checks on pg_cron every 15 min (event checks look back
  7 days, state checks recompute, rows self-resolve and reopen), `operator_invariant_summary()`
  for /reports/health, and a baseline step that acknowledges everything found on install.
- `0358_collected_item_cannot_be_reclaimed.sql`: BEFORE UPDATE trigger on `lots`. A stamped,
  unrefunded, un-put-back lot moving into `unsold` / `in_inventory` is **skipped, not
  aborted**, and recorded as `collected_lot_reclaim_refused` (page) with the writer's query
  text; the health-check emails it within minutes.
- `payment-followups` abandon and `grace-expiry` now flip only lines with no pickup stamp and
  log what they left alone, so neither job depends on the trigger for correctness.
- The health-check route emails new `page` rows through the shared `lib/ops-alert.ts` and
  stamps `notified_at` only after Resend accepts. /reports/health gains a Handover invariants
  group and an open-rows table.
- `packages/db/test/collected_item_invariant_monitor.sql` (CI): every detector case breaks the
  guard that normally prevents the state and confirms the monitor reports it, then confirms the
  real remediation resolves it. Verified locally: with the 0358 trigger dropped, 17 assertions
  fail; with each detector check sabotaged in turn, only that check's assertions fail.

Fixes 6, 7 and 8 in §5 remain open. An acknowledge action on /reports/health is the obvious
next piece; today rows are acknowledged only by the install seed.

