# auction-engine: Supabase-native deploy

We replaced the BullMQ + Redis + Railway plan with a Postgres-native
schedule (pg_cron) plus a thin Cloudflare Workers cron dispatcher. This
doc is the runbook for getting it live and the rollback if it doesn't
work.

## What changed

The old plan required Upstash Redis ($) + Railway ($) + a Node
container running BullMQ workers. None of it was ever deployed.

The new design uses tooling we already pay for:

| Concern                         | Old (BullMQ + Railway)              | New (Supabase + Cloudflare)               |
|---|---|---|
| Schedule close-lot               | per-lot delayed job in Redis        | `pg_cron` scans `lots WHERE close_at <= now()` every 5s |
| Run finalize_lot                 | Node Worker on Railway              | `finalize_due_lots()` SQL function         |
| Build invoices                   | BullMQ debounced job                | `build_invoice_jobs` table + 30s drainer   |
| Mark settlements releasable      | settlements worker step 1           | `mark_settlements_releasable()` (1m pg_cron) |
| Stripe transfers (settlement)    | settlements worker step 2-3         | `/api/cron/settlements-release` (1m)        |
| Push, email, SMS, closing-soon, saved-searches | Polling workers in Node container | `/api/cron/*` routes on the main bidwizops Worker, fired by a tiny `bidwizops-cron` Worker |
| Product cache warming            | BullMQ + OpenRouter Worker          | `product_cache_warm_jobs` table (drain route deferred — see "Open work") |

No new vendors. No new monthly bills. The pg_cron + table-queue layer
is the same model `notifications_outbox` already uses, just extended to
cover what BullMQ used to handle.

## One-time setup

### 1. Apply migrations 0071–0073

```bash
# From WSL:
cd /mnt/c/Users/jmacl/Projects/auction-platform
# This uses .env.migrations.local for SUPABASE_ACCESS_TOKEN + SUPABASE_PROJECT_REF
node scripts/apply-migrations.mjs
```

Migrations:
- `0071_pg_cron_and_queue_tables.sql` — enables `pg_cron`, adds
  `product_cache_warm_jobs` + `build_invoice_jobs` tables
- `0072_pg_cron_functions.sql` — `finalize_due_lots`,
  `build_invoices_for_auction`, `drain_build_invoice_jobs`,
  `mark_settlements_releasable`
- `0073_pg_cron_schedules.sql` — schedules the four pg_cron jobs

Verify in Supabase Dashboard → Integrations → Cron: four jobs listed,
all enabled, `finalize-due-lots` running every 5 seconds.

### 2. Generate the cron shared secret

```bash
openssl rand -hex 32
# copy the output — this is CRON_SECRET
```

Set it in both Workers:

```bash
# Main bidwizops Worker:
cd apps/operator-web
echo "<paste-secret>" | npx wrangler secret put CRON_SECRET

# Cron dispatcher:
cd ../cron-trigger
echo "<paste-secret>" | npx wrangler secret put CRON_SECRET
echo "https://clovrbid.com" | npx wrangler secret put CRON_TARGET_URL
```

The two values must match. The /api/cron/* route handlers reject any
POST whose `x-cron-secret` header doesn't equal CRON_SECRET.

### 3. Deploy the cron-trigger Worker

```bash
cd /mnt/c/Users/jmacl/Projects/auction-platform/apps/cron-trigger
npm install
npx wrangler deploy
```

Cloudflare assigns it a `*.workers.dev` URL (which is disabled), and
the crons in `wrangler.jsonc` start firing on the schedule. Confirm:

```bash
npx wrangler tail
# In another shell, wait 60s and you should see lines like:
# [cron-trigger] /api/cron/notifications-drain ok {"scanned":0,...}
```

### 4. Redeploy operator-web

The /api/cron/* routes are new. Redeploy the main Worker so they're
served:

```bash
cd /mnt/c/Users/jmacl/Projects/auction-platform
CLOUDFLARE_API_TOKEN=<your-token> bash scripts/cloudflare-cutover.sh
```

## Verify

End-to-end smoke test:

1. Create a test auction in the operator console (Auctions → New).
2. Add one in-inventory lot with `close_at = now() + 2 minutes`.
3. Schedule the auction.
4. Wait two minutes.
5. Run this query in the Supabase SQL editor:

```sql
SELECT id, lot_code, status, close_at, closed_at, winner_bidder_id, current_bid_cents
FROM lots WHERE auction_id = '<your-test-auction-uuid>';
```

`closed_at` should be populated within ~5 seconds of `close_at`.

If the lot had a bid, also check:

```sql
SELECT * FROM build_invoice_jobs WHERE auction_id = '<your-test-auction-uuid>';
SELECT * FROM invoices WHERE auction_id = '<your-test-auction-uuid>';
SELECT * FROM notifications_outbox WHERE payload->>'lot_id' = '<lot-uuid>';
```

The `build_invoice_jobs` row appears within 5s and disappears within 30s
after `build_invoices_for_auction` runs successfully. The `invoices` row
is what the bidder pays. The `notifications_outbox` row drives push/email/SMS.

## Rollback

If pg_cron behaves badly:

```sql
-- Disable everything in one statement:
SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname IN (
  'finalize-due-lots',
  'drain-build-invoice-jobs',
  'mark-settlements-releasable',
  'cron-history-cleanup'
);
```

Re-enabling later: re-run migration 0073.

If the Cloudflare side breaks:

```bash
cd apps/cron-trigger
npx wrangler delete  # removes the worker; crons stop firing immediately
```

The /api/cron/* routes stay live (they're inert without the dispatcher
calling them — protected by CRON_SECRET).

## Open work

- **`/api/cron/cache-warm-drain`** — not yet built. The `product_cache_warm_jobs`
  table accumulates entries from manifest imports but nothing drains them
  until the OpenRouter-based enrichment in `packages/auction-engine/src/productCacheWarm.ts`
  is ported to a Worker route. ~400 lines, deferrable since cache-warm
  is a discovery optimization, not a critical path.

- **Once the new path proves out**, delete `packages/auction-engine`
  entirely: `Dockerfile`, `railway.toml`, all `src/*.ts`, BullMQ deps.
  See `git log -1 -- packages/auction-engine` for last-good reference.

- **Twilio SDK on Workers** — the SMS drain imports `twilio`, which
  uses `axios` under the hood. With `nodejs_compat` this should work
  but isn't proven. If SMS send fails after deploy, swap to a direct
  fetch-based REST call to `https://api.twilio.com/2010-04-01/Accounts/<sid>/Messages.json`
  (Basic Auth + form-encoded POST — ~30 lines).
