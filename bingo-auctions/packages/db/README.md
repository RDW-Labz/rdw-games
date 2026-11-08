# BinGo Database Layer

The database layer is the authoritative persistence engine for the BinGo multi-tenant auction marketplace. It runs on Supabase (managed PostgreSQL 15+) with row-level security, parameterized queries, and a pg_cron-based auction engine that has completely replaced the prior Redis/BullMQ worker infrastructure.

## Overview

**Stack:**
- Supabase PostgreSQL with Row-Level Security (RLS) enforced on every table (migration 0002+)
- 126 SQL migrations (0001–0126) tracked in `packages/db/migrations/`
- pg_cron extension for scheduled background jobs (every 5 seconds for closing lots, 30 seconds for invoicing, 60 seconds for auction lifecycle)
- SECURITY DEFINER SQL functions for business logic that bypasses RLS
- Real-time subscriptions via Supabase Realtime on the `lots` table for live bid updates

**Migration Status (as of 2026-05-23):**
- Latest migration applied to prod: **0125** (open_due_lots, launch blocker fix)
- Pending: **0126** (get_recent_wins RPC for social-proof feed)

## Auction Lifecycle

A lot's journey through the system follows this state machine:

```
[draft] → [scheduled] → [live] → [won]
                          ↓
                      [unsold] → (optional) [relisted] → [scheduled] (re-enter)
                          ↓
                      [in_inventory] (manual hold)
                          ↓
                      [canceled]
```

**Timing and Progression:**

1. **Lot Created** — operator or field-mobile staff create a lot in `draft` status with a `close_at` timestamp.

2. **Auction Scheduled** — operator transitions the parent auction to `scheduled` status. Lots remain `draft` until the auction is assigned and confirmed.

3. **Scheduled → Live Transition** (migration 0125, `open_due_lots`, pg_cron every 5 seconds)
   - When the parent auction's `starts_at` timestamp is reached and the auction status is `scheduled` or `live`, the lot is promoted from `scheduled` → `live`.
   - This was a **launch-blocker bug**: no function existed to perform this transition, so scheduled auctions sat in `scheduled` forever once their start time passed.
   - `open_due_lots()` scans for eligible lots using `pg_try_advisory_xact_lock(7423940124)` to prevent concurrent ticks from stepping on each other.
   - See migration 0125 header for full root-cause analysis (RCA).

4. **Live and Bidding** — once a lot is `live`, bidders call the `place_bid(lot_id, max_amount_cents)` RPC (migration 0111). The function:
   - Serializes all concurrent bids on the same lot with `pg_advisory_xact_lock` (prevents proxy-duel races).
   - Validates identity, payment method, and minimum increment.
   - Resolves the proxy auction duel (highest max bid wins; existing leader wins on ties).
   - Inserts one or two bid rows (new bid + optional auto-bid from the outbid leader).
   - **Soft-close extension**: if the bid lands within `soft_close_minutes` (default 3, configurable per auction) of `close_at`, the lot's `close_at` is bumped forward. Setting `soft_close_minutes = 0` disables this (migration 0111 §B).
   - Updates the lot's `current_bid_cents`, `winner_bidder_id`, `bid_count`, and `close_at`.

5. **Live → Won/Unsold Transition** (migration 0072, `finalize_due_lots`, pg_cron every 5 seconds)
   - When the lot's `close_at` timestamp passes, `finalize_due_lots()` scans for `live` lots where `close_at <= now()` and calls `finalize_lot()` on each.
   - `finalize_lot()` checks if the soft-close window has extended the deadline (returns `reason='reschedule'` if so; the worker re-enqueues for the new time).
   - Once the true close time arrives, the lot transitions to `won` (if there are bids) or `unsold` (if no bids).
   - A 'won' notification is enqueued in the `notifications` table.
   - A `build_invoice_jobs` entry is upserted with a 30-second debounce to trigger invoice assembly.

6. **Invoicing** (migration 0072, `drain_build_invoice_jobs`, pg_cron every 30 seconds)
   - The `drain_build_invoice_jobs()` function reads the `build_invoice_jobs` table for entries where `run_at <= now()` and calls `build_invoices_for_auction()` for each.
   - `build_invoices_for_auction()` groups won lots by bidder, computes subtotal (sum of winning bids), buyer premium, application fee, and upserts one invoice per (auction, bidder) pair.
   - Invoice-lot line items are created.
   - On success, the job is deleted; on failure, `attempt_count` is bumped up to 5 retries before the job is abandoned.

7. **Auction-Level Lifecycle** (migration 0096, `advance_auction_lifecycle`, pg_cron every 60 seconds)
   - Reconciles the parent auction's status against its child lots.
   - Flips `scheduled` → `live` if any child lot is already `live` or `won` (catches the case where `place_bid()` updates lots but the parent hasn't been promoted yet).
   - Flips `live` → `closed` when every child lot reaches a terminal state (`won`, `unsold`, `canceled`, or `relisted`). Sets `closed_at`.
   - Accepts `scheduled` → `closed` for auctions where all lots were canceled before going live.

8. **Auto-Relist** (migration 0097, `auto_relist_unsold_lots`, pg_cron every 10 minutes)
   - When an operator has `auto_relist_enabled = true` and `auto_relist_max_attempts > 0`, unsold lots are automatically relisted into the next eligible auction at the same warehouse.
   - The lot's `relist_count` is incremented; the new lot has `relisted_from_lot_id` pointing to its source.
   - Once `relist_count` reaches `auto_relist_max_attempts`, the lot stays `unsold` and surfaces in the "needs manual review" queue.

9. **Settlement and Payout** (migration 0072, `mark_settlements_releasable`, pg_cron every 60 seconds)
   - As invoices are paid (via Stripe), the platform computes operator settlements (gross revenue minus commissions).
   - `mark_settlements_releasable()` transitions settlements from `held` → `releasable` once their `release_at` timestamp passes.
   - A separate Cloudflare Worker (`/api/cron/settlements-release` in operator-web) handles the actual Stripe transfer out.

## Core Database Functions

### `place_bid(lot_id, max_amount_cents)` — Migration 0111 & 0084

**Signature:**
```sql
FUNCTION place_bid(p_lot_id UUID, p_max_amount_cents BIGINT)
RETURNS place_bid_result
```

**Behavior:**
- Entry point for all bid placement from the mobile and web apps via PostgREST RPC.
- Serializes concurrent bids on the same lot with `pg_advisory_xact_lock(hashtext(lot_id))`.
- Validates: authenticated, is-a-bidder, has-payment-method, no-unpaid-fees, not-suspended, lot-open, within-time, meets-minimum-increment, above-starting-bid.
- Resolves the proxy duel: highest max-bid wins; existing leader wins ties.
- Inserts 1–2 bid rows; updates lot current-bid and winner.
- Extends `close_at` if inside soft-close window AND `soft_close_minutes > 0` (migration 0111 §B).
- Returns a `place_bid_result` composite type with success/reason/lot-state.
- Clients subscribe to `lots` realtime for UPDATE broadcasts.

### `open_due_lots(p_batch_size = 100)` — Migration 0125

**Signature:**
```sql
FUNCTION open_due_lots(p_batch_size INTEGER DEFAULT 100)
RETURNS jsonb
```

**Behavior:**
- Promotes lots from `scheduled` → `live` when their parent auction's `starts_at <= now()` and the auction is in `scheduled` or `live` status.
- Defense: skips lots whose `close_at` is already in the past (misconfigured rows).
- Uses `pg_try_advisory_xact_lock(7423940124)` to serialize concurrent ticks.
- Batch size defaults to 100 lots per tick; the lock ensures no overlapping execution.
- Idempotent: re-running returns the count of newly promoted lots (or `skipped: true` if another tick is in flight).
- **Schedule:** pg_cron every 5 seconds (same cadence as `finalize_due_lots` so the open → bid → close chain can complete within one tick window).
- **Added:** 2026-05-23 as a launch-blocker fix. Before this, scheduled auctions sat in `scheduled` status forever.

### `finalize_due_lots(p_batch_size = 50)` — Migration 0072

**Signature:**
```sql
FUNCTION finalize_due_lots(p_batch_size INTEGER DEFAULT 50)
RETURNS jsonb
```

**Behavior:**
- Scans for `live` lots where `close_at <= now()` and calls `finalize_lot()` on each.
- Replaces the prior Redis/BullMQ "close lot at time T" job queue entirely. No need to pre-schedule; just scan every 5 seconds.
- Uses `pg_try_advisory_xact_lock(7423940123)` to prevent concurrent ticks from stepping on each other.
- Inner `finalize_lot()` is idempotent: already-closed lots are no-ops; soft-close extensions return `reason='reschedule'`.
- On `won` result, upserts a `build_invoice_jobs` entry with a 30-second debounce.
- Returns a JSON object with counts: `{processed: N, won: M}`.
- **Schedule:** pg_cron every 5 seconds.

### `advance_auction_lifecycle()` — Migration 0096

**Signature:**
```sql
FUNCTION advance_auction_lifecycle()
RETURNS jsonb
```

**Behavior:**
- Reconciles each auction's status against its child lots' aggregate state.
- **Scheduled → Live:** flips when any child lot is `live` or `won`.
- **Live/Scheduled → Closed:** flips when every child lot is in a terminal state (`won`, `unsold`, `canceled`, `relisted`). Sets `closed_at` timestamp.
- Returns a JSON object: `{promoted_live: N, promoted_closed: M}`.
- **Schedule:** pg_cron every 60 seconds (once per minute; cheap query, typically < 10 ms).

### `auto_relist_unsold_lots()` — Migration 0097

**Signature:**
```sql
FUNCTION auto_relist_unsold_lots()
RETURNS TABLE
```

**Behavior:**
- Scans for unsold lots at operators where `auto_relist_enabled = true` and `relist_count < auto_relist_max_attempts`.
- For each eligible lot, finds the next `draft` or `scheduled` auction at the same warehouse.
- Calls the helper `relist_lot_into_auction(lot_id, auction_id)` to mint a new lot with the same metadata/photos, set `relisted_from_lot_id`, increment `relist_count`, and flip the source to `relisted`.
- Lots that exhaust retries stay `unsold` and surface in the manual-review queue.
- **Schedule:** pg_cron every 10 minutes.

### `mark_settlements_releasable()` — Migration 0072

**Signature:**
```sql
FUNCTION mark_settlements_releasable()
RETURNS int
```

**Behavior:**
- Updates `operator_settlements` rows from `held` → `releasable` when their `release_at <= now()`.
- Pure-SQL state flip; no external API calls.
- Returns the count of rows updated.
- **Schedule:** pg_cron every 60 seconds (every minute).

### `drain_build_invoice_jobs(p_batch_size = 20)` — Migration 0072

**Signature:**
```sql
FUNCTION drain_build_invoice_jobs(p_batch_size INTEGER DEFAULT 20)
RETURNS int
```

**Behavior:**
- Reads `build_invoice_jobs` table for entries where `run_at <= now()` and `attempt_count < 5`.
- Calls `build_invoices_for_auction()` for each.
- On success, deletes the job; on failure, increments `attempt_count` and stores the error.
- Uses `pg_try_advisory_xact_lock(7423940124)` to serialize ticks.
- Returns the count of successfully processed jobs.
- **Schedule:** pg_cron every 30 seconds.

### `get_recent_wins(p_days = 7, p_limit = 10)` — Migration 0126

**Signature:**
```sql
FUNCTION get_recent_wins(p_days INTEGER DEFAULT 7, p_limit INTEGER DEFAULT 10)
RETURNS TABLE (
  invoice_id UUID,
  representative_title TEXT,
  representative_photo_url TEXT,
  savings_cents BIGINT,
  lot_count INTEGER,
  paid_at TIMESTAMPTZ
)
```

**Behavior:**
- Returns anonymized "Recent wins" social-proof data for the mobile bidder app homepage.
- SECURITY DEFINER bypasses RLS so the anon/unauthenticated key can call it.
- **Privacy contract enforced in the function body:**
  - `bidder_id`, email, phone, display_name, and all Stripe identifiers are **never selected**.
  - Only aggregate financial data and the single highest-MSRP lot title/photo are returned (both already public on the lot detail page).
- Filters to `invoices.status = 'paid'` and `paid_at > now() - (p_days || ' days')`.
- `p_days` is clamped to [1, 90]; `p_limit` is clamped to [1, 50] (defense against runaway queries).
- **Granted to:** `anon` (public/unauthenticated) and `authenticated` (logged-in bidders).
- **Added:** 2026-05-23 for the Wave 1D native mobile port.

## Concurrency Model

**Lot-Level Serialization:**
- All `place_bid` calls on the same lot are serialized with `pg_advisory_xact_lock(hashtext(lot_id::text))` held for the duration of the transaction. This is strictly stronger than row-level locking and prevents proxy-duel races.
- Prevents two callers from both observing the old leader's max-bid and both "winning" the duel.

**Tick-Level Serialization:**
- `open_due_lots` and `finalize_due_lots` each hold a transaction-level advisory lock to prevent overlapping ticks.
- If a tick is already running, the next pg_cron firing is skipped (returns `{skipped: true}`); the following 5-second tick picks it up.
- **Locks used:** `7423940124` (open_due_lots), `7423940123` (finalize_due_lots), `7423940124` (drain_build_invoice_jobs, reused for debounce ordering).

**Soft-Close Window:**
- When a bid lands within `soft_close_minutes` (default 3 minutes, configurable per auction format) of `close_at`, the lot's `close_at` is bumped forward by that many minutes.
- `soft_close_minutes = 0` **disables** soft-close (migration 0111 §B).
- The extension can happen repeatedly; each bid in the window re-extends.

## Migrations and Schema Management

**Location:** `packages/db/migrations/NNNN_descriptive_name.sql`

**Naming Convention:**
- 4-digit zero-padded number followed by descriptive snake_case name.
- Example: `0125_open_due_lots.sql`, `0111_place_bid_concurrency_and_soft_close.sql`.

**Application:**
- Local development: `npx supabase db reset` applies all migrations.
- CI/production: `node scripts/apply-migrations.js` or equivalent (consult deployment runbook).
- Check status: `node scripts/apply-migrations.js --status` (if the script exists; otherwise query `_schema_migrations` table directly).

**Idempotency:**
- All migrations are idempotent: re-running a migration that's already applied is safe and does nothing.
- Functions use `CREATE OR REPLACE FUNCTION` (not `CREATE FUNCTION`) so re-applying doesn't fail.
- Constraints and indexes use `IF NOT EXISTS` or `ON CONFLICT` patterns.
- The `_schema_migrations` table (seeded in migration 0033) tracks which migrations have been applied.

**Tracking Table:**
```sql
SELECT migration_name, applied_at FROM _schema_migrations ORDER BY applied_at DESC LIMIT 10;
```

## Row-Level Security (RLS)

Every table has RLS enabled (migration 0002+). Policies enforce:

- **Operators** can only see their own rows (filtered by `operator_id`).
- **Bidders** can only see:
  - Their own profile, payment methods, and settings.
  - Auctions and lots at operators they can bid at (no operator-level privacy leak).
  - Invoices they are the bidder on.
  - Bids they placed.
- **Operator staff** (users in `operator_users`) can see all rows for their operator(s).

RLS is **NOT** bypassed for the app's PostgREST endpoints. Policies are scoped and enforce the multi-tenant boundary. SECURITY DEFINER functions like `place_bid`, `finalize_lot`, `open_due_lots`, etc., run as the function owner (postgres role) and bypass RLS, but they perform their own authorization checks (e.g., `SELECT ... WHERE operator_id = <current_operator_id>`).

## Pre-Deploy Checklist

Before running migrations on production:

1. **Backup:** Verify a recent backup exists and is restorable.
2. **Review Changes:** Read the migration file header. Note if it performs:
   - `DROP COLUMN`, `DROP TABLE`, or `TRUNCATE` (destructive; needs approval).
   - `ALTER TABLE ... ADD NOT NULL` without a default (may fail if null rows exist).
   - Complex data transformations (test on a clone first).
3. **Test on Staging:** Apply the migration to a staging/clone environment and verify:
   - No errors during application.
   - Corresponding tests pass.
   - Performance queries (if any new indexes) don't block writes.
4. **Verify Rollback Plan:** If the migration is not reversible, document why and who approved the risk.
5. **Timing:** Run during a maintenance window if the migration locks tables or rebuilds indexes.
6. **Monitor:** After applying to production, watch error logs and slow-query logs for 10 minutes.

## Architecture History

**BullMQ Removal (2026-05-12):**

Prior to this date, the auction-closing workflow relied on a Redis/BullMQ worker process:
- A Node.js service polled a job queue for "close lot X at time T" jobs.
- When the time arrived, the worker called `finalize_lot()` and handled retries via Redis.

This was **replaced entirely by pg_cron** (PostgreSQL's native job scheduler) in migrations 0071–0073:
- **finalize_due_lots()** scans the database every 5 seconds for due lots instead of relying on pre-scheduled jobs.
- **build_invoices_for_auction()** and **drain_build_invoice_jobs()** moved into Postgres functions.
- **mark_settlements_releasable()** moved into Postgres.
- Only external-API-dependent work (email, SMS, Stripe, Expo push) remains in Cloudflare Workers (e.g., `/api/cron/*` routes in operator-web).

The pg_cron approach eliminates operational complexity:
- No separate Redis service to monitor.
- No job queue to tune (connection pooling, memory).
- Schema and state are unified in Postgres.
- Easier to test, audit, and reason about.

**Do NOT re-introduce BullMQ or Redis workers for lot-closing or invoice-building logic.** If a new background job is needed, first consider pg_cron. Only use Cloudflare Workers or external queues for tasks that require fetch(), secrets, or external API calls.

## Running the Database Locally

```bash
# From the repo root
cd C:\Users\jmacl\Projects\auction-platform

# Initialize Supabase (one-time)
npx supabase init

# Start local Postgres + Auth + Storage
npx supabase start

# Apply all migrations and seed
npx supabase db reset

# Verify migrations applied
psql <connection-string> -c "SELECT migration_name FROM _schema_migrations ORDER BY applied_at;"

# Inspect pg_cron jobs (if needed)
psql <connection-string> -c "SELECT jobname, schedule, command FROM cron.job;"
```

## Inspecting Scheduled Jobs in Production

To see the current pg_cron jobs on a live database:

```sql
-- Via Supabase SQL editor or psql
SELECT jobname, schedule, command, active
FROM cron.job
ORDER BY jobname;
```

Or from the command line (if access is available):

```bash
# Future: add a dedicated inspector script
node scripts/inspect-cron-jobs.mjs
```

*(The inspector script may be added post-launch. For now, use the SQL query above.)*

## Links and References

- **Migrations:** `packages/db/migrations/`
- **Migration 0125** (open_due_lots — launch blocker): `packages/db/migrations/0125_open_due_lots.sql`
- **Migration 0111** (place_bid concurrency & soft-close): `packages/db/migrations/0111_place_bid_concurrency_and_soft_close.sql`
- **Migration 0096** (auction lifecycle): `packages/db/migrations/0096_auction_lifecycle.sql`
- **Migration 0097** (auto-relist): `packages/db/migrations/0097_auto_relist.sql`
- **Migration 0072** (pg_cron functions): `packages/db/migrations/0072_pg_cron_functions.sql`
- **Migration 0073** (pg_cron schedules): `packages/db/migrations/0073_pg_cron_schedules.sql`
- **Migration 0126** (get_recent_wins RPC): `packages/db/migrations/0126_get_recent_wins_rpc.sql`
- **RLS policies:** `packages/db/migrations/0002_rls.sql`
- **Migration tracking:** `packages/db/migrations/0033_migration_tracking_and_resolver.sql`
