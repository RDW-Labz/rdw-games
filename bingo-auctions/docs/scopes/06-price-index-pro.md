# 06 — Price Index (Pro)

**Lane:** B · **Money:** no (enrich lookups cost a little; capped) · **Needs:** 01 (`price_index` perk) for the UI only. The data job can start right away.

## Goal
Pro members see what similar items sold for at BinGo, a predicted closing range, a price trend and retail price.

## Data
- Source: **closed, sold lots**: final price, title, category, MSRP, condition, close date, location, UPC (if stored).
- Leave out unsold, refunded, canceled, test lots and ads (scope 03).
- **Never expose who bought anything.** Totals and individual sale prices only, no buyer info.
- Precompute nightly plus on each lot close, so reads are instant.

## "Similar" items
- Many lots lack category/MSRP (admin Inventory has "No MSRP" / "No category" filters), so **title similarity carries most of the weight**.
- Match order:
  1. Same UPC (best).
  2. Title similarity (Postgres trigram or similar) + same category when present + MSRP within ±30% when present.
- Weight recent sales higher.

## What Pro sees
1. **Sold history:** date, final price, % of MSRP. Last N similar sales.
2. **Predicted price:** range (25th–75th percentile) + median. **Only with 3+ similar sales.** Otherwise: "Not enough data yet."
3. **Trend:** median change over 30 and 90 days, up or down.
4. **Retail price:** MSRP from the lot, or from Enrich.
- Label: "Estimates based on past BinGo sales. Not a guarantee."

## Enrich button
- On tap: online lookup for retail price and specs. Use UPC when present, else title.
- **Cache** results per UPC/title so we never pay twice. Daily spend cap in admin. When the cap is hit: "Try again tomorrow."
- Send only product info (UPC/title). Never customer data.
- Provider: cheapest reliable product/UPC lookup. Its key lives in secrets, never in code.

## Where
- **"Price check" button on every lot page.** Pro opens it. Others see a lock + "Pro" upsell.
- **Pro dashboard:** search any item and see history, prediction and trend.
- Swipe feed button (scope 09).

## Admin
On/off, min similar sales (3), enrich daily cap, provider on/off, lookup usage and cost.

## Confirm first
- What's stored on closed lots, how far back it goes and roughly how many sold lots exist.
- Whether UPC is stored on lots (inventory search accepts UPC, so probably yes).
- Category quality and whether categories are a fixed list.

## Done when
- Non-Pro gets nothing from the price API (tested).
- With fewer than 3 comps it says "Not enough data yet" (tested).
- No buyer info in any response (tested).
- Price check opens in under 1 second from precomputed data.
- Enrich respects the cache and the daily cap.

## Ship
Data job + admin first (09:00–16:00). Customer UI after 01, never 18:00–22:00. Rollback = flag off.
