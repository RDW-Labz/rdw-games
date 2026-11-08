> Historical runbook: processor, account and infrastructure examples below may be obsolete. Use README.md and CLAUDE.md for current setup and release rules. Preserve historical legal/account names as recorded.

# ClovrBid Incident Response Runbook

**Operated by GOLD RUN LLC. Brand: ClovrBid.**

ClovrBid incident response. Read top-to-bottom on first incident; use the index for subsequent ones. Update this file after every postmortem — stale runbooks are worse than no runbook.

---

> ## ⚠️ Read before using any playbook below
>
> **Sentry is not wired. It has never received a single event from this
> deployment.** `sentry.server.config.ts` and `sentry.edge.config.ts` only call
> `Sentry.init()` when `SENTRY_DSN` is set, and that variable has never been
> pushed to the Worker. No `SENTRY_DSN`, `NEXT_PUBLIC_SENTRY_DSN` or
> `SENTRY_AUTH_TOKEN` repo secret exists, so client reporting and source-map
> upload are dark too. The `rdw-rb.sentry.io` projects in §6 are inherited from
> the ClovrBid fork.
>
> Every "check Sentry" step in this file has therefore always been a dead end.
> They have been rewritten against signals that actually exist. If you find one
> that still says to open Sentry, it is a bug in this document — the real
> sources are:
>
> | Instead of Sentry | Use |
> |---|---|
> | Scheduled-job failures | `cron.job_run_details` (§7) |
> | Slow or expensive queries | `pg_stat_statements`, `pg_stat_user_tables` (§7) |
> | Route errors, 5xx, exceptions | `npx wrangler tail bingo-web` |
> | App crashes | `client_crash_reports` table |
> | Anything that should have paged you | The ops-alert email — see below |
>
> **What does reach a human:** `/api/cron/health-check` runs every 5 minutes and
> emails `OPS_ALERT_EMAIL` (fallback `jmacluer@gmail.com`) via Resend, throttled
> to one message per check per hour. It covers pg_cron failure spikes, the
> invoice dead-letter queue, auto-charge failures, app crash spikes, and handover
> invariant violations. `ops_alert_throttle` records what was last sent.
>
> **Also stale in this file, and not fixed here:** payments moved from Stripe to
> Square (2026-06), so §§3.2, 3.3 and 3.9 describe a payment path that no longer
> exists. They are marked individually. The domain is `bingoauctions.com`, not
> `clovrbid.com`, and the Workers are `bingo-web` / `bingo-cron`, not
> `bidwizops` / `bidwizops-cron`.
>
> *Added 2026-09-19 after a 45-minute outage in which the health check fired
> correctly on every tick for most of an hour and reached nobody.*

---

## Index

1. [Severity Definitions](#1-severity-definitions)
2. [On-Call Contacts](#2-on-call-contacts)
3. [Incident Playbooks](#3-incident-playbooks)
   - 3.1 [Auction stuck open past close_at](#31-auction-stuck-open-past-close_at)
   - 3.2 [Payment stuck — PI succeeded, invoice still pending](#32-payment-stuck--pi-succeeded-invoice-still-pending)
   - 3.3 [Stripe webhook retry storm](#33-stripe-webhook-retry-storm)
   - 3.4 [CF Worker down (bidwizops or bidwizops-cron)](#34-cf-worker-down-bidwizops-or-bidwizops-cron)
   - 3.5 [Supabase down](#35-supabase-down)
   - 3.6 [RLS errors after a migration](#36-rls-errors-after-a-migration)
   - 3.7 [Mobile app crash loop on launch](#37-mobile-app-crash-loop-on-launch)
   - 3.8 [AI cost spike](#38-ai-cost-spike)
   - 3.9 [Stripe chargeback storm](#39-stripe-chargeback-storm)
   - 3.10 [Auction-engine queue backlog](#310-auction-engine-queue-backlog)
   - 3.11 [Console inert after a deploy — stale bundle](#311-console-inert-after-a-deploy--stale-bundle)
4. [Rollback Procedures](#4-rollback-procedures)
5. [Backup and Disaster Recovery](#5-backup-and-disaster-recovery)
6. [Key URLs and Dashboards](#6-key-urls-and-dashboards)
7. [Diagnostic SQL Queries](#7-diagnostic-sql-queries)
8. [Postmortem Template](#8-postmortem-template)
9. [On-Call Rotation](#9-on-call-rotation)
10. [Update Cadence](#10-update-cadence)

---

## 1. Severity Definitions

### SEV-1 — Page immediately

Data loss, money loss, or security breach. Wake the on-call person now regardless of time.

**Examples:**
- A chargeback wins and we cannot submit evidence in time or reverse it
- The Supabase service-role key or Stripe secret key is exposed in logs, a public repo, or a response body
- Auctions silently close without `finalize_due_lots` running (lots have no winner, bids are orphaned)
- A migration deletes or corrupts live bidder or payment data

**Response:** Call the primary on-call directly (number in 1Password). If no answer within 5 minutes, call secondary. Open a war-room Slack channel `#incident-YYYY-MM-DD`. Write a postmortem regardless of resolution time.

### SEV-2 — Email + Slack ping within 15 minutes

System is degraded but functional. No immediate data or money loss, but customers are affected or the risk is escalating.

**Examples:**
- pg_cron stops firing or `finalize_due_lots` errors repeatedly
- A burst of 5xx or exceptions in `wrangler tail bingo-web` (> 20 in 5 minutes)
- Slow API responses (P99 > 5 s for > 5 minutes)
- Mobile app crash loop on > 5% of active sessions
- CF cron Worker stops POSTing to operator-web
- Stripe webhook retry storm (handler returning 5xx repeatedly)

**Response:** On-call triages within 15 minutes. Postmortem required if the degradation lasts more than 30 minutes.

### SEV-3 — GitHub issue

Bug or papercut with no live customer impact.

**Examples:**
- Typo or stale copy in a legal document
- Layout broken on an uncommon device or browser
- A non-critical dashboard chart shows wrong data

**Response:** Open a GitHub issue with the label `bug`. No on-call action required.

---

## 2. On-Call Contacts

| Role | Name | Email | Phone |
|------|------|-------|-------|
| Primary | Michael Cluer | michael@cluerholdings.com | See 1Password vault |
| Secondary (CTO) | Darren | shadetreerocketsurgeon84@gmail.com | See 1Password vault |

Phone numbers are stored in the **1Password vault** and are not written in this file (this file lives on GitHub).

Cloudflare account owner: Darren (`shadetreerocketsurgeon84@gmail.com`). Michael has Superadmin via API token stored in `.env.cloudflare.local` and in 1Password.

---

## 3. Incident Playbooks

### 3.1 Auction stuck open past close_at

**Symptoms**
- Bidders can still place bids on an auction that should be closed.
- An ops-alert email titled "Scheduled jobs are failing: N in the last 15 minutes".
- **And an SMS saying the same thing.** The SMS is the one to trust for timing:
  on 2026-09-20 the check fired at 19:06:05, one minute after the first
  failure, and the email was read at 19:31 — by which point the four-minute
  burst had been over for 22 minutes. If you got the email and not the SMS,
  check `OPS_ALERT_SMS` and the Twilio credentials with
  `gh workflow run ops-alert-verify.yml -f mode=dry`, which now reports both
  lists and warns when numbers are set but Twilio is not.
- Staff console shows auction status `live` with `ends_at` in the past.
- Or: no alert at all, and a customer told you. See the note at the end of this playbook.

**First five minutes**
1. Run the failure query below. This is the primary source — start here, not with any dashboard.
2. Read the `return_message` column. It sorts the incident into one of two very different shapes:
   - **`connection failed` / `job startup timeout`** → the database is saturated. The jobs are victims, not causes. Go to *Saturation* below.
   - **A Postgres error naming a function or table** → the job itself is broken. Go to *Broken job* below.
3. Check whether `bingo-cron` is alive at all: it POSTs to `https://bingoauctions.com/api/cron/health-check` every 5 minutes. `npx wrangler tail bingo-cron` shows the invocations. If there are none, see §3.4.

**Root-cause diagnosis**
```sql
-- Which jobs are failing, and why. jobname lives in cron.job, not job_run_details.
SELECT j.jobname, d.status, d.return_message, d.start_time,
       round(extract(epoch FROM (d.end_time - d.start_time)) * 1000) AS ms
FROM cron.job_run_details d
JOIN cron.job j USING (jobid)
WHERE d.start_time > now() - interval '1 hour'
  AND d.status <> 'succeeded'
ORDER BY d.start_time DESC
LIMIT 40;

-- Is this saturation? Healthy is avg < 50 ms and zero failures.
SELECT date_trunc('minute', d.start_time) AS minute,
       count(*) AS runs,
       count(*) FILTER (WHERE d.status <> 'succeeded') AS failed,
       round(avg(extract(epoch FROM (d.end_time - d.start_time)) * 1000)) AS avg_ms,
       round(max(extract(epoch FROM (d.end_time - d.start_time)) * 1000)) AS max_ms
FROM cron.job_run_details d
WHERE d.start_time > now() - interval '90 minutes'
GROUP BY 1 ORDER BY 1 DESC;
```

**Saturation** — every job slow at once, `connection failed` across unrelated jobs, and it clears by itself when load drops. The jobs are not the problem; the database ran out of connection slots. `max_connections` is 60 and roughly 53 are held at idle by managed pools, so there is very little headroom.

```sql
-- What is actually burning the instance (cumulative since stats_reset).
SELECT left(regexp_replace(query, '\s+', ' ', 'g'), 120) AS q,
       calls, round((total_exec_time/1000)::numeric, 1) AS total_s,
       round(mean_exec_time::numeric, 2) AS mean_ms
FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 10;

-- A table being read end-to-end on every request shows up here:
-- seq_tup_read / seq_scan close to n_live_tup means full scans.
SELECT relname, seq_scan, seq_tup_read, n_live_tup,
       CASE WHEN seq_scan > 0 THEN seq_tup_read / seq_scan END AS tuples_per_scan
FROM pg_stat_user_tables WHERE seq_scan > 1000 ORDER BY seq_tup_read DESC LIMIT 10;

-- Who holds the connections right now.
SELECT usename, application_name, state, count(*)
FROM pg_stat_activity GROUP BY 1,2,3 ORDER BY 4 DESC;
```

During the hour it is happening there is no safe lever that helps — do not restart the database or deploy. It recovers when load falls. Capture the queries above *while it is live*, because `pg_stat_activity` is gone afterwards, then fix the cost. (2026-09-19: one unindexed lookup on `lots` was 31 CPU-hours over 11 days.)

**Broken job** — one job failing, others healthy, an error naming a function or table. Common causes: RLS blocking the service-role function, a migration that altered a signature, a renamed column. Fix forward with a migration (§4).

> **If nobody was told:** the health check emails on a pg_cron failure spike, but only above its threshold, and the email is throttled to one per hour. If an incident ran and no mail arrived, check `ops_alert_throttle` for a recent `pg_cron_failure_spike` row before assuming the check is broken.

**Manual fix**

Run via Supabase SQL editor (use the service-role connection, not the anon key):
```sql
-- Finalize all overdue lots manually
SELECT public.finalize_due_lots();

-- Confirm the stuck auctions are now closed
-- (Audit C2: column is auctions.ends_at, not close_at; status enum is
-- 'draft'/'scheduled'/'live'/'closed'/'canceled' — never 'open'.)
SELECT id, title, ends_at, status
FROM auctions
WHERE ends_at < now() AND status = 'live';
```

**Rollback**
If a recent migration broke the `finalize_due_lots` function, write a fix-forward migration (see §4). Do not revert schema migrations on a live database.

**Postmortem trigger:** Any occurrence where an auction was open more than 10 minutes past `ends_at`. This is a SEV-1 candidate if any bids were placed after the correct close time — those bids may need to be voided and bidders notified.

---

### 3.2 Payment stuck — PI succeeded, invoice still pending

> ### ⚠️ Stripe-era — this path no longer exists
>
> BinGo settled onto **Square** in 2026-06. There is no live Stripe charge, card or
> webhook path left (`lib/stripe.ts` was replaced by `lib/square.ts`), so the endpoint,
> the `evt_`/`pi_` ids and the `stripe events resend` command below all refer to
> something that is not running. **Do not work this playbook during an incident.**
> Kept only as fork history until a Square equivalent is written — that gap is real and
> currently unfilled.

**Symptoms**
- Stripe dashboard shows `PaymentIntent` status `succeeded`.
- The corresponding row in `invoices` still has `status = 'pending'`.
- Bidder or operator reports a completed payment that is not reflected in the console.

**First five minutes**
1. Look up the `PaymentIntent` ID from Stripe dashboard (format `pi_...`).
2. Check whether the webhook event was received by the handler:

```sql
-- Did we record the webhook event?
SELECT stripe_event_id, event_type, processed_at
FROM processed_webhook_events
WHERE stripe_event_id = 'evt_...'   -- find the evt_ id in Stripe dashboard > Webhooks > Events
   OR stripe_event_id LIKE 'evt_%'
ORDER BY processed_at DESC
LIMIT 20;
```

If the row is absent, the webhook did not reach us or errored before the idempotency insert.

**Root-cause diagnosis**
- In the Stripe dashboard go to **Developers > Webhooks**, select the endpoint `https://clovrbid.com/api/webhooks/stripe`, and find the failed event under **Recent deliveries**.
- Check the HTTP response code. A 5xx means the Worker returned an error; `npx wrangler tail bingo-web` is the only live log.
- A 4xx (401/400) usually means `STRIPE_WEBHOOK_SECRET` is wrong or missing in the Worker's env vars.

**Fix**
Once the underlying error is resolved (redeploy if needed), replay the specific event:
```bash
stripe events resend evt_XXXXXXXXXXXXXXXX
```

Then verify in the DB:
```sql
SELECT id, status, paid_at, stripe_payment_intent_id
FROM invoices
WHERE stripe_payment_intent_id = 'pi_...';
```

**Postmortem trigger:** SEV-1 if payment was collected but invoice remained pending for > 1 hour. SEV-2 otherwise.

---

### 3.3 Stripe webhook retry storm

> ### ⚠️ Stripe-era — this path no longer exists
>
> BinGo settled onto **Square** in 2026-06. There is no live Stripe charge, card or
> webhook path left (`lib/stripe.ts` was replaced by `lib/square.ts`), so the endpoint,
> the `evt_`/`pi_` ids and the `stripe events resend` command below all refer to
> something that is not running. **Do not work this playbook during an incident.**
> Kept only as fork history until a Square equivalent is written — that gap is real and
> currently unfilled.

**Symptoms**
- Many `stripe_webhook` errors in a short window (visible only in `wrangler tail bingo-web`; no alert exists).
- Stripe dashboard shows a webhook endpoint with a high failure rate (> 10 consecutive 5xx responses within an hour).
- Stripe will retry webhooks for 72 hours with exponential backoff — a storm indicates the underlying issue has not been fixed.

**First five minutes**
1. Check whether the bidwizops Worker itself is up:
```bash
curl -I https://clovrbid.com/api/cron/health-check \
  -X POST \
  -H "x-cron-secret: <CRON_SECRET from 1Password>"
```
A 200 means the Worker is up. A 5xx or timeout means the Worker is down — go to §3.4 immediately.

2. If the Worker is up, run `npx wrangler tail bingo-web` and reproduce or wait for the next delivery. Read the stack trace. Common causes: a database schema mismatch after a migration, a missing env var, a Supabase connectivity hiccup.

**Fix**
- Fix the underlying exception and redeploy (see §4 CF Worker rollback if needed).
- Once the endpoint is healthy, Stripe will resume delivering queued retries automatically.
- If you need to force a specific event, use `stripe events resend evt_...`.

**Do not disable the webhook endpoint** in Stripe to stop the storm — that will cause permanent event loss. The correct action is to fix the handler and let retries drain.

**Postmortem trigger:** SEV-2 if storm lasted < 30 minutes with no payment impact. SEV-1 if any `payment_intent.succeeded` events were permanently dropped (Stripe stops retrying after 72 hours).

---

### 3.4 CF Worker down (bidwizops or bidwizops-cron)

**Symptoms**
- `https://clovrbid.com` or `https://clovrbid.com` returns 5xx or is unreachable.
- The health-check POST stops appearing in `wrangler tail bingo-web` (bingo-cron is silent).
- Cloudflare dash shows elevated error rates on the `bidwizops` service.

**First five minutes**
1. Check Cloudflare Worker status in the dashboard: `dash.cloudflare.com` → Workers & Pages → `bidwizops`.
2. Check whether the failure is a Cloudflare-wide incident: `cloudflarestatus.com`.
3. Pull recent Worker logs in the Cloudflare dashboard (Workers → `bidwizops` → Logs).

**Rollback to previous Worker version**

Get the list of stored versions (CF keeps the last 10):
```bash
curl -s "https://api.cloudflare.com/client/v4/accounts/82bbd89ae113151d3817ccbad1155fcd/workers/scripts/bidwizops/versions" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" | jq '.result[] | {id, metadata}'
```

Identify the last known-good version ID, then deploy it:
```bash
curl -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/82bbd89ae113151d3817ccbad1155fcd/workers/scripts/bidwizops/deployments/by-script" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"versions":[{"version_id":"<previous-version-id>","percentage":100}]}'
```

For **bidwizops-cron**, substitute `bidwizops-cron` for `bidwizops` in the URLs above.

`$CLOUDFLARE_API_TOKEN` is in `.env.cloudflare.local` and in 1Password. Node 22 is not required — these are plain curl commands.

**After rollback**
- Verify `https://clovrbid.com/api/cron/health-check` returns 200 (using the cron secret).
- Root-cause the bad deploy before rolling forward. Check git log for the commit that triggered the broken build and open a GitHub issue.

**Postmortem trigger:** Any Worker outage > 5 minutes is SEV-1 (live auctions and payments are unavailable).

---

### 3.5 Supabase down

**Symptoms**
- All API routes return database errors.
- `npx wrangler tail bingo-web` shows a flood of `PGRST` or `connection refused` from `supabase-admin.ts` or `supabase-server.ts`.
- Supabase dashboard is unreachable or shows an incident banner.

**First five minutes**
1. Check `status.supabase.com` for an active incident affecting `us-east-1`.
2. `npx wrangler tail bingo-web` — if the Worker is up but every DB call fails, this is Supabase-side.
3. Distinguish an outage from saturation before declaring one. They look identical from the Worker and have opposite responses: an outage is waited out, saturation is caused by us and is fixable. If the database answers a query at all, it is not down — see §3.1 *Saturation*.
4. Post a status update to operators and bidders (see communication plan below).

**What we can do**
Supabase outages are not recoverable from our side. The database, auth, and storage layers are all hosted by Supabase. There is no self-hosted failover.

- If the outage is partial (reads work, writes fail), consider putting the operator console into a maintenance page by deploying a temporary Worker that returns a static 503 HTML response — this avoids a flood of confusing errors.
- Do not attempt to replay failed requests during an outage. Once Supabase recovers, the system resumes normally; pg_cron will catch up on any missed finalize windows.

**Communication**
Post a status update at `clovrbid.com/status` (TODO — this page needs to be built). Until then, notify operators directly by email.

**Recovery verification**
After Supabase reports recovery:
```sql
-- Confirm DB is responsive
SELECT now(), current_database();

-- Check for any auctions that should have closed during the outage
-- (Audit C2: column is ends_at, status enum value for an open auction is 'live'.)
SELECT id, title, ends_at FROM auctions
WHERE ends_at < now() AND status = 'live';

-- If found, run finalize manually
SELECT public.finalize_due_lots();
```

**Postmortem trigger:** Any Supabase outage is SEV-1 by definition. Document timeline and operator impact even if the root cause was upstream.

---

### 3.6 RLS errors after a migration

**Symptoms**
- Staff or bidders report "permission denied" or a screen that silently shows nothing where rows should be.
- A recent migration was deployed.

> This playbook used to say "filter Sentry to the last deploy window". Sentry has never received an event here, so that step never worked — and this failure mode has no alert at all. **An RLS break is currently invisible until a person reports it.** Treat a vague "it stopped showing my stuff" after a deploy as this until proven otherwise.

**First five minutes**
1. `npx wrangler tail bingo-web` and reproduce the action. The PostgREST error comes back with the table name and SQLSTATE `42501`. This is the only live signal.
2. If you cannot reproduce, ask what the person was doing and check the newest migration for `ALTER TABLE`, `ENABLE ROW LEVEL SECURITY`, `CREATE POLICY`, `DROP POLICY`, a `RENAME`, or a new column.
3. A new column is its own trap: `lots` uses column-level grants, so a column added without `GRANT SELECT (col)` is invisible to `anon` and PostgREST reports it as not existing rather than as a permission error.

**Root-cause diagnosis**
```sql
-- List RLS policies on the affected table
SELECT policyname, cmd, roles, qual, with_check
FROM pg_policies
WHERE tablename = '<affected_table>'
ORDER BY policyname;

-- Check if RLS is enabled
SELECT relname, relrowsecurity
FROM pg_class
WHERE relname = '<affected_table>';
```

Common causes:
- A new table was created without `ALTER TABLE <name> ENABLE ROW LEVEL SECURITY` and without policies.
- A policy was inadvertently dropped by a migration.
- A `RENAME` or `ALTER COLUMN` broke a policy's `USING` expression.

**Fix**
Write a fix-forward migration (see §4). Never disable RLS on a table that holds multi-tenant data. Write the missing policy, test in the Supabase SQL editor against a service-role connection, then apply via the normal migration flow.

**Postmortem trigger:** SEV-1 if any tenant's data was readable by another tenant. SEV-2 if the error just blocked writes/reads without cross-tenant exposure.

---

### 3.7 Mobile app crash loop on launch

**Symptoms**
- An ops-alert email titled "Crash spike: N JS crash(es) in the last hour", or `client_crash_reports` shows a startup crash on > 5% of sessions.
- Crash appeared after a recent OTA update or native build.

**First five minutes**
1. Query `client_crash_reports` for the last 2 hours. Note `message`, `stack`, `screen`, and whether it correlates with a specific update id:
```sql
SELECT created_at, is_fatal, screen, left(message, 120) AS message, app_version
FROM client_crash_reports
WHERE created_at > now() - interval '2 hours'
ORDER BY created_at DESC LIMIT 50;
```
   `is_fatal = true` is a real JS error and a rollback is a legitimate response. `is_fatal = false` is the OS reclaiming a backgrounded process — a rollback changes nothing there.
2. Identify whether the culprit is an OTA (JS bundle) or a native build (device must reinstall from TestFlight).

**OTA rollback (JS bundle)**

Find the previous update's ID in the EAS dashboard: `expo.dev/accounts/rdw_cluer`.

Then push the previous bundle to both channels (bidder app uses `preview` and `production`):
```bash
# Roll back bidder app
EXPO_TOKEN=<token from 1Password> eas update \
  --branch preview \
  --message "rollback to <previous-update-id>"

EXPO_TOKEN=<token from 1Password> eas update \
  --branch production \
  --message "rollback to <previous-update-id>"
```

Confirm the crash rate drops by re-running the `client_crash_reports` query above 5 minutes after the rollback is live.

Important: OTA updates cannot fix crashes caused by native code changes. If the stack trace points to a native module, you need a new native build.

**Native build rollback**

TestFlight retains all previous builds for 90 days. Existing testers who already installed a previous version are unaffected. New installs will get the broken build until a fixed IPA is processed. Options:
- Remove the broken build from TestFlight testing groups while a fix is prepared.
- Push a new native build with the fix (takes 15–30 minutes for Apple processing).

**Postmortem trigger:** SEV-2 for any crash loop. SEV-1 if the crash prevents bidders from participating in a live auction.

---

### 3.8 AI cost spike

**Symptoms**
- AI spend over $5/hr. **No alert exists for this** — the threshold below was only ever wired to Sentry. Check `ai_calls` directly.
- OpenRouter dashboard shows unusual hourly burn: `https://openrouter.ai/keys/usage`.

**First five minutes**
1. Open OpenRouter usage dashboard and identify which API key / call pattern is burning.
2. Query the DB for which operator is responsible:
```sql
SELECT operator_id, SUM(cost_cents) AS total_cents
FROM ai_calls
WHERE created_at >= now() - interval '1 hour'
GROUP BY operator_id
ORDER BY total_cents DESC;
```

**Emergency cap**

If a single operator is the source, immediately set their AI budget to zero:
```sql
UPDATE operators
SET monthly_ai_budget_cents = 0
WHERE id = '<operator_id>';
```

This takes effect on the next AI call from that operator (the budget check is enforced before each call). Notify the operator that their AI features are temporarily suspended and explain why.

**Thresholds**
- $5/hr — **no automatic alert** (was Sentry-only; never fired). Must be checked by hand or added to the health check.
- $20/hr — Page on-call (SEV-2).
- Unexpected sustained burn > $50 in any single hour — treat as SEV-1 (possible prompt injection or rogue loop).

**Root cause**
Check `ai_calls` for the offending operator and look at the `model`, `prompt_tokens`, and `completion_tokens` columns to identify which feature is looping or generating unexpectedly large prompts.

**Postmortem trigger:** SEV-2 for any spike > $20 in an hour. SEV-1 if caused by a security exploit (prompt injection, unauthorized API key use).

---

### 3.9 Stripe chargeback storm

> ### ⚠️ Stripe-era — this path no longer exists
>
> BinGo settled onto **Square** in 2026-06. There is no live Stripe charge, card or
> webhook path left (`lib/stripe.ts` was replaced by `lib/square.ts`), so the endpoint,
> the `evt_`/`pi_` ids and the `stripe events resend` command below all refer to
> something that is not running. **Do not work this playbook during an incident.**
> Kept only as fork history until a Square equivalent is written — that gap is real and
> currently unfilled.

**Symptoms**
- Multiple `charge.dispute.created` webhook events in a short window.
- `charge.dispute.created` events appear in Stripe webhook logs.
- Operator reaches out about disputes on their connected account.

**First five minutes**
1. Quantify the scope:
```sql
SELECT operator_id, COUNT(*) AS dispute_count, SUM(total_cents) AS total_exposure_cents
FROM invoices
WHERE disputed_at >= now() - interval '7 days'
  AND dispute_status NOT IN ('won', 'charge_refunded')
GROUP BY operator_id;
```

2. Under Stripe Connect Standard (Path A), disputes hit the **operator's connected account**. Stripe automatically deducts the disputed amount from the operator's balance. Platform-side financial impact is limited to application fee clawback (Stripe may claw back the application fee portion). The main platform risk is operator churn and reputational harm.

**Response**
- Contact the affected operator(s) directly. Share the dispute IDs and amounts. Evidence submission must be done through the operator's Stripe dashboard (or via the ClovrBid disputes UI at `/disputes`).
- If the storm is clearly fraudulent (same bidder disputing many invoices), consider suspending that bidder ON the affected operator(s). Suspension is per-operator (audit C4: `bidders` has no platform-wide `suspended_at` column; the suspension lives on `operator_bidder_relations` with column name `suspended_reason`, not `suspension_reason`):
```sql
-- Per-operator suspension. Repeat for each affected operator.
INSERT INTO operator_bidder_relations (operator_id, bidder_id, suspended_at, suspended_reason)
VALUES ('<operator_id>', '<bidder_id>', now(), 'chargeback_fraud')
ON CONFLICT (operator_id, bidder_id) DO UPDATE
   SET suspended_at = EXCLUDED.suspended_at,
       suspended_reason = EXCLUDED.suspended_reason;
```
- For platform-wide bidder lockout (truly egregious cases), set `auth.users.banned_until` directly via the Supabase dashboard or service role — this is the same mechanism `delete_my_account()` uses.
- Alert Stripe support if the pattern looks like a coordinated fraud ring.

**Postmortem trigger:** Any storm of > 5 disputes in a 24-hour window is SEV-2. Document the bidder pattern, the operator impact, and whether our fraud signals (deposit requirements, identity verification) could have caught it earlier.

---

### 3.10 Auction-engine queue backlog

**Symptoms**
- An ops-alert email titled "N invoice(s) failed to build and have stopped retrying".
- Invoices are not being generated after auction close.
- `build_invoice_jobs` has a non-zero count — the table is normally **empty**, so any row at all is the signal.

> Until 2026-09-19 this check reported to Sentry only, and it also selected a column (`id`) that `build_invoice_jobs` does not have — so PostgREST refused the query, the route logged a warning and reported healthy. It was dead twice over and had never once fired. Both are fixed; the check now emails. If you are reading this because of an email, the alerting works.

**First five minutes**

`build_invoice_jobs` is keyed by `auction_id` (one row per auction needing invoice generation). A successful drain DELETEs the row; failed attempts bump `attempt_count` and stamp `last_error`. There is no `status` column — pending == row exists.

```sql
-- Queue depth (audit C3 fix: schema is auction_id PK, run_at, attempt_count,
-- last_attempt_at, last_error — no status, no lot_id, no error_message).
SELECT COUNT(*) AS pending FROM build_invoice_jobs;

-- Pending breakdown by retry state
SELECT
  CASE
    WHEN attempt_count = 0          THEN 'fresh'
    WHEN attempt_count BETWEEN 1 AND 4 THEN 'retrying'
    ELSE 'dead_letter'
  END AS state,
  COUNT(*)
FROM build_invoice_jobs
GROUP BY state;

-- Dead-letter jobs (attempt_count >= 5, will not auto-retry)
SELECT auction_id, last_error, attempt_count, last_attempt_at, run_at
FROM build_invoice_jobs
WHERE attempt_count >= 5
ORDER BY last_attempt_at DESC NULLS LAST
LIMIT 20;
```

**Manual drain**

If pending count > 100:
```sql
SELECT public.drain_build_invoice_jobs(50);
```

Run this a few times until the queue clears, watching for errors in the output. If jobs keep failing, read the `last_error` column — it will usually point to an RLS issue, a missing lot record, or a bad winner assignment.

**Dead-letter resolution**

Jobs with `attempt_count >= 5` will not retry. For each one, investigate the `last_error`, fix the underlying data issue, then reset the job (keyed by `auction_id`):
```sql
UPDATE build_invoice_jobs
SET attempt_count = 0,
    last_error    = NULL,
    run_at        = now()
WHERE auction_id = '<auction_id>';
```

**Postmortem trigger:** SEV-2 if more than 20 invoices were delayed by > 30 minutes. SEV-1 if any winning bidder was charged incorrectly or not charged at all due to the backlog.

---

### 3.11 Console inert after a deploy — stale bundle

**Symptom:** staff report the console "glitches out" — the page renders but
clicking does nothing, most visibly in the Auction Builder where no item can
be selected. Force-closing the PWA does not help until the page is reloaded.

**Cause:** `wrangler deploy` replaces the Worker's `_next/static` assets
wholesale. A console left open from before the deploy still references the
previous build's chunk URLs. Those now 404, so the next client-side navigation
fails and the UI stops responding. Nothing is wrong with the database or the
Worker — the tab is simply holding a build that no longer exists.

**Fix, immediately:** tell affected staff to reload the page
(Cmd/Ctrl-Shift-R, or close and reopen the PWA window and pull to refresh).
One reload per tablet clears it. No deploy, rollback, or migration is needed.

**Do this on every deploy:** after "Deploy Cloudflare Workers (BinGo)"
reports success, tell the floor to reload. Staff tablets run the console as a
standalone PWA and stay open for a whole shift, so every deploy strands every
open tablet until someone reloads it.

**Do not:** roll back the Worker. The deployed code is fine; rolling back
strands the tablets a second time on the way back.

**Confirming it is this and not something else:** a hard reload fixes it
instantly and permanently. If a reload does not fix it, this is not the
cause — stop and investigate properly.

**Postmortem trigger:** none by itself. SEV-3 if a deploy during trading hours
left staff unable to work for more than 30 minutes because nobody was told to
reload.

---

## 4. Rollback Procedures

### CF Worker version rollback

Node 22 is not required. Use curl with the Cloudflare REST API.

```bash
# Step 1: list the last 10 deployed versions
curl -s \
  "https://api.cloudflare.com/client/v4/accounts/82bbd89ae113151d3817ccbad1155fcd/workers/scripts/bidwizops/versions" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  | jq '.result[] | {id: .id, created_on: .metadata.created_on}'

# Step 2: deploy the previous version (replace VERSION_ID)
curl -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/82bbd89ae113151d3817ccbad1155fcd/workers/scripts/bidwizops/deployments/by-script" \
  -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"versions":[{"version_id":"VERSION_ID","percentage":100}]}'
```

Repeat for `bidwizops-cron` if needed. `$CLOUDFLARE_API_TOKEN` is in 1Password and `.env.cloudflare.local`.

### EAS OTA rollback

Find the previous update's ID in `expo.dev/accounts/rdw_cluer`. Push it to both channels — the bidder app's TestFlight build is on the `preview` channel; production OTA goes to `production`. Always push to both.

```bash
EXPO_TOKEN=<token> eas update --branch preview --message "rollback: <previous-update-id>"
EXPO_TOKEN=<token> eas update --branch production --message "rollback: <previous-update-id>"
```

Important: OTA builds must not come from the WSL ARM environment. The `hermesc` binary is x86_64 ELF and cannot run on aarch64. Run EAS updates from a non-ARM machine, or bundle the fix into the next `eas build` (cloud build handles this correctly).

### Native build rollback

TestFlight retains all previous builds for 90 days. Existing installs are not forcibly upgraded. To prevent new testers from getting the broken build:
- Remove the broken build from active TestFlight groups in App Store Connect.
- Submit a fixed IPA as a new build. Apple processing takes 15–60 minutes.

### Migration rollback — forward only

**Never run `DROP TABLE` or destructive `ALTER TABLE` on a populated production table.**

All schema changes are additive and forward-only:
- Add columns with `DEFAULT`, never remove columns with live data.
- Rename via add-new-column, backfill, swap references, then deprecate the old column in a later migration.
- If a migration introduced a bad policy or function, write a new migration that fixes it.
- Migration files live in `supabase/migrations/`. Numbering is `NNNN_short_description.sql`.

### CSS and branding rollback

Brand and styling changes are low risk. Roll back with:
```bash
git revert <commit-hash>
```
Then redeploy via `bash scripts/deploy-cf.sh` (must run in WSL native FS — the build step has EPERM errors on the Windows-WSL crossover; see deployment docs for details).

---

## 5. Backup and Disaster Recovery

### Database (Supabase)

- **Pro tier**: Point-in-Time Recovery (PITR) up to 7 days. To restore, use the Supabase dashboard: project `xgsujdzicnjenhqihovk` → Backups.
- **Free tier**: Nightly snapshots only, no PITR.
- **Action item (open):** Confirm with Michael that the Supabase project is on the Pro plan before relying on PITR.

### Storage (lot photos, dispute photos, floor plans)

- Stored in Supabase Storage. Supabase replicates storage objects per their plan's SLA. We do not maintain a separate backup of storage objects.
- Loss of storage objects (lot photos) would require re-upload from the operator — it does not affect financial data.

### Source code

- Canonical source: `github.com/jmacluer-design/auction-platform` (private, `master` branch).
- Local working tree on Michael's Windows machine is secondary and may contain uncommitted WIP.
- All deploys should be from the GitHub-tracked state.

### Secrets

- **Target state**: All secrets in 1Password vault (setup in progress).
- **Current state**: Secrets are spread across `.env.cloudflare.local`, `.env.migrations.local`, `apps/*/eas.json` env fields, and `.env.local` on Michael's machine.
- **Action item (open):** Complete 1Password vault setup and document which vault item corresponds to which environment file. Until then, Michael's machine is the sole source of truth for secrets — protect it accordingly.

### Recovery Time Objective

| Layer | RTO | Notes |
|-------|-----|-------|
| CF Worker (code) | < 10 min | Version rollback via API |
| Supabase (infra outage) | Dependent on Supabase SLA | No self-hosted failover |
| Supabase (data restore) | < 1 hour | PITR on Pro plan |
| Mobile app OTA | < 15 min | EAS update to both channels |
| Mobile app native | 60–90 min | Apple processing time |

---

## 6. Key URLs and Dashboards

| Service | URL | Notes |
|---------|-----|-------|
| Stripe | dashboard.stripe.com | Payments, disputes, webhooks, connected accounts |
| Supabase | supabase.com/dashboard/project/xgsujdzicnjenhqihovk | DB, auth, storage, migrations |
| Sentry | rdw-rb.sentry.io | **Not wired — has never received an event from this deployment.** Projects are inherited from the ClovrBid fork. See the banner at the top of this file. |
| Cloudflare Worker logs | `npx wrangler tail bingo-web` | The live source for route errors, 5xx and exceptions |
| Cloudflare | dash.cloudflare.com | Under Darren's account (shadetreerocketsurgeon84@gmail.com) |
| Expo / EAS | expo.dev/accounts/rdw_cluer | OTA updates, build history |
| App Store Connect (Bidder) | appstoreconnect.apple.com | ASC ID: 6767012532, Apple ID: jmacluer@icloud.com, Team: 73554WL25P |
| App Store Connect (Staff) | appstoreconnect.apple.com | ASC ID: 6767026881 |
| OpenRouter | openrouter.ai/keys/usage | AI cost monitoring |
| Resend | resend.com/emails | Transactional email delivery |
| Twilio | console.twilio.com | SMS delivery |
| GitHub | github.com/jmacluer-design/auction-platform | Source, PRs, issues |
| Status page | clovrbid.com/status | TODO — not yet built (§4.5) |
| Cloudflare Status | cloudflarestatus.com | CF infrastructure status |
| Supabase Status | status.supabase.com | Supabase infrastructure status |

---

## 7. Diagnostic SQL Queries

Run these in the Supabase SQL editor (project `xgsujdzicnjenhqihovk`) using the service-role connection for full access.

```sql
-- Last 10 pg_cron job failures
SELECT jobname, status, return_message, start_time
FROM cron.job_run_details
WHERE status = 'failed'
ORDER BY start_time DESC
LIMIT 10;
```

```sql
-- Unprocessed webhook events (there should be none; non-empty means events dropped before DB write)
SELECT event_type, COUNT(*)
FROM processed_webhook_events
WHERE processed_at IS NULL
GROUP BY event_type;
```

```sql
-- Today's AI cost by operator (highest spenders first)
SELECT operator_id, SUM(cost_cents) AS total_cents
FROM ai_calls
WHERE created_at >= CURRENT_DATE
GROUP BY operator_id
ORDER BY total_cents DESC;
```

```sql
-- Dispute exposure last 30 days
SELECT operator_id,
       COUNT(*) AS open_disputes,
       SUM(total_cents) AS exposure_cents
FROM invoices
WHERE disputed_at IS NOT NULL
  AND disputed_at >= now() - interval '30 days'
  AND dispute_status NOT IN ('won', 'charge_refunded')
GROUP BY operator_id;
```

```sql
-- Find invoice by Stripe PaymentIntent ID
SELECT id, status, paid_at, total_cents, stripe_payment_intent_id, stripe_charge_id
FROM invoices
WHERE stripe_payment_intent_id = 'pi_...';
```

```sql
-- Auctions open past their close time (audit C2: ends_at, status='live')
SELECT a.id, a.title, a.ends_at, COUNT(l.id) AS lot_count
FROM auctions a
LEFT JOIN lots l ON l.auction_id = a.id
WHERE a.ends_at < now()
  AND a.status = 'live'
GROUP BY a.id, a.title, a.ends_at
ORDER BY a.ends_at;
```

```sql
-- Invoice job queue depth (audit C3: no status column, one row per pending auction_id)
SELECT COUNT(*) AS pending FROM build_invoice_jobs;
```

```sql
-- Dead-letter invoice jobs (audit C3: keyed by auction_id, column is last_error)
SELECT auction_id, last_error, attempt_count, last_attempt_at, run_at
FROM build_invoice_jobs
WHERE attempt_count >= 5
ORDER BY last_attempt_at DESC NULLS LAST;
```

```sql
-- Recent bidder suspensions (audit C4: per-operator, not platform-wide;
-- the bidders table has no suspended_at column)
SELECT operator_id, bidder_id, suspended_at, suspended_reason
FROM operator_bidder_relations
WHERE suspended_at IS NOT NULL
ORDER BY suspended_at DESC
LIMIT 20;
```

---

## 8. Postmortem Template

Store postmortems at: `docs/postmortems/YYYY-MM-DD-short-title.md`

**Trigger threshold:** Every SEV-1, and any SEV-2 that lasted more than 30 minutes.

---

### Template

```markdown
# Postmortem: <short title>

**Date:** YYYY-MM-DD
**Severity:** SEV-1 / SEV-2
**Duration:** HH:MM (from first symptom to full resolution)
**Author:** <name>
**Reviewed by:** <names>

## Impact

- Who was affected (bidders / operators / both)?
- How many users / auctions / payments were impacted?
- Was any data lost or corrupted?
- Was any money collected incorrectly or not collected?

## Timeline

| Time (UTC) | Event |
|------------|-------|
| HH:MM | First symptom observed / alert fired |
| HH:MM | On-call notified |
| HH:MM | Root cause identified |
| HH:MM | Mitigation applied |
| HH:MM | Full resolution confirmed |

## Root Cause

One paragraph. What actually went wrong at the technical level.

## Contributing Factors

- e.g., no test coverage for this code path
- e.g., migration was applied without verifying pg_cron health-check first
- e.g., alert threshold was too high, delayed detection

## What We Did Right

- e.g., health-check route caught the failure within 5 minutes
- e.g., rollback took < 10 minutes

## What We Did Wrong

- e.g., no runbook entry for this failure mode (add one!)
- e.g., secrets were not in 1Password, slowed down rollback

## Action Items

| Action | Owner | Due | Status |
|--------|-------|-----|--------|
| Write a migration to fix the RLS gap | Michael | YYYY-MM-DD | open |
| Add test coverage for the webhook handler | Darren | YYYY-MM-DD | open |
| Add this incident to the runbook | Michael | YYYY-MM-DD | open |

## Links

- Evidence (cron.job_run_details window, pg_stat_statements rows, wrangler tail excerpt):
- GitHub PR with fix: <url>
- Stripe event replay: <evt_...>
```

---

## 9. On-Call Rotation

**Current rotation:** Informal. Michael is primary; Darren is secondary.

- Phone numbers are in the **1Password vault**. Do not write them in this file.
- Response expectations: SEV-1 — respond within 5 minutes, 24/7. SEV-2 — respond within 15 minutes during waking hours; next morning otherwise.
- When adding a third engineer, formalize a rotation here and document handoff procedure (state of open incidents, any active deploys, error budget status).

**Handoff checklist (when primary changes):**
- [ ] Any open SEV-1 or SEV-2 incidents?
- [ ] Any migrations applied in the last 24 hours that need monitoring?
- [ ] Any active OTA updates rolled out?
- [ ] CF Worker deployed recently?
- [ ] Anything unusual in `wrangler tail bingo-web` or the Square dashboard?

---

## 10. Update Cadence

This runbook is a living document.

- **After every incident postmortem:** add or update the relevant playbook section. If the incident was not covered here, write a new playbook entry.
- **Quarterly:** review all playbooks even if there were no incidents. Update URLs, contact info, version IDs, and thresholds. Confirm Supabase plan tier and backup configuration.
- **Stale runbooks are worse than no runbook.** A runbook that contradicts current reality sends responders in the wrong direction at 2am.

Last reviewed: 2026-05-17 (initial draft).
Next scheduled review: 2026-08-17.
