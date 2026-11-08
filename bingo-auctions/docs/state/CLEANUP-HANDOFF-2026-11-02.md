# Cleanup handoff — 2026-11-02

## Step 4 merged; step 5 has no separate deploy

- PR #642 squash: `8f3336b5638184e207444c8cdaf86e0cbf96fd5f`, merged 2026-11-02 at 14:07 Central only after owner instruction and fresh green checks. No deploy was needed or performed.
- Step 4 CI [41514813322](https://github.com/jmacluer-design/bingo-auctions/actions/runs/41514813322), E2E [41514813362](https://github.com/jmacluer-design/bingo-auctions/actions/runs/41514813362), embed smoke [41514813332](https://github.com/jmacluer-design/bingo-auctions/actions/runs/41514813332), and footprint guard [41514813443](https://github.com/jmacluer-design/bingo-auctions/actions/runs/41514813443) passed.
- Step 5 starts from that fetched master on `braden/cleanup-5`. It anonymizes source comments only; the location-only inventory is CLEANUP-COMMENT-PRIVACY-2026-11-02.md. Migration findings are listed without identifier values; no migration bytes change.
- Owner explicitly overrides the default deploy rule for step 5: **no standalone deploy**. Keep its PR draft until explicit merge approval, then let step 6 carry these comments. Step 6 deploys once before 16:00 Central, or holds until 09:00 the following day if it misses. Verify `/api/version` and run `post-deploy-check.yml` afterward; roll back a failed live change first. This is a hold rule, not a claim of a scheduled automatic action.
- Local step 5 typecheck/lint passed. A concurrent unit run hit an unchanged image-enrichment wall-clock assertion (716 ms versus <200 ms); phase stopped, then the owner explicitly approved an isolated retry and unit-only rerun. The isolated timing test passed (one selected test, 19 skipped, 66 ms test duration); neither test nor implementation changed. The unit-only rerun then passed all 12 workspace tasks in 14.2 s, including operator-web 141 files / 1,255 tests and DB (7 passed / 48 optional skipped). Remote CI evidence belongs in the step 5 PR.
- Mobile source still ships only with the next normal app release. Existing automatic CI smoke builds are owner-authorized; no app release or OTA is authorized here.

## Step 3 is merged and deployed

- PR #641 squash: `78a24dbd6be84adcc3edff123944eb686d07d1f6`.
- Deploy [41510285074](https://github.com/jmacluer-design/bingo-auctions/actions/runs/41510285074) passed during the approved afternoon window. Both Worker source trees changed, so both Workers deployed.
- `/api/version` returned that exact SHA before post-deploy check [41511589834](https://github.com/jmacluer-design/bingo-auctions/actions/runs/41511589834), which passed on the same SHA.
- Post-deploy E2E [41511440748](https://github.com/jmacluer-design/bingo-auctions/actions/runs/41511440748) passed. No rollback needed. The latest verified safe build/deploy for the next steps is now the squash/run above; the step 2 and original baseline records remain below and in the rollback document.
- Braden explicitly allowed the existing automatic CI mobile smoke builds on merge. This does not authorize a mobile release or OTA; source edits still ship with the next normal app release.
- Step 4 is scripts/docs only and does not deploy. Keep one draft PR per step and wait for explicit merge approval. If a later step 5 or 6 website/cron deploy cannot complete by 16:00 Central, open the draft PR and hold deployment until the next 09:00 Central window (2026-11-03 for today's work); this records a hold, not a scheduled automatic action.

## Step 4 — baseline confirmed and resumed with owner approval

- Base: fresh `origin/master` `80117020b7a69a9edaead44755770b9d3963d282`, after the other authorized changes merged. The keep/delete audit was regenerated against that base: 397 tracked script files / 122 root entries; 52 obsolete files (7,103 lines) removed, 345 retained. No deployment for this scripts/docs-only step.
- The original manifest-key failure was reproduced on a separate clean detached origin/master checkout at `/private/tmp/bingo-step4-master-baseline`, using Node 20.19.4 and the exact same test. Result: 7 passed / 1 failed at line 49 (`po=po9`). Git status was clean before and after. Dependencies were independent file copies, with no folder links and no install/ci in that checkout.
- Braden confirmed the expected generic key is `ponumber=po9`: `PO_Number` normalizes to `ponumber`. With explicit approval, corrected only that expectation in its own commit `ba019686`; implementation and fixtures are unchanged. The corrected file passes 8/8, and the complete scripts unit-test run passes 180 / 227, with 47 optional cases skipped and zero failures. CI currently invokes selected script tests and does not run this deduper test file; no CI/E2E workflow was changed here.
- Fresh forced workspace typecheck (12/12), lint (11/11), and unit/DB tasks (12/12) passed against the updated base. Operator-web: 141 files / 1,255 tests passed; field-mobile: 161 tests passed; DB: 7 passed / 48 opt-in cases skipped. Preflight and source/schedule guards passed. Remote CI evidence belongs in the step 4 draft PR. The full retained/deleted file inventory and all reference locations are in CLEANUP-SCRIPTS-KEEP-DELETE-2026-11-02.md.
- Braden explicitly said to wait for step 4 to merge before starting steps 5–6. Keep draft; merge only after his explicit instruction. Any later deployment missing 16:00 Central remains held until the next 09:00 window; no automatic future execution is scheduled here.
- The previously approved automatic Maestro run 41510259087 concluded cancelled, not successful; cleanup did not cancel it or change its files. Existing web CI and post-deploy E2E for step 3 passed.

## Step 2 is merged and deployed

- PR #640 squash: `6d31edff2b9977b0f0a8aef671c9f7818fc0a56f`.
- Website deploy [41503157644](https://github.com/jmacluer-design/bingo-auctions/actions/runs/41503157644) succeeded in the 09:00–16:00 Central window. Both cron deploy/secret steps were skipped.
- `/api/version` returned the exact squash SHA before the post-deploy workflow was dispatched.
- Post-deploy check [41504587521](https://github.com/jmacluer-design/bingo-auctions/actions/runs/41504587521) passed.
- Post-deploy E2E [41504220940](https://github.com/jmacluer-design/bingo-auctions/actions/runs/41504220940) passed against the new build. Existing synthetic-user setup is owner-authorized; do not change E2E in this phase.
- No rollback was needed. The last verified safe website build for the next step is now the squash above; its deploy run is 41503157644. The pre-cleanup rollback tag and original baseline remain in CLEANUP-ROLLBACK-2026-11-02.md for full-phase recovery.

## Requested charge comparison — NOT SCHEDULED

Owner requested execution tomorrow after 07:00 America/Chicago (2026-11-03). Suggested target: 07:05 CT. No connected agent scheduler or scheduling tool is available in this session, so no automatic run or future delivery is claimed. The SQL below is prepared only; it has NOT been executed against production.

Use the existing reviewed `apply-migration.yml` workflow with **mode=query only**, or the owner's approved read-only query runner, after the full overnight window closes. Do not apply migrations, write data, change accounts, run production maintenance scripts, or expose keys/customer data. This specific read-only comparison is owner-authorized.

Count processor attempts with outcomes succeeded/declined/error, excluding offline settlements and demo operators. Report failed attempts and distinct failed invoices separately; split declines/errors and automatic/manual retries. Compare Nov 2 18:00–Nov 3 07:00 Central against the seven previous matching night windows. Use America/Chicago rather than fixed UTC offsets: the Oct 31 overnight window includes the DST change and is an hour longer. Include total attempts, failure rate, prior-week mean/median/range, absolute/percentage difference, and limits on causal interpretation. Return aggregate counts only, with source/run evidence; no customer names, emails, card data, raw payment details or per-invoice identifiers.

```sql
WITH nights AS (
  SELECT (date '2026-11-02' - n) AS night_date,
         ((date '2026-11-02' - n) + time '18:00') AT TIME ZONE 'America/Chicago' AS starts_at,
         ((date '2026-11-02' - n + 1) + time '07:00') AT TIME ZONE 'America/Chicago' AS ends_at
  FROM generate_series(0, 7) AS g(n)
)
SELECT n.night_date, n.starts_at, n.ends_at,
       extract(epoch FROM (n.ends_at - n.starts_at)) / 3600 AS window_hours,
       count(ca.id) AS processor_attempts,
       count(ca.id) FILTER (WHERE ca.outcome = 'succeeded') AS succeeded_attempts,
       count(ca.id) FILTER (WHERE ca.outcome = 'declined') AS declined_attempts,
       count(ca.id) FILTER (WHERE ca.outcome = 'error') AS error_attempts,
       count(ca.id) FILTER (WHERE ca.outcome IN ('declined', 'error')) AS failed_attempts,
       count(DISTINCT ca.invoice_id) FILTER (WHERE ca.outcome IN ('declined', 'error')) AS failed_invoices,
       count(ca.id) FILTER (WHERE ca.source = 'auto_charge' AND ca.outcome IN ('declined', 'error')) AS failed_auto_attempts,
       count(ca.id) FILTER (WHERE ca.source = 'manual_retry' AND ca.outcome IN ('declined', 'error')) AS failed_manual_attempts,
       round(100.0 * count(ca.id) FILTER (WHERE ca.outcome IN ('declined', 'error')) / nullif(count(ca.id), 0), 2) AS failure_percent
FROM nights n
LEFT JOIN charge_attempts ca
  ON ca.attempted_at >= n.starts_at AND ca.attempted_at < n.ends_at
 AND ca.source IN ('auto_charge', 'manual_retry')
 AND ca.outcome IN ('succeeded', 'declined', 'error')
 AND EXISTS (SELECT 1 FROM operators o WHERE o.id = ca.operator_id AND o.is_demo IS NOT TRUE)
GROUP BY n.night_date, n.starts_at, n.ends_at
ORDER BY n.night_date DESC
```
