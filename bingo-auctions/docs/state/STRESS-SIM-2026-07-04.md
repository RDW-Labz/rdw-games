# Stress simulation — 500 bidders × 500 lots ending daily (2026-07-04)

**Question:** what does the platform look like at BinGo's target daily scale —
500 registered bidders and a 500-lot auction closing every day?

**Method:** `scripts/stress-sim/` ran the REAL engine — `place_bid`,
`open_due_lots`, `finalize_due_lots`, `drain_build_invoice_jobs`,
`advance_auction_lifecycle`, the exact SQL pg_cron runs in prod — on a
fully-migrated local Postgres 16 (all 214+ migrations + the CI Supabase shim).
500 carded bidders placed 5,545 bid RPCs (daytime proxy bids + 165 live snipe
duels riding soft-close extensions) against 500 lots staggered 1.5 s apart —
**~10× time compression** of a real 2-hour close window, so every rate below is
~10× what a real day produces. A mock auto-charge worker applied a 90/10
paid/declined mix.

## Verdict: PASS with ~10× headroom. Zero correctness failures.

| Check | Result |
|---|---|
| Lots reaching a terminal state | **500/500** (500 won, 0 unsold, 0 stuck) |
| Winner = highest max bid (recomputed independently) | **0 wrong winners** |
| Invoice math (subtotal + 15% premium + 9.5% tax, recomputed) | **0 mismatches** across 316 invoices |
| Invoice coverage | 316 invoices = exactly 1 per winning bidder; 500 invoice_lots = every won lot exactly once |
| Queues after the day | build_invoice_jobs 0 · auto_charge_jobs 0 (all drained) |
| Engine errors | **0** |

## Performance (remember: this is 10× real load)

| Metric | Value | Read |
|---|---|---|
| `place_bid` latency | p50 4.0 ms · p95 6.8 ms · p99 16.7 ms · max 461 ms | DB-side cost is negligible; prod latency will be network/pooler-dominated. The 461 ms max was a single early call (cold plan caches). |
| `finalize_due_lots` tick (every 5 s, batch 50) | p50 4.1 ms · p95 6.9 ms · max 26 ms | Batch capacity is 50 lots/5 s = 10 lots/s; the day never queued more than **8** due lots (peak snipe pileup). Real-day backlog ≈ 1. |
| Close→finalized lag | median 2.5 s · max 5.0 s | Bidders see "won" within one cron tick of close. |
| Soft-close cascade | **1,154 extensions** from 165 snipe duels | The anti-snipe engine absorbed overlapping duels on adjacent lots without pushing the day: the last lot finalized only **48 s** after the nominal final close. |
| Invoice build | 316 invoices built ~30 s (debounce) after each bidder's last win; drain tick p50 0.3 ms, max 103 ms | |
| `advance_auction_lifecycle` (60 s) | p50 2.8 ms | |

## What one day generates (row growth, synthetic prices)

| Table | Rows/day | Notes |
|---|---|---|
| bids | 3,891 (2,751 human + 1,140 proxy auto-bids) | ~120 k/month |
| lot_status_history | 1,500 | 3 transitions/lot |
| invoices + invoice_status_history | 316 + 632 | |
| invoice_lots | 500 | |
| operator_bidder_relations | 494 (first-day churn; steady-state ≈ new bidders only) | |
| **DB size after the day** | **20 MB** (incl. full schema) | months of daily 500-lot auctions fit comfortably in the smallest Supabase tier |

Money flow at the synthetic price mix (avg hammer $185/lot — illustrative
only): hammer $92,560 + premium $13,884 + tax $10,112 = **$116,556 gross**,
295 invoices auto-charged clean, 21 (10%) landing in `payment_failed_grace` —
i.e. at a realistic decline rate expect **~20–30 grace invoices/day** to chase
(the per-operator unpaid-invoice bid-block then gates those bidders
automatically, which the sim exercised).

Half the blind proxy bids (2,785) were rejected `below_min_increment` — the
generator draws maxes independent of the current price, so this is the gate
working, not an error; each rejection still exercised the full auth/lock path.

## Caveats — what this did NOT test

1. **HTTP layer**: prod bids go browser/app → Cloudflare Worker/PostgREST →
   pooler → this SQL. The DB engine has ~10× headroom; the pooler/Worker layer
   is the next thing to watch at scale (500 concurrent *connected* clients,
   realtime subscriptions).
2. **Square**: auto-charge outcomes were mocked (the idempotency-key class of
   failure is already covered by the 45-char guard from PR #19).
3. **Push/notification fan-out** (outbid pushes at snipe time) happens in the
   Worker, not the DB — untested here.
4. Soft-close was compressed only 2× (1 min vs prod 2 min) while everything
   else compressed ~10× — i.e. extensions overlapped *more* aggressively than
   a real day. Conservative in the right direction.

## Repro

See `scripts/stress-sim/README.md`. Report JSON from this run is embedded in
the PR (#36) description trail; the harness re-runs in ~18 min on a laptop.
