# mega-sim — persona-driven E2E simulator

A Node script that walks through the platform's operations flow as
real personas (operator-admin → lotter → picker), captures latency
and AI cost telemetry, and writes a structured report. Built to catch
the kinds of bugs that the manual Option-C end-to-end caught: schema
drift, RPC ambiguity, dropped field propagation, status-state-machine
violations.

## Usage

```bash
# Default: real AI calls, auto-cleanup
node scripts/mega-sim

# Cheap iteration: skip AI calls
node scripts/mega-sim --no-ai

# Keep the SIM operator around to inspect in operator-web
node scripts/mega-sim --keep

# Tear down all SIM operators (any with `sim-` slug prefix)
node scripts/mega-sim --cleanup
```

## Output

`artifacts/mega-sim/<ISO-timestamp>/`:
- `report.md` — human-readable: failures, latency p95 by step, AI cost by task/model/phase
- `report.json` — full machine-readable detail
- `timeline.csv` — every step with start/end/duration/ok/error
- `cost-by-task.csv` — per-AI-call detail (task, model, tokens, cost, latency, escalation tier)
- `bottlenecks.md` — top 10 slowest steps with hints

## What it exercises

Phase 1 today:
- **Operator setup** — operator + slug + code + warehouse + 3 bins + admin/picker auth users (real Supabase auth, real JWTs)
- **Manifest import** — service-role direct DB writes mirroring `commitImport`. 26 rows: 5 with UPC, 10 supplier-SKU-as-title, 5 ASIN/FNSKU/LPN, 1 extreme-long-title edge case
- **Quick Lot** — `create_draft_lot` RPC end-to-end; verifies `pending_intake` status, `lot_code` regex, source propagation
- **AI Photo + Shelf scans** — direct in-Node calls to `domain-lotting`'s `identifyPhoto` + `shelfScan`; cost captured via the `LlmTelemetrySink` hook
- **Single intake** — picker scans field-lotted lot_code + bin → `in_inventory`
- **Manifest UPC intake** — exercises the 0059 manifest-fall-through; verifies `source_label` → `lots.source` propagation
- **Manifest title intake** — covers the Lowe's-style "supplier SKU as title" case
- **Manifest ASIN intake** — verifies asin/fnsku/lpn copy at mint
- **Batch put-away** — `batch_intake_lot_to_bin` with mixed identifiers
- **Bogus identifier** — verifies clean `lot_not_found`
- **Idempotency** — re-scanning a UPC after intake (documents current behavior)

## Architecture

Pure Node, no `@supabase/supabase-js` (avoids the Expo session-storage shim). All Supabase access via raw `fetch()` against the REST + Auth APIs. Helpers in `lib/supa.js`. AI cost wired through `lib/cost.js` which calls `setCostEstimator` + `setTelemetrySink` from `@auction-platform/domain-lotting` so every `complete()` call gets captured.

Personas live in `personas/`. Each takes a shared `ctx` object that operator-setup populates. `assert.step()` wraps each individual check; failures don't abort the run, they accumulate for the report.

## Adding a new persona / step

1. Add a new file under `personas/` exposing `async run({ ctx, noAi })`.
2. Use `step('name', async () => { ... })` for each unit of work.
3. Use `expect(actual).toBe(expected)` (and friends) inside steps.
4. Wrap RPC/REST calls with `time('label', () => supa.supaRpc(...))` so they appear in the latency report.
5. `cost.pushTag('phase.subphase')` before AI calls to slice the cost report by phase.

## Phase 2B — Compliance + Billing RPCs (added 2026-05-17)

Four new personas run after `closer` in the phase-2 pipeline:

### `pricing_tiers`
Verifies `compute_application_fee_cents()` bracket math (migration 0087).
- Founder at $0 MTD + $5k sale → 2.0% = $100 (10000 cents)
- Founder straddle: $300 MTD + $50k sale crosses the $25k bracket boundary; first $24,700 at 2.0%, remaining $25,300 at 1.5% → ~$873.50 (87350 cents ±$1)
- Standard (non-founder) at $0 MTD + $5k sale → 2.5% = $125 (12500 cents)
- Cleans up fake paid invoices and restores `founder_pricing = TRUE`.

### `ai_budget`
Verifies `check_operator_ai_budget()` cap enforcement (migration 0085).
- Confirms default `monthly_ai_budget_cents = 10000` and `ai_billing_markup_bps = 2500`.
- Sets budget to 1 cent → call returns `allowed = false`.
- Restores budget → call returns `allowed = true`, `pct_used = 0`.
- Inserts fake `ai_calls` row at 9000 cents MTD; with 25% markup the billed total ($112.50) exceeds the $100 cap → `allowed = false`.
- Verifies `pct_used` is capped at 100.00 when billed MTD exceeds budget.
- Cleans up fake `ai_calls` row.

### `operator_policies`
Verifies operator T&C versioning + bidder consent (migration 0088).
- Confirms migration 0088 seeded a v1 published policy with `payment_window_hours = 0`, `pickup_window_days = 7`, `shipping_offered = false`.
- Admin inserts and publishes a v2 policy (24h payment grace, 10-day pickup, shipping enabled).
- `get_active_operator_policy()` returns v2 after publish.
- New test bidder is created and signs in.
- Before consent: `operator_policy_acceptances` has 0 rows.
- `record_operator_consent(op, 2)` returns a UUID.
- After consent: acceptance row exists with `version = 2` and `accepted_at` set.
- Test bidder places a bid (verifies auth layer doesn't reject post-consent).
- Test bidder cleaned up at end of run.

### `account_deleter`
Validates the Apple Guideline 5.1.1(v) deletion RPC (migration 0089). Runs **last** because it permanently tombstones bidder C.
- Calls `delete_my_account()` via bidder C's JWT.
- RPC returns `{ ok: true, deleted_at, anonymized_email: 'deleted-<uuid>@deleted.local' }`.
- `bidders` row: email anonymized, `display_name = 'Deleted Bidder'`, `deleted_at` set, PII columns nulled.
- Sign-in with original credentials fails (account tombstoned).
- `auth.identities` cleared (0 rows via Admin API).
- Bid history in `bids` is **retained** (7-year tax retention).
- Invoices are **retained** (settled status preserved).
- Original email freed: a fresh `adminCreateUser` with the original email succeeds.
- `cleanup.js` skips the `bidders` row DELETE for tombstoned IDs (bids/invoices FK integrity), but still calls `adminDeleteUser` on the auth row.

## Phase 2C (not yet built)

Full settlement: Stripe Connect charge, payout, 1099-K ledger reconciliation. Requires a live Stripe test-mode account wired to the SIM operator.
