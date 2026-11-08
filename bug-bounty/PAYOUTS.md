# Payouts — every dollar lands in RDW Labz

Standing instruction (Michael, 2026-11-01): **all payouts go to RDW Labz, using payment forms we
already own.** Nothing routes to a personal account, and no new processor gets signed up while an
owned rail exists.

## What we own, verified live 2026-11-01

The Square merchant behind SquareHub is connected with a production token at location
**`L7YP1B2MC8CJY` — "RDW", Harrison AR** (merchant `ML4NQHZS1KS9D`, business name *Discount Bins US*;
25 locations on the account, 7 active). This is a live money rail we already run — not a sandbox,
not a new signup.

| Offer | Amount | Link | Square object |
|---|---|---|---|
| DNS Hygiene Audit — single zone sweep | **$1,500** | https://square.link/u/h41lTw3P | payment link `SCTFMRRWANM7Q7XG` · order `kOpGLVCRC3agkQaam39vEt70uRLZY` |
| DNS Hygiene Monitoring — 1 month | **$750** | https://square.link/u/7GnO5RnD | payment link `5NXCAVKNUGMCGB26` · order `EGFGLitIHFtVEuFlGxT94onVzPbZY` |

Both verified by reading them back from Square (correct amount, `location_id=L7YP1B2MC8CJY`) and by
fetching the public URL (HTTP 200). They are payable today.

**Resolved (Michael, 2026-11-01):** RDW Labz is a **DBA of RDW**, and RDW also owns Discount Bins.
The merchant name *Discount Bins US* is therefore the same legal entity — no change needed, and a
deposit shows against RDW either way. If a receipt should read *RDW Labz* instead, add it as a DBA
in the Square dashboard; the payment links keep working.

No Square location was named "RDW Labz", so one was created on 2026-11-01 at Michael's direction:
**`L6WC96AFWEZP8` — "RDW Labz"**, ACTIVE, 601 US-62 65 S., Harrison AR 72601, cloned from the corporate
"RDW" location. Same merchant means the **same bank settlement account and fee schedule** — a location
is a reporting bucket, not a new account, so RDW Labz revenue is now separable in Square reporting.

| Offer | Amount | Link (RDW Labz) | Square object |
|---|---|---|---|
| DNS Hygiene Audit — single zone sweep | **$1,500** | https://square.link/u/S3Z5A4mL | `PHBTY2WM4RGXTC7H` · order `wuYbTAKbJu511HhKA9Ez8HKfIF9YY` |
| DNS Hygiene Monitoring — 1 month | **$750** | https://square.link/u/3s4r8pVO | `P4G6MTPMF3CLYQNA` · order `2jJDjfwahuB5o1qUB2j3lvS2sZBZY` |

The earlier pair on the corporate "RDW" location stays live and must not be deleted — four outreach
emails already carry them:

| Offer | Link (RDW) | Square object |
|---|---|---|
| Audit $1,500 | https://square.link/u/h41lTw3P | `SCTFMRRWANM7Q7XG` |
| Monitoring $750 | https://square.link/u/7GnO5RnD | `5NXCAVKNUGMCGB26` |

Both sets verified by reading each one back from Square (amount + `location_id`) and fetching the public
URL (HTTP 200). `engine/square_links.py` recreates the forward set idempotently.

SquareHub's connector token keeps its default location as the corporate "RDW" on purpose: that app also
invoices Discount Bins customers, and changing the global default would misattribute their money. Audit
and Labz invoicing must pass `location_id=L6WC96AFWEZP8` explicitly.

## Watching it — the Labz tab in SquareHub

SquareHub now has a **Labz** tab (`/labz`, endpoint `GET /api/v1/labz/revenue`) that reads this
location live through the same Square connector the rest of the app uses: collected, unpaid, the
offers in the world with their amounts and states, and every order at the location. Nothing is copied
into a local table, so there is no second source of truth.

Two rules it enforces, learned the hard way: only the Labz location counts as Labz revenue — the
merchant's corporate location carries the bins trade, and its orders would otherwise have read as
$4,324.62 of "security work" — and offers issued on the corporate location before Labz existed are
listed but counted separately, because four prospect emails already carry those links.

Deployed 2026-11-01 (squarehub-core `0153185`, api image rebuilt, `frontend/dist` rebuilt).

## Routing table — every stream

| Stream | Who pays | Rail | Status |
|---|---|---|---|
| Paid DNS audit ($1,500) | Client invoiced directly | Square payment link above, RDW location | **live, payable now** |
| Monitoring retainer ($750/mo) | Same client, 30-day terms | Same rail, one month per link | **live, payable now** |
| Bounties (H1 / Bugcrowd / Intigriti / YesWeHack) | Program funds the platform award | Platform payout → **RDW Labz bank account** | blocked on Michael's KYC + tax form |
| Consultation / bespoke work | Client | Square link, invoice raised through SquareHub | rail ready, price per quote |
| Wholesale / liquidation (existing business) | Existing customers | Square, 25 locations | unchanged, not part of this |

### Bounty payouts specifically — HackerOne has a first-class route for this

HackerOne publishes **Researcher Business Accounts**: one Community Member account used when the
research happens as a company or legal entity. Payments go to the business, not to an individual.
The setup is the same three steps an individual does, with entity details substituted
([docs.hackerone.com/en/articles/14289683](https://docs.hackerone.com/en/articles/14289683)):

1. **Self-identify as a business account** — legal name and jurisdiction of formation. Ours: *RDW*,
   Arkansas, with *RDW Labz* as the trading name.
2. **Payment method → company option**, account-holder name = the registered business name, and it
   **must match the tax form**. Bank transfer is available as a company: company name, address, ABA
   routing number, account number. Minimums are $50 local / $100 SWIFT.
3. **Tax form as a corporation** — W-9 with RDW's EIN. The entity holds the liability, so no
   individual is personally on the hook.
4. **Identity verification (Veriff)** — done by the account owner as the entity's authorised
   representative, valid 12 months.

Two hard rules from HackerOne's own policy that decide the rail:

- *"The bank account holder name you provide must be your own name or, for business accounts, your
  registered business name and should match your tax form. Using a third-party account is prohibited
  and monitored; violations may result in suspension."*
- PayPal works, but only an account registered to the same identity — so a **business** PayPal in
  RDW's name is acceptable, and a personal one is not.

**Therefore:** the primary rail is a **business bank account in RDW's name** (ACH via Currencycloud,
no PayPal fee, no personal-name mismatch). Business PayPal in RDW's name is the backup. A personal
PayPal handle is the one option that would put a payout in the wrong legal person.

### What Michael has to enter himself, and where

Never in chat, never in a file in the repo — the tax ID goes straight into the platform's own form:

| Item | Where it goes | Notes |
|---|---|---|
| EIN | HackerOne → Payment Setup → tax form (W-9, corporation) | entered once, never logged |
| Bank routing + account | HackerOne → Payment Setup → Bank Transfer → company | must be the RDW account |
| Legal name string | same form as the bank | match what the bank has on file |
| Veriff ID check | HackerOne → identity verification | authorised representative |

Everything around that — target selection, sweeps, duplicate checks, writing the submission in the
platform's format, tracking state — is automated.

## Where each artifact lives

- `PAYMENTS.md` — how the platforms pay, and the KYC gate that stays human.
- `SALES.md` — the offer, pricing and the three streams.
- `outreach/` — the mail that carries the links (drafted, reviewed before send).
- `templates/audit-scope.md` — the one-page scope a client signs before a paid sweep starts.
- Square side: SquareHub `connector_credentials` (token, Fernet-encrypted), location `L7YP1B2MC8CJY`.

## Never

- Never condition a vulnerability disclosure on payment — the finding is given away free, the audit is
  a separate purchase. That ordering is what keeps the safe-harbour position intact.
- Never claim or serve anything on a client's or target's hostname.
- Never put a card number, bank detail or token in the repo or the transcript.
