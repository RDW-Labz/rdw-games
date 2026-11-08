# Architecture

## Tenancy model

- **Operators** are tenants. Every operator-scoped table carries `operator_id` and is gated by an RLS policy that resolves the caller's operator via `current_operator_id()`.
- **Bidders** are global. One `bidders` row works on every operator on the platform. Operators only see bidder PII via a join through `invoices` (i.e., bidders who have actually purchased from them).
- **Operator staff** (`operator_users`) link an `auth.users` row to one operator with one of three roles: `admin`, `manager`, `picker`.

## Lot lifecycle

```
pending_intake ──┐
                 ├── (intake scan) ─→ in_inventory ──── (auction builder) ─→ scheduled
                 │                                                            │
                 └── (operator deletes) ─→ X                                   ↓
                                                                              live
                                                                              │
                                              ┌─────── won ←─ winner ←──── (closeLot worker)
                                              │       (or)   ←─ no bidder ─→ unsold
                                              ↓
                                      buildInvoices worker
                                              ↓
                                          paid → staged → picked_up
```

- `pending_intake` and `in_inventory`: `auction_id IS NULL`. The lot exists as inventory but isn't in any auction. Bidder-facing queries (which all filter by `status IN ('scheduled','live',...)`) never surface these.
- `scheduled` / `live`: `auction_id` set, `lot_number` set per-auction sequential. This is the bidder-visible state.
- `won` / `unsold` / `canceled` / `relisted`: terminal states. closeLot worker sets `won` / `unsold`; operator manual cancel sets `canceled`; relisted is the no-show flow.

Every lot has an app-wide unique **lot_code** of the form `{operator.code}-NNNNNN` (e.g. `RDW-000123`). The code is generated atomically by the `next_lot_code(operator_id)` RPC, which row-locks `operators` to advance `next_lot_seq`. Codes are stable for the life of the lot — even cancellation + relisting does not reuse them. Operators can additionally map a column from their import as `external_code` (per-operator unique) — supplier SKU, route stop, asset tag, whatever's already on a pre-stickered box. Intake scans resolve in priority order: lot_code → UUID → external_code (operator-scoped).

## Auction engine

The "engine" is now two layers, neither of which is a long-running Node
container — see `docs/AUCTION_ENGINE_DEPLOY.md` for setup.

**Layer 1: pg_cron (SQL-only work).** Postgres-side scheduling. Functions
defined in migration 0072, schedules in 0073.

1. **place_bid()** — Postgres function called from the bidder app via PostgREST RPC. Locks the lot row, validates, resolves the proxy duel, extends `close_at` if inside the soft-close window, writes 1–2 bid rows, updates the lot.
2. **finalize_due_lots()** — every 5s. Scans `lots WHERE status='live' AND close_at <= now()` `FOR UPDATE SKIP LOCKED`, calls `finalize_lot()` on each. Replaces the per-lot delayed BullMQ job — soft-close extensions are picked up automatically on the next scan, no reschedule dance needed.
3. **build_invoices_for_auction(auction_id)** + **drain_build_invoice_jobs()** — every 30s. finalize_due_lots upserts `build_invoice_jobs` with a 30s debounced `run_at`; the drainer rebuilds the invoice when the window expires.
4. **mark_settlements_releasable()** — every minute. Flips `operator_settlements.status` `held → releasable` for rows whose hold expired.
5. **cron-history-cleanup** — hourly. Trims `cron.job_run_details` (5s cadence generates ~17k rows/day).

**Layer 2: Cloudflare cron routes (need external HTTP).** Lives in
`apps/operator-web/src/app/api/cron/*` plus drainable modules in
`src/lib/cron/`. Fired by a tiny separate Worker at
`apps/cron-trigger/` whose only job is to POST to these routes on the
configured schedule, authenticated by a shared `CRON_SECRET`.

6. **/api/cron/settlements-release** — every minute. Reads `releasable` settlements, calls Stripe transfers with idempotency key `settle:<id>`, marks `transferred`.
7. **/api/cron/notifications-drain** — every minute. Reads unsent push rows from `notifications_outbox`, sends via Expo Push API, marks `processed_at`.
8. **/api/cron/email-drain** — every minute. Same shape via Resend, separate `emailed_at` column.
9. **/api/cron/sms-drain** — every minute. Same shape via Twilio (opt-in), separate `smsed_at` column.
10. **/api/cron/closing-soon** — every minute. Joins `watchlist`+`lots` within 10m of close, INSERTs `closing_soon` outbox rows.
11. **/api/cron/saved-searches** — every 5 minutes. Per saved_search with `notify=true`, finds new matching lots since `last_matched_at`, INSERTs `saved_search_hit` outbox rows.

**Producer changes:** Operator-web's `src/lib/queue.ts` used to enqueue
BullMQ jobs against an external Redis. With pg_cron taking over close
scheduling, `enqueueAuctionCloseJobs` is now a no-op (the pg_cron scan
implicitly schedules from `lots.close_at`). `enqueueCacheWarm` writes
to the `product_cache_warm_jobs` table; that queue's drain route is
the only worker not yet ported — see "Open work" in
AUCTION_ENGINE_DEPLOY.md.

**Why not the old plan (BullMQ + Redis + Railway):** Nothing was ever
deployed. The new design uses tooling we already pay for (Supabase +
Cloudflare), eliminates two vendor bills, and inherits the
notifications_outbox idempotency model the platform already relies on.

## Realtime

Tables published on `supabase_realtime`: `lots`, `bids`, `bin_assignments` (migration 0017). The bidder app subscribes to:
- `lot:<id>` channel for `UPDATE` events on `lots` (current_bid_cents, close_at, winner_bidder_id, status changes).
- The lot detail screen also runs a 1Hz local clock for the urgency countdown — that's not Realtime.

## Notifications outbox

```
SQL function (place_bid, finalize_lot, etc.)
    │
    │ INSERT INTO notifications_outbox
    ▼
notifications_outbox  ──► push worker ──► Expo Push ──► processed_at
                      │
                      ├─► email worker ──► Resend ──► emailed_at
                      │
                      └─► sms worker ──► Twilio ──► smsed_at
```

Three workers drain the same table on independent flags. A single notification can deliver to push + email + SMS based on bidder per-channel prefs (`bidders.push_enabled`, `email_enabled`, `sms_enabled`). Each worker tracks its own attempt counters and skip reasons (e.g. `push_disabled`, `email_disabled`, `no_phone`, `sms_disabled`). `kind` is an enum (`outbid` / `won` / `pickup_ready` / `pickup_confirmed` / `dispute_update` / `closing_soon` / `saved_search_hit`) with bespoke templates per channel + per kind. All workers do a per-batch lookup to enrich the payload with `lot_code` so notifications include the user-facing identifier.

## Bidder feature flags

Operators (our SaaS customers) decide which search/sort/filter conveniences their bidders see and which are gated behind a per-operator paid bidder tier. The data model is a single JSONB column:

```sql
operators.bidder_features JSONB DEFAULT '{...}'
-- Each key is a feature name, each value is "all" | "pro" | "off".
```

The catalog lives in [`packages/shared/src/features.ts`](../packages/shared/src/features.ts) (17 flags grouped into search/filter, sort, discovery). The bidder app's `useOperatorFeatures(operatorId)` hook fetches the flags + the bidder's subscription tier and returns a merged visibility decision via `isFeatureVisible(flagValue, tier)`. UI components conditionally render based on those flags. The cross-operator browse falls back to a hardcoded `UNIVERSAL_DEFAULTS` set; per-operator flags only apply when the bidder narrows to one operator.

The operator console exposes `/settings/bidder-experience` with quick presets ("Calm storefront" / "Power buyer (free)" / "Pro-tier bundle") plus a per-flag radio editor.

## Categories

A platform-curated taxonomy (16 top + 51 leaves, seeded in migration 0018). Every operator's lots classify into the same tree — bidders shop by what they want to buy, not who's selling it.

- `categories(id, slug, name, parent_id, icon, sort_order)` — the tree.
- `category_aliases(raw, category_id, source, confidence)` — keyword → category mapping. Imports auto-classify via longest-substring match against this table; LotTR (planned import tool) will populate it via LLM at scale.
- `lots.category_id` — the canonical pointer. `lots.category` keeps the raw retailer string for debugging.

The operator console exposes `/settings/categories` for bulk-assigning categories to lots that didn't auto-classify.

## Indoor map

- **MVP (Phase 4)**: Operator uploads PNG floor plan to Supabase Storage. `warehouses.floor_plan_url` + `floor_plan_width_px` + `floor_plan_height_px` carry the image. `bins.x_px` + `y_px` carry pixel coordinates. Renderer uses Leaflet `CRS.Simple` on web and `react-native-svg` + `react-native-svg-pan-zoom` on mobile. No external mapping SDK, no recurring cost.
- **Scale path**: When operators have multiple warehouses or floor plans change frequently, swap the renderer for Mappedin Pro at $165/warehouse/mo. Migration touches the renderer components only — schema + bin coordinates port directly to Mappedin's editor.

## Money

Always integer cents (`BIGINT` in Postgres, `number` in TS). Application fees stored as basis points (10000 = 100%). Stripe Tax computes sales tax at checkout. Buyer's premium is computed at invoice build time (basis points × subtotal).

## Stripe Connect topology

- Platform = our Stripe account.
- Each operator = a Connect Express account, onboarded via hosted flow during Phase 1 onboarding.
- Bidder pays the platform; PaymentIntent lands in the platform balance.
- `operator_settlements` worker fires Stripe transfers to operators after a per-operator hold window (default 7d). This is the **delayed settlement** marketplace pattern from Phase 15.
- Refunds (disputes): operator-initiated via `/disputes`; refund processed against the platform PaymentIntent; settlement is reduced or reversed accordingly.
- Bidder Pro subscriptions live on per-operator `bidder_subscriptions` rows; operators set their own monthly price via `operators.pro_monthly_cents` and `pro_stripe_price_id`.

## Why this stack and not others

- **Not Firestore**: auction tables need joins (`lots` × `bids` × `invoices`), `SELECT FOR UPDATE` (race-safe bidding), tsvector search, and per-operator RLS. Postgres wins decisively.
- **Not Postgres triggers for auction close**: triggers can't reliably fire on a wall-clock schedule, can't retry, can't observe. BullMQ owns timing.
- **Not InsForge / app-factory**: weaker fit for multi-tenant SaaS with realtime fairness and Stripe Connect orchestration.
- **Not custom Node + Postgres**: would shape up like a worse Supabase. Re-evaluate if/when scale makes Supabase the bottleneck.
