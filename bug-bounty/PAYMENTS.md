# Where the money actually comes from

Written 2026-11-01, after the four free disclosures went out. Those four were the right thing to
send and they pay **nothing**: Xola publishes no bounty, Differential and Stewart run
disclosure-only programmes, Celemi publishes safe harbour only. Cash requires assets that sit
inside a programme with a payout attached, which is a different corpus — and `engine/programs.py`
builds it.

## The paying pool, measured

`python3 engine/programs.py stats` after a `sync` (source: `bounty-targets-data`, refreshed daily):

| Platform | Programmes listed | Paying | Bounty-eligible DNS apices |
|---|---|---|---|
| HackerOne | 450 | 219 | 1,182 |
| Bugcrowd | 297 | 292 | 518 |
| Intigriti | 143 | 41 | 247 |
| YesWeHack | 55 | 53 | 182 |
| **total** | **945** | **605** | **2,123** |

86 of those programmes pay at least $2,000 at the top and expose at least three apex domains —
630 domains between them, T-Mobile, Tesla, Auth0, Chime, Canva, Binance, Atlassian, FDJ United.
That is the pool worth sweeping: a dangling record there has an owner with a budget and a triage
team, and the platform handles the mechanics of getting paid.

## How a researcher actually gets paid

Verified against the platforms' own documentation, not memory:

- **HackerOne** — the bounty is awarded into your HackerOne account and paid out via **PayPal**,
  **bank transfer** (Currencycloud) or **Bitcoin/USDC**. Money cannot move until three things are
  in place: a payment method, a **tax form** (W-9 for US, W-8BEN otherwise — renewed every three
  years, and the name cannot be changed afterwards), and **approved identity verification**.
- **Bugcrowd** — **bank transfer** and **PayPal**, Bitcoin on select programmes. Bugcrowd covers
  the fees from its account to the payment provider; anything the provider charges is on you.
- **Intigriti** — **wire transfer**, **PayPal**, **Payoneer**, **UPI**, plus self-billing invoices.
- **YesWeHack** — payout mechanics not verified here; check before counting on it.

Common shape: the programme funds the award, the platform escrows it, and the researcher cashes
out after KYC + tax paperwork. Nothing is paid to a company name by default — the payout account
has to match the verified individual. If this work should land in RDW Labz rather than personally,
that is a decision to make **before** the first account is created, because HackerOne explicitly
forbids moving a profile or its payouts to a third party later.

## What has to be done by a human

Account creation, identity verification and tax forms are identity-bound. No agent can or should
do them. Everything on either side of that gate is automatable:

| Step | Who |
|---|---|
| Create the platform account, verify ID, sign the tax form, set payout method | Michael |
| Sync scopes, pick targets, enumerate, detect dangling records | `engine/programs.py` + `engine/dangling.py` |
| Check a finding against the programme's disclosed reports (duplicate pre-check) | assistant |
| Write the submission in the platform's format with the evidence bundle | assistant |
| Paste it in, press submit | Michael |
| Chase the triager, escalate, re-test on request | assistant drafts, Michael sends |

## What a takeover is worth

Subdomain takeover consistently lands **Low to Medium** on these programmes: $100–$500 is the
common band, up to ~$1,000 where the scope explicitly covers it or the hostname carries SSO /
cookie scope. The realistic constraint is duplicates: on a well-known estate, 40–70% of dangling
records have already been reported by someone else. Our edge is not the technique, it is the
timestamp — `cnames` records when each edge was first seen, so "this target went dead this week"
is a query, and a fresh record is a live submission rather than a duplicate.

At one accepted Medium per month the platform stream is a few hundred dollars. It is not the
business; it is the reputation and the case studies.

## The stream with no KYC in the way

The paid DNS-hygiene audit ($1.5k–5k one-off, $500–1.5k/month retainer — `SALES.md`,
`templates/audit-scope.md`, `engine/audit.py`) needs no platform account, no tax form and no
identity verification: it is an invoice from RDW Labz to a company, paid by bank transfer. The
four findings already sent are the door-openers for exactly this, and they are in front of
security teams who can see the problem in their own zone.

Order of operations stays fixed: the finding is disclosed free, then the audit is offered as a
separate service. Never conditioned on payment.

## Scope gate — an apex match is not authorisation

`programs.py check <host>` decides whether a *specific hostname* is inside a published scope:
a wildcard covering it (`*.X`), an entry naming the host, or a scope URL served from it. Sharing a
registrable apex is **not** enough, and the first sweep proved why: `blog.luva.bet.br` dangles into
a deleted Azure app, and the engine's apex match folded it onto Superbet's `superbet.bet.br`
listing. Different operator, different company, out of scope — the `check` gate caught it before a
report went anywhere, and the row was dropped. Run `check` on every finding before drafting.

## Next actions, in order

1. **Payout rail is live.** The $1,500 audit and $750 monitoring links are payable today into the RDW
   Labz Square location — see `PAYOUTS.md`. Nothing more is needed to take money from a client.
2. **Michael**: confirm the merchant legal name question in `PAYOUTS.md` (*Discount Bins US* vs RDW
   Labz) and, if bounties should land in RDW Labz rather than personally, register one platform account
   as the business with the EIN + business bank account. HackerOne has the largest paying pool in our
   data (219 programmes).
3. Send `outreach/*-audit-offer.txt` no earlier than 2026-11-08 — five business days after the free
   disclosure, which is touch 2 of the sequence.
4. Sweep the high-value slice: `programs.py seed --limit 400 --order big`, then `dangling.py run`.
5. In parallel, work the audit stream: the four disclosed companies are the warmest leads in hand.
