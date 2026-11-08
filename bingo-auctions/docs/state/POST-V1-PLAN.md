# Post-v1.0 Update Plan

> Captured 2026-05-24 during the v1.0 submission push.
>
> **Sources:**
> - `docs/audits/ui-ux-cross-platform-audit-2026-05-23-browser.md` — browser-side feature audit
> - Mobile-code compare against `apps/bidder-app/app/**` + `apps/field-mobile/app/**`
> - `docs/EAS_UPDATE_PLAYBOOK.md` (currently on branch `chore/eas-update`, commit `e0aa980`)
> - **2026-05-24 polish/asset re-scan** of `apps/operator-web/src/app/(public)/_components/**` against `apps/bidder-app/app/**` (per user ask: "we added a bunch of images/graphic resources to the browser dashboard but we have not updated apple or google play bidder with any of the modernization")
>
> This is a **quality-of-life plan** — not a P0 hotfix list. v1.0 ships to Apple
> tonight; v1.0.1 is the first iteration after Apple approves (24-48h after acceptance).

---

## 60-second summary

- **65 items audited** (was 42; +23 polish/asset items added 2026-05-24).
- **✅ 17 items already shipped** in bidder-app (no action).
- **🟢 19 OTA-able items** for bidder-app (`eas update --branch preview --branch production`).
- **🟡 9 items need new EAS Build** (native deps like `expo-linear-gradient`, new screens, new assets baked into binary).
- **🟠 11 items are operator-web only** (`/winners` 404, Google Play "coming soon" copy, polish bugs, etc.).
- **🔴 2 items cross-cut** mobile + backend.
- **Hard constraint:** `apps/field-mobile/app.config.ts` lines 145-150 — staff app has **expo-updates REMOVED**. Field-mobile cannot receive OTAs at all. Every staff change requires a new EAS Build + TestFlight push.
- **Bidder-app `version: '0.1.1'`** with `runtimeVersion: { policy: 'appVersion' }` — OTA bundles only reach binaries on the same version string. Bump to `0.1.2` in v1.1 build.
- **The browser audit was about the BIDDER experience.** Field-mobile (staff app) is not in scope for any of the audit items below — staff app changes are tracked separately.
- **Asset architecture good news:** the entire v3 photo-real pack lives on `cdn.clovrbid.com/v3/` (R2). Mobile already fetches HomeHero, CategoryGrid, SectionBanner, no-photo placeholder from the same CDN. URL changes are OTA-able; only NEW screens/components need new builds.
- **Asset architecture bad news:** `expo-linear-gradient` is **NOT in `apps/bidder-app/package.json`**. HomeHero + CategoryGrid + SectionBanner all silently fall back to a flat `rgba(10,12,17,0.5)` overlay instead of the dark-to-light gradient the web has. This is a visible polish regression that needs a new EAS Build to fix.

**Top 10 to tackle first (across both sprints, unified priority list):**

1. `🟡 P0` Install `expo-linear-gradient` in bidder-app and rebuild — every modernized v3 component (HomeHero, CategoryGrid, SectionBanner) currently degrades to a flat dim overlay because the dep is missing. Apple users have never seen the real gradient treatment. (Sprint 2 build, 1h dep + bake into v1.1)
2. `🟢 P0` Ship the `feat/native-recent-wins` branch as an OTA — RecentWinsRail is wired but verify on TestFlight before promoting to production. (Sprint 1, 1h)
3. `🟡 P1` Add ClovrRush as a dedicated bidder-app screen — flagship branded feature, zero mobile parity today (no screen + no nav badge + no live count). (Sprint 2, 1d)
4. `🟢 P1` Port AppPromoBanner equivalent to bidder-app first-launch (dismissable for 7 days) — directs users from web→app, mobile→keep using app. Today the bidder-app has zero promo strip. (Sprint 1, 3h)
5. `🟢 P1` Profile screen rebuild — currently 3 generic text links (`Edit profile / Saved searches / Subscription`). Browser has Payment / Receipts / Watchlist / My Bids cards + v3 brand icon. (Sprint 1, 4h)
6. `🟢 P1` Add full filter rail (Condition pills, Price min/max) to Browse — bidder-app has Category + Discount + Sort but is missing Condition pills and Price range. (Sprint 1, 4h)
7. `🟡 P1` Port the homepage ClovrRush callout (red gradient pulse + count pill) to bidder-app home — links to the new ClovrRush screen. (Sprint 2 with ClovrRush, 2h)
8. `🟢 P1` "Save % off retail" red pill on LotCard photo zone — verify Mac.Bid-style discount badge actually renders on TestFlight (LotCard.tsx has the code; needs visual confirmation). (Sprint 1, 1h verify)
9. `🟠 P1` Operator-web: fix `/winners` 404 + flip "Google Play coming soon" to "Available" copy once first Play Internal track build is live. (Sprint 1, 2h)
10. `🟡 P1` Port v3 brand icon (`v3/brand/icon-180.png`) into bidder-app launch / profile header. Mobile splash + adaptive-icon were brought to v3 in `apps/bidder-app/assets/` already but the in-app header/profile still has no brand mark. (Sprint 2 build, 2h)

---

## Sprint 1 (v1.0.1 OTA) — JS-only changes shipped via `eas update`

Defaults to **both `preview` + `production` channels** per `feedback_ota_both_branches.md`. All items below land on master, then run `gh workflow run "EAS Update (OTA)" --field app=bidder --field branches=both --field message="..."`.

| Item | File path | Effort | Sprint | Priority | Notes |
|---|---|---|---|---|---|
| Verify RecentWinsRail renders on TestFlight before production OTA | `apps/bidder-app/app/(tabs)/index.tsx:671` | 1h | 1 | P0 | Already wired (line 671). Just confirm the rail isn't empty on prod RPC. Canary to `preview` first. |
| Profile screen rebuild: add Payment / Invoices / Watchlist / My Bids cards | `apps/bidder-app/app/(tabs)/profile.tsx` | 4h | 1 | P1 | Today it's 3 generic links. Mirror browser's 4-card layout. All sub-routes exist (`/profile/payment-method`, `/invoice/[id]`, `/(tabs)/watchlist`, `/(tabs)/my-bids`). |
| Add Condition pills (New / Like New / Open Box / Tested / As Is) to Browse | `apps/bidder-app/app/(tabs)/index.tsx` (around line 478) | 3h | 1 | P1 | Browser has 5 condition chips + "Ending Soon" virtual chip. Bidder-app has none. Same `useFeatureVisible` gate pattern as discount filter. |
| Add Price min/max input to Browse | `apps/bidder-app/app/(tabs)/index.tsx` | 2h | 1 | P1 | Server side already supports it; just need 2 numeric inputs + a clear button. Apply on blur to avoid query-thrash. |
| Stub "Recently viewed" empty state — currently silent when storage is empty | `apps/bidder-app/app/(tabs)/index.tsx:707-732` | 1h | 1 | P2 | Today the rail just hides. Add a one-line "Tap any lot to start your history" inside the section header. |
| Wire "Saved searches" deep-link from /profile (currently buried under separate Profile link) | `apps/bidder-app/app/(tabs)/profile.tsx` | 1h | 1 | P2 | Surfacing it on the new profile card layout (item above). |
| Empty-state copy on Browse — replace "No live lots right now" with notification opt-in CTA | `apps/bidder-app/app/(tabs)/index.tsx:577-579` | 2h | 1 | P1 | Browser shows "Get the app" — wrong for mobile. Replace with "Turn on push to get pinged when new lots go live" + opt-in button. |
| Empty-state copy on Watchlist + My Bids — remove "Browse the app" CTA, point in-app | `apps/bidder-app/app/(tabs)/watchlist.tsx:121-124`, `my-bids.tsx:344-353` | 1h | 1 | P2 | Already in-app pointers — just audit copy. |
| Add `/clovrrush` deep-link handler so universal-links from the browser open the eventual ClovrRush screen | `apps/bidder-app/app/_layout.tsx` | 1h | 1 | P2 | Stub-route until the screen lands in Sprint 2. Apple URL scheme already routes `clovrbid.com/*` per `app.config.ts:113`. |
| Tighten OperatorPolicyModal copy — mention dispute window inline (browser shows "2-day dispute window" badge on lot detail) | `apps/bidder-app/app/lot/_OperatorPolicyModal.tsx` | 2h | 1 | P2 | Already pulls `refund_window_post_pickup_hours`. Add the badge to the modal header. |
| Verify "Save % off retail" red pill renders on LotCard (Mac.Bid-style discount overlay) | `packages/domain-bidding/src/components/LotCard.tsx` | 1h | 1 | P1 | Code exists (LotCard.tsx); needs visual TestFlight confirmation. Spec says it only renders when MSRP exists AND savings ≥ 10%. |
| Add operator name on lot detail "Run by [Operator] · Buyer's premium: 15%" line | `apps/bidder-app/app/lot/[id].tsx:1395-1447` | 2h | 1 | P2 | Buyer's premium % lives on `operators.buyer_premium_pct` (verify column exists; if not it's `🔴` cross-cutting). |
| Add "Apple App Store available, Google Play coming soon" footer banner in app | `apps/bidder-app/app/(tabs)/index.tsx` (new SectionBanner row) | 1h | 1 | P2 | Audit called out the inconsistency. Bidder-app footer can mirror browser's Google Play status. |

### Asset / visual polish — OTA-able (web→mobile pass)

These ride on the existing CDN architecture — `https://cdn.clovrbid.com/v3/*` is already reachable from bidder-app via `expo-image`. URL change + JSX wiring only.

| Item | File path | Effort | Sprint | Priority | Notes |
|---|---|---|---|---|---|
| Port **AppPromoBanner** (mobile→keep-using-app strip) to bidder-app first launch | new file `apps/bidder-app/app/(tabs)/_components/AppPromoBanner.tsx` + wire into `(tabs)/index.tsx` head | 3h | 1 | P1 | Web version dismisses for 7 days via localStorage; mobile equivalent uses `AsyncStorage`. Pulls from `apps/operator-web/src/app/(public)/_components/AppPromoBanner.tsx`. Don't promote app-store CTAs — promote in-app features ("Outbid push alerts", "QR scan", "Pickup map"). |
| Port **ClovrRushCallout** (red gradient + pulsing dot + count) to bidder-app home | new component + wire above category grid in `(tabs)/index.tsx` | 2h | 1 | P1 | **Requires gradient lib (Sprint 2 build) OR fallback to solid red.** Tracks the same `getClovrRushCount` RPC the homepage uses. Tap navigates to `/clovrrush` (stub-routed in Sprint 1, real screen lands in Sprint 2). |
| Add the 4th SectionBanner (`trusted-auctions-800x250.webp`) — bidder-app currently renders 3 banners (ending-soon, pickup-ready, trusted-auctions) but web has 4 (mobile-bidding, ending-soon, pickup-ready, trusted-auctions) | `apps/bidder-app/app/(tabs)/index.tsx:673-704` | 30m | 1 | P2 | Mobile already has `trusted-auctions` but NOT `mobile-bidding`. Add `mobile-bidding-800x250.webp` banner pointing to `/profile/payment-method` or scan tour. CDN URL exists. |
| Swap LotCard photo-zone placeholder from generic gray bg to the v3 `no-photo-placeholder.webp` | `packages/domain-bidding/src/components/LotCard.tsx:50` | 30m | 1 | P2 | Shared package already uses the v3 placeholder URL — verify on TestFlight, no change needed if it renders. |
| Add Recent Wins "View all winners →" CTA on bidder-app rail header (after `/winners` page ships on web) | `packages/domain-bidding/src/components/RecentWinsRail.tsx` | 30m | 1 | P2 | Depends on backend `/winners` route landing first (see Backend-only section). |
| Port the homepage **"Bidding on the go" section copy** to bidder-app inline ("Push notifications · QR scan · AR pickup maps") | `apps/bidder-app/app/(tabs)/index.tsx` (after last SectionBanner) | 1h | 1 | P2 | Re-emphasizes the differentiators the web AppPromoStrip lists. Pure text — no asset port needed. |
| Replace the bidder-app loading spinner (currently `ActivityIndicator color="#4f8cff"`) with the brand-accent color `#5FE065` to match the v3 green palette | `apps/bidder-app/app/(tabs)/_layout.tsx:89` | 15m | 1 | P3 | Trivial color change; matches the rest of the v3 surface. |

**Sprint 1 total: ~31h, all OTA-able. Ship in one batch via `eas update --branch preview --branch production` after smoke-testing on TestFlight.**

---

## Sprint 2 (v1.1 new EAS Build) — Native changes that need App Review

These require a `version` bump (e.g., `0.1.1 → 0.1.2`) in `app.config.ts` so `runtimeVersion: { policy: 'appVersion' }` lets the new bundle target the new binary. Submit through `.github/workflows/eas-build.yml` → TestFlight → App Review (24-48h).

| Item | File path | Effort | Sprint | Priority | Notes |
|---|---|---|---|---|---|
| **Install `expo-linear-gradient`** (P0 — fixes all silent gradient fallbacks across HomeHero, CategoryGrid, SectionBanner) | `apps/bidder-app/package.json` + `npx expo install expo-linear-gradient` | 1h | 2 | P0 | Hidden critical regression. Components have `try { require('expo-linear-gradient') } catch { LinearGradient = null }` and fall back to flat `rgba(10,12,17,0.5)`. Apple users have NEVER seen the dark-to-light gradient the web has. Verify install with `npx expo doctor` after. |
| ClovrRush dedicated screen — new tab or stack route with live count badge, All/Mine toggle | new file `apps/bidder-app/app/clovrrush.tsx` + tab in `(tabs)/_layout.tsx` | 1d | 2 | P1 | Port logic from `apps/operator-web/src/app/(public)/clovrrush/page.tsx` + `ClovrRushClient.tsx`. Uses existing `LotCard` from `@auction-platform/domain-bidding`. Live count via existing `bids` channel subscription. Decision needed: 7th tab vs header pill (see Open Questions). |
| Live count Realtime subscription for ClovrRush tab badge | `apps/bidder-app/app/(tabs)/_layout.tsx` (Tabs.Screen badge prop) | 4h | 2 | P1 | Single-channel websocket pinned at root layout. Add to v1.1 build because tab badge is a React Navigation primitive that the binary needs to support. |
| Bump `version` in `app.config.ts` from `0.1.1 → 0.1.2` | `apps/bidder-app/app.config.ts:21` | 30m | 2 | P0 | Required to break `runtimeVersion` lock so Sprint 1 OTAs don't bleed into the new binary. Do this in the same PR as the v1.1 build kickoff. |
| Bake v3 brand icon into bidder-app launch / profile header | `apps/bidder-app/assets/` (already has v3 icons) + reference in `(tabs)/profile.tsx` | 2h | 2 | P1 | Splash + adaptive-icon were already updated to v3 (commit `ca4977a` / `404404e`). In-app surfaces (profile header, nav, About) still don't display the brand mark. Pull from `https://cdn.clovrbid.com/v3/brand/icon-180.png` (already used by operator-web's PublicNav). |
| Add ClovrRush nav affordance — red pill button in Browse header (alt: 7th tab) | `apps/bidder-app/app/(tabs)/index.tsx` (header) OR `_layout.tsx` (tab) | 4h | 2 | P1 | Web has both an inline nav link AND a homepage callout. Bidder-app needs at least the callout (Sprint 1) + a persistent nav pill OR tab (Sprint 2). Decision needed before build kickoff. |
| Port web's **CategoryMegaMenu** drill-down to bidder-app — currently CategoryGrid is flat top-16; web has hierarchical mega-menu | new component `apps/bidder-app/app/(tabs)/_components/CategoryDrawer.tsx` + slide-in panel | 1d | 2 | P2 | Web `CategoryMegaMenu.tsx` exposes parent→leaf hierarchy. Mobile flat grid misses 80+ leaf categories. Defer to v1.1 unless user feedback. |
| Bundle v3 brand icon variants into native assets to remove CDN dependency for the launch flash | `apps/bidder-app/assets/` + `app.config.ts` icon paths | 2h | 2 | P3 | Today the assets are 1.5 MB stock Expo files. Replacing with v3-baked icons removes the first-paint dependency on CDN. Optional — current setup works. |

**Sprint 2 total: ~3-4d. Bundle into a single EAS Build → submit ASCII profile change docs (none required this time) → App Review.**

---

## Backend-only / operator-web items (no mobile binary impact)

| Item | File path | Effort | Sprint | Priority | Notes |
|---|---|---|---|---|---|
| Fix `/winners` 404 (homepage "Recent wins" → "View all winners →" link) | `apps/operator-web/src/app/(public)/winners/page.tsx` (new) | 2h | 1 | P1 | Operator-web only. Replicate the homepage RecentWins component on a full page. |
| Flip "Google Play coming soon" → "Available on Google Play" once first internal-testing build is live | `apps/operator-web/src/app/download/page.tsx`, `apps/operator-web/src/app/(public)/page.tsx` (homepage banners + AppPromoStrip line 513), `apps/operator-web/src/app/(public)/_components/AppPromoBanner.tsx` (mobile/Android CTA) | 1h | 1 | P1 | Per memory `auction_platform_google_play.md`, Play Console is verified. Once Play Internal track has a build (Sprint 2 EAS Android), flip copy in all three locations. |
| Dedupe duplicate FilterRail render on `/browse?view=lots` and `/clovrrush` | `apps/operator-web/src/app/(public)/browse/page.tsx`, `clovrrush/page.tsx:386-403` | 2h | 1 | P2 | Audit bug. Sidebar + mobile drawer are intentionally rendered twice with CSS media-query gating, but the audit flagged duplicate landmarks. Add `aria-hidden` on the off-screen instance. |
| Fix "Auction ends" showing `—` on lot detail when scheduled lot has null `close_at` | `apps/operator-web/src/app/(public)/lot/[code]/page.tsx` | 1h | 1 | P2 | Audit bug. Show "Goes live [auction.starts_at]" instead of em-dash. |
| Unify 404 page header style (currently strips search bar + city selector) | `apps/operator-web/src/app/not-found.tsx` (lines 113-168 MinimalNav) | 2h | 1 | P2 | Use the full PublicHeader on 404. Currently a stripped-down MinimalNav loses the search bar, city picker, and ClovrRush nav link. Reusing PublicNav requires breaking the (public)/ route group dependency. |
| Replace 404 page favicon ref `<img src="/icon.png" />` (line 145) with the CDN v3 icon | `apps/operator-web/src/app/not-found.tsx:145` | 15m | 1 | P3 | Stale reference to local /public asset that doesn't exist (`apps/operator-web/public/` only has `favicon.ico`). Currently rendering a broken image on every 404 page. Replace with `https://cdn.clovrbid.com/v3/brand/icon-180.png`. **Trivia: this is a broken-image bug, not polish.** |
| Update OG card URLs on download, support, browse, signup, login, request-access, pricing, legal, how-it-works, operator-pitch pages from `04_APP_SOCIAL/home-hero-social-1200x628.jpg` (v1) → `/v3/og/home-hero-og-1200x628.jpg` (v3) | 9 page files under `apps/operator-web/src/app/**` | 2h | 1 | P2 | Homepage was migrated to v3 OG (commit `b9ed8d9`) but the rest of the routes still link to v1 OG cards with stale flat-clover branding. Search & replace across all `metadata.openGraph.images[0].url` declarations. |
| Add `unstable_cache` or revalidate to `getClovrRushCount` upstream so the nav + homepage callout share the same 15s cached value | `apps/operator-web/src/app/(public)/clovrrush/live-count.ts` (verify already cached; if not, add) | 1h | 1 | P3 | Per `getClovrRushCount` comment in `(public)/layout.tsx:80-82` the count is cached for 15s. Confirm `unstable_cache` wrapper exists; if not, add it. Performance optimization. |
| Run R2 cleanup of v1+v2 legacy paths (`scripts/r2-cleanup-v1-v2.sh`) — per `972f5c8` commit "Next: deletes the v1+v2 legacy R2 folders once this deploy verifies live" | scripts already exist | 30m | 1 | P3 | Storage hygiene; not user-facing. Delete `/04_APP_SOCIAL/`, `/05_SECTION_BANNERS/` (non-v3), `/06_LISTING_UI_PHOTO_STYLE/` (non-v3) prefixes from R2. Saves bucket cost + removes the rollback temptation. |

**Backend-only total: ~10h. All operator-web; deploys via existing Cloudflare Pages workflow.**

---

## Cross-cutting items (mobile + backend in lockstep)

| Item | File path | Effort | Sprint | Priority | Notes |
|---|---|---|---|---|---|
| Surface `operators.buyer_premium_pct` on lot detail "Run by X · Buyer's premium: 15%" line | Mobile: `apps/bidder-app/app/lot/[id].tsx` + Backend: confirm column exists in `operators` table | 4h | 2 | P1 | If column doesn't exist, need a migration + RLS update. Defer to v1.1 build because of migration coupling. |
| Operator policy "dispute window" badge on lot detail (browser shows "2-day dispute window" chip near title) | Mobile: `apps/bidder-app/app/lot/[id].tsx` + Backend: confirm `operator_policies.dispute_window_hours` is selectable | 2h | 1 | P1 | RPC already returns `refund_window_post_pickup_hours` — but audit said "dispute" not "refund." May be same field with new label. Read the policy table to confirm before implementing. |

---

## Asset / visual polish port (web → mobile) — full inventory

This is the **net-new section** added 2026-05-24 after the user explicitly called out the gap. Bidder-app's main screen + lot detail + profile + auth screens have been audited against the modernized operator-web `(public)/` surface.

### Web surface inventory (what's been built since 2026-05-22)

Pulled from git log of `apps/operator-web/src/app/(public)/`, `apps/operator-web/src/app/(public)/_components/`, and `apps/operator-web/public/` for the last ~50 commits:

| Web component | Path | Status on mobile |
|---|---|---|
| HomeHero | `_components/HomeHero.tsx` | ✅ Mobile equivalent at `apps/bidder-app/app/(tabs)/_components/HomeHero.tsx`. Same CDN URL. **Caveat: gradient lib missing — flat fallback.** |
| CategoryGrid (16-up, 4-col desktop / 2-col mobile, gradient-overlay labels) | `(public)/page.tsx:198-309` | ✅ Mobile equivalent at `apps/bidder-app/app/(tabs)/_components/CategoryGrid.tsx`. Same CDN URLs. **Caveat: gradient lib missing — flat fallback.** |
| SectionBanner (4 banners on web: mobile-bidding, ending-soon, pickup-ready, trusted-auctions) | `(public)/page.tsx:325-425` | 🟡 Partial: bidder-app has 3 (ending-soon, pickup-ready, trusted-auctions). **Missing: mobile-bidding banner.** **Caveat: gradient lib missing — flat fallback.** |
| AppPromoBanner (dismissable 7-day localStorage strip) | `_components/AppPromoBanner.tsx` | 🔴 **No mobile equivalent.** |
| AppPromoStrip ("Bid from anywhere" with phones-photo + App Store badge + Google Play coming-soon) | `(public)/page.tsx:429-558` | 🔴 **No mobile equivalent** (mobile already IS the app — but the differentiator copy "outbid push · QR · AR pickup maps" is missing from any mobile surface). |
| ClovrRushCallout (red gradient banner with pulsing dot + count pill, only when count > 0) | `(public)/page.tsx:567-674` | 🔴 **No mobile equivalent.** |
| RecentWins (horizontal scroll rail of anonymized "Saved $X" cards) | `_components/RecentWins.tsx` | ✅ Mobile equivalent at `packages/domain-bidding/src/components/RecentWinsRail.tsx`, wired in `(tabs)/index.tsx:671`. |
| LotCard (photo + condition pill + countdown pill + savings %) | `_components/LotCard.tsx` | ✅ Mobile equivalent at `packages/domain-bidding/src/components/LotCard.tsx`. |
| WatchlistButton (overlay star on LotCard) | `_components/WatchlistButton.tsx` | ✅ Mobile equivalent in `packages/domain-bidding/src/components/WatchlistToggle.tsx`. |
| FilterRail (Category accordion + Condition pills + Price range + Sort) | `_components/FilterRail.tsx` | 🟡 Partial: bidder-app has Category + Discount + Sort. **Missing: Condition pills + Price min/max.** |
| CategoryMegaMenu (hierarchical mega-menu, all 98 categories) | `_components/CategoryMegaMenu.tsx` + `CategoryMegaMenuClient.tsx` | 🔴 **No mobile equivalent.** Mobile has flat top-16 CategoryGrid. |
| SearchBar (typeahead with category suggestions) | `_components/SearchBar.tsx` | 🔴 **No mobile equivalent.** Bidder-app has no search input. |
| Sticky `PublicNav` with logo + CategoryMegaMenu + SearchBar + CityPicker + auth chips + ClovrRush pill | `(public)/layout.tsx:98-302` | 🟡 Bottom-tab navigation is the mobile primitive — most of this is intentionally not ported. **But: brand logo + ClovrRush pill should appear.** |
| 4 v3 SectionBanner pairs (1600x500 desktop + 800x250 mobile) | CDN `/v3/05_SECTION_BANNERS/*` | Mobile only consumes the 800x250 variants. ✅ |
| 10 v3 CategoryHero themes (1920x800) | CDN `/v3/04_HOMEPAGE_BANNERS/{theme}-text-1920x800.webp` | 🔴 Mobile doesn't render any CategoryHero today. |
| 16 v3 category card images (4:3) — image_url_clean + image_url | CDN — DB-driven via `categories.image_url_clean` | ✅ Mobile reads same DB column. |
| 1 v3 phones promo photo (1080x1350) | CDN `/v3/app-promo/app-promo-1080x1350.webp` | 🔴 Used in web AppPromoStrip; no mobile use. |
| 1 v3 OG card (1200x628) | CDN `/v3/og/home-hero-og-1200x628.jpg` | N/A (mobile doesn't generate OG cards). |
| v3 brand icon (180/192/512px PNG variants) | CDN `/v3/brand/icon-*.png` | ✅ Splash + adaptive icon in `apps/bidder-app/assets/`. 🟡 Not surfaced in-app on profile / about. |
| no-photo-placeholder (LotCard fallback) | CDN `/v3/06_LISTING_UI_PHOTO_STYLE/no-photo-placeholder.webp` | ✅ Shared LotCard uses same URL. |

### Static-asset gap summary

- **0 PNG/JPG/WEBP files** exist locally in `apps/operator-web/public/` other than `favicon.ico`. **All visual assets are R2/CDN-hosted under `cdn.clovrbid.com/v3/`.** This is excellent for OTA-ability — URL changes don't require a new build.
- **`apps/bidder-app/assets/` and `apps/field-mobile/assets/` are identical** — both contain only the 4 Expo defaults (`adaptive-icon.png`, `favicon.png`, `icon.png`, `splash.png`, all already v3-aligned per commit `ca4977a`).
- **No mobile-side asset port needed** for the core v3 pack — `expo-image` resolves the same R2 URLs the web uses, with `cachePolicy="memory-disk"` for offline-resilience.
- **Net-new asset work**: 1 new banner (`mobile-bidding-800x250.webp` — already exists on CDN), 1 new promo photo for any in-app App Promo strip (`app-promo-1080x1350.webp` — already exists on CDN). **Zero new uploads required.**

### Component gap (the real work)

| Item | File path | Effort | Sprint | Priority | Notes |
|---|---|---|---|---|---|
| **AppPromoBanner native port** — dismissable 7-day strip pinned above HomeHero | new `apps/bidder-app/app/(tabs)/_components/AppPromoBanner.tsx` | 3h | 1 | P1 | Pulls AsyncStorage instead of localStorage. Copy: feature differentiators, not store CTAs (mobile IS the app). Listed as Sprint 1 OTA item above. |
| **ClovrRushCallout native port** — red gradient + pulsing dot above CategoryGrid when count > 0 | new component + wire into `(tabs)/index.tsx` | 2h | 1 | P1 | Reads same count RPC as web. **Gradient requires `expo-linear-gradient` (Sprint 2 build dep) — for Sprint 1, ship with solid red fallback.** Listed above. |
| **mobile-bidding SectionBanner** — 4th banner pointing to /scan or onboarding | `apps/bidder-app/app/(tabs)/index.tsx:673` (add 4th) | 30m | 1 | P2 | CDN URL `mobile-bidding-800x250.webp` already exists. Listed above. |
| **CategoryMegaMenu native equivalent** — slide-in drawer with parent→leaf hierarchy | new `apps/bidder-app/app/(tabs)/_components/CategoryDrawer.tsx` | 1d | 2 | P2 | Defer to v1.1 build. Today bidder-app has flat top-16 CategoryGrid; users browsing leaves use FilterRail's Category accordion. Listed above. |
| **SearchBar native equivalent** — typeahead with category suggestions | new `apps/bidder-app/app/(tabs)/_components/SearchBar.tsx` | 4h | 2 | P2 | No search input today on bidder-app. Browser typeahead uses `/api/search/suggest`. |
| **ClovrRush dedicated screen** — new tab/stack route | listed in Sprint 2 above | 1d | 2 | P1 | (Cross-listed.) |
| **expo-linear-gradient install** — fix all silent fallbacks | listed in Sprint 2 above | 1h | 2 | P0 | (Cross-listed.) |
| **v3 brand mark on profile header** — currently profile header is text-only "Signed in as X" | `apps/bidder-app/app/(tabs)/profile.tsx:18-22` | 1h | 2 | P2 | Pulls `https://cdn.clovrbid.com/v3/brand/icon-180.png` via `expo-image`. Visual continuity with the splash + adaptive icon. |
| **AppPromoStrip differentiator line in-app** — "Push notifications · QR scan · AR pickup maps" (web copy) | inline in `(tabs)/index.tsx` after last banner | 1h | 1 | P2 | Text-only addition; reinforces what the user gets ON the native app vs the mobile web. Listed above. |
| **Loading spinner accent color** — `#4f8cff` → `#5FE065` (v3 green) | `apps/bidder-app/app/(tabs)/_layout.tsx:89` | 15m | 1 | P3 | Listed above. |

### Top 20 missing/stale file paths (web→mobile)

The user asked for "top 20" — these are the concrete file references behind the items above:

1. `apps/bidder-app/app/(tabs)/_components/AppPromoBanner.tsx` — **does not exist; needs to be created.**
2. `apps/bidder-app/app/(tabs)/_components/ClovrRushCallout.tsx` — **does not exist; needs to be created.**
3. `apps/bidder-app/app/clovrrush.tsx` — **does not exist; needs to be created (Sprint 2).**
4. `apps/bidder-app/app/(tabs)/_components/CategoryDrawer.tsx` — **does not exist (Sprint 2).**
5. `apps/bidder-app/app/(tabs)/_components/SearchBar.tsx` — **does not exist (Sprint 2).**
6. `apps/bidder-app/package.json` — **missing `expo-linear-gradient` dependency.**
7. `apps/bidder-app/app/(tabs)/index.tsx:673-704` — **only 3 SectionBanner instances; needs `mobile-bidding` 4th banner.**
8. `apps/bidder-app/app/(tabs)/profile.tsx` — **plain text, no v3 brand mark or 4-card layout.**
9. `apps/bidder-app/app/(tabs)/_layout.tsx:89` — **loading spinner uses old `#4f8cff`, should be `#5FE065`.**
10. `apps/bidder-app/app/(tabs)/_layout.tsx:103` — **`tabBarActiveTintColor: '#4f8cff'`** — same old palette in tab bar.
11. `apps/operator-web/src/app/not-found.tsx:145` — **`<img src="/icon.png" />` references a file that doesn't exist in `apps/operator-web/public/`.**
12. `apps/operator-web/src/app/download/page.tsx:33` — **OG card on v1 path; should be v3.**
13. `apps/operator-web/src/app/support/page.tsx:11` — **OG card on v1 path; should be v3.**
14. `apps/operator-web/src/app/signup/page.tsx:17` — **OG card on v1 path; should be v3.**
15. `apps/operator-web/src/app/(auth)/login/page.tsx:17` — **OG card on v1 path; should be v3.**
16. `apps/operator-web/src/app/(public)/browse/page.tsx:42` — **OG card on v1 path; should be v3.**
17. `apps/operator-web/src/app/(public)/lot/[code]/page.tsx:332` — **OG card on v1 path; should be v3.**
18. `apps/operator-web/src/app/pricing/page.tsx:31` — **OG card on v1 path; should be v3.**
19. `apps/operator-web/src/app/how-it-works/page.tsx:24` — **OG card on v1 path; should be v3.**
20. `apps/operator-web/src/app/operator-pitch/page.tsx:30` — **OG card on v1 path; should be v3.**

(All 9 of the v1 OG-card references collapse to one Sprint 1 cleanup task: "swap v1 OG URLs to v3 across operator-web metadata blocks.")

---

## Already shipped (no action needed)

The audit was written from the outside and missed substantial work already in `apps/bidder-app/`. None of these need re-doing.

| Item | Where it already lives | Status |
|---|---|---|
| Home hero ("Better Deals. Better Bids.") + CTA | `apps/bidder-app/app/(tabs)/index.tsx:657-663` (HomeHero component) | ✅ |
| Category grid (2-col phone, 4-col iPad, 16 categories with CDN images) | `apps/bidder-app/app/(tabs)/_components/CategoryGrid.tsx` | ✅ |
| Recent wins / social proof feed | `apps/bidder-app/app/(tabs)/index.tsx:671` (RecentWinsRail) — wired but verify on TestFlight | ✅ |
| Section banners (Ending soon, Pickup ready, Trusted auctions) — 3 of 4 web banners | `apps/bidder-app/app/(tabs)/index.tsx:673-704` (SectionBanner × 3) | ✅ (partial — missing mobile-bidding 4th banner) |
| LotCard with condition badge, discount %, watchlist star, bid count, time remaining (mac-bid variant) | `packages/domain-bidding/src/components/LotCard.tsx:1-80` | ✅ |
| Lot detail: SavingsCallout (SAVE % pill + strikethrough MSRP) | `apps/bidder-app/app/lot/[id].tsx:287-345` | ✅ |
| Lot detail: PickupInfoCard (Auction ends / Pickup by / NOT TRANSFERRABLE badge) | `apps/bidder-app/app/lot/[id].tsx:349-450` | ✅ |
| Lot detail: AnonymizedBidHistory (Bidder #N + YOU + "Show all" toggle) | `apps/bidder-app/app/lot/[id].tsx:536-666` | ✅ |
| Lot detail: SimilarLotsRail (3-tier fallback horizontal) | `apps/bidder-app/app/lot/[id].tsx:668-737` | ✅ |
| Lot detail: Pre-open state ("auction hasn't opened yet") | `apps/bidder-app/app/lot/[id].tsx` (`canBid = lot.status === 'live'` guards bid sheet) | ✅ |
| Login: Google SSO + Apple Sign In | `apps/bidder-app/app/(auth)/_oauth-buttons.tsx` | ✅ |
| Login: "Forgot password?" link → forgot-password screen | `apps/bidder-app/app/(auth)/login.tsx:114-120` + `forgot-password.tsx` | ✅ |
| Sign Up: email/password + Google/Apple buttons | `apps/bidder-app/app/(auth)/signup.tsx` | ✅ |
| 2-step bidder onboarding (DOB + consents → payment method) | `apps/bidder-app/app/(auth)/signup.tsx:91-161` + `complete-profile.tsx` + `profile/payment-method.tsx` | ✅ |
| 18+ age gate at signup | `apps/bidder-app/app/(auth)/signup.tsx:99-101` (`calcAge(dob) < 18`) | ✅ |
| Watchlist screen with heat-color countdown badge | `apps/bidder-app/app/(tabs)/watchlist.tsx` | ✅ |
| My Bids screen with Leading/Outbid/Won/Lost classification + live tick | `apps/bidder-app/app/(tabs)/my-bids.tsx` | ✅ |
| Splash + adaptive icon at v3 brand mark (clover + gold-gavel) | `apps/bidder-app/assets/{icon,adaptive-icon,splash}.png` | ✅ (in-app surfaces still need it though — see polish section) |
| Shared `cdn.clovrbid.com/v3/*` asset URLs (HomeHero, CategoryGrid, SectionBanner, LotCard no-photo) | Bidder-app reads same URLs as web | ✅ |

---

## Known bugs (from audit + new polish scan)

| Bug | Browser location | Status / fix |
|---|---|---|
| `/winners` returns 404 | Homepage "View all winners →" | 🟠 Backend-only fix in Sprint 1 — see Backend section. |
| Filter panel rendered twice in DOM | `/browse?view=lots`, `/clovrrush` | 🟠 Backend-only fix in Sprint 1 — `aria-hidden` on the off-screen instance. |
| "Auction ends" shows `—` on lot detail when `close_at` is null | `/lot/DEMO-000001` | 🟠 Backend-only — show "Goes live [starts_at]" instead. **Already fixed in `lot/[id].tsx:381-385`** for mobile (it falls back to `'—'` too — needs the same fix as web). 🔴 cross-cutting. |
| Android app "coming soon" but Play Console is verified | `/download`, homepage banners, AppPromoBanner Android CTA | 🟠 Backend-only — flip copy once Sprint 2 EAS Android build is on Play Internal. |
| 404 page uses different header style + broken icon ref | `/auction/[id]` 404 | 🟠 Backend-only fix in Sprint 1 — use full PublicHeader on 404 + fix `<img src="/icon.png" />` broken ref. |
| Gradient overlays silently render flat on iOS bidder-app | All v3 modernized components | 🟡 **NEW — Sprint 2 dep install fix.** `expo-linear-gradient` missing from `apps/bidder-app/package.json`. |
| 9 operator-web pages link to v1 OG cards | `download/page.tsx:33`, `support/page.tsx:11`, `signup/page.tsx:17`, `(auth)/login/page.tsx:17`, `(public)/browse/page.tsx:42`, `(public)/lot/[code]/page.tsx:332`, `pricing/page.tsx:31`, `how-it-works/page.tsx:24`, `operator-pitch/page.tsx:30`, `legal/[slug]/page.tsx:91`, `legal/page.tsx:11`, `(operator-marketing)/request-access/page.tsx:18` | 🟠 **NEW — Sprint 1 backend-only cleanup.** Swap `04_APP_SOCIAL/home-hero-social-1200x628.jpg` → `/v3/og/home-hero-og-1200x628.jpg` everywhere. |

---

## Field-mobile (staff app) — NOT covered by this audit

The browser audit was about the BIDDER experience. Field-mobile is the staff app
(`bidwizops` bundle). Important constraints to remember when you DO eventually
plan staff-app updates:

- **`expo-updates` is removed entirely** (`apps/field-mobile/app.config.ts:144-150`). Every staff change is a new EAS Build, not OTA.
- Staff app has different routes entirely: `(staff)/bins`, `checkout`, `inventory`, `layout`, `lotting`, `picker`. None of them have a bidder-experience analogue.
- Push iOS only — no `android` block in `apps/field-mobile/eas.json` (per `.github/workflows/eas-build.yml:50-54`).
- Field-mobile has **NO `cdn.clovrbid.com/v3/*` references at all** (verified by grep). When staff-app gets a v3 visual pass, it would inherit nothing automatically.
- Field-mobile also lacks `expo-linear-gradient` — same gap as bidder-app.

When you're ready to audit the staff experience, run a separate audit pass against `apps/operator-web/src/app/(operator)/` and compare to `apps/field-mobile/app/(staff)/`. That's a different document — don't bolt it onto this one.

---

## Workflow reference

**To ship Sprint 1 (OTA):**

```powershell
cd C:\Users\jmacl\Projects\auction-platform
# After merging Sprint 1 PRs to master:
gh workflow run "EAS Update (OTA)" --ref master `
  --field app=bidder `
  --field branches=both `
  --field message="v1.0.1 quality-of-life pass — profile + filters + recent-wins + AppPromoBanner + ClovrRushCallout"
```

(Note: `eas-update.yml` workflow lives on branch `chore/eas-update` commit `e0aa980`. Merge that PR first.)

**To ship Sprint 2 (new build):**

```powershell
cd C:\Users\jmacl\Projects\auction-platform
# After bumping version in app.config.ts:21 to 0.1.2:
# AND installing expo-linear-gradient: cd apps/bidder-app; npx expo install expo-linear-gradient
gh workflow run "EAS Build" --ref master `
  --field app=bidder `
  --field profile=production `
  --field platform=ios `
  --field submit=true
```

Then wait 24-48h for App Review.

---

## Open questions / risks

- **OTA reach risk:** Sprint 1 OTA only reaches users on `version: 0.1.1`. Once they update to v1.1 build (`0.1.2`), they need a NEW OTA bundle targeting 0.1.2 to pick up subsequent JS changes. Plan Sprint 1 to fully ship BEFORE Sprint 2 binary lands.
- **ClovrRush as a tab vs a header link:** putting it as a 7th tab crowds the bar. Alternative: put a red "RUSH" pill button in the Browse header that pushes onto the stack, mirroring the desktop nav. Decide before Sprint 2 starts. Audit says "dedicated screen/tab" but doesn't insist on tab placement.
- **Buyer's premium % data path:** verify `operators.buyer_premium_pct` exists before promising "Run by X · Buyer's premium: 15%" in Sprint 1. If it doesn't, this gets pushed to Sprint 2 + a migration.
- **iOS 26 launch crash regression risk:** per memory `auction_platform_ios26_launch_crash.md`, RNSScreen + Sentry caused the v13/v14 hang. Any Sprint 2 native change should run the Maestro smoke flow before submission. Don't reintroduce `@sentry/react-native` plugin.
- **`expo-linear-gradient` install risk:** the lib has had peer-dep churn between Expo 53→54. Run `npx expo doctor` after install. If it doesn't autolink cleanly, the current try/catch fallback in HomeHero/CategoryGrid/SectionBanner means the app keeps working — just without gradients. Don't ship the build if doctor complains.
- **Asset CDN single-point-of-failure:** today the entire visual surface depends on `cdn.clovrbid.com` (R2) being reachable. `expo-image` with `cachePolicy="memory-disk"` mitigates this after first launch, but first-launch over a flaky network shows flat backgrounds. Consider bundling the 4 SectionBanner mobile variants + the HomeHero + the brand icon into `apps/bidder-app/assets/` as a Sprint 2 polish item (P3). Not a launch blocker.

---

## Dependency hygiene (Expo doctor 2026-05-24)

Surfaced during EAS Build #7 (bidder iOS `840a3900`). All warnings — build still completed successfully. **None block v1.0 submission.** Document here so the v1.0.1 cleanup sprint catches them.

| Package | Current | Expo SDK 54 expected | Severity | Why we shipped anyway | v1.0.1 action |
|---|---|---|---|---|---|
| `react-native-screens` (duplicate) | 4.18.0 (bidder) + 4.24.0 (workspace root) | ~4.16.0 | 🟡 Medium | EAS Cloud deduplicates at install — the iOS IPA contains exactly ONE version. Bidder pinned to 4.18 after iOS 26 crash per memory `auction_platform_ios26_launch_crash.md`; don't auto-bump. | Pin workspace-root `react-native-screens` to match bidder pin (4.18.0) via `package.json` `overrides`. Re-run doctor to verify dedup. **Sprint 2 new build only — don't OTA, this is a native dep.** |
| `expo-checkbox` | 4.0.1 | ~5.0.8 | 🟡 Medium (major version gap) | Only used in bidder onboarding consent checkboxes (`I agree to ToS`, `I authorize ClovrBid to save my payment method`, etc). Renders + functions today on 4.0.1; major version bump = API change that needs verification. | `npx expo install expo-checkbox` in `apps/bidder-app`, then re-test onboarding flow. **Sprint 2 new build** (this is a native checkbox component, can't OTA). |
| `@stripe/stripe-react-native` | 0.55.1 | 0.50.3 | 🟢 Low | We're NEWER than Expo's recommended version. Usually means more fixes, not fewer. Live key flow (card save + PaymentSheet) tested cleanly on 0.55.1 — that's the version `acct_1TaMSs` ran the BIN-000035 demo against. | Leave at 0.55.1 unless we hit a regression. Add `"expo": { "install": { "exclude": ["@stripe/stripe-react-native"] } }` in `package.json` to silence the warning. |
| `@react-native-community/datetimepicker` | 8.6.0 | 8.4.4 | 🟢 Low | DOB picker on bidder onboarding step 1. Minor version bump, no API changes affecting DOB use case. | Same — silence warning via `expo.install.exclude` OR `npx expo install` to bump to recommended. |

**Why not fix all of this in v1.0:**

- Build #7 succeeded — IPA is known-good and Apple-validated
- We burned 7 EAS build cycles tonight already; another one for dep hygiene isn't warranted when builds aren't crashing
- All four warnings are non-runtime — they're "we're not on the exact version Expo recommends," not "the app will crash"
- v1.0.1 sprint can address checkbox + RN-screens dedup as part of native cleanup, alongside `expo-linear-gradient` install

**Verification scripts (for v1.0.1):**

```powershell
cd C:\Users\jmacl\Projects\auction-platform\apps\bidder-app
# Audit + auto-fix the easy ones
npx expo install --check
# Re-run doctor
npx expo doctor --verbose
```

If `expo-checkbox` 5.x changes the API in a breaking way, the consent-checkbox UI in `apps/bidder-app/app/bidder/onboarding/step-1.tsx` (or wherever the 4-checkbox flow lives) needs a quick render test before shipping the v1.1 build.

---

## UI polish: touchable buttons (user-flagged 2026-05-24)

> User feedback: "missing touchable looking buttons on the app"

The bidder-app currently uses bare `Pressable` + text without strong button affordance. Users may not realize what's tappable. Replace with a branded `BrandedButton` component that has:

- Solid background fill OR border outline (variants: `primary` / `secondary` / `ghost`)
- Pressed state styling (opacity 0.85 + slight translate or shadow change)
- Minimum tap target **44pt × 44pt** (Apple HIG / Google a11y baseline)
- Optional left/right icon slot
- Loading state with spinner

### Inventory of bare Pressables to upgrade (P0 for v1.0.1 OTA)

| Screen | Current | Should be | File path |
|---|---|---|---|
| Login | Bare Pressable "Sign in" | `<BrandedButton variant="primary">Sign in</BrandedButton>` | `apps/bidder-app/app/(auth)/login.tsx` |
| Login | "Continue with Google" | `<BrandedButton variant="ghost" leftIcon={<GoogleG/>}>` | same |
| Signup | Bare "Create account" | `primary` | `apps/bidder-app/app/(auth)/signup.tsx` |
| Onboarding step 1 | "Continue to payment method" | `primary` | `apps/bidder-app/app/bidder/onboarding/*` |
| Lot detail | "Place Bid" / "Watch this lot" | `primary` + `secondary` | `apps/bidder-app/app/lot/[id].tsx` |
| Profile | "Sign out" / "Add a card" | `ghost` + `primary` | `apps/bidder-app/app/(tabs)/profile.tsx` |
| Forgot password | "Send reset link" | `primary` | `apps/bidder-app/app/(auth)/forgot-password.tsx` |

### Effort

- New `BrandedButton.tsx` in `packages/design-system/src/components/` — 2h
- Roll out across the 7 screens above — 3h
- **Total: 5h, P0, Sprint 1 OTA-able**

---

## UI polish: tab bar (user-flagged 2026-05-24)

> User feedback: "the basic ass little triangle tabs on the ios app"

Current `apps/bidder-app/app/(tabs)/_layout.tsx` uses Expo Router's default `Tabs` which renders the stock iOS tab bar — small icons + labels + a thin chevron/triangle indicator. Looks unbranded.

### What to do

1. Custom tab bar component using Expo Router's `tabBar` prop:
   - Solid dark background (matching design tokens — `bg-surface`)
   - Branded active indicator: solid green pill OR top border in `#5FE065` brand color
   - Larger icon size (28px instead of 24px)
   - Active state: filled icon + branded color
   - Inactive state: outline icon + muted color
   - Badge support (e.g., ClovrRush count, watchlist count)

2. Replace stock vector icons with v3 brand-aligned icon set:
   - Browse: shopping bag / storefront
   - Watchlist: bookmark / star
   - My Bids: gavel / hand
   - Scan: QR code
   - Pickup: package / box
   - Profile: user circle

3. Optional: add a center-emphasized ClovrRush button when active (red pulsing dot when LIVE count > 0).

### Effort

- Custom `CustomTabBar.tsx` component — 3h
- Icon set audit / swap — 1h
- Active/inactive styling + badge support — 2h
- **Total: 6h, P0, Sprint 1 OTA-able** (styling only; no new native modules)

---

## Reporting & data — bidder + operator dashboards (user-flagged 2026-05-24)

> User feedback: "We need to think about reporting and data for all users as well"

Two audiences need different reporting surfaces. Both are post-v1.0 work.

### Bidder-side ("My Stats" screen on mobile + web)

New screen accessible from Profile. Shows the bidder their own activity.

| Metric | Source | Why |
|---|---|---|
| Total won (count + dollar) | `invoices` where `bidder_id = me` AND `status IN ('paid','picked_up')` | Engagement |
| Total saved (sum of MSRP - winning bid) | `lots.msrp_cents - invoices.subtotal_cents` | Brag-worthy |
| Top 3 categories by spend | `lots.category` × `invoices.subtotal_cents` | Personalization signal |
| Win rate | `count(won) / count(bid)` last 30d | Confidence metric |
| Pickup history | `invoices` where `status = 'picked_up'`, last 10 | Receipt-style list |
| Avg time-to-pickup | `picked_up_at - paid_at` | Operator metric (do bidders show up?) |

**Effort:** 1d mobile + 1d web (shared component if possible) = 2d total. P1, Sprint 1 OTA-able for mobile (read-only data), Sprint 1 web deploy for browser. New `/api/bidder/stats` route on operator-web.

### Operator-side (Reports tab — already exists at /reports)

Per audit, `/reports` exists in the operator console. Audit it + expand:

| Report | Has it now? | Action |
|---|---|---|
| GMV (today / 7d / 30d / YTD) | TBD — read `apps/operator-web/src/app/(operator)/reports/page.tsx` first | Add if missing |
| Top 10 lots by close price | ? | Add |
| Top 10 bidders by GMV | ? | Add |
| Lots sold vs unsold (auction-level conversion) | ? | Add |
| Buyer-premium revenue | ? | Add |
| Settlement / Stripe payout summary | ? | Add — read from `payouts` table |
| Pickup completion rate | ? | Add — `picked_up_at IS NOT NULL` / total won |
| Dispute rate + resolution | ? | Add — read `disputes` table |
| Refund volume (`refund_window_post_pickup_hours` applied) | ? | Add |

**Effort:** Depends entirely on what's already at /reports. Could be 1d (add 2 missing reports) or 5d (build from scratch). Read the file first then estimate. P1, Sprint 1 web deploy. **Backend-only — does not affect mobile binary.**

### Mobile analytics event coverage (Sprint 1 OTA)

Verify PostHog event coverage matches web. Web sends ~40 events; mobile likely sends fewer. Audit `apps/bidder-app/` for `posthog.capture()` calls and compare to web's event taxonomy:

| Event | Web has it? | Mobile has it? | Should mobile have it? |
|---|---|---|---|
| `bidder_signup_started` | ✅ | ? | ✅ yes |
| `bidder_signup_completed` | ✅ | ? | ✅ yes |
| `bidder_onboarding_completed` | ✅ | ? | ✅ yes |
| `lot_viewed` | ✅ | ? | ✅ yes (key funnel) |
| `bid_placed` | ✅ | ? | ✅ yes |
| `bid_outbid` | ✅ | ? | ✅ yes |
| `won_lot` | ✅ | ? | ✅ yes |
| `payment_completed` | ✅ | ? | ✅ yes |
| `pickup_started` | ✅ | ? | ✅ yes (mobile-only QR scan flow) |
| `pickup_completed` | ✅ | ? | ✅ yes |
| `dispute_opened` | ✅ | ? | ✅ yes |
| `watchlist_added` / `watchlist_removed` | ✅ | ? | ✅ yes |

**Effort:** 4h audit + add missing events. P1, Sprint 1 OTA-able. New file `apps/bidder-app/lib/analytics.ts` to centralize event names + properties.

---

## v1.0.1 patch — TOTAL SCOPE

Combining all Sprint 1 items (existing 19 + new ones above):

| Stream | Items | Effort | OTA-able? |
|---|---|---|---|
| Browser audit gap-closers (profile, filters, AppPromoBanner, RecentWins) | 14 | ~15h | ✅ Yes |
| Touchable button polish | 7 screens + new component | 5h | ✅ Yes |
| Tab bar polish | New CustomTabBar | 6h | ✅ Yes |
| Bidder "My Stats" screen | 1 new screen | 8h | ✅ Yes |
| Mobile analytics event coverage | Audit + ~12 events | 4h | ✅ Yes |
| Operator-web reporting expansion | Depends on /reports state | 8-40h | Backend-only |
| **Total v1.0.1 mobile OTA** | | **~38h** | |
| **Total v1.0.1 web deploy** | | **~10h-40h** | |

**Realistic ship timeline:** 2-3 working days for mobile patch, parallel with web reporting work. Land everything on master, hold the OTA dispatch until Apple approves v1.0. Then fire `gh workflow run "EAS Update (OTA)" --field branches=both` and users get it on next app launch.
