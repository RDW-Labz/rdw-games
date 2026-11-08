# stress-sim — 500 bidders × 500 lots daily-close load simulation

Drives the REAL database engine — `place_bid`, `open_due_lots`,
`finalize_due_lots`, `drain_build_invoice_jobs`, `advance_auction_lifecycle`,
the exact SQL functions pg_cron runs in prod — against a fully-migrated
local Postgres, at ~10× time compression: a real BinGo day staggers 500 lots
over a ~2 h close window (14.4 s/lot); the sim staggers them 1.5 s apart
(~12.5 min), so every rate the engine sees is ~10× the real daily rate.
Clean survival = ≥10× headroom on the real day.

**Never run against prod or any Supabase instance.** It builds its own
throwaway local DB.

## Run

```bash
# 1. Local Postgres 16 + pgvector (apt: postgresql-16 postgresql-16-pgvector)
sudo -u postgres createdb stress_sim
PGPASSWORD=postgres psql -h localhost -U postgres -d stress_sim -f scripts/stress-sim/shim.sql
for f in packages/db/migrations/*.sql; do
  PGPASSWORD=postgres psql -h localhost -U postgres -d stress_sim -v ON_ERROR_STOP=1 -q -f "$f" || break
done

# 2. Run (needs `npm i pg` somewhere on NODE_PATH or run from a dir with pg installed)
node scripts/stress-sim/run.mjs   # ~18 min, writes report.json next to itself
```

## What it does

- `shim.sql` — the CI Supabase-stub (roles, auth/storage/cron schemas) with one
  difference: `auth.uid()` reads the `app.sim_uid` session GUC so the driver
  can impersonate each bidder through the full production gate stack in
  `place_bid` (payment method, unpaid fees, suspension, increments, proxy
  duel, soft close).
- `run.mjs` — seeds 1 operator (15% premium, 9.5% AR tax) + 1 auction +
  500 lots (close_at staggered exactly like `redistribute_close_times`) +
  500 bidders with cards on file. Then, concurrently:
  - **daytime proxy bids**: ~8/lot exponential, random bidders/maxes;
  - **snipe duels** on ~30% of lots: two bidders alternate raises inside the
    soft-close window, riding the anti-snipe extensions live;
  - **cron emulation** on real cadences (open/finalize 5 s, invoice drain
    30 s, lifecycle 60 s), timing every tick and sampling finalize backlog;
  - a **mock auto-charge worker** (90% paid / 10% declined) so terminal
    invoice states populate.
- Verifies: every lot terminal; winner = highest max; invoice math
  (subtotal/premium/tax) recomputed independently; one invoice per winning
  bidder; queue drained. Reports place_bid latency percentiles, tick
  durations, soft-close cascade size, close-tail, row/DB growth.

First run's findings: `docs/state/STRESS-SIM-2026-07-04.md`.
