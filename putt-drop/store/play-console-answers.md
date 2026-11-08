# Putt Drop: Play Console answers (draft for Braden)

Drafts only. Braden reads every question in Play Console and answers it himself. Items marked CHECK may be worded
differently in the current form.

## App content → Privacy policy
https://rdwlabz.com/privacy (RDW, LLC, 1301 N Main St, Harrison, AR 72601). CHECK it is live and covers purchases,
no ads/analytics and not directed to under-13s before entering it in Play Console.

## App content → Ads
No, my app does not contain ads.

## App content → App access
All functionality is available without special access. (The unlock is a normal Play purchase, not a login.)
CHECK: if Play review asks how to reach paid holes, say "license testers get the purchase free; holes 1-12 are free".

## App content → Content rating (IARC questionnaire)
- Email: devops@therdw.com.
- Category: Game (casual / sports). CHECK the exact category list.
- Violence: No. Blood: No. Fear/horror: No.
- Sexuality / nudity: No. Crude humor: No. Language / profanity: No.
- Controlled substances (drugs, alcohol, tobacco): No.
- Gambling (real or simulated): No. Loot boxes / random paid items: No.
- Users can interact or exchange content with each other: No. Shares the user's location: No.
- Digital purchases: **Yes** (one in-app purchase, unlocks the full game).
- Unrestricted internet / web browser: No.
- Expected result: Everyone / PEGI 3 / USK 0, with the "In-App Purchases" notice.

## App content → Target audience and content
- Target age groups: **13-15, 16-17, 18 and over**. Do NOT tick any group under 13.
- "Could your store listing unintentionally appeal to children?": No. Keep the listing art neon/minimal, no cartoon
  characters, no kid-style wording. CHECK: if Google flags it as appealing to kids, we answer their follow-up; that
  would pull in the Families policy, which we want to avoid.

## App content → Data safety (decided by Braden 2026-10-13)
- Does your app collect or share any of the required user data types? **Yes** (only the item below).
- **App info and performance → Diagnostics**: collected, **not shared**, **not linked to the user**, processed
  ephemerally is not claimed; purpose: App functionality. Collected by Google's Play Billing Library (its
  `datatransport` diagnostics; the reason the app has INTERNET/ACCESS_NETWORK_STATE, see docs/billing.md).
  Collection is required (no opt-out in the game).
- Everything else: not collected. Progress, settings and the "unlocked" flag stay on the device. The game code makes
  no network requests. Payment data is handled by Google Play's billing system and does not need to be declared by us
  (Play Console Help: Data safety, payment service exception).
- Is all user data encrypted in transit? Yes (Google's library sends over HTTPS).
- Do you provide a way to request data deletion? We hold no user data; the privacy policy contact email works.
- No ads, analytics, crash reporting or other third-party SDKs that collect data.
- Privacy policy (https://rdwlabz.com/privacy) must include: "Google's billing library may send basic diagnostics to
  Google." (rdwlabz.com is edited in Braden's other session.)

## App content → other declarations
- Government app: No. Financial features: None. Health: No. News: No. COVID: No.
- Data safety "Independent security review": skip.

## Store settings
- App or game: Game. Category: Sports (alternative: Casual). Tags: Mini golf, Casual, Offline. CHECK available tags.
- Contact email: devops@therdw.com. Website: https://rdwlabz.com.

## Monetization
- App is **Free** (free download with in-app purchase). Not "Paid".
- In-app product: one-time, non-consumable "Unlock full game" (`unlock_full`), about $2.99 USD. Price is set only with
  Braden's go (stop point).
- Payments profile: Braden enters bank and tax info himself (walk-through at that stop).
