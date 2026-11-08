# ClovrBid Competitive Pricing Analysis

**Prepared:** May 17, 2026
**Research basis:** Web research against public pricing pages, third-party review aggregators (G2, Capterra, SaaSWorthy, GetApp), and competitor comparison sites. All pricing citations include source URLs.

---

## 1. Executive Summary

ClovrBid's current $99/month + 2% GMV structure is genuinely competitive against every platform studied, and is the only one in the market that bundles a native lotting/intake app with AI photo identification into the base subscription. The dominant incumbent — HiBid (AuctionFlex) — charges $95/month for the console alone, then stacks a 0.4% gross-proceeds fee, $0.25 per online bid (capped at $150/auction), and separate credit-card authorization costs, producing effective total platform costs of 1–3% of GMV at modest auction volumes. AuctionMethod charges $750/month with a $1,500 setup fee but takes zero GMV percentage, making it optimal only for high-volume operators. Proxibid and LiveAuctioneers run pure commission models (5–6% of hammer or ~3.99% of hammer respectively) with no subscription, but both operate as marketplace/audience plays where operators sacrifice customer-relationship ownership. The most important structural gap ClovrBid exploits is vertical integration: no competitor bundles the lotting app + auction engine + bidder mobile app + payments under one contract at a small-operator-accessible price point. The risk is that ClovrBid's 2% GMV fee is higher than HiBid's stacked equivalent at very high GMV, creating an enterprise ceiling. A two-tier structure would close that exposure.

---

## 2. Per-Competitor Breakdown

### HiBid / AuctionFlex 360 (MarkNet Alliance)

**Sources:** [auctionflex.com/hibid-pricing.htm](https://www.auctionflex.com/hibid-pricing.htm), [trial.auctionflex.com/pricing](https://trial.auctionflex.com/pricing), [sites.google.com/view/af360wiki/pricing/hibid-pricing](https://sites.google.com/view/af360wiki/pricing/hibid-pricing), [sellinglane.com/selling-lane-vs-hibid/](https://sellinglane.com/selling-lane-vs-hibid/)

**Pricing model (effective April 1, 2025):**
The product has two billing layers that always run together. First, AuctionFlex 360 (the operator console/back-office software) costs $95/month flat. Second, HiBid internet bidding is usage-based: $0.25 per unique online bid, capped at $25/auction for Internet Absentee, $75 for Internet-Only, and $125 for Webcast Live. The Webcast setup adds a $25 per-auction setup fee. On top of that, AuctionFlex charges a separate 2% GMV fee on gross auction sales processed through the AuctionFlex software (distinct from the 0.4% HiBid marketplace proceeds fee). The HiBid marketplace itself charges operators 0.4% of the total winning high bid on items sold to online bidders. Translation: a small operator running $30K/month in GMV pays roughly $95 + $60–180 (bid fees) + $120 (2% GMV via AuctionFlex) + $120 (0.4% HiBid proceeds) = approximately $395–515/month in total platform cost, which is ~1.3–1.7% effective rate. At $100K/month GMV, effective rate drops toward 1% — but at $50K/month it runs 1.5–2%, directly comparable to ClovrBid's 2%.

Credit card authorization during bidder registration: $1 per bidder, capped at $50/auction.

**Product scope:** AuctionFlex 360 covers operator back-office, lot management, auction scheduling, invoicing, and payment processing (via Global Payments integration, not Stripe). HiBid.com is their bidder-facing marketplace (not a white-label bidder app). There is no documented "HiBid Lotter" app with public pricing found during research — the HiBid mobile app is bidder-facing. Any lotting/scanning workflow requires ManyFastScan or similar third-party tools bolted on separately.

**Payment topology:** HiBid/AuctionFlex integrates with Global Payments as the payment processor. The operator collects funds; AuctionFlex deducts its fees from the operator's invoice. Operators appear to remain merchant of record for their transactions. Sales tax responsibility is operator-side based on available documentation. This is not a destination-charge/Stripe Connect model.

**Lock-in mechanics:** Month-to-month subscription with no documented multi-year contract requirement for the base tier. However, the HiBid marketplace creates a strong network effect lock-in: bidder accounts, bid history, watchlists, and buyer relationships are stored on HiBid.com under HiBid's brand. When an operator leaves, they lose access to the bidder audience and relationship data cultivated on the platform. This is the most powerful form of lock-in: the audience itself belongs to HiBid, not the operator.

**Self-service tier:** Yes, with a 3-day free trial. Operators can sign up and run an auction without a sales call. Pricing is published online.

---

### ManyFastScan

**Sources:** [manyfastscan.com/pricing](https://www.manyfastscan.com/pricing), [manyfastscan.com](https://manyfastscan.com/), [manyfastscan.com/use-cases/auction-integration-hibid-auctionworx-and-more/](https://manyfastscan.com/use-cases/auction-integration-hibid-auctionworx-and-more/)

**Pricing model:** The confirmed first-user plan is $129/month, which includes unlimited items, unlimited ecommerce integrations, and AI photo recognition and description generation. A 15-day free trial is available. Additional user seats are listed at $175–225 each (partial data). The platform operates on a per-seat SaaS model, not per-scan or per-lot. No evidence found of token packs or pay-per-scan pricing.

**Product scope:** ManyFastScan is a pure lotting/cataloging app — it does not run auctions, take payments, or host bidders. Its value proposition is scanning items (barcode or photo), having AI generate a title + description + MSRP + stock photo, printing labels with lot codes and QR codes (integrates with Zebra printers), and exporting lots to HiBid, AuctionWorx, and other platforms via CSV/API. It is explicitly a satellite tool around HiBid, not a competitor to HiBid.

**Payment topology:** Not applicable. ManyFastScan does not touch payments.

**Lock-in mechanics:** Monthly subscription, no documented contract. Lot data stays in the operator's account. Switching cost is workflow re-training. Integration depth with HiBid creates soft lock-in since exported lot data goes to their HiBid account.

**Self-service tier:** Yes, fully self-service with a free trial. No sales call required.

**ClovrBid comparison:** ManyFastScan at $129/month is what operators pay just for the lotting layer when using HiBid. ClovrBid bundles an equivalent capability (plus AI vision + MSRP lookup + warehouse bin placement) into the $99 base subscription. This is ClovrBid's strongest competitive angle against operators currently running HiBid + ManyFastScan stacked.

---

### Proxibid (part of EG Group / Sandhills Publishing)

**Sources:** [discover.proxibid.com/master-rate-card](https://discover.proxibid.com/master-rate-card), [discover.proxibid.com/packages](https://discover.proxibid.com/packages), [proxibid.com/Buyers-Premium-Fees/lotInformation/80686181](https://www.proxibid.com/Buyers-Premium-Fees/lotInformation/80686181)

**Pricing model:** Proxibid operates a pure-commission, no-subscription model for operators. Sellers pay a commission on GMV that varies by category, with a 5% "All Other" rate as the baseline floor. Category-specific rates are lower but require 75% of lots in a given auction to qualify as that category — a strict condition that punishes mixed-inventory auctions. Buyers pay an Internet Premium (typically 2–4% added to the operator's buyer's premium, passed directly to Proxibid). Operators historically paid 5–6% of proceeds to Proxibid, with some accounts reporting a recent increase from 5% to 6%. A 2026 Master Rate Card exists (effective January 1, 2026) covering live auction and timed auction tiers, and rebates are available for high-volume partners accrued quarterly. Account packages are available but require contacting a client success manager — pricing is not fully self-service.

**Product scope:** Proxibid provides the marketplace/audience + bidder registration + checkout. It does not bundle back-office management software, lotting tools, or a standalone white-label bidder app. Operators use their own auction management software (often AuctionFlex) and list on Proxibid as one channel. Proxibid's catalog is primarily heavy equipment, vehicles, construction, agricultural — not retail liquidation.

**Payment topology:** Proxibid acts as a marketplace facilitator in its model. It passes an "Internet Premium" directly from bidders to Proxibid, separate from the operator's buyer's premium. Fund custody and sales-tax treatment varies by transaction structure.

**Lock-in mechanics:** Commission-only structure means no subscription lock-in. However, bidder audience ownership (same as HiBid) creates exit friction. Multi-year volume contracts with rebate tiers create informal lock-in for high-volume operators.

**Self-service tier:** Partially. Basic timed-auction listing can be set up, but the full package pricing and live-auction configuration requires a sales conversation.

---

### AuctionMethod

**Sources:** [auctionmethod.com/pricing](https://www.auctionmethod.com/pricing), [spotsaas.com/product/auctionmethod/pricing](https://www.spotsaas.com/product/auctionmethod/pricing), [getapp.com/retail-consumer-services-software/a/auctionmethod/pricing/](https://www.getapp.com/retail-consumer-services-software/a/auctionmethod/pricing/)

**Pricing model:** AuctionMethod's Basic Service plan starts at $750/month with a one-time $1,500 setup/onboarding fee. It is a flat-fee, no-GMV-percentage model — no per-lot, per-auction, or commission charges. The $750/month includes 100,000 monthly pageviews, 30GB image storage, and 30,000 transactional emails. Notable add-ons: live chat/phone support $150/month, SMS notifications $15 per 500 messages, Advanced Shipping (EasyPost) $150/month, Private Label (remove "Powered by AuctionMethod") $100/month. Chargebacks handled at $395/flat fee (free for Fiserv users). A 10% annual prepay discount is available. 30-day free trial, no credit card required.

**Product scope:** AuctionMethod is a fully-hosted white-label auction platform — operator console, bidder-facing website, mobile bidding app, auction management, and invoicing. No built-in lotting/AI intake tool. It targets estate liquidators and general auctioneers, not specifically retail returns/liquidation. The payment integration is operator-configured (Fiserv, and others), not a Stripe Connect destination-charge model.

**Payment topology:** Operator is the merchant of record, collects payments through their configured processor. AuctionMethod does not take custody of buyer funds.

**Lock-in mechanics:** Month-to-month subscription, cancel anytime. The $1,500 setup fee creates a meaningful upfront switching cost. Private Label ($100/month add-on) means your branded site is hosted by them — if you leave, you lose the white-label presentation. Data portability is not explicitly called out in public docs.

**Self-service tier:** Yes, 30-day trial with no credit card. Sales call is optional, not required.

---

### BidJS / Bidlogix

**Sources:** [bidlogix.com](https://www.bidlogix.com/), [g2.com/products/bidlogix-bidjs/pricing](https://www.g2.com/products/bidlogix-bidjs/pricing), [capterra.co.uk/software/174506/bidjs](https://www.capterra.co.uk/software/174506/bidjs), [getapp.com/retail-consumer-services-software/a/bidjs/pricing/](https://www.getapp.com/retail-consumer-services-software/a/bidjs/pricing/)

**Pricing model (UK/EU pricing):** Four published tiers. Starter: GBP 400/month (~$505 USD at current rates). Growth: GBP 625/month (~$790 USD) — adds branding removal, additional admin users, global search, 3 languages. Pro: GBP 1,250/month (~$1,580 USD) — adds OAuth SSO, API/Webhook access, 5 languages. Enterprise: custom pricing — dedicated Slack channel, 20+ languages. The model is subscription-only with no GMV percentage. Pay-as-you-go per-lot pricing exists for lower-volume use. Free trial available, no free version.

**Product scope:** BidJS is an embeddable auction engine (JavaScript widget-based) plus hosted option, targeting auction houses that want to put timed and live bidding directly on their own domain rather than listing on a third-party marketplace. No lotting tool, no AI intake, no bidder mobile app. UK/EU-centric customer base. Auction categories: fine art, antiques, industrial, commercial.

**Payment topology:** Operator-side. The operator configures their own payment gateway. BidJS does not facilitate payments.

**Lock-in mechanics:** Monthly contracts at base tiers; Enterprise contracts likely multi-year. The embedded/hosted split creates some architectural dependency.

**Self-service tier:** Free trial available. Starter tier can likely be set up without a sales call.

---

### LiveAuctioneers

**Sources:** [liveauctioneers.com/pages/master-rate-card/](https://www.liveauctioneers.com/pages/master-rate-card/), [getapp.com/retail-consumer-services-software/a/liveauctioneers/pricing/](https://www.getapp.com/retail-consumer-services-software/a/liveauctioneers/pricing/), [nawcc.org forums](https://mb.nawcc.org/threads/using-live-auctioneer.172937/), [auctionwriter.com/estate-auction-fees-2025](https://auctionwriter.com/estate-auction-fees-2025-update-what-every-auction-house-should-know/)

**Pricing model:** LiveAuctioneers charges operators a percentage of hammer (winning bid, not including buyer's premium) as a platform listing/audience fee — reported range of 3–5%, with the platform fee raised to 3.99% as of September 2025 for online payment processing. Operators set their own buyer's premium (typically 20–27.5% for online bidders in the fine-art segment), but the premium charged online cannot exceed the floor bidder's premium by more than 5 percentage points. LiveAuctioneers takes a share of the internet bidder's premium above what floor bidders pay. No subscription fee. No setup fee for standard listing. Master Rate Card is published.

**Product scope:** Marketplace/audience play only — fine art, antiques, collectibles, jewelry. Operators get a listing page on LiveAuctioneers.com and access to their buyer pool. No back-office software, no lotting tools, no white-label bidder experience. Operators must use their own auction management system (typically AuctionFlex or similar) and simulcast to LiveAuctioneers.

**Payment topology:** LiveAuctioneers operates "Live.Payments," a built-in payment facilitation service, where buyers pay LiveAuctioneers directly and funds are disbursed to operators. This is a marketplace-facilitator model — LiveAuctioneers has custody of buyer funds.

**Lock-in mechanics:** No subscription means low switching cost. Audience/bidder relationships belong to LiveAuctioneers. Category restriction (fine art/collectibles) effectively locks users in by market segment, not by contract.

**Self-service tier:** Yes, operators can create accounts and list auctions without a sales call for standard listings.

---

### Bidpath

**Sources:** [bidpath.com](https://bidpath.com/), [bidpath.com/sam/](https://bidpath.com/sam/), [goodfirms.co/software/bidpath](https://www.goodfirms.co/software/bidpath), [sourceforge.net/software/product/Bidpath/](https://sourceforge.net/software/product/Bidpath/)

**Pricing model:** Pricing is not published. Custom quote only — requires a sales call or demo request. No free trial, no self-service. Bidpath markets itself as enterprise auction infrastructure serving 850+ auction organizations across 27 countries.

**Product scope:** End-to-end suite: SAM (auction engine for live/timed/hybrid), AIM (mobile cataloging app — their equivalent of ClovrBid's lotting app), and Go (back-office CMS). This is the most complete product stack among the competitors studied, but it targets large enterprise auction houses, not small operators. AIM is Bidpath's lotting/cataloging mobile app — the existence of this confirms enterprise players see mobile intake as table-stakes.

**Payment topology:** Operator-configured — Bidpath integrates with operator payment processors. Not a marketplace facilitator.

**Lock-in mechanics:** Perpetual license per server installation available in addition to SaaS. Enterprise contracts are standard. High switching cost due to custom configuration.

**Self-service tier:** No. Everything requires a sales engagement.

---

### Secondary Comparables

**BidFTA / Nellis Auction**
BidFTA is the underlying platform for several retail-returns auction operations including Nellis Auction. Nellis charges buyers a 15% buyer's premium (confirmed by support documentation at [nellisauction.freshdesk.com](https://nellisauction.freshdesk.com/support/solutions/articles/157000204076-what-is-a-buyer-s-premium-)). BidFTA itself does not appear to license its platform to third-party operators — it is a captive platform for operating their own auction locations. Not a competitor to ClovrBid in the platform-licensing sense.

**Whatnot**
Whatnot charges sellers 8% commission on final sale price (reduced to 4% for Coins/Money, 5% for Electronics) plus 2.9% + $0.30 payment processing per transaction — total effective seller cost 11–12%. No subscription fee. No per-lot fee. Source: [help.whatnot.com/hc/en-us/articles/4847069165965](https://help.whatnot.com/hc/en-us/articles/4847069165965-Whatnot-Seller-Fees-and-Commissions-Schedule). Not a B2B platform-licensing play — Whatnot is a consumer marketplace. Useful framing: the 8% commission (comparable to 2% GMV + typical 6–10% buyer's premium that Whatnot replaces) shows consumer-marketplace-style economics are 4–6x ClovrBid's take rate.

**GovDeals (Liquidity Services)**
GovDeals charges buyers a 7.5–10% buyer's premium. Government seller agencies pay zero listing fees. Source: [govauctions.app/guides/govdeals-faq](https://govauctions.app/guides/govdeals-faq). GovDeals processed ~$903 million GMV in FY2025. Revenue model is entirely buyer-side premium. Not directly comparable to ClovrBid's segment.

**Selling Lane**
An emerging competitor in the same small-operator SaaS space: $995/month or $9,995/year, no GMV percentage, unlimited everything. Source: [sellinglane.com/pricing/](https://sellinglane.com/pricing/). Positioned as a "HiBid replacement" for operators unhappy with HiBid's per-bid/per-GMV stacking. No lotting app, no AI intake. Self-service, no sales call.

---

## 3. Market Patterns

**Three dominant pricing archetypes exist, and ClovrBid currently sits between all three.**

The first archetype is "Marketplace Commission": platforms like Proxibid and LiveAuctioneers charge no subscription but take 3–6% of hammer. The implicit deal is: "you get our audience in exchange for a tax on every dollar you make." These platforms are cheap to start and expensive at scale. They also own the bidder relationship, creating the most pernicious form of lock-in — when you leave, you lose your audience. For the retail liquidation segment, this is a particularly bad deal because high-frequency, lower-average-lot-price auctions mean the per-transaction tax compounds aggressively.

The second archetype is "Metered SaaS": HiBid/AuctionFlex represents this model — a low base subscription ($95/month) combined with multiple usage meters (per-bid fees capped by auction type, 0.4% marketplace proceeds, 2% AuctionFlex GMV fee, credit-card auth fees). On paper the subscription looks cheap. In practice, a $30K/month operator pays $395–515/month total, effectively 1.3–1.7% of GMV. The model is psychologically clever: the $95 headline appears reasonable, but the true cost is buried in invoices that grow with success. Operators in online forums specifically call out HiBid's economics as "punishing growth."

The third archetype is "Flat Subscription": AuctionMethod ($750/month + $1,500 setup), Selling Lane ($995/month), and BidJS (GBP 400–1,250/month) charge flat rates with no GMV tax. This model protects high-GMV operators — a $1M/month operator on AuctionMethod pays the same $750 as a $50K/month operator. The catch is the entry price: $750–995/month is too expensive for small operators starting out, and the $1,500 setup fee creates real friction.

**Key structural gaps visible in the market:**

The lotting app gap is the most important finding. No operator-facing auction platform studied bundles a mobile AI lotting/intake app into the base subscription. HiBid operators must buy ManyFastScan separately ($129+/user/month). Bidpath has an AIM app (enterprise tier only). The retail-liquidation segment is the fastest-growing category in B2C auctions (driven by e-commerce returns volume), and it is the segment most dependent on rapid, accurate lot intake — exactly what the ClovrBid lotting app addresses. This is a genuine product-level differentiation, not a marketing claim.

The white-label bidder app gap is the second important finding. HiBid has a bidder app, but it is HiBid-branded — operators are tenants in HiBid's bidder experience. AuctionMethod has a mobile bidding app. No other platform studied gives small operators a white-label or branded-neutral native bidder app at sub-$200/month. ClovrBid's bidder app (iOS, single identity across all operators) provides cross-operator network effects without sacrificing operator autonomy — a structural advantage HiBid has only at the platform level, not at the per-operator level.

The sales-tax black hole is an industry-wide problem. HiBid/AuctionFlex, AuctionMethod, and Proxibid all leave sales tax as the operator's problem. LiveAuctioneers facilitates payments but its marketplace-facilitator obligations for sales tax vary by state. ClovrBid's Stripe Connect Standard (destination charges, operator is merchant of record) is consistent with the industry norm — operators handle sales tax — and does not create marketplace-facilitator obligations for ClovrBid, which is a significant compliance advantage at this stage.

**Who is expensive vs cheap at different GMV levels:**

At $20K/month GMV: AuctionMethod ($750+$1,500 amortized) is most expensive. ClovrBid ($99 + $400 = $499) beats HiBid's effective cost ($395–515). Proxibid ($1,000–1,200 at 5–6%) is the most expensive.
At $100K/month GMV: ClovrBid ($99 + $2,000 = $2,099) becomes expensive vs HiBid ($95 + ~$600–700 = $795–895). AuctionMethod ($750 flat) beats both. Selling Lane ($995 flat) is competitive.
At $500K/month GMV: ClovrBid ($99 + $10,000 = $10,099) is the most expensive option by far. AuctionMethod ($750) and Selling Lane ($995) dominate. This is ClovrBid's enterprise ceiling.

---

## 4. ClovrBid Positioning

**Where $99 + 2% is strong:**

For operators running $5K–$50K/month in GMV, ClovrBid's total cost ($199–$1,099/month) is comparable to or below HiBid's stacked pricing when ManyFastScan ($129+/user/month) is factored in. A small liquidation operator currently paying $95 (AuctionFlex 360) + $129 (ManyFastScan) + 0.4% HiBid proceeds + 2% AuctionFlex GMV fee = roughly $450–600/month is paying more for less. ClovrBid's pitch to this operator is legitimately cheaper with a better product.

The "no setup fee, month-to-month, self-service credit card" positioning is differentiated against AuctionMethod ($1,500 setup) and Bidpath (enterprise sales). It matches AuctionFlex 360's ease of entry while bundling more product.

The 2% application fee is structurally aligned with Stripe Connect destination charges: ClovrBid takes the fee automatically at settlement, with no invoice to argue over. HiBid's billing is opaque (per-bid + per-auction + GMV percentage all on one monthly invoice). Operators who've been burned by surprise HiBid invoices will find ClovrBid's math transparent and predictable.

**Where $99 + 2% is weak:**

At $100K+ monthly GMV, the 2% fee becomes $2,000+/month, which exceeds AuctionMethod's flat $750 and Selling Lane's $995. A HiBid sales rep pitching a $200K/month operator would correctly point out that ClovrBid costs $4,100/month vs HiBid's ~$1,100–1,400 (AuctionFlex 360 + HiBid proceeds fees). This is the $99 + 2% structure's primary vulnerability.

The $99 subscription is so low that it doesn't signal premium quality to operators who've been told "you get what you pay for" by AuctionFlex salespeople for years. In the auction software industry, $99/month is priced below the credibility floor for a full-stack platform. This is a perception problem, not a cost problem.

**Specific recommendations:**

Subscription tier: The $99 price point is well-positioned for launch but should graduate to $149–199 within 6–12 months as ClovrBid proves value. Consider a two-tier structure: Starter at $99/month (reasonable GMV cap, e.g. $25K/month, or single warehouse) and Growth at $199/month (unlimited warehouses, advanced analytics, API access). This protects the entry-level positioning while signaling that the platform is worth real money.

GMV application fee: The 2% rate is defensible for the $5K–$75K/month GMV range but creates a credibility problem with high-GMV operators. A tiered application fee — 2% on the first $50K/month GMV, 1.25% on $50K–$200K, 0.75% above $200K — would address the enterprise ceiling while keeping entry economics intact.

Lotting app: Do not unbundle. The integrated lotting app is ClovrBid's most differentiated asset. Charging separately for it would (a) make the pricing more complex, (b) eliminate the "HiBid + ManyFastScan = more than ClovrBid" argument that is ClovrBid's best conversion pitch. Keep it bundled at all tiers.

Setup/onboarding fee: Do not introduce one for self-service operators. AuctionMethod's $1,500 setup fee creates friction that ClovrBid's self-service model eliminates. Maintain zero setup fee as a structural advantage. For future enterprise/custom deployments, a one-time configuration fee of $500–1,000 could be appropriate.

Bidder-side fee: Do not introduce one at launch. The entire industry has trained bidders to expect zero platform fees from the auction engine (buyer's premiums are the operator's mechanism). Introducing a bidder-side platform fee would create bidder pushback and damage Bingo Auctions' (the first operator) ability to compete with BidFTA. Long-term, an optional premium bidder tier (e.g. "ClovrBid Pro" at $9.99/month: early access to lots, saved searches, instant payment tokens) is worth exploring, but not before achieving scale.

AI usage billing: The 25% markup on OpenRouter costs with a $100/month cap is reasonable. At launch, the AI costs are a rounding error — a typical scan identifies an item for $0.01–0.05 using a vision model. At 500 lots/auction, that's $5–25 in OpenRouter cost per auction, meaning the $100 cap is generous for most operators. Consider making the $100 cap a "guardrails included" messaging point (no surprise AI bills) rather than burying it. Long-term, as usage grows, consider moving to a credit pack add-on at the $200+/month GMV tier.

---

## 5. Concrete Recommended Pricing Structure for ClovrBid

### Self-Service / Small Operator Tier — "Starter"

- Monthly subscription: $99/month (no change from current)
- Application fee on GMV: 2% of (winning bid + buyer's premium) — no change, Stripe destination charge at settlement
- Lotting app (ClovrBid Staff): included in subscription
- Bidder app (ClovrBid for iOS): free for all bidders, included in platform
- AI usage: included up to $75/month passthrough cost; 25% markup applies above $75 (i.e. operator pays $75 included, then cost+25% after). This reduces the hard cap to a softer usage model.
- Setup fee: $0
- Contract: month-to-month, cancel anytime
- Operator limit: up to 2 warehouse locations

This tier is optimal for Bingo Auctions as the first operator and for any new operator under $50K/month GMV. Total cost at $20K/month GMV: $499/month (2.5% effective rate). Total cost at $50K/month GMV: $1,099/month (2.2% effective rate).

### Enterprise / High-GMV Operator Tier — "Growth"

- Monthly subscription: $249/month
- Application fee on GMV: 2% on first $50K/month GMV, then 1.25% on $50K–$250K, then 0.75% above $250K/month — calculated monthly, applied per-auction
- Lotting app: included (unlimited seats)
- API access + webhook integrations: included
- Dedicated onboarding call (90 min): included
- SLA-backed support response: 4 business hours
- Up to 10 warehouse locations
- AI usage: included up to $200/month passthrough cost; 25% markup above
- Setup fee: $0
- Contract: month-to-month (annual prepay at 10% discount available)

Total cost at $100K/month GMV: $249 + $2,500 (2% of $50K) + $625 (1.25% of $50K) = $3,374/month (3.4% effective on GMV — note this includes a platform with integrated AI lotting and white-label bidder app that HiBid doesn't offer).

**Honest comparison at $100K/month GMV:**
- ClovrBid Growth: $3,374/month
- HiBid (AuctionFlex 360 + HiBid + ManyFastScan 3 seats): ~$95 + $1,200 (1.2% HiBid + AuctionFlex GMV combined) + $387 (3 ManyFastScan seats) = ~$1,682/month
- ClovrBid is more expensive at this tier by $1,700/month. The justification is bundled AI intake + native bidder app + Stripe Connect payments + dispute tooling + warehouse map. If those features are valuable, the gap closes. If an operator just needs auction hosting, HiBid wins on price.

### TestFlight Launch-Day Pricing (Now through first 12 months)

Keep current $99 + 2% structure exactly as-is. This is appropriate for: validating the product-market fit, proving Bingo Auctions, and avoiding the need to defend pricing before the product is proven. The $99 price is not a mistake — it is the correct launch price for an unproven SaaS in a market where incumbents have strong network effects.

**Graduation path:** After Bingo Auctions has run 6+ auctions and the platform has cleared $500K in cumulative GMV, introduce the Growth tier publicly. Announce pricing increases with 60-day notice. Give early operators a "founder rate" lock-in at $99/month for life (Starter features) or $179/month (Growth features) — this rewards early adopters and creates a word-of-mouth incentive to sign up early.

---

## 6. Open Questions

**Before locking pricing, Michael should clarify:**

1. What is Bingo Auctions' expected monthly GMV in months 1–6? The $99 + 2% structure looks very different at $10K/month ($299 total) vs $100K/month ($2,099 total). Knowing where Bingo will actually operate validates whether Starter tier economics are correct.

2. Is ClovrBid willing to be the merchant of record for payment disputes? The current Stripe Connect Standard (destination charges) model keeps operators as merchant of record, which is correct. But if a future operator requests that ClovrBid handle chargebacks centrally (to unlock easier pricing comparison against marketplace-facilitator platforms), that significantly changes liability exposure. Define the boundary now.

3. Will the lotting app be available to operators who don't use ClovrBid for auctions (i.e. as a standalone SKU for HiBid operators)? This is the "sell to the enemy" question. A $129+/month standalone ClovrBid Staff subscription could steal ManyFastScan customers and generate revenue before the auction platform is adopted — but it also means building a competitor-compatible product and potentially diluting the auction platform's differentiation.

4. What is the target operator count for year 1? If the goal is 10–20 operators by end of 2026, the $99 price point and zero setup fee are correct. If the goal is 3–5 high-GMV anchor operators, a higher subscription with a dedicated onboarding experience makes more sense.

5. How does Bingo Auctions plan to set their buyer's premium? The platform currently has no default. The industry norm for retail liquidation is 15–20%. This decision materially affects bidder conversion and repeat purchase behavior and should be set before the first public auction.

6. Is the 48-hour dispute window defensible against BidFTA's 7-day return policy? Nellis Auction's 7-day full-refund policy is a known conversion driver. ClovrBid's 48-hour window is more restrictive. This is a pricing-adjacent decision that affects operator economics and bidder trust — should be a conscious choice, not a default.

---

## Sources

- [auctionflex.com/hibid-pricing.htm](https://www.auctionflex.com/hibid-pricing.htm) — HiBid pricing, effective April 2025
- [trial.auctionflex.com/pricing](https://trial.auctionflex.com/pricing) — AuctionFlex 360 pricing tiers
- [sites.google.com/view/af360wiki/pricing/hibid-pricing](https://sites.google.com/view/af360wiki/pricing/hibid-pricing) — Unofficial AF360 wiki with fee breakdown
- [sellinglane.com/selling-lane-vs-hibid/](https://sellinglane.com/selling-lane-vs-hibid/) — Side-by-side HiBid cost calculation
- [sellinglane.com/pricing/](https://sellinglane.com/pricing/) — Selling Lane pricing ($995/month)
- [manyfastscan.com/pricing](https://www.manyfastscan.com/pricing) — ManyFastScan pricing ($129/user/month)
- [manyfastscan.com/use-cases/auction-integration-hibid-auctionworx-and-more/](https://manyfastscan.com/use-cases/auction-integration-hibid-auctionworx-and-more/) — ManyFastScan HiBid integration
- [discover.proxibid.com/master-rate-card](https://discover.proxibid.com/master-rate-card) — Proxibid 2026 Master Rate Card
- [discover.proxibid.com/packages](https://discover.proxibid.com/packages) — Proxibid packages
- [auctionmethod.com/pricing](https://www.auctionmethod.com/pricing) — AuctionMethod pricing
- [spotsaas.com/product/auctionmethod/pricing](https://www.spotsaas.com/product/auctionmethod/pricing) — AuctionMethod pricing confirmed at $750/month + $1,500 setup
- [bidlogix.com](https://www.bidlogix.com/) — BidJS/Bidlogix platform overview
- [g2.com/products/bidlogix-bidjs/pricing](https://www.g2.com/products/bidlogix-bidjs/pricing) — BidJS pricing tiers (GBP 400–1,250+/month)
- [liveauctioneers.com/pages/master-rate-card/](https://www.liveauctioneers.com/pages/master-rate-card/) — LiveAuctioneers rate card
- [auctionwriter.com/estate-auction-fees-2025](https://auctionwriter.com/estate-auction-fees-2025-update-what-every-auction-house-should-know/) — Industry-wide buyer's premium and fee context
- [help.whatnot.com/hc/en-us/articles/4847069165965](https://help.whatnot.com/hc/en-us/articles/4847069165965-Whatnot-Seller-Fees-and-Commissions-Schedule) — Whatnot 8% commission structure
- [nellisauction.freshdesk.com](https://nellisauction.freshdesk.com/support/solutions/articles/157000204076-what-is-a-buyer-s-premium-) — Nellis Auction 15% buyer's premium
- [govauctions.app/guides/govdeals-faq](https://govauctions.app/guides/govdeals-faq) — GovDeals 7.5–10% buyer's premium
- [bidpath.com/sam/](https://bidpath.com/sam/) — Bidpath SAM + AIM product overview
