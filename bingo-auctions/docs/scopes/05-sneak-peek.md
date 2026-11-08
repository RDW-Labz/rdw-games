# 05 — Sneak Peek (Members Browse Inventory)

**Lane:** B · **Money:** no · **Needs:** 01 (`sneak_peek` perk)

## Goal
Bidder Pass and Pro members can browse inventory that's uploaded but **not yet in an auction**. They watch items and get alerted with a link the moment a watched item goes into an auction. Bidding opens for everyone at the same time, so the **bidding engine is untouched**.

## What members see
- Items in the **"In inventory"** stage (binned, ready for Auction Builder) that have **photos + a title**.
- Not shown: "Not put away" / Drafts, Manifest pool, items missing photos or title.
- Admin toggle (default **off**): also show Unsold / Refunded–relist items waiting to go back up.
- Admin per-item "hide from sneak peek" switch.

**Shown:** photos, title, description, condition, category, MSRP (only if lots already show MSRP publicly).
**Never shown:** bin/location, source/VRID, truck name, vendor, intake date, cost, staff notes. Truck and vendor names stay hidden unless Jared OKs them.

## Watch + alert
- Watch button on each item. "My Sneak Peek watchlist" on the member page.
- When Auction Builder puts a watched item into an auction → **push + email**: "An item you're watching is up for auction" with a link to the lot.
- If an item leaves inventory without going to auction, mark it "No longer available". No alert.
- If the member's perk lapses, the watchlist stays but browsing locks. Alerts for already-watched items still go out (keeps them engaged).

## Where
- Member dashboard **"Sneak Peek" tab** (app + website): search, filter by category, newest first, paginated.
- Swipe feed "Sneak Peek" tab (scope 09).
- Non-members: a teaser with **count only**, e.g. "2,129 items coming up — see them first with Bidder Pass". No item details.

## Security
- Enforce on the server (RLS/API). A non-member must get **nothing** back from the sneak peek API, even when calling it directly. Write a test for this.
- The member endpoint returns only the public fields listed above.

## Confirm first
- Inventory stages and fields: the admin Inventory page shows In auction / In inventory / Not put away / Available / Unsold / Unpicked-up / Refunded–relist. Which field drives these?
- Is an inventory item the same row as a lot, or separate?
- Exactly where Auction Builder attaches an item to an auction. That's the hook for alerts.
- Push and email providers and templates.
- Whether lot pages show MSRP to the public today.

## Done when
- Non-member and expired member: API returns nothing (tested).
- Member sees only In-inventory items with photos + title, and only public fields (tested).
- Adding a watched item to an auction in Auction Builder (sandbox) sends push + email with a working link.
- Large inventory (2k+) loads fast: paginated, thumbnails.

## Ship
Customer app never 18:00–22:00. Website 09:00–16:00. Rollback = flag off.
