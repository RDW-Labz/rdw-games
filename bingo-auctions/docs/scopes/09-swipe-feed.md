# 09 — Swipe Feed: Offers, Ads, Sneak Peek, Price Check

**Lane:** B (last) · **Money:** no · **Needs:** 01, 03, 05, 06, 08

## Goal
The mobile apps already have a TikTok-style swipe feed for lots. Add the new features to it without slowing it down.

## Delivery
- **New server feed endpoint.** Inserts (offer cards, ads, sneak peek) and feed ordering come from the server,
  never decided by the app. The endpoint returns the next cards, their spacing and membership filtering.
- **The current pager is the flag-off fallback.** `apps/bidder-app/app/lot/pager.tsx` with
  `apps/bidder-app/lib/browse-pager.ts` stays as-is behind the flag: with the flag off, opening a filtered result
  keeps the current pager order/index and makes no new-feed request.

## Add
1. **Bidder Pass offer card (non-members only):** full-screen card about every **25 swipes**: "Skip fees + ads. Bidder Pass, 7 days free." → trial flow (08), or join (01) if the trial was already used.
2. **Ads (non-members only):** about every **20th swipe**. A boosted ad shows more often (default about every 7th swipe) with the gold highlight. Same "Sponsored" tag, tap tracking and stats as scope 03.
3. **Sneak Peek tab (Bidder Pass + Pro):** swipe through upcoming inventory (scope 05 rules and fields), tap to watch.
4. **Price check button (Pro):** on each lot in the feed, opens scope 06.
- Every spacing number is editable in admin. Members never get offer cards or ads.

## Rules
- Inserts come from the new server feed endpoint, not decided by the app.
- Never two inserts back to back. Never an insert as the first card.
- Preload the next cards. Feed must stay smooth on weak signal.
- Swipe position survives an insert (no jump back).

## Confirm first
- The feed component and its data source/API, pagination and preloading.
- The existing pager context (`apps/bidder-app/lib/browse-pager.ts`) and the `/lot/pager` screen, which the flag
  must leave exactly as today.
- Existing analytics events on the feed (reuse for ad impressions).

## Done when
- Members: zero ads and zero offer cards (tested via API).
- Spacing matches admin settings.
- No visible stutter on a mid-range Android phone.
- The Sneak Peek tab is locked for non-members (teaser only).
- **Permanent regression:** flag off, opening a filtered result keeps the current pager order/index and makes no
  new-feed request; flag on uses the approved server feed and membership filtering.

## Ship
Customer app never 18:00–22:00. Android stays on the 0.1.1 rescue line. Rollback = flag off (feed identical to today).
