# Migration gap 0331–0355 — 2026-09-30 (read-only)

Question: `_schema_migrations` in prod records 0330 and then jumps to 0356. Are 0331–0355 actually in prod, why are they unrecorded, and does tomorrow's 0380/0381 depend on any of them?

Method: every "present in prod" answer below comes from `apply-migration.yml mode=query` (SELECT only) run 9/30 between 14:30 and 16:30 CT, checking the object each file creates or the function body it patches. Code references are to `origin/master` at `1daf9cf`. Nothing was written.

**Correction to this morning's note:** I said 0331 "never ran in prod". It did. See §1, 0331.

---

## 1. Is each change in prod?

| # | Change | Recorded? | In prod? | Proof |
|---|---|---|---|---|
| 0331 | Data repair: refunded invoices re-stamped paid; paid_at; refunded_at | no | **yes, applied 8/25 ~12:36 CT** — but the bug kept running until 8/29, so its leftovers came back (see below) | Invoice `a5c6981d` (the one named in the file) was set paid→refunded by a system write at 8/25 17:36:45 UTC. Every refund up to 8/24 has `refunded_at`; the gaps start 8/25 |
| 0332 | `charge_attempts` table, `bidders.card_type/prepaid_type/card_facts_synced_at` | no | yes | table exists; column exists |
| 0333 | Seed `charge_attempts` from surviving decline codes | no | yes | 58 rows dated before 8/27 with source `auto_charge` — the PR #280 body says "seed produced 58 rows". 7,386 rows today |
| 0334 | `bin_present_lots` one row per box | no | yes | function exists, comment is the 0334 text (Cage-01-01 audit) |
| 0335 | Promote shelved complete drafts to `in_inventory` | no | yes | 0 draft lots still match the file's WHERE; the only 2 bin-less drafts left are the ones it deliberately skipped |
| 0336 | Stamp `refunded_at` on resolved missing-item lines | no | yes | 0 resolved `missing` outcomes with an unstamped line |
| 0337 | No-show sweep includes `checked_in`; `stamp_forfeited_invoice_lines` on `no_show`; backfill 29 | no | yes | `auto_mark_pickup_no_show` body has `('pending', 'scheduled', 'checked_in')`; stamp fn has `no_show`; 0 stale checked_in pickups |
| 0338 | `lot_lotter_name()` | no | yes | function exists |
| 0339 | `meta_events_outbox` + 3 triggers | no | yes | table exists; `trg_meta_purchase` exists |
| 0340 | `bidders.ad_tracking_opt_out` | no | yes | column exists |
| 0341 | `bidders.meta_fbc/meta_fbp/meta_attribution_at` | no | yes | `meta_fbc` exists |
| 0342 | `ready_to_bid` campaign (audience `card_never_bid`); `campaign_audience` split | no | yes | campaign row present (enabled=true); function body has `card_never_bid` |
| 0343 | `category_demand_tiers()` | no | yes | function exists |
| 0344 | `advance_auction_lifecycle` treats `disposed` as terminal | no | yes | body has `'relisted', 'disposed')` |
| 0345 | Trigger blocks relisting a missing item | no | yes | `lots_block_relist_of_missing_item_trg` exists |
| 0346 | `list_workers_admin`, `worker_productivity*`, index | no | yes | function + `lots_lotted_by_worker_created_idx` exist |
| 0347 | `worker_daily_productivity`, `worker_productivity(uuid,text)` | no | yes | both exist; the only `worker_productivity` overload is `(uuid, text)` |
| 0348 | Productivity ignores relist children | no | yes, as superseded by 0349 | 0349 re-created the same three functions; prod bodies exclude `system_auto` (0349's rule) |
| 0349 | `lots.relist_origin` + check + trigger; `auto_relist_unsold_lots` marks `system_auto`; backfill | no | yes | column, `lots_relist_origin_chk`, `lots_default_relist_origin_trg` exist; every relist child is `human_relot` (1,079) or `desk_relist` (4,367), none NULL |
| 0350 | `place_bid` self-raise can only raise | no | yes | body has `GREATEST(max_amount_cents, p_max_amount_cents)`; 1 overload |
| 0351 | Sweep honours `collected_lot_ids`; GIN index | no | yes | body has `collected_lot_ids @> ARRAY[il.lot_id]`; `pickup_sessions_collected_lot_ids_gin` exists |
| 0352 | `missing` removal kind | no | yes | `lots_removal_kind_check` lists destroyed, bin_store, donated, liquidated, **missing**, other |
| 0353 | Relot never auto-schedules; refunded `won` can be relotted | no | yes | `relist_lot_into_auction` body and comment carry the 0353 text |
| 0354 | Put-away records finding an item | no | yes | `intake_lot_to_bin` body and comment carry the 0354 text |
| 0355 | Trigger blocks relisting a collected item | no | yes | `lots_block_relist_of_collected_item_trg` exists |

**All 25 are in prod.** 0332–0355 are schema/function changes and every one is present. 0331 is data-only and ran, but its target kept being re-damaged for four more days.

### 0331's leftovers (separate from tomorrow)

0331 ran on 8/25. The webhook guard that stops the damage shipped with the 8/29 22:38 UTC deploy. Between the two, refunds kept getting re-stamped. What is wrong in prod today, all from that 8/25–8/29 window plus a few stragglers:

| Leftover | Count | 0331 step that fixes it |
|---|---|---|
| Fully refunded invoice reading `paid` (`219cab28…`, $2.52, refunded 8/29 18:12 UTC) | 1 | step 1 |
| `paid_at` overwritten with the refund time (receipt exists to restore from) | 88 | step 2 |
| Refunded invoice with blank `refunded_at` (line stamp exists to copy from) | 91 | step 3 |

0331 is idempotent (every UPDATE is guarded by the condition it repairs). **Re-running it once fixes all three row sets.** It is a write to payment tables, so it waits for an explicit go; any hour is fine for it (nothing customer-facing changes except "Paid" → "Refunded" on one invoice page, and refund dates appearing on 91 operator invoice pages).

```
gh workflow run apply-migration.yml --ref master -f mode=rerun -f file=0331_repair_refunds_clobbered_by_the_payment_webhook.sql
```

Not covered by 0331 (found on the way, logged in the 9/30 investigation follow-up): 98 fully refunded invoices reading `partially_refunded` because `refund.updated` sets status from the single refund's amount (`api/square/webhook/route.ts:264`); 137 July refunds carrying $0 in `refunded_cash_cents` because refund accounting (0270) arrived 7/16.

---

## 2. Why 0331–0355 are missing from `_schema_migrations`

`_schema_migrations` is written by exactly one thing: `scripts/apply-migrations.js` (the INSERT at line 328), whether run from a laptop or by the `apply-migration.yml` workflow (`mode=rerun` calls the script with `--rerun <file>`). Nothing else records. The workflow header has said so since July: "its `_schema_migrations` only tracks a fraction of history" (SESSION-HANDOFF-2026-07-01: 45 of 208 files at the time; 174 of 370 today).

`applied_by` tells the story:

| Files | `applied_by` | Route |
|---|---|---|
| 0325–0330 (8/19–8/20) | `claude-session` | the script, run from a laptop |
| 0331–0355 (8/25–9/14) | *(no row)* | applied by another route — the PR bodies (#280, #282, #294, #297, #304–#310) each say "applied to prod, dry-run in a rolled-back transaction first". That is a direct SQL session (psql / Management API query), not the script |
| 0356 onward (9/14 19:30 UTC →) | `runner@runnervm…` | the workflow |

**The workflow did not change how it records.** There were zero `apply-migration.yml` runs between 8/21 and 9/14 19:30 UTC. The only change to the applier in that period is `fa94e75` (9/14 12:01 CT, "Require SUPABASE_PROJECT_REF explicitly"): it removed the hard-coded default project ref (ClovrBid's upstream project) so the Management API path refuses to guess which database to write to. It touches nothing about recording. Applies went back through the workflow the same afternoon, which is exactly where the recorded rows resume (0356 at 9/15 16:08 UTC, after a run of query/status runs on 9/14).

So the gap is bookkeeping: for three weeks the script was bypassed, and only the script writes the ledger. The schema itself is complete.

---

## 3. Does 0380 or 0381 depend on anything in 0331–0355?

**No.** Checked against what each file actually touches, and confirmed present in prod:

**0380 `consent_records_client`** replaces `record_operator_consent(uuid, integer)` to read the client IP and user agent from `request.headers`. Needs: `operator_policies.published`, `operator_policy_acceptances(ip_address, user_agent, version)`, and the existing function signature. All present (0378/0379 era, recorded). Nothing from 0331–0355.

**0381 `keep_for_business`** creates `lot_internal_keeps` + `keep_lot_for_business(uuid, integer, text)`. It sets the lot to `status='disposed', removal_kind='other'` and writes `removed_at/removed_by/removal_note/flagged_*`. Needs, all present:

| Dependency | From | In prod |
|---|---|---|
| `lots.removal_kind`, `removed_at`, `removed_by`, `removal_note`, `flagged_for_disposal`, `flagged_at`, `flagged_reason`, `lot_code` | 0319 and earlier | yes |
| `lots_removal_implies_disposed` constraint | 0319 | yes |
| `'disposed'` in `lot_status`; `'other'` in `lots_removal_kind_check` | 0319; 0352's version of the check is what's live and still allows `other` | yes |
| `operator_audit_log.reason_note` | earlier | yes |
| `advance_auction_lifecycle` counts `disposed` as terminal, so a kept lot inside a scheduled/live auction can't pin that auction open | **0344** | yes |

0344 is the one item in the gap range that matters for 0381's behaviour, and it is present. Neither `lot_internal_keeps` nor `keep_lot_for_business` exists yet, so 0381 is a clean first apply.

---

## 4. Go / no-go for tomorrow 05–07

**GO.**

- Every schema and function change from 0332–0355 is in prod. The ledger gap is a record-keeping artifact of how those files were applied, not missing schema.
- 0380 and 0381 depend on nothing in the gap beyond 0344, which is present.
- `mode=rerun` applies the one named file and does not consult `_schema_migrations`, so the gap cannot block or misdirect the apply. Both files exist on `master` (#406 merged, `4594353`).
- The post-apply check in HANDOFF-2026-09-29 §1 still applies unchanged.

Separately, with its own go: re-run 0331 to clear the 1 / 88 / 91 leftovers. **Update 9/30 16:00:** 0380 and 0381 applied 13:12/13:16, both green. 0331 re-run and the ledger backfill (**0385**, `0385_backfill_schema_migrations_ledger_0331_0355.sql`, proven idempotent on the rig) are scheduled for Friday 10/2 05:00–07:00, in that order. See HANDOFF-2026-09-30.md §3.
