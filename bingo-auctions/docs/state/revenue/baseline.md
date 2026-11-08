# Revenue baseline — BinGo Auctions (Phase 0)

As of 2026-10-15. Operator `bingo-auctions` only (demo operator excluded).
Every number comes from a saved prod query in `queries/` (read-only, aggregates
only, no customer identities) and is recomputed by `node compute_baseline.mjs`
→ `baseline.json`. Window: 11 full weeks, 2026-07-27 to 2026-10-11 (Central),
unless marked 84d (last 84 days to 2026-10-15).

## Fee structure today

| Fee | Value | Charged? | Source |
|---|---|---|---|
| Buyer's premium | 15% on every auction (356/356) | Yes | b1 `auc_bp`, `ops` |
| Sales tax | 9.5% (self-managed) | Yes | b1 `ops.tax_rate_bps` |
| Relot fee (unpaid after 48h grace) | $5 | Yes — 102 assessed ever, $510; only 31 paid ($155) | b1 `fees`, b4 `policy` |
| Restock fee | $5 in published policy v2 | **No.** Shown on the pickup page ("may apply"); no code charges it | b4 `policy`; `apps/operator-web/src/app/profile/pickup/[id]/page.tsx:552` |
| Pro membership | $4.99/mo configured | **No.** `pro_enabled=false`, 0 subscriptions; built for Stripe | b1 `ops`, `subs` |
| Shipping | EasyPost code exists | **No.** `offers_shipping=false` | b1 `ops`, `fulfil` |
| No-show | 7-day pickup window, `full_forfeit` | Forfeit (money kept, item relisted) | b4 `policy` |

## Weekly averages (11 full weeks)

| Metric | Per week |
|---|---|
| Hammer (winning bids) | $16,379 |
| Buyer's premium | $2,457 |
| Sales tax collected | $1,547 |
| Invoice total | $20,383 |
| Square processing fees | $823 |
| **Cash refunds** | **$3,725 (18.3% of invoice totals)** |
| Invoices | 802 |
| Distinct buyers | 182 |

Growth: hammer in the last 4 weeks is +48% over the first 4 weeks.

## Lots and buyers (84d)

| Metric | Value |
|---|---|
| Lots closed / auctions | 24,198 / 253 (252 Harrison, 1 Dodge City) |
| Sell-through | 83.4% |
| Zero-bid lots | 3,858 (15.9%) |
| Avg / median hammer | $9.56 / $5.00 |
| Hammer ÷ MSRP (sold lots) | 4.7% |
| Relisted lots | 3,923 |
| Buyers | 576; 67.7% bought in 2+ separate weeks |
| **31 buyers with 60+ invoices** | **$97,990 hammer ≈ 50% of all 84d hammer** |
| Top 20 buyers' share of hammer | 47.6% |
| Invoice lines refunded | 2,464 of 20,340 (12.1%). 2,428 of them before pickup. A reason is recorded on 99.8%, but it's mostly a pre-selected default (see docs/audits/refunds-before-pickup-2026-10-15.md) |
| Lines forfeited (no-show) | 767 (3.8%); 823 lines / $4,215 hammer forfeited 84d |
| Paid → picked up | p50 1.9 days, p90 4.9 days; 31% after day 3; 27 after day 7 |

Bidder base: 1,350 accounts, 1,005 with a card on file, 1,329 marketing opt-in,
311 push tokens, 756 new in 84d, 157 referred. Watchlist 26,126 rows from 656
bidders; 36 saved searches from 21 bidders.

## What this baseline cannot tell us (gaps)

- **Why refunds happen.** $3.7k/week goes back out. A reason is stored
  (`after_state->>'sub_reason'`; corrected 2026-10-15), but each screen
  pre-selects one, so it isn't reliable. See the refunds audit.
- **Customer demand from Feedback.** Only 4 non-staff Feedback rows exist ever;
  the daily summary email has almost nothing to summarize. Demand signals must
  come from behaviour data instead.
- **Net margin.** Lot cost (`lots.cost_cents`) was not queried; revenue here is
  gross. Staff time per pickup is not measured anywhere.
