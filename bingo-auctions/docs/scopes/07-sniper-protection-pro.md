# 07 — Sniper Protection (Pro)

**Lane:** A (last) · **Money:** no · **Needs:** 01 (`sniper_protection` perk)
**Touches bidding, but does not change today's soft close.** Flag stays off in prod until Braden says go.

## Rule
- **Today's soft close stays exactly as it is, for everyone.** `place_bid` already extends a standard lot's `close_at`
  to `now() + auctions.soft_close_minutes` when a bid lands inside the soft-close window
  (`packages/db/migrations/0453_sqft_place_bid_per_unit.sql` §7). The per-operator default is
  `operators.default_soft_close_minutes` (default 3); auction creation copies it onto the per-auction
  `auctions.soft_close_minutes` override (also default 3), and `place_bid` reads that auction column. There is
  **no** `auctions.default_soft_close_minutes` column — `0084_place_bid_security_guards.sql` records that same
  prior table mix-up. That behavior must not change for a non-Pro bidder, whether the flag is on or off.
- Pro gets **extras on top of the existing soft close**, never a replacement for it:
  - a **pre-close outbid alert** to the Pro member who is outbid inside the closing window; and
  - a **longer personal grace window** for that Pro member's lot after they are outbid. Its mechanics are
    **not settled here** — see the design checkpoint below.
- **Design checkpoint before any implementation:** the approved concept does not fix the grace duration,
  eligibility, whether the timer is per-bidder or per-lot, or how the shared `lots.close_at` cutoff and the
  finalizer handle a personal deadline. The **#788 design note must decide all of these first**, and the scope
  must be updated with that decision before code. Until then, `place_bid` and the finalizer keep one shared
  `lots.close_at` per lot and no Pro grace is implemented.
- The old "last 2 minutes / +2 minutes / 6-minute cap" rule is **superseded and must not be implemented**.
  There is no separate extension window, extension length or cap; the existing `soft_close_minutes` plus the
  Pro grace setting are the only numbers, and both are editable in admin.
- If the Pro member's max/proxy bid still covers the new bid, they were not outbid, so no Pro extra applies
  (the ordinary soft close still does).

## Build
1. Pro extras run **inside the same server-side transaction as bid placement**, after the existing soft-close
  calculation, using server time. Never trust the client clock. The base soft-close result is carried through unchanged.
2. The pre-close outbid alert goes to the Pro member right away: push + text, with a lot link. The ordinary
  outbid notification path is reused; do not add a second alert for non-Pro bidders.
3. The longer personal grace window is implemented **only after the #788 design note resolves the mechanics
  above**. When built, it applies only to the outbid Pro member's calculation of the lot's close time.
  It never applies to another bidder's lot and never bypasses the ordinary soft close.
4. The auction close job, invoices and closing-night card charges must still wait for every lot whose
  `close_at` moved. Nothing gets invoiced while a lot is still open.
5. Auction terms page: describe the existing soft close, plus the Pro pre-close alert and longer personal grace
  window when the flag is on.
6. Log every Pro extra (lot, bidder, time, old end, new end) for disputes.

## Confirm first
- Read the existing soft close in `place_bid` (`0453` §7 and the latest `0216`/`0263` revisions) and confirm
  `auctions.soft_close_minutes` is already live. **Do not add a second extension rule on top of it.**
- Where bids are placed (RPC/edge function/server), max/proxy bids, how end time is stored and enforced.
- Staggered closing logic, the close job, and realtime timer updates.
- Outbid alert path and the SMS provider.

## Done when
- Tests:
  - **Permanent regression:** with the flag either on or off, an eligible non-Pro bid retains the existing
  soft-close behavior (`close_at` = `now + soft_close_minutes`, bounded by the existing rule).
  - Flag-off Pro behavior matches the baseline exactly.
  - An auction configured for 2 minutes keeps 2-minute behavior when the operator default is 3, and no query or
    document references a nonexistent `auctions.default_soft_close_minutes` column.
  - After the #788 decision: Pro and non-Pro bids, timers, concurrent cutoff, and finalization between the
    baseline and grace deadlines are covered; flag-off is identical to today.
  - Pro outbid inside the closing window gets the pre-close alert and the longer personal grace window.
  - Non-Pro outbid gets only today's soft close, with no Pro alert and no grace.
  - Pro max bid covers → no Pro extra (ordinary soft close still applies).
  - Two bids at the same instant → one consistent end time.
  - The close job waits for every lot whose close time moved.
- Sandbox load test: many last-minute bids across many lots, no errors, no lot closes early or late.
- Flag off = bidding identical to today.

## Ship
Deploy outside 18:00–22:00, ideally a morning with no auction closing that day. Flag on only on Braden's go. Watch the first closing night live. Rollback = flag off.
