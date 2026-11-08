# Privacy Policy

**BinGo Auctions — Operated by RDW, LLC**
Effective date: July 8, 2026
Version: 1.1

---

## 1. Who We Are

RDW, LLC d/b/a BinGo Auctions is an Arkansas limited liability company operating the BinGo Auctions online auction at https://bingoauctions.com and its mobile apps (collectively, the "Service"). We are the seller and auctioneer for the auctions we run. When this policy says "we," "us," or "our," it means RDW, LLC. When it says "you," it means you — whether you are a Bidder using our app or website or just a visitor to our site.

This policy describes what personal information we collect, why we collect it, who we share it with, how long we keep it, and what rights you have over it.

Contact us about privacy at privacy@bingoauctions.com.

---

## 2. Information We Collect

### 2.1 Information You Give Us Directly

**Account registration.** When you create a BinGo Auctions account, we collect your name, email address, and a password (stored as a salted hash — we never store plaintext passwords). You may also give us your ZIP code; it is optional.

**Profile and preferences.** You may optionally add a phone number, a ZIP code, notification preferences, and a pickup contact name. We use your ZIP code only to understand where our bidders live so we can plan auctions and pickup locations near you; you can change or remove it in your profile at any time.

**Payment information.** When you add a payment method, your card number and full billing details are entered directly into Square's hosted payment fields and go to Square, not to our servers. We store only the Square-provided card token, last-four digits, card brand, and expiration month/year so we can display your saved method in the app. If you have not given us a ZIP code, we also copy the 5-digit billing ZIP code you entered with your card from Square and save it as your account ZIP code. You can change it in your profile.

**Identity verification.** If we require identity verification, it is performed by a third-party verification provider that collects and processes your government-issued ID on its own infrastructure. We receive only the verification result (verified / not verified / requires review). We do not store copies of your ID documents.

**Content you submit.** As a Bidder, this includes bid amounts, dispute descriptions, and dispute photos you upload at pickup.

**Communications.** If you contact us by email or through a support channel, we retain the content of that communication and your contact information.

### 2.2 Information We Collect Automatically

**Usage data.** Our servers log IP addresses, HTTP request metadata, pages and screens visited, features used, and session timestamps. These logs are stored in Cloudflare and our Supabase database.

**Device and app data.** Our mobile app (built with Expo) collects your device model, operating system version, and Expo push notification token so we can send you bid and pickup notifications. We do not collect device serial numbers or advertising identifiers.

**Error and performance data.** We use Sentry for application error monitoring. When the app or website encounters an error, Sentry captures a stack trace, the screen or URL where the error occurred, and limited contextual data. We configure Sentry to strip or mask personal data from error reports, but we cannot guarantee that all PII is excluded from every error event.

**Product analytics.** We use PostHog for product analytics and session recording. PostHog collects page views, click events, feature interactions, session replays, and a pseudonymous identifier linked to your account. Session recording captures what you interact with on screen; PostHog is configured to mask input fields that contain passwords or payment data. We use this data to understand how the product is used and to improve it.

**Cookies and similar technologies.** Our website uses cookies and similar tracking technologies for session management, security (CSRF protection), analytics (PostHog), and advertising (the Meta Pixel).

The Meta Pixel is different in kind from the others: it is an **advertising** technology, and the data it collects is used by Meta for its own advertising purposes, not only ours. You can turn it off at [Your privacy choices](/privacy-choices), and we honor Global Privacy Control signals automatically. Turning it off also stops the server-side advertising data described in Section 4, so a single choice covers both.

We are deploying a general cookie consent banner before broad public launch. Until that banner is in place, PostHog analytics and Sentry error tracking are loaded on all page visits. If you wish to opt out of PostHog tracking before the consent banner is available, contact privacy@bingoauctions.com and we will suppress your tracking manually.

### 2.3 Information We Receive from Third Parties

**Square.** After you connect a payment method, Square sends us confirmation metadata (payment method tokens). Square may share fraud signals with us in connection with a specific transaction.

**Device OS notification services.** When you grant notification permissions, your device's operating system (Apple APNS or Google FCM) routes push notifications through Apple's or Google's infrastructure. We pass your push token to those services to deliver messages; they handle delivery.

---

## 3. How We Use Your Information

We use the personal information we collect for the following purposes:

**Operating our auctions.** Processing bids, managing auctions, generating invoices, facilitating payments through Square, tracking pickup scheduling and completion, and providing the core functionality of the Service.

**Account management.** Creating and authenticating your account, verifying your identity when required, managing your notification preferences, and supporting account recovery.

**Communications.** Sending you transactional emails and push notifications about bids placed, outbid alerts, auction wins, payment confirmations, invoices, dispute updates, and pickup reminders. These messages are required for operation of the Service; you cannot unsubscribe from transactional messages while your account is active.

**Marketing communications.** If you have opted in, we may send you promotional emails about new features, promotions, or BinGo Auctions news. Every marketing email includes a one-click unsubscribe link and our mailing address. You can unsubscribe at any time without affecting your ability to use the Service.

**SMS notifications.** We may send SMS messages for bid alerts or pickup reminders only if you have affirmatively opted in to SMS communications. We retain a record of your opt-in consent, including the timestamp, the message you consented to, and your phone number. You can opt out of SMS at any time by replying STOP.

**Fraud prevention and security.** Detecting, investigating, and preventing fraudulent transactions, chargeback abuse, shill bidding, account takeover, and other abuse of the Service.

**Legal compliance.** Retaining records necessary to comply with tax law, responding to lawful legal process, and meeting our obligations under applicable regulations.

**Product improvement.** Using aggregated and pseudonymized analytics data to understand how the Service is used, identify usability problems, and prioritize new features. We do not make individual-level product decisions based on session recordings.

**Dispute resolution.** Preserving bid history, payment records, listing photos, and dispute correspondence to enable resolution of disputes and to defend against legal claims.

---

## 4. How We Share Your Information

We do not sell your personal information.

We **do** share a limited set of information with Meta (Facebook/Instagram) for advertising, as described under "Meta Platforms" below. This is the only sharing we do for advertising purposes. You can opt out at any time, for any reason, at [Your privacy choices](/privacy-choices) — see Section 8. We honor Global Privacy Control signals automatically.

Otherwise, we share information only as follows:

**Square (Block, Inc.)** We share payment information with Square for payment processing and fraud detection. Square is an independent data controller for the data it holds. See https://squareup.com/us/en/legal/general/privacy.

**Supabase, Inc.** Our primary database and authentication layer is hosted on Supabase, which runs on AWS infrastructure. All data stored in our database (account records, bid history, auction data, etc.) resides on Supabase's servers. Supabase processes this data as our data processor under a Data Processing Agreement.

**Cloudflare, Inc.** Our website, API, and content delivery are served through Cloudflare's network. Cloudflare processes request logs, IP addresses, and traffic metadata as our data processor. See https://www.cloudflare.com/privacypolicy/.

**Sentry (Functional Software, Inc.)** Error reports and stack traces are sent to Sentry for monitoring and debugging. We configure Sentry to minimize PII in these reports. Sentry processes this data as our data processor.

**PostHog, Inc.** Product analytics events and session recordings are sent to PostHog. PostHog may process your pseudonymous user ID and behavioral data as our data processor.

**Meta Platforms, Inc. (Facebook/Instagram) — advertising.** So that we can measure whether our advertising works and reach people likely to be interested in our auctions, we send Meta a limited record of certain actions: creating an account, placing your first bid, and paying an invoice (including the invoice total).

Two things about this are worth stating plainly. First, unlike the processors above, **Meta is not acting solely on our instructions** — it uses this data for its own advertising systems, including building audiences that resemble our customers. Second, where your email address or phone number is included, it is **hashed (SHA-256) before it leaves our servers**; we never send Meta your email address or phone number in readable form. We also send the identifiers Meta's own pixel set in your browser (its `_fbp` and `_fbc` cookies), which are what let Meta connect a purchase back to the advertisement you clicked; these are Meta's identifiers rather than yours, and opting out erases them. We do not send Meta your bid history, the items you browse, your address, your IP address, or your payment details.

Some of this is collected in your browser by the Meta Pixel, and some is sent directly from our servers, so opting out covers both. See [Your privacy choices](/privacy-choices).

**Law enforcement and legal process.** We will disclose information to law enforcement, courts, or regulators when we are legally required to do so or when we believe in good faith that disclosure is necessary to prevent imminent harm, comply with a legal obligation, or protect the rights and safety of our users or the public.

**Business transfers.** In the event of a merger, acquisition, or sale of all or substantially all of our assets, your information may be transferred to the acquiring entity. We will notify you by email or prominent notice on the website before your information is transferred and becomes subject to a different privacy policy.

---

## 5. Retention Periods

We keep your information only as long as we need it for the purposes described in this policy or as required by law.

- **Active account data** (profile, contact information, notification preferences): retained for the life of your account plus 3 years after account closure to support dispute resolution and legal claims.
- **Bid and transaction records**: retained for 7 years after the transaction date to comply with tax and audit requirements.
- **Payment method tokens**: retained until you remove them from your account; underlying card data is stored by Square only.
- **Identity verification results**: retained for 3 years after the verification event or for the life of your account, whichever is longer, to support fraud investigations.
- **Error logs (Sentry)**: retained for 90 days within Sentry's platform per our account configuration.
- **Product analytics events (PostHog)**: retained for 24 months within PostHog per our account configuration.
- **Server access logs (Cloudflare)**: retained for up to 30 days in log storage; aggregate traffic data retained longer.
- **Dispute records and photos**: retained for 5 years after the dispute closes.
- **Marketing consent records**: retained for 5 years after consent is given or withdrawn, to demonstrate compliance.

When we delete data, we delete or anonymize it such that it can no longer be linked to an identifiable individual. Anonymized aggregate data may be retained indefinitely.

---

## 6. Security

We use commercially reasonable administrative, technical, and physical safeguards to protect your information from unauthorized access, alteration, disclosure, or destruction. These include:

- TLS encryption for all data in transit between your device and our servers.
- Database encryption at rest on Supabase's infrastructure.
- Row-level security policies in the database that limit which records each authenticated user can read.
- API authentication using short-lived JWTs issued by Supabase Auth.
- Square's PCI-compliant infrastructure for all payment card data.

No security system is impenetrable. We cannot guarantee that your information is completely secure. If you discover a security vulnerability, please report it responsibly to legal@bingoauctions.com.

In the event of a data breach that is reasonably likely to result in harm to affected individuals, we will notify affected users and relevant authorities as required by applicable state breach-notification laws.

---

## 7. Your Privacy Rights

Depending on where you live, you may have rights regarding your personal information. We honor the rights described below for all US-resident users regardless of state, as a matter of policy.

### 7.1 Access

You can request a copy of the personal information we hold about you. We will provide it in a portable, machine-readable format (JSON or CSV) where technically feasible.

### 7.2 Correction

You can request that we correct inaccurate personal information we hold about you.

### 7.3 Deletion

You can request that we delete your personal information. We will delete or anonymize your data, subject to legal holds: we retain transaction records for the retention periods described in Section 5 as required by tax and audit law, and we may retain information needed to detect or prevent fraud.

### 7.4 Portability

You can request a machine-readable export of the data you provided to us directly (bid history, profile data, transaction records).

### 7.5 Opt Out of Sale or Sharing

We do not sell personal information.

We **do** share personal information for cross-context behavioral advertising, as that term is used under California law: we send Meta the account, first-bid, and purchase events described in Section 4 so that Meta can measure and target advertising. You have the right to opt out of this, and you can exercise it at any time at [Your privacy choices](/privacy-choices). We also treat a Global Privacy Control browser signal as a valid opt-out request and honor it automatically, without requiring you to do anything else.

### 7.6 Opt Out of Profiling

We do not use your personal information to make automated decisions that produce legal or similarly significant effects on you. If we introduce such features, we will update this policy and provide an opt-out right.

### 7.7 Non-Discrimination

Exercising any of the rights above will not result in denial of the Service, different prices, or a different level of quality from us.

### 7.8 Submitting a Request

To exercise any of these rights, email privacy@bingoauctions.com with your name, the email address associated with your account, and a description of your request. We will verify your identity before processing any request.

**California residents (CCPA/CPRA):** We will respond to verifiable consumer requests within 45 days. If we need an extension (up to an additional 45 days), we will notify you. You may authorize an agent to submit a request on your behalf by providing the agent with written authorization and directing them to privacy@bingoauctions.com.

**Texas residents (TDPSA):** We will respond within 45 days, with a possible 45-day extension upon notice. You may appeal a denied request by emailing privacy@bingoauctions.com with "TDPSA Appeal" in the subject line.

**Virginia residents (VCDPA):** We will respond within 45 days, with a possible 45-day extension. You may appeal a denial within a reasonable time by emailing privacy@bingoauctions.com with "VCDPA Appeal" in the subject line.

**Colorado residents (CPA):** We will respond within 45 days, with a possible 45-day extension. You may appeal a denied request by emailing privacy@bingoauctions.com with "CPA Appeal" in the subject line. If your appeal is denied, you may contact the Colorado Attorney General.

---

## 8. Categories of Personal Information — CCPA/CPRA Disclosure

The following table summarizes the categories of personal information we collect, the business purposes for collection, and the categories of third parties we share each category with. We collect all categories described below. We have not sold any category in the preceding 12 months. We share identifiers and commercial information with Meta for cross-context behavioral advertising, as described in Section 4; we have not shared any other category for that purpose.

| Category | Examples | Collected | Business Purpose | Shared With |
|---|---|---|---|---|
| Identifiers | Name, email, IP address, device ID, account ID | Yes | Account operation, fraud prevention | Square, Supabase, Cloudflare, Sentry, PostHog |
| Personal records | Phone number, mailing address, ZIP code | Yes (optional) | Notifications, pickup contact, planning auction locations | Supabase |
| Commercial information | Bid history, transaction records, items won | Yes | Auction operation, dispute resolution | Square, Supabase |
| Internet / network activity | Clickstream, session data, error logs | Yes | Product improvement, security | Sentry, PostHog, Cloudflare |
| Geolocation | IP-derived approximate location; ZIP code you provide | Yes (inferred; ZIP optional) | Fraud detection, regional compliance, planning auction locations | Cloudflare (log data), Supabase |
| Sensitive — government ID | Used in identity verification flow | Via third-party provider only | Age/identity verification | Third-party verification provider (not stored by us) |
| Financial account information | Card token (last 4, brand, expiry) | Yes | Payment processing | Square |

---

## 9. Children's Privacy

BinGo Auctions is not directed to individuals under 18. We do not knowingly collect personal information from anyone under 18. If we become aware that we have collected personal information from a minor, we will delete it promptly. If you believe we have collected information from a minor, contact privacy@bingoauctions.com.

---

## 10. International Users

BinGo Auctions is operated in the United States and is currently available to US residents only. If you access the Service from outside the United States, your information will be transferred to and processed in the United States, where data protection laws may differ from those in your country.

---

## 11. Changes to This Policy

We will update this policy from time to time by posting a new version at /legal/privacy with an updated effective date and version number. For material changes, we will provide advance notice by email. Your continued use of the Service after the effective date means you accept the updated policy.

---

## 12. Contact

**RDW, LLC d/b/a BinGo Auctions**
Privacy inquiries: privacy@bingoauctions.com
General legal: legal@bingoauctions.com
Website: https://bingoauctions.com
