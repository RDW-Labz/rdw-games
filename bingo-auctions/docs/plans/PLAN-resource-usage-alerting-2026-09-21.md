# Resource usage alerting — plan and §7c impact review

Status: **BLOCKED — Michael must provide supported billing-usage access/credentials.** No new resource signals have been built. The existing PAT cannot read authoritative image billing usage. Resume implementation only after that access is tested successfully; a replacement PAT alone is not a proven solution. Existing monitoring continues unchanged.

**Access gate tested September 21, 13:32 Central:** the existing Actions PAT returns HTTP 200 for organization details, project API-request usage, Prometheus metrics, disk utilization and organization entitlements. It returns **401** for the dashboard's `/platform/organizations/{slug}/usage` endpoint; the candidate `/v1/organizations/{slug}/usage` returns **404**. [Read-only probe run](https://github.com/jmacluer-design/bingo-auctions/actions/runs/35638982405), diagnostic branch `braden/billing-api-access-probe`, commit `cf45dd5`. No credential was exported. The current token therefore does not read the authoritative image-usage number through the tested routes. A different supported authentication/API arrangement is a **Michael item**; this result does not prove that merely creating another PAT will fix it. Keep image quota automation blocked and use dated manual dashboard evidence until that access is established. Do not build any new resource signals meanwhile. The earlier “unverified” descriptions below are the original planning state, superseded by this test result.

Extend the existing weekly cost report with resource trends. Retain the existing cron-failure incident and delivery path. Add four signal families: image quota/cost, connection headroom, physical disk capacity, and cron startup/failure pressure. Pending manifest inventory belongs in the digest, not the pager.

## 1. What is actually reachable

Production project: `npwseclcxcatjhgjrtwe`; organization: `zxxeawzafidlpnisntul`.

**Verified with the existing token:** GitHub Actions secret `SUPABASE_ACCESS_TOKEN` successfully reads production SQL through `POST /v1/projects/{ref}/database/query`. The existing `apply-migration.yml` diagnostic mode is the available execution path. A fresh aggregate-only SELECT ran in [workflow 35634126397](https://github.com/jmacluer-design/bingo-auctions/actions/runs/35634126397), captured at **2026-09-21 12:47:10 Central**. It returned connection counts/settings, logical database bytes, cron failures, and manifest-pool totals. No row-level customer data was read.

**Authenticated successfully by the September 21 access probe:**

- `GET /v1/projects/{ref}/analytics/endpoints/metrics`: Prometheus performance metrics; permission `analytics_logs_read`. [API reference](https://supabase.com/docs/reference/api/v1-scrape-project-metrics).
- `GET /v1/projects/{ref}/config/disk/util`: timestamp and filesystem size/available/used bytes; permission `infra_disk_config_read`. Pair with disk configuration/autoscale settings. [API reference](https://supabase.com/docs/reference/api/v1-get-disk-utilization).
- `GET /v1/organizations/{slug}/entitlements`: plan entitlements, not proof of metered billing usage. [Public schema](https://api.supabase.com/api/v1-json).

The token is held by Actions, not exported to the local shell. The allowlisted read-only probe used that existing secret without exposing it.

**Image usage is blocked on Michael.** The public API request counts are not billed image-origin usage. Supabase's [dashboard client](https://github.com/supabase/supabase/blob/master/apps/studio/data/usage/org-usage-query.ts) uses `/platform/organizations/{slug}/usage`; our PAT receives HTTP 401 there. Michael must establish supported account authentication or a supported billing export/API. No cookie scraper or guessed endpoint will be built. Once access exists, compare scope, billing cycle and value with the dashboard before resuming the implementation sequence below. Until then, this entire extension remains blocked; dated manual dashboard evidence is not automated coverage.

## 2. Evidence and threshold decisions

### Image transformations

Earlier dashboard observation: **3,912 distinct origin images / 100 included**, all attributed to BinGo. These are unique origins during a billing cycle, not resize requests. At the documented $5 per additional 1,000-origin package, 3,812 excess origins correspond to $20 for the observed usage; that is neither a monthly forecast nor an approved budget. [Supabase billing definition](https://supabase.com/docs/guides/platform/manage-your-usage/storage-image-transformations).

The user subsequently disabled the spend cap, and that was verified in the billing UI. The earlier audit's “cap enabled” statement is historical. Never re-enable it automatically.

Proposed behavior: collect daily when supported; email the existing recipients once when authoritative cycle usage first exceeds the included **100**; thereafter include usage, daily changes, estimated excess charge, cycle dates and observation age in the weekly digest. No SMS for the quota crossing alone. On initial activation, report an existing breach once as an existing condition, not as a newly observed crossing. A later monetary-budget crossing can generate one additional email, but requires an explicit budget; accepting today's $20 does not supply one.

Evidence limit: quota crossing is an objective billing boundary, not a backtested predictor of customer failure. The dashboard indicated daily transformation updates, so a daily read may discover a large jump after the crossing. Do not promise warning before every quota breach. Use provider timestamps/cycle identity, not a guessed calendar month. Quota, price and cap state must have their own sources and observation dates.

### Connection headroom

Fresh baseline: **31 client backends**, **40 total processes**, **90 max_connections**, **3 superuser-reserved connections**, **0 additional reserved connections**; the diagnostic client is included. One active client was the observer; zero blocked clients. Earlier post-restart samples had 40 and 35 client backends. None establishes close-hour peaks.

The weekly script currently counts every `pg_stat_activity` row, inflating connections with background processes. Correct that before reusing it. Report client connections across databases against max_connections, and separately show ordinary-client capacity after reserved slots. Reconcile replication/pooler categories with the installed PostgreSQL version and Supabase metrics before calling this exact available capacity; pooler client slots and database connections are different limits.

Existing **20% remaining headroom** is a useful inherited advisory candidate, not a calibrated new page threshold. If ordinary-client capacity is confirmed as 87, 80% utilization begins at 70 clients; the raw 90-capacity equivalent is 72. Never silently change denominator between reports. Initially evaluate the candidate in shadow mode over three consecutive five-minute samples; the persistence window is a design candidate, not incident-derived. After calibration, permit one advisory email on entry and one recovery notice. No new SMS threshold is approved yet.

Calibration: retain at least seven days including several auction close periods; retain longer if no representative high-load window occurs. Replay candidate crossings against cron failures and known customer-impact times, record lead time and non-incident crossings, then choose a threshold/window. Earlier 53–54/60 snapshots were not a pre-failure time series and cannot prove that 80% would have warned in time. An absence of new incidents does not validate prediction. Segment evidence at the September 21 16:44:39Z restart/tier change; today's 90-connection limit and cron configuration must not be applied retrospectively to older failures.

### Database and physical disk

Fresh logical database size: **1,566,387,347 bytes** (~1.57 GB decimal / 1.46 GiB). Earlier dashboard physical disk was **2.58/8 GB**, including about 960 MB WAL and system files. These are different measurements at different times. Object Storage's ~20 GB is a third, separate quantity.

Daily collection; weekly digest of physical used/available/capacity, logical DB size, WAL contribution where available, and seven-/28-day growth. Show a time-to-capacity estimate only with sufficient fresh samples and sustained positive growth; label the method and uncertainty. Disk resizing/autoscale invalidates the old capacity baseline. No evidence-backed disk page threshold exists in the current history. Do not turn a guessed 80%/90% into an allegedly calibrated pager. Select warning/page boundaries after observed growth and an actionable response-time budget are available; until then the explicit status is **trend coverage only**.

### Cron startup/failure pressure

Keep **>=10 failed runs in a rolling 15-minute window** and the existing incident key. The source records quiet-day peaks of 0–2 against incident peaks of 24–36; this is the one current threshold with historical separation and earlier warning evidence (`health-check/route.ts:38–70`).

Add classification to the same incident: `connection failed`, `job startup timeout`, and other failures, plus current connection/headroom/configuration evidence. Do not send a second “worker slots” page for the same cluster. Fresh read: zero failed runs in the last 15 minutes. Prior 24-hour hourly buckets include 117 connection failures at 19:00 Central yesterday, then mixed failures later; hourly counts are not rolling-15-minute threshold tests.

A significant qualification: live `cron.use_background_workers=off`, `cron.max_running_jobs=32`, `max_worker_processes=6`, `max_parallel_workers=2`. A startup-timeout message alone is **not proof** of background-worker exhaustion under this current configuration. Preserve the failure label; investigate connection/startup mechanism rather than embedding that root cause in the alert. The current email text equates the two; correcting that explanatory text belongs in the eventual scoped change.

## 3. Pending pool and deliberately excluded pages

`import_rows.status='pending'` is manifest inventory. Migration 0029 explicitly retains never-lotted rows as history. It is not an automatically draining worker queue. BinGo's fresh read returned **307,421 pending / 311,493 total**, oldest pending May 28; the last seven days contain **22,201 arrivals, 493 lotted, zero dropped**. These counts do not prove a processing failure or an exact net-pool delta (imports, edits and deletions can affect that).

Add operator-scoped count, age buckets, arrivals, lotted and dropped counts to the weekly resource section. Exclude a page until there is an agreed business expectation. Distinguish this from `lots.status='pending_intake'`, job queues, and pooler waiters. Existing invoice DLQ paging remains unchanged.

CPU and memory can accompany diagnostic/digest context once the metrics endpoint works, with explicit windows and sample coverage. Do not create another CPU page from the historical “91%” infrastructure summary. Earlier dedicated post-restart CPU windows were 12.7–14.4%; summary aggregation was unproven. Egress, MAU and Realtime were below quota in the earlier observation and need no new pager rule now.

## 4. Extend the existing system

The weekly cost workflow ran successfully on schedule today: [35604478991](https://github.com/jmacluer-design/bingo-auctions/actions/runs/35604478991). It produces a run summary and creates/comments on one `prod-cost` issue when findings cross thresholds; it is not an existing weekly email digest. Keep its weekly cadence and issue identity. Add a resource section from saved observations. A weekly email to the existing recipients would be a deliberate extension, with one send per reporting period, not a claim about current behavior.

Use small shared, pure collection-result/evaluation/formatting modules rather than invoke the health-check route to fetch data. Existing five-minute Cloudflare scheduling can collect cheap SQL connection/configuration observations through one service-role-only RPC. Daily Actions collection can read Management API usage/disk with the already-held PAT. Keep that account-level token out of the public app and browser.

Proposed durable state: a small, RLS-protected resource-sample store and separate incident/delivery state, scoped by project or organization as appropriate. Use a new migration after the current highest number, never edit 0359–0366. Store numeric aggregates, units, source timestamp, collection timestamp, scope, capacity, billing-cycle ID, validity and error class; no query text, customer rows or secrets. Persist samples only when implementation is authorized. Roll up five-minute samples to hourly after seven days; retain hourly/daily records for 90 days. Verify storage/write cost before enabling.

Observation states must include healthy, breached, stale, unavailable, and insufficient history. Missing data never becomes zero or recovery. Collector failure should fail its run and appear in the digest. Current `apps/cron-trigger/src/index.ts:197–201` treats HTTP 200 with `{ok:false}` as success: the new collection path must return non-2xx on collection failure or its caller must inspect an explicit structured collection status. Do not change existing business-route response contracts accidentally.

A single deduplicated monitoring-health email can flag persistent missing samples. This is monitoring integrity, not another resource KPI. For database/Worker outages, an external scheduled Actions check must send directly through Resend using Actions-held credentials and the same maintained recipient configuration, without calling the failed Worker or querying its throttle table. Serialize that watchdog workflow and retain its delivery state in Actions artifacts; verify artifact loss/expiry behavior explicitly. Its delivery is unverified until those secrets, recipient parity and failure-path tests pass. GitHub scheduling is a best-effort backstop, not a sub-minute paging guarantee.

Trend warnings use crossing/recovery state, cycle identity and severity; do not email every poll while a monthly total stays high. Preserve the existing cron incident and throttle. New trend state must distinguish suppressed, provider-accepted, failed and unknown delivery. Use atomic incident claims with expiry and stable delivery IDs; test send-success/receipt-failure recovery. Do not promise exactly-once email/SMS across provider/database failures.

**SMS dependency:** [PR348](https://github.com/jmacluer-design/bingo-auctions/pull/348) is still open, with SMS changes to the alert helper, health check, debug check, deploy workflow and tests. Live `/api/version` and master both report `685b29e5b818ba573fec50d2e1ae6a5d29c6ae44`; that source has no SMS path. The user's statement that SMS works is not corroborated by the deployed source inspected here. Resolve/verify PR348's delivery dependency separately before relying on SMS. This plan does not merge it or change its unrelated search work.

## 5. §7c — callers, surfaces, objects, and failure impact

- **Callers:** `sendOpsAlert` is used by the debug test and health-check branches for cron spikes, invoice DLQ, auto-charge/invoice conditions, client crashes and invariant violations. The invariant branch uses the boolean result to stamp `notified_at`. Preserve that contract for existing callers; add a richer internal result/adapter for new monitoring rather than silently changing booleans. Reconcile overlapping helper/health-check/deploy edits with PR348 before implementation.
- **Schedulers/upstream:** `apps/cron-trigger/src/index.ts` runs health-check every five minutes. `.github/workflows/prod-cost-report.yml` owns weekly scheduling, PAT and GitHub issue writes; `.github/workflows/ops-alert-verify.yml` tests recipient/delivery configuration. Preserve cron authentication, explicit BinGo target and current recipient resolution. A five-minute collector must not run the heavyweight weekly diagnostics or publish weekly issue comments every five minutes.
- **Database dependencies:** existing `health_check_pg_cron_failures()` from migration 0149 reads `cron.job_run_details`; `ops_alert_throttle` comes from migration 0215, with RLS and no public policies. Health-check also reads financial job tables, crash reports and invariant violations. New sample/state tables and an aggregate RPC require fixed search_path, restricted grants, bounded queries and retention; do not add triggers or change business-table writes. SQL collection takes ordinary read locks and has cost; it is not literally lock-free.
- **Shared data readers:** report and health-check must agree on failed-only cron rows, rolling versus fixed windows, and connection categories. The weekly report currently counts non-successful runs (including running), labels a newest-first bucket “worst,” and uses cumulative statement totals without query IDs for interval comparison. Correct these where needed for trustworthy shared resource reporting; label elapsed query execution as elapsed time, not measured CPU-hours. Restart/reset/eviction makes a delta unavailable, never negative activity.
- **Surfaces:** alerts affect staff/owners; the same database serves operator web, public web, mobile web, iOS and Android. No customer screen, pickup behavior, payment, bid, image URL or fallback is modified. Resource-query overhead or leaked permissions could indirectly harm all surfaces, so verify query cost/auth without causing saturation. The full-screen-image fallback remains separate draft PR356.
- **Downstream delivery:** reuse recipients/provider configuration. Current helper conflates suppression/failure, uses non-atomic check-then-send throttling, ignores throttle-query/upsert errors and hardcodes a health-check footer. Do not assume these provide atomic trend deduplication. New source-aware messages must contain observation age, window, units, action and runbook link. Provider acceptance is not inbox/handset receipt.
- **No automatic remediation:** no instance upgrades, cap toggles, connection kills, queue purges, database/stat resets or invoice/pickup changes follow an alert.

## 6. Validation and implementation order

1. **Access/measurement slice:** allowlisted API probe, clear unavailable results, correct connection/cron semantics, secure sample schema and a completely side-effect-free dry-run. Capture dashboard/API parity with identical scope and windows. No new trend notifications.
2. **Digest slice:** saved sample history, resource section in existing report/issue, optional weekly email through existing recipients. Missing image API remains prominently disclosed. Include pool data without a backlog incident.
3. **Alert slice:** authoritative image quota crossing email when access is proven; calibrated connection/disk advisory rules only after their evidence gates pass. Retain the existing cron threshold; verify SMS deployment separately. No new resource SMS rule ships on guessed numbers.

For each slice, run three substantive passes: scope/dependency review, behavior/failure-case verification, independent integration review; then preflight on the final revision. Use independent workers for API contracts and threshold fixtures, one owner for shared alert/delivery changes, and a final cross-path reviewer. These tasks do not justify multiple agents editing the same helper.

Required negative fixtures: all-process versus client count (40 vs31); 90→60 capacity changes; reserved-slot denominator; stale/missing/partial samples; 9 vs10 cron failures; running jobs excluded; fixed versus rolling windows; equal/above quota; unchanged overage; billing rollover and corrections; zero/negative growth and resizing; restart/reset/eviction; missing scope/token; failed providers and throttle storage; concurrent collectors; success-before-receipt crash; escalating/recovering incidents; and dry-run with zero sends/state/issue writes. Deliberately restore the corresponding bug and demonstrate each new guard fails. Do not merely run the same suite three times.

Existing tests: `apps/operator-web/src/lib/__tests__/ops-alert-recipients.test.ts`, `ops-alert-throttle.test.ts`, cron schedule guard; SMS tests currently belong to PR348. Manual evidence still needed: same-window dashboard parity, close-hour sampling completeness/overhead, real recipient receipt when separately authorized, and deployed scheduler/secret state. No live failure injection or sends are part of this plan.

## 7. Review record and preflight

Pass 1 complete: traced existing coverage and read-only access; two independent reviewers examined alert dependencies and historical thresholds.

Pass 2 complete: fresh SQL confirmed measurements and exposed `cron.use_background_workers=off`; replaced unsupported worker-slot diagnosis, arbitrary pool paging, and presumed SMS coverage with explicit qualifications. Separated billing boundary from calibrated incident predictor.

Pass 3 complete: independent reviews checked the final plan against the aggregate SQL and existing callers. Corrected `notified_at`, added explicit collection-failure propagation and a database/Worker-independent watchdog delivery path, and required historical configuration segmentation. Remaining API/calibration/delivery gaps are explicit implementation gates, not approvals.

Preflight complete: target/time/source labels checked against the successful read-only workflow; documented API capability separated from authenticated access; earlier cap-change context preserved; uncalibrated thresholds and SMS dependency marked; only this plan added for this task, with existing work preserved and no production/billing/delivery mutations. Numeric consistency and whitespace checks passed. No application tests were run for this documentation-only plan; the list above is future acceptance work.
