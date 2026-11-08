# Deploy State Inventory — 2026-05-23

Authoritative read-only snapshot of what is live on the ClovrBid production
backend on 2026-05-23. Generated against:

- Supabase project ref: `xgsujdzicnjenhqihovk`
- Cloudflare account: `82bbd89ae113151d3817ccbad1155fcd`
- Production hostname: `clovrbid.com` (Worker: `bidwizops`)
- Repo HEAD: `9501914` (`feat(native-lot-detail): port savings callout + pickup card + anon bid history + similar lots`)

All commands were read-only. No migrations applied, no deploys triggered,
no Stripe API calls.

---

## 1. Supabase migrations applied to prod

Source: `node scripts/apply-migrations.js --status`

- Total migrations on disk in `packages/db/migrations/`: **126** (0001 → 0126)
- Applied to prod: **125** (0001 → 0125)
- **Unapplied: 1**
  - `0126_get_recent_wins_rpc.sql` — `feat(db): add get_recent_wins SECURITY DEFINER RPC`
    (commit `68be78c`). Created the RPC for the native bidder-app
    RecentWinsRail (Wave 1D).

All migrations 0001–0125 verified applied. Cross-references in this report
assume them applied (e.g. 0094 warehouse foundation, 0096 auction
lifecycle, 0105 auto_charge, 0111 place_bid concurrency, 0116/0119 v3
category photos, 0122 dispute hours, 0123 bidder_stripe_key_mode, 0124
setup intent authentication, 0125 open_due_lots).

---

## 2. pg_cron jobs (cron.job)

7 active jobs. All `active=true`.

| jobid | jobname                       | schedule          | command                                               |
|-------|-------------------------------|-------------------|-------------------------------------------------------|
| 3     | finalize-due-lots             | every 5 seconds   | `SELECT public.finalize_due_lots()`                   |
| 4     | drain-build-invoice-jobs      | every 30 seconds  | `SELECT public.drain_build_invoice_jobs()`            |
| 5     | mark-settlements-releasable   | `* * * * *` (1m)  | `SELECT public.mark_settlements_releasable()`         |
| 6     | cron-history-cleanup          | `0 * * * *` (hr)  | `DELETE FROM cron.job_run_details WHERE end_time < now() - interval '7 days'` |
| 7     | advance-auction-lifecycle     | `* * * * *` (1m)  | `SELECT public.advance_auction_lifecycle()`           |
| 8     | auto-relist-unsold            | `*/10 * * * *`    | `SELECT public.auto_relist_unsold_lots()`             |
| 9     | open_due_lots                 | every 5 seconds   | `SELECT public.open_due_lots()`                       |

Cross-reference vs migrations:

- `finalize-due-lots` — engine foundation (0050s area).
- `drain-build-invoice-jobs` — 0096 auction lifecycle.
- `mark-settlements-releasable` — settlement hold expiry sweep.
- `cron-history-cleanup` — housekeeping for cron.job_run_details.
- `advance-auction-lifecycle` — 0096.
- `auto-relist-unsold` — 0097.
- `open_due_lots` — **0125** (this is the one added in the launch fix
  `b88390a`; jobid=9 confirms it was created after the others).

No expected job is missing. No orphan jobs detected.

---

## 3. SECURITY DEFINER functions

83 SECURITY DEFINER functions in `public`. Full list (alphabetical):

`_ensure_operator_bidder_relation`,
`advance_auction_lifecycle`,
`apply_relot_fee`,
`assign_lot_to_bin`,
`assign_lots_to_auction`,
`auto_pick_featured_images`,
`auto_relist_unsold_lots`,
`batch_intake_lot_to_bin`,
`bidder_confirm_customer_pickup`,
`bidder_has_warehouse_access`,
`bidders_lock_email_to_auth`,
`build_invoices_for_auction`,
`bulk_import_lots`,
`buy_dutch`,
`buy_flat_price`,
`cancel_auction`,
`check_operator_ai_budget`,
`claim_prestickered_qr`,
`claim_webhook_event`,
`clear_force_password_rotate`,
`clear_paid_relot_fees`,
`commit_webhook_event`,
`compute_application_fee_cents`,
`compute_dutch_current_price`,
`confirm_pickup` (two signatures: text + uuid),
`create_bins_bulk`,
`create_draft_lot`,
`current_operator_id`,
`current_operator_role`,
`delete_my_account`,
`drain_build_invoice_jobs`,
`drop_import_rows`,
`enqueue_notification`,
`enrich_brands_batch`,
`ensure_pickup_row`,
`filter_auction_featured_images`,
`filter_lot_photo_urls`,
`finalize_due_lots`,
`finalize_lot`,
`get_active_operator_policy`,
`get_active_policy_versions`,
`get_lot_recent_bids`,
`get_pickup_slots`,
`intake_lot_to_bin`,
`is_bidder`,
`is_subscriber`,
`log_auction_initial_status`,
`log_auction_status_change`,
`log_invoice_initial_status`,
`log_invoice_status_change`,
`log_lot_initial_status`,
`log_lot_status_change`,
`lookup_product_by_code`,
`mark_invite_consumed`,
`mark_settlements_releasable`,
`mint_blank_qr_batch`,
`mint_invite_direct`,
`mint_operator_invite`,
`move_bin_contents`,
`next_lot_code`,
`open_due_lots`,
`place_bid`,
`record_consent`,
`record_operator_consent`,
`redeem_operator_invite`,
`redistribute_close_times`,
`relist_lot_into_auction`,
`reorder_auction_lots`,
`reserve_lot_number_range`,
`reserve_next_lot_number`,
`resolve_category_id`,
`resolve_category_ids_batch`,
`resolve_lot_by_qr_token`,
`revoke_bin_token`,
`rotate_bin_token`,
`rotate_lot_qr`,
`schedule_pickup`,
`seed_default_operator_policy`,
`set_invoice_fulfillment`,
`staff_confirm_pickup`,
`stamp_admin_first_seen`,
`sync_lot_bid_count`,
`upsert_competitor_lots_batch`

Note: `get_recent_wins` (added in unapplied migration 0126) is **NOT yet
present** in prod — expected, since 0126 has not been applied.

`confirm_pickup` has two overloads (text and uuid signatures). Confirmed
intentional from 0079 fix-confirm-pickup migration.

---

## 4. Tables + row counts

10 critical tables sampled.

| Table                          | Count |
|--------------------------------|-------|
| operators                      | 2     |
| warehouses                     | 4     |
| bidders                        | 6     |
| auctions                       | 3     |
| lots                           | 37    |
| bids                           | 1     |
| invoices                       | 0     |
| bin_assignments                | 0     |
| operator_policy_acceptances    | 0     |
| policy_versions                | 6     |

Note: no table named `consents` exists in prod. Consent state lives in
`policy_versions` + `operator_policy_acceptances` + `terms_acceptances`.
No table named `bidder_payment_methods` exists — bidder payment methods
are stored in Stripe (referenced via `bidders.stripe_*` columns), not in
the DB.

Lots breakdown by status: scheduled=3, live=1, unsold=5, pending_intake=27,
in_inventory=1. (Sum = 37.)

Full public schema has 53 tables. Notable extras: `auction_status_history`,
`auction_timeline`, `auto_charge_jobs`, `build_invoice_jobs`, `disputes`,
`import_rows`, `imports`, `invoice_lots`, `lot_import_batches`,
`lot_sticker_pool`, `notifications_outbox`, `operator_ai_usage_mtd`,
`operator_billing_mtd`, `operator_invites`, `operator_requests`,
`operator_settlements`, `operator_shipping_config`, `payment_followups`,
`pickups`, `processed_webhook_events`, `saved_searches`, `terms_acceptances`,
`walk_progress_per_warehouse`, `warehouse_landmarks`, `watchlist`.

---

## 5. Cloudflare Worker — `bidwizops` (the operator-web Worker)

- Worker ID: `bidwizops` (tag `a057d6269b0a405da1fc6ae44d1c1ed1`)
- Created: 2026-05-11T18:20:46Z
- **Last deploy: 2026-05-23T05:42:31Z** (deployment `d1e8cac9-97f2-41a4-a60b-f17973075fbe`)
- Recent deploy cadence (most recent 5):
  - `d1e8cac9` 2026-05-23T05:42:31Z
  - `1ed04e55` 2026-05-23T03:43:44Z
  - `06eefd42` 2026-05-23T03:03:53Z
  - `28f0e09d` 2026-05-23T02:50:22Z
  - `e823f57a` 2026-05-23T02:40:18Z
- Compat date: 2026-04-01, flags: `nodejs_compat`, usage_model: standard.
- Observability: enabled (sample rate 1, persist=true, invocation_logs=true).
- `workers.dev` URL: disabled (`workers_dev=false`).
- Has assets bundle (OpenNext output) + 3 named handlers (Durable Object
  classes: `BucketCachePurge`, `DOQueueHandler`, `DOShardedTagCache`).
- Last deployed via `wrangler` (matches `bash scripts/deploy-cf.sh`).

### Smoke test — public bidder routes

All return 200 unless noted. Host headers preserved.

| Route                        | HTTP | Content-Type                    | Size (bytes) | Notes |
|------------------------------|------|---------------------------------|--------------|-------|
| `/`                          | 200  | text/html                       | 126,998      | homepage |
| `/browse`                    | 200  | text/html                       | 70,820       | category browse |
| `/auctions`                  | 200  | text/html                       | 70,784       | (already serves; no redirect surprise) |
| `/clovrrush`                 | 200  | text/html                       | 162,344      | branded ClovrRush page |
| `/signup`                    | 200  | text/html                       | 13,821       | bidder signup |
| `/login`                     | 200  | text/html                       | 17,573       | |
| `/legal/terms`               | 200  | text/html                       | 66,922       | |
| `/legal/privacy`             | 200  | text/html                       | 69,802       | |
| `/download`                  | 200  | text/html                       | 35,327       | |
| `/lot/BIN-000035`            | 200  | text/html                       | 86,881       | lot detail |
| `/lots/BIN-000035`           | 307  | (redirect)                      | 0            | **legacy redirect IS live** (closes pending task #63) |
| `/sitemap.xml`               | 200  | application/xml                 | 1,851        | includes auction GUIDs |
| `/robots.txt`                | 200  | text/plain                      | 2,256        | |
| `/manifest.webmanifest`      | 200  | application/manifest+json       | 818          | |
| `/api/health`                | 404  | text/html                       | 19,119       | route does not exist — see drift #1 below |

No unexpected 4xx/5xx other than `/api/health` 404 (likely never created).

---

## 6. Stripe state

### Key modes (PREFIX ONLY — secret values not read)

From `apps/operator-web/.env.local`:

| Var                                   | Prefix      | Mode      |
|---------------------------------------|-------------|-----------|
| `STRIPE_SECRET_KEY`                   | `sk_test_…` | **TEST**  |
| `STRIPE_PUBLISHABLE_KEY`              | `pk_test_…` | **TEST**  |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`  | `pk_live_…` | **LIVE**  |

**MIXED-MODE on local .env.local.** This is exactly the mismatch
`stripe-keys.ts` warns about (CRITICAL on every isolate init). It only
affects local dev, not prod, because the file is never deployed.

Production Worker `bidwizops` has these Stripe vars set (as
`secret_text` bindings — values not readable):

- `STRIPE_SECRET_KEY` ✓
- `STRIPE_PUBLISHABLE_KEY` ✓
- `STRIPE_WEBHOOK_SECRET_CONNECT` ✓
- `STRIPE_WEBHOOK_SECRET_PLATFORM` ✓
- `STRIPE_STARTER_PRICE_ID` ✓
- `STRIPE_PRO_PRICE_ID` ✓

**`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is NOT bound on the prod Worker.**
This is the deprecated alias that, per `.env.example`, the helper falls
back to "for one deploy cycle." Today the helper reads
`STRIPE_PUBLISHABLE_KEY` server-side and passes it down via prop, so its
absence does not break checkout — but anything still grabbing the
NEXT_PUBLIC_ alias directly would receive empty string. (This was the
2026-05-22 launch lockout root cause.) The repo HEAD has the helper,
but new code added in this state should never read the NEXT_PUBLIC_
alias.

### Stripe live-mode confirmation

Cannot fully confirm prod is LIVE without reading the secret on the
Worker. Indirect signals:

- `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` in local `.env.local` is `pk_live_…`
  (this is what the user pasted in for local→prod parity testing).
- Prod operator marketing site, signup, and card-save pages are live.
- No "test mode" warning visible on `/signup`.

To verify decisively (out of scope here per read-only constraint): run a
single read-only `GET https://api.stripe.com/v1/balance` with the
prod Worker secret to inspect `livemode: true`.

### Onboarded operators

Two operator rows. **Neither has `stripe_account_id` populated**:

| id                                       | slug             | business_name      | status | stripe_account_id | stripe_onboarding_complete | subscription_status | subscription_tier |
|------------------------------------------|------------------|--------------------|--------|-------------------|---------------------------|---------------------|-------------------|
| `99999999-9999-9999-9999-999999999999`   | `demo`           | Demo Auctioneer    | active | NULL              | true                      | none                | starter           |
| `05775af4-adb7-4f0f-943e-94a91e17f60d`   | `bingo-auctions` | BinGo Auctions     | active | NULL              | true                      | none                | starter           |

Both have `stripe_onboarding_complete=true` but `stripe_account_id=NULL`.
This means the `stripe_onboarding_skipped` path was taken (probably via
the `ALLOW_SKIP_STRIPE_ONBOARDING` Worker secret, also bound). No Stripe
Connect Standard accounts are actually onboarded against this DB.

---

## 7. R2 / CDN state

### R2 buckets

1 bucket: `clovrbid-assets` (created 2026-05-22T20:52:35Z, default
location).

### CDN smoke test

`cdn.clovrbid.com` is healthy:

```
HEAD https://cdn.clovrbid.com/v3/brand/icon-180.png
HTTP/1.1 200 OK
Content-Type: image/png
Content-Length: 37616
Cache-Control: public, max-age=31536000, immutable
ETag: "8c3b0bf95d919294406336d16c51dd35"
Server: cloudflare
```

The bare `https://cdn.clovrbid.com/` returns 404 (expected — no root
index object) and a bad path like `/categories/v3/electronics.webp`
returns 404 (the v3 paths the repo actually uses are under `/v3/brand/…`
and `/04_APP_SOCIAL/…`, both confirmed serving).

---

## 8. Environment configuration audit

Cross-reference of `apps/operator-web/.env.example` vs `bidwizops`
Worker bindings (the production binding list — values are secrets, only
names are visible).

### Vars/Secrets bound on prod Worker `bidwizops`

```
ALLOW_SKIP_STRIPE_ONBOARDING
ASSETS                                  (asset binding)
CRON_SECRET
LLM_MODEL_PHOTO_IDENTIFY_OLLAMA
LLM_OLLAMA_BASE_URL
LLM_PROVIDER_PHOTO_IDENTIFY
OLLAMA_CF_ACCESS_CLIENT_ID
OLLAMA_CF_ACCESS_CLIENT_SECRET
OPENROUTER_API_KEY
PUBLIC_APP_URL
RESEND_FROM_EMAIL
SENTRY_DSN
STRIPE_PRO_PRICE_ID
STRIPE_PUBLISHABLE_KEY
STRIPE_SECRET_KEY
STRIPE_STARTER_PRICE_ID
STRIPE_WEBHOOK_SECRET_CONNECT
STRIPE_WEBHOOK_SECRET_PLATFORM
SUPABASE_SERVICE_ROLE_KEY
SUPER_ADMIN_EMAILS
```

### Documented in `.env.example` but NOT visible on Worker

| Var                                    | Status on Worker | Notes |
|----------------------------------------|------------------|-------|
| `NEXT_PUBLIC_SUPABASE_URL`             | **missing**      | Required client-side; if absent, all browser supabase-js init fails. May be inlined at build time via Next.js env compile-step, in which case absence on the Worker is fine. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY`        | **missing**      | Same as above. |
| `REDIS_URL`                            | **missing**      | The repo notes "BullMQ on Redis" but engine code on prod runs via pg_cron, not BullMQ. Likely intentional that REDIS_URL is unset on the CF Worker. |
| `STRIPE_WEBHOOK_SECRET` (legacy)       | **missing**      | Fallback for single-secret deploys. Both new-style secrets ARE set, so this is fine. |
| `NEXT_PUBLIC_SENTRY_DSN`               | **missing**      | Client DSN. Could be inlined at build time. |
| `NEXT_PUBLIC_POSTHOG_KEY`              | **missing**      | Inlined at build time most likely. |
| `NEXT_PUBLIC_POSTHOG_HOST`             | **missing**      | Default `https://us.i.posthog.com`. |
| `ANTHROPIC_API_KEY`                    | **missing**      | LotTR-Pro AI lookups. `/api/lottr/*` returns 503 without it. |
| `OPERATORS_SIGNUP_BASE_URL`            | **missing**      | Used by `/admin/*` invite URL builder. Falls back to `https://operators.clovrbid.com`. `operators.clovrbid.com` IS bound as a custom domain on the same Worker, so falling back works. |
| `STRIPE_BIDDER_SUBSCRIPTION_PRICE_ID`  | **missing**      | Bidder subscription price for ClovrRush Pro. May be unused at launch. |
| `STRIPE_CONNECT_CLIENT_ID`             | **missing**      | Only needed for the legacy OAuth Connect flow. Repo uses Standard direct-create, so this is correctly unset. |

Vars present on Worker but NOT in `.env.example`:

- `ALLOW_SKIP_STRIPE_ONBOARDING` — undocumented in example; live and
  active (this is what makes both operators have `stripe_account_id=NULL`
  but `stripe_onboarding_complete=true`).
- `LLM_MODEL_PHOTO_IDENTIFY_OLLAMA`, `LLM_OLLAMA_BASE_URL`,
  `LLM_PROVIDER_PHOTO_IDENTIFY`, `OLLAMA_CF_ACCESS_CLIENT_ID`,
  `OLLAMA_CF_ACCESS_CLIENT_SECRET` — Ollama tunnel config for photo ID,
  recently added.
- `OPENROUTER_API_KEY` — fallback LLM provider.
- `PUBLIC_APP_URL`, `RESEND_FROM_EMAIL`, `CRON_SECRET` — implicitly
  required, just not in example.

The biggest gap is whether `NEXT_PUBLIC_*` vars need to also be present
on the Worker or if Next.js webpack inlines them at build time. They are
inlined at build time and the deploy comes from `scripts/deploy-cf.sh`
which exports `NEXT_PUBLIC_*` before `next build`. So no action needed
unless a build runs without them.

---

## 9. Active Cloudflare Workers

2 Workers in the account.

### `bidwizops` (operator-web — main app)

Already covered in section 5. Custom domain bindings (all on
`clovrbid.com` zone):

- `clovrbid.com` → bidwizops (production)
- `www.clovrbid.com` → bidwizops (production)
- `operators.clovrbid.com` → bidwizops (production)

### `bidwizops-cron` (scheduler)

- Created: 2026-05-12T21:01:09Z
- Last modified: 2026-05-23T05:42:37Z (same deploy wave as the main Worker)
- Compat date: 2026-04-01
- Last deployed via `wrangler`
- Cron triggers (6, all active):
  - `* * * * *` — notifications-drain + email-drain + auto-charge-drain
  - `*/2 * * * *` — sms-drain
  - `*/5 * * * *` — closing-soon + saved-searches + health-check
  - `*/30 * * * *` — payment-followups + ai-budget-check
  - `0 * * * *` — settlements-release + grace-expiry
  - `0 0 * * *` — operator-sub-lapse (added 2026-05-22 for 0106)
- Bindings: `CRON_SECRET`, `CRON_TARGET_URL`, `SENTRY_DSN` (all secrets).

This Worker fans out to `/api/cron/*` routes on the main Worker. It is
separate from pg_cron — pg_cron handles in-database batch jobs (lot
finalize, auction lifecycle, invoice draining), while bidwizops-cron
handles HTTP-driven side effects (email, push, SMS, Stripe API auto-charge).

---

## 10. Subdomain resolution

| Hostname                       | Status   | Notes |
|--------------------------------|----------|-------|
| `clovrbid.com`                 | OK 200   | bidwizops |
| `www.clovrbid.com`             | OK       | bidwizops (custom domain bound) |
| `operators.clovrbid.com`       | OK       | bidwizops (custom domain bound, used by /admin pages) |
| `cdn.clovrbid.com`             | OK       | R2 (200 on real asset, 404 on root — expected) |
| `request-access.clovrbid.com`  | **DNS FAIL** | Not registered; the operator marketing page moved to `clovrbid.com/request-access` (path-based, not subdomain). Confirmed 200. |
| `staging.clovrbid.com`         | **DNS FAIL** | Not registered. No staging environment exists. |

The README/`docs` may mention `request-access.clovrbid.com` from
pre-cutover plans; the actual implementation is path-based. No drift —
just stale doc references possible.

---

## 11. Recommended actions (punch list)

In priority order. Each entry includes the exact command (read-only or
gated) and a safety note.

### P0 — Apply migration 0126 (1 migration drift)

`0126_get_recent_wins_rpc.sql` is on disk but not applied. The native
bidder-app commit (`9501914`) ports a RecentWinsRail that calls
`get_recent_wins`. If the rail is wired client-side already, that RPC
call will 404 on prod.

```bash
cd /c/Users/jmacl/Projects/auction-platform
node scripts/apply-migrations.js
```

Safety: the migration only adds a SECURITY DEFINER RPC. No destructive
DDL. Idempotent re-runs are blocked by `_schema_migrations`. **The user
must confirm before this is run.**

### P1 — Decide whether `/api/health` should exist

Prod returns 404. If the bidwizops-cron health-check fan-out
(`/api/cron/health-check`) is sufficient, no action. If external uptime
monitors need a public `/api/health`, add one. Smoke test:

```bash
curl -sS https://clovrbid.com/api/cron/health-check  # (would need CRON_SECRET)
```

No safety risk; investigative only.

### P2 — Mixed-mode Stripe keys in local `.env.local`

`STRIPE_SECRET_KEY=sk_test_…` + `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_live_…`
will trip `stripe-keys.ts` CRITICAL warnings on every local dev start.
This does not affect prod (the file is not deployed). Either align
both to `_test_` for local dev, or both to `_live_` to mirror prod.
**Do not touch prod Worker secrets** as part of this fix.

### P3 — Stripe key prefix verification (read-only inspection)

We cannot confirm prod is in LIVE mode without seeing one of the
secrets. The cheapest read-only verification is a single
`GET /v1/balance` from the prod Worker secret (would show
`livemode: true|false`). User approval required before this is run, per
the constraint in the task statement.

### P4 — Document the new env vars that aren't in `.env.example`

Variables in production but not in the example file:

- `ALLOW_SKIP_STRIPE_ONBOARDING`
- `LLM_MODEL_PHOTO_IDENTIFY_OLLAMA`, `LLM_OLLAMA_BASE_URL`,
  `LLM_PROVIDER_PHOTO_IDENTIFY`, `OLLAMA_CF_ACCESS_CLIENT_ID`,
  `OLLAMA_CF_ACCESS_CLIENT_SECRET`
- `OPENROUTER_API_KEY`
- `PUBLIC_APP_URL`, `RESEND_FROM_EMAIL`, `CRON_SECRET`

Add these to `apps/operator-web/.env.example` so the next operator
onboarding the codebase doesn't miss them. Safety: doc-only change.

### P5 — Stripe onboarding state is artificially complete

Both `operators` rows have `stripe_onboarding_complete=true` but
`stripe_account_id=NULL`. This is the
`ALLOW_SKIP_STRIPE_ONBOARDING=true` path. Before the first real
operator transacts, run them through the actual Connect Standard
onboarding (`/onboarding/stripe/start`) so `stripe_account_id` gets
populated and webhook routing works. No code change needed; flow exists.

### P6 — Stale doc references to `request-access.clovrbid.com`

If any doc still references the subdomain (`request-access.clovrbid.com`),
update it to the path-based equivalent (`clovrbid.com/request-access`).
Doc-only fix; no DNS/Worker change needed.

### P7 — Pending tasks list shows legacy redirect as pending

Task #63 ("Add /lots/[code] → /lot/[code] legacy redirect") is marked
pending in the harness task list, but smoke test confirms
`/lots/BIN-000035 → 307` is **live in prod**. Close the task.

---

## Drift summary

| # | Item                              | Severity | State                             |
|---|-----------------------------------|----------|-----------------------------------|
| 1 | Migration 0126 not applied        | P0       | Repo has it, prod doesn't         |
| 2 | `/api/health` 404                 | P1       | Possibly intentional              |
| 3 | Local `.env.local` mixed Stripe   | P2       | Local-only; CRITICAL warning      |
| 4 | Stripe live-mode unverified       | P3       | Indirect signals point to live    |
| 5 | New env vars not in .env.example  | P4       | Doc gap                           |
| 6 | Operators skipped Stripe onboard  | P5       | Pre-launch artifact               |
| 7 | Stale `request-access.*` subdomain refs | P6 | Likely doc-only                    |
| 8 | Task #63 pending but already live | P7       | Harness state stale               |

No critical drift detected (no destructive divergence, no missing
production secrets, no orphaned scheduled jobs).
