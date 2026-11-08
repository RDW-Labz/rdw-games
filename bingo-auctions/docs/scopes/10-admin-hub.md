# 10 — Admin Hub: All New-Feature Data in One Place

**Lane:** shared. Each scope builds its own admin page to this standard. Lane B builds the hub shell and the Revenue page after 01 merges.
**Money:** no · **Needs:** 01 (revenue tagging)

## Goal
Every new feature's data stays organized and visible in the admin dashboard. Nothing gets tracked only in the database or logs.

## Layout
Add one **"Growth"** section to the admin sidebar with these pages:

| Page | From scope | Shows |
|---|---|---|
| **Overview** | all | Top numbers this month vs last month: total new-feature revenue, members by plan, active ads, wallet/credit held, trials started → converted |
| **Revenue** | 01 | Revenue per source (`handling_fee`, `bidder_pass`, `member_pro`, `ad_subscription`, `ad_boost`) per day/week/month, vs BinGo's existing average revenue. Waived fees shown separately |
| **Memberships** | 01, 08 | Plans and prices, perk map, members list, status counts, cancels, Pro cap + waitlist, trial settings and funnel (offered → started → converted → canceled), price-change notices |
| **Ads** | 03 | Businesses, ads, approval queue, tiers/prices, placement, boost calendar + line, stats (impressions, unique viewers, taps, tap rate), revenue per business/tier, failed cards, disputes, ad credit |
| **Balances** | 04 | Total held (cash + credit), per-customer balances, loads, credits issued (+bonus), spending, cash-out queue, adjustments |
| **Sneak Peek** | 05 | Items visible now, members using it, most-watched items, alerts sent, watched items that sold and for how much |
| **Price Index** | 06 | Price checks per day, top searched items, enrich lookups used vs daily cap and their cost, settings |
| **Sniper Protection** | 07 | Pro extras per night (pre-close outbid alerts, longer personal grace windows), lots affected, average extra time, full Pro-extra log |
| **Swipe Feed** | 09 | Offer card views → taps → signups; feed ad impressions/taps; spacing settings |
| **Change Log** | all | One searchable list of every admin change across all pages: who, what, before → after, when, why |

## Every page follows the same pattern
1. **Top row:** 3–5 key numbers with the change vs last period.
2. **Main table:** search, filters (date range, status, plan/tier), sort, pagination.
3. **CSV export** of what's on screen.
4. **Settings panel** for that feature (all prices, timers and spacing live here, nothing hard-coded).
5. **Change log** filtered to that feature.
- Same look as the existing admin pages (reuse their components).
- Fast on large data: summaries are precomputed, nothing scans whole tables on page load.

## Rules
- **Real numbers only.** No multipliers or adjusted stats anywhere.
- Customer info shown only where admin already shows it today. No new places with customer names, emails or card data.
- Admin roles: only admin accounts see Growth pages. Actions that move money (refunds, credits, price changes) follow the shared-login rule and get logged.
- Times shown in Central time.

## Confirm first
- Existing admin dashboard layout, sidebar, roles and shared components (tables, filters, CSV export).
- Existing revenue reports, to get the "current average revenue" baseline.

## Done when
- Every page above exists, uses the pattern, and its numbers match the source tables exactly (tested on sandbox data).
- Overview loads in under 2 seconds.
- Every settings change appears in both the page's log and the main Change Log.

## Ship
Admin only, 09:00–16:00. Each page ships with its feature behind the same flag. Rollback = flag off.
