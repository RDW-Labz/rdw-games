# Research dossier — Phase 1

Market snapshot dated **2026-10-15**. Sources were read that day. "Verified" means
the page itself was fetched. "Search snippet" means the page refused the fetch (HTTP
403) and the number comes from the search engine's quote of that page. Snippet
numbers need a human to re-check before they go into a customer-facing price.

## A. External mechanisms (stated as "X pays $Y for Z because W")

| # | Operator | Rule | Source | How checked |
|---|---|---|---|---|
| E1 | Nellis Auction (NV/AZ liquidation, same model as BinGo) | Buyer pays a **15%** buyer's premium. Buyer pays **5% of hammer** to cancel a won item, or as a relist fee if it is not paid and picked up in 7 days. Buyer pays **$1 per item** restocking if they miss a pickup appointment after the item was pulled. Why: staff already prepped the item. | https://nellisauction.com/terms | Verified |
| E2 | BidFTA (OH/KY/IN/TN liquidation) | Buyer pays a **17.25%** premium plus a **$1 per-lot freight fee** ($0.25 if the item is under $5). Missed pickup: buyer pays a **reinstatement fee equal to the premium, min $10, max $100**. Why: covers freight and re-handling. | https://www.bidfta.com/terms | Search snippet (403) |
| E3 | BidFTA+ | Buyer pays **$2.99/month** for early pickup hours (10:00–noon), members-only auctions, custom alerts, early bin-store entry. Why: skip the line and see better stock. | https://www.bidfta.com/bidfta-plus | Search snippet (403) |
| E4 | MAC.BID (Pittsburgh liquidation) — fees | Buyer pays a **15%** premium plus a **$3 lot fee** per item. Pickup window 3 business days. To keep an item 5 more business days, buyer pays **$5 per item, or $25 per big-box item**. To move it to a closer site, **$5 per item**. Why: they can't get there in time. | https://help.mac.bid/content/what-if-i-cannot-pick-up-an-item ; search snippet for the $3 fee and 15% | Hold/transfer verified; $3/15% snippet |
| E5 | MAC.BID memberships | Buyer pays **$9.99/mo or $99.99/yr** (Standard: early entry, 5 free holds/transfers a month) or **$29.99/mo or $299.99/yr** (Premium: unlimited holds, 20 transfers, 1 return/month). Free users pay $10 per hold. Why: frequent buyers buy their way out of per-item hold fees. | https://www.mac.bid/memberships | Verified |
| E6 | OLA / Online Liquidation Auction | Buyer pays a **15%** premium plus a **$2.00 item fee** on every item. | https://www.olabid.com/terms-and-conditions/ | Search snippet |
| E7 | BidRL | Buyer pays a **13%** premium. | https://www.bidrl.com/terms.html | Search snippet |
| E8 | B-Stock (pallet marketplace, Amazon/Home Depot etc.) | Reseller pays a **10%** premium on whole pallets/truckloads and arranges freight themselves. Why: buys in bulk at wholesale. | https://bstalker.com/guides/amazon-liquidation-auctions | Search snippet |
| E9 | Home Depot liquidation pallets | Reseller pays **$75–150 freight per pallet** on top of the bid. | https://closo.co/blogs/inventory-liquidation/home-depot-liquidation-auctions | Search snippet |
| E10 | Liquidation.com | Buyer pays a **5–10%** premium that rises with bid value. | https://www.liquidation.com/c/buyer/index.html | Search snippet |
| E11 | Quicklotz (TX/NC wholesale) | Resellers pay **$9,995–$21,000 per truckload** of returns/overstock. | https://www.quicklotz.com/ | Verified |
| E12 | Consignment auctions (industry) | Outside sellers pay the auction house **20–30% of hammer** (sliding 35% under $500 down to 15% over $5,000). | https://closo.co/blogs/inventory-liquidation/consignment-auction ; https://gavelist.com/glossary/sellers-commission | Search snippet |
| E13 | eBay promoted listings / Bring a Trailer | Sellers pay **2–100% ad rate** (eBay) or **$99/$349 per listing** (BaT) for visibility. Only works where outside sellers exist. | https://www.shopify.com/blog/how-much-does-ebay-take-from-a-sale | Search snippet |
| E14 | HiBid / AuctionFlex (auction SaaS) | Operators pay **$95/month + $0.25 per online bid (capped per auction) + 0.4% of proceeds**. | `docs/competitive-pricing-analysis.md` (2026-05-17, cites auctionflex.com) | Prior research in repo |

**The pattern.** Every warehouse liquidator in the BinGo mould (Nellis, BidFTA,
MAC.BID, OLA) charges 13–17.25% premium, the same range as BinGo's 15%. They earn
the rest from **small per-item fees on buyer behaviour BinGo already sees**:
a per-lot handling fee ($0.25–$3), paid holds past the pickup window ($5/item),
reinstatement after a missed pickup ($10–$100), and memberships that bundle
those holds ($2.99–$29.99/month). Promoted listings (E13) and consignment (E12)
need outside sellers, and BinGo has none today.

## B. Internal demand signals (BinGo's own data)

| # | Signal | Number | Source |
|---|---|---|---|
| S1 | A small reseller group drives half the business | 31 buyers with 60+ invoices in 84 days = 10,262 lines, $97,990 hammer (≈50%). Each made ~25 pickup trips (785 total) | queries/b5.json, b6.json |
| S2 | Those heavy buyers pick up slower | Paid→pickup p50 **2.65 days** for heavy buyers vs 1.84 for everyone else; p90 5.6 vs 4.8 | queries/b6.json |
| S3 | Many buyers need more than 3 days, a few more than 7 | 2,663 of 8,497 pickups (31%) after day 3; 27 after day 7 | queries/b4.json `pickup_lag` |
| S4 | No-shows are frequent and BinGo earns nothing extra on them | 823 lines / $4,215 hammer forfeited in 84 days; light buyers forfeit **8.3%** of lines vs 3.2–3.5% for regulars; 1,335 no-show actions logged | queries/b4.json, b5.json, b6.json |
| S5 | The fees BinGo already charges barely collect | $5 relot fee: 102 assessed, only 31 paid (30%). The $5 restock fee is published but never charged | queries/b1.json; baseline.md |
| S6 | Unsold stock is large | 3,858 zero-bid lots (15.9%) and 3,923 relists in 84 days | queries/b2.json |
| S7 | Alerts are wanted but the tool is unused | 656 bidders keep 26,126 watchlist rows; only 21 bidders use saved searches | queries/b4.json |
| S8 | Refunds are the biggest money leak, cause unclear | 12.1% of lines refunded = 18.3% of invoice dollars; 98.5% are before pickup; the reason is mostly a pre-selected default (corrected 2026-10-15) | queries/b2.json, b7.json, r1.json |
| S9 | Customer Feedback is close to empty | 4 non-staff Feedback rows ever, so the daily summary email is not a demand source | queries/b4.json |

## C. What this means for Phase 2 (inputs, not picks)

- The closest outside match to S1–S4 is **MAC.BID's paid hold + membership**
  (E4/E5) and **Nellis/BidFTA's missed-pickup fees** (E1/E2): BinGo has the
  buyers who would pay, and the rules already sit in `operator_policies`.
- **Per-item handling fee** (E2/E4/E6) is the most common add-on in the market.
  It is a price change for every customer, so it needs Braden + Jared sign-off
  and carries the most complaint risk.
- **Pallet/bulk lots for resellers** (E8/E11) match S1 + S6, but need a new lot
  type and staff time to build pallets.
- **Promoted lots and consignment** (E12/E13) have no payer today: BinGo is the
  only seller on its own site.
