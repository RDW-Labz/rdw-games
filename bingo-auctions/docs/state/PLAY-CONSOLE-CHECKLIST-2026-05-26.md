# Google Play Console — complete submission checklist (2026)

Paste-ready answers for BOTH apps. Reflects the current (2026) Play Console
"App content" + Dashboard flow. Sections marked **[API DONE]** are already
committed via the androidpublisher API; everything else is **console-only**
(Google provides no API for content rating, data safety, target audience,
or the policy declarations — a human must complete them).

## App identifiers

| | Bidder | Staff |
|---|---|---|
| Store name | **ClovrBid** | **ClovrBid Staff** |
| Package | `com.cluerholdings.auctionplatform` | `com.cluerholdings.bidwizops` |
| Developer | RDW, LLC (Organization account) | same |
| AAB uploaded | production draft, versionCode 12 | production draft, versionCode 3 |

## Shared facts (use for both apps)

- **Privacy policy URL:** `https://clovrbid.com/legal/privacy`
- **Contact email:** `legal@clovrbid.com`
- **Website:** `https://clovrbid.com`
- **Developer account type:** Organization (RDW, LLC) → **exempt** from the
  14-day/12-tester closed-testing gate. Both apps may go straight to
  production review.

---

## SECTION-BY-SECTION (Policy and programs -> App content)

Work top to bottom. Each must show a green check before "Send for review" unlocks.

### 1. Privacy policy
- Both apps: paste `https://clovrbid.com/legal/privacy` -> Save

### 2. App access (important — both apps need login)
- Choose: **"All or some functionality is restricted"**
- Add instructions:
  - **Bidder** — Name: "Reviewer login". Username `reviewer@clovrbid.com`, Password `ReviewMe2026Clovr!`. Instructions: "Email + password login. A persistent demo auction with 3 live lots is always available after sign-in."
  - **Staff** — Name: "Demo staff login". Username `demo-staff@clovrbid.com`, Password `DemoStaff2026!`. Instructions: "Invite-only operator staff app. This demo account is tied to the Demo Auctioneer operator. After login you land on the staff hub (Put-away, Check Out, Worklist, Layout, Lotting)."

### 3. Ads
- Both apps: **No, my app does not contain ads** -> Save  *(Staff already saved)*

### 4. Content ratings (IARC questionnaire) — do as a human, ~2 min
- Email: `legal@clovrbid.com`
- Category: **All other app types** (not a game)
- Accept IARC Terms of Use
- Answer every question **No**:
  - Violence — No
  - Sexuality / nudity — No
  - Profanity / crude humor — No
  - Controlled substances (drugs/alcohol/tobacco references) — No
  - **Gambling / simulated gambling / contests — No** (ascending-price auctions for real goods are NOT gambling)
  - User-generated content / user-to-user communication — No (operators post listings; bidders don't message each other)
  - Shares user location with other users — No
  - Allows purchase of digital goods — No (physical goods only)
  - Any "miscellaneous" prompts — No
- -> Result: **Everyone** (US) / **PEGI 3**. Save -> Submit.

### 5. Target audience and content
- Target age group: select **18+** only (uncheck all under-18 boxes)
- "Could your app appeal to children?" -> **No**
- Google Play for Families -> not enrolled

### 6. Data safety — console-only, the longest form

First question: **"Does your app collect or share any of the required user data types?" -> Yes**

For each data type below: **Collected = Yes · Shared = No · Processed ephemerally = No · Encrypted in transit = Yes**
(Stripe / Supabase / Sentry / Cloudflare are *processors*, not "sharing" for their own use -> Shared = No.)

**Security questions (both apps):**
- Is all collected data encrypted in transit? -> **Yes**
- Do you provide a way for users to request data deletion? -> **Yes**

#### Bidder data types + purpose

| Data type | Sub-type | Purpose(s) | Optional? |
|---|---|---|---|
| Personal info | Name | Account management, App functionality | Required |
| Personal info | Email address | Account management, App functionality | Required |
| Personal info | User IDs | App functionality, Analytics | Required |
| Personal info | Phone number | App functionality (SMS notifications) | **Optional** |
| Financial info | Purchase history | App functionality, Account management | Required |
| App activity | App interactions | Analytics, App functionality | Required |
| App activity | In-app search history | App functionality (saved searches) | Required |
| App info & performance | Crash logs | App functionality (Sentry) | Required |
| App info & performance | Diagnostics | App functionality (performance/Sentry) | Required |
| Device or other IDs | Device or other IDs | Analytics, App functionality | Required |

- **Do NOT declare "Payment info."** Card data is collected directly by Stripe's SDK; the app/servers never receive or store card numbers, so per Google's payment-processor guidance it is not your app's collection.
- Approximate location: **optional/operator's call.** Coarse region is derived server-side from IP (Cloudflare) for US-only/fraud, not via device GPS. For maximum candor add Location -> Approximate location -> App functionality, Fraud prevention. Otherwise omit (defensible — the app holds no location permission).

#### Staff data types + purpose (much smaller — internal tool)

| Data type | Sub-type | Purpose(s) | Optional? |
|---|---|---|---|
| Personal info | Email address | App functionality (login) | Required |
| Personal info | User IDs | App functionality | Required |
| App info & performance | Crash logs | App functionality (Sentry) | Required |
| App info & performance | Diagnostics | App functionality (Sentry) | Required |

- **No** location, **No** financial/purchase, **No** app-activity analytics, **No** advertising IDs.

### 7. Government apps
- Both: **No, this is not a government app** -> Save

### 8. Financial features  *(newer required declaration — matters for Bidder)*
- **Bidder:** the prompt lists financial product categories (personal loans, debt management, crypto, investments/trading, insurance, etc.). ClovrBid is a **marketplace for physical goods**, none of those. Select **"My app doesn't provide any of these financial features."**
  - If asked about "facilitates transactions / e-commerce" -> it's a goods marketplace using a licensed processor (Stripe); not a regulated financial product.
- **Staff:** none -> "My app doesn't provide any of these financial features."

### 9. Health apps
- Both: **No** (not a health app) -> Save

### 10. News apps
- Both: **No, my app is not a news app** -> Save

### 11. (If shown) permissions / photo & camera
- Camera is used for QR/barcode scanning + lot photos -> declare camera as "App functionality" if prompted. No background location, no SMS/Call Log, no high-risk permissions.

---

## STORE LISTING + SETTINGS

### Main store listing [API DONE]
- Titles + short + full descriptions already committed via API for both apps.
- **Still needs (console, file uploads):**
  - **App icon** 512x512 PNG
  - **Feature graphic** 1024x500 PNG (required to publish)
  - **Phone screenshots** — min 2, max 8. Play accepts the raw 1206x2622 phone PNGs directly (ratio 9:16, within Play's 320-3840px rule — no resize needed for Play).
    - Staff: the 4 in `docs/screenshots/staff/` (field-ops, put-away, check-out, lotting)
    - Bidder: the Browse / Watchlist / My-bids / Pickup set

### Store settings [partially API-able]
- App category: **Shopping** (Bidder) / **Business** (Staff)
- Tags: pick closest from Google's fixed list ("Barcode scanner", "Productivity" for Staff)
- Contact email: `legal@clovrbid.com`

---

## FINAL STEP — send to review

Once every App-content section is green + listing has icon/feature-graphic/screenshots:

1. **Production** (left nav) -> **Releases** -> the draft release (vc12 bidder / vc3 staff is already there)
2. Add **release notes** ("First public release of ClovrBid." / "First public release of ClovrBid Staff.")
3. **Countries/regions:** add **United States** (US-only launch)
4. Click **"Next" -> "Send X for review"**
5. Google review: typically 1-3 days (Org account, no testing gate). Email on decision.

---

## Already DONE via API (don't redo)

- Store listing titles + short + full descriptions (both apps) — committed
- AAB uploaded to production track (both apps) — vc12 bidder, vc3 staff
- Service account has Release Manager access (both apps)

## ONLY a human can do (no API exists)

Content rating (IARC) · Data safety · Target audience · App access · Government/Financial/Health/News declarations · image uploads (icon/feature graphic/screenshots) · clicking "Send for review". Budget ~15-20 min per app with this sheet open.

## Sources (current Google docs, fetched 2026-05-26)

- Prepare your app for review — https://support.google.com/googleplay/android-developer/answer/9859455
- Provide info for Data safety — https://support.google.com/googleplay/android-developer/answer/10787469
