# BinGo Member + Ads Features — Scope Index (Nov 2026)

Decided by Braden on 2026-11-04. These scopes say **how each feature must work**.
Each scope has a **Confirm first** list. Check it against the real code before building.
If the code contradicts a scope, stop that part and report it. Don't guess.

## Scopes

| # | Scope | Money? | Lane |
|---|-------|--------|------|
| 01 | [Memberships foundation (Bidder Pass + Pro perks, admin)](01-memberships-foundation.md) | Yes | A |
| 02 | [$2.99 handling fee](02-handling-fee.md) | Yes | A |
| 03 | [Ads platform (business ads, boost, admin Ads page)](03-ads-platform.md) | Yes (billing parts) | B |
| 04 | [Balance: prepaid wallet + store credit](04-balance-wallet-store-credit.md) | Yes | A |
| 05 | [Sneak peek (members browse inventory)](05-sneak-peek.md) | No | B |
| 06 | [Price index (Pro)](06-price-index-pro.md) | No | B |
| 07 | [Sniper protection (Pro)](07-sniper-protection-pro.md) | No, but touches bidding | A (last) |
| 08 | [Bidder Pass 7-day trial](08-bidder-pass-trial.md) | Yes | A |
| 09 | [Swipe feed: offers, ads, sneak peek, price check](09-swipe-feed.md) | No | B (last) |
| 10 | [Admin hub: all new-feature data in one place](10-admin-hub.md) | No | Shared (each scope builds its page; B builds the shell) |

## Perks by plan

| Perk | Free | Bidder Pass ($9.99/mo, $99/yr) | Member Pro ($100/mo) |
|------|------|------|------|
| No $2.99 handling fee | – | ✓ | ✓ |
| No ads anywhere | – | ✓ | ✓ |
| Sneak peek + watch alerts | – | ✓ | ✓ |
| Price index (history, prediction, trend, retail, enrich) | – | – | ✓ |
| Sniper protection | – | – | ✓ |

Pro includes everything in Bidder Pass. Member Pro has a member cap (default 30) and a waitlist: the next person in line gets a 48-hour hold on any open spot.
Every price, timer and spacing number is set in admin, never hard-coded. All new-feature data shows up under the admin **Growth** section (scope 10).

## Build order (two lanes, no overlap)

**Lane A — Orchestrator (money lane):** 01 → 02 → 04 → 08 → 07
**Lane B — Orchestrator (code lane):** 06 data job + 03 admin/business side (no customer display yet) → *(after 01 merges)* 10 Growth shell + Revenue page → 03 customer display + 05 → 06 UI → 03 billing + boost (boost cancel credit needs 04) → 09

All code for both lanes goes through the orchestrator; Grok plans and reviews only. The lanes must not edit the same files.

Every scope ships its own Growth admin page (scope 10 pattern) in the same PR as the feature.

- One PR per scope phase. No stacked PRs. Rebase on master before merge.
- Both lanes add migrations. Claim the next migration number in `docs/state/migration-numbers.md` before writing one, so numbers never collide. The cleanup-phase migration freeze is lifted **only for these scopes** and **only for additive migrations** (new tables or columns, no changes to existing data). Each reserved number still needs **Braden's yes per PR** before it is written or applied; reserved numbers alone are not approval.
- Money parts (01 billing, 02, 03 billing/boost, 04, 08) ship to prod **only on Braden's go**.
- 07 stays flag-off in prod until Braden says go. Today's soft close for everyone is unchanged; 07 adds Pro extras on top.

## Rules for every scope (BinGo standing rules)

- No change may break existing functionality. Every feature sits behind a flag, **off by default**.
- Square **sandbox only** for tests. Never the live account. Never add fake cards to test accounts.
- No raw SQL against prod. Migrations follow the existing pending-migrations process. Locking migrations only 05:00–07:00 Central.
- One prod change at a time, each confirmed before the next.
- Every change: full tests → deploy → run `post-deploy-check.yml`. If it fails, **roll back first**, investigate second. A rollback must be ready before every ship.
- Deploy windows (Central): console/website 09:00–16:00. Staff app after 18:00 (TEST-channel OTAs anytime). **No customer-app or bidding changes 18:00–22:00** (auctions close and cards charge then).
- Merge only when ALL checks are green, including CI/test and E2E.
- No customer names, emails or card data in code, commits, PRs or logs.
- Android customers stay on the 0.1.1 rescue line. Never roll Android back to its built-in version.
- Sensitive staff actions on the shared login need manager PIN + typed staff name + reason.
- Don't touch tax rates (Springdale stays on the fallback).
- **Revenue tagging:** every charge gets a `revenue_source` (`handling_fee`, `bidder_pass`, `member_pro`, `ad_subscription`, `ad_boost`). Wallet loads are **not** revenue (they're money we hold). This feeds one Revenue page: revenue per feature per month vs BinGo's existing average.
- Handoff notes go in `docs/state/`.

## Open questions (defaults let work continue)

1. Bidder Pass card fails → perks stop right away? **Default: yes** (same as ads).
2. Member price changes → everyone at next billing + 30-day notice? **Default: yes** (same as ads).
3. Unused wallet/credit balances: ask the accountant about Arkansas unclaimed-property rules. Doesn't block the build.
4. Sneak peek: also show Unsold / Refunded–relist items waiting to go back up? **Default: no** (admin toggle).
5. Enrich lookup provider and cost per lookup. **Default: cheapest reliable UPC/product lookup, daily cap in admin.**
6. Truck/vendor names (Wayfair, Lowe's, etc.) stay hidden from customers unless Jared OKs it. Some supplier deals don't allow naming the retailer.
