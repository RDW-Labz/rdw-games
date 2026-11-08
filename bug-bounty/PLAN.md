# Turning the recon pipeline into revenue

Written 2026-11-01. Michael's question: three ways to make money, with crons and specialised
models/APIs. This is the honest version — including the parts that do not pay.

## What we actually have

`engine/dangling.py` — a stdlib-only, SQLite-backed monitor. Enumeration (CT logs) → CNAME edge →
resolve every target → classify the namespace → draft report + outreach. Measured on this box:

- 3 zones / 712 hosts / 66 CNAME edges / 48 targets → **3.8 seconds**, 4 claimable findings.
- Whole 149-zone pool ≈ minutes. Daily cron costs nothing but electricity.
- Detection is **deterministic**: `dig` + a namespace table. No model, no tokens, no cost, no
  hallucinated severity. That is a feature, not a limitation — see "where models belong".

Three verified findings already exist (Xola / Wix, Differential / Elastic Beanstalk, Stewart /
Traffic Manager), each with a report, an evidence bundle and a ready-to-send email.

## Stream 1 — Paid bounty programs (HackerOne / Bugcrowd / Intigriti)

The only stream that pays per finding without a client relationship.

**Reality check, because this is where hype gets people:** public programs have duplicates. A
takeover on a big scope gets found by everyone's cron, usually within days. What wins is
*continuous monitoring of newly-appeared dangling records*, not batch scanning — a record created
last Tuesday that nobody has swept yet. Our engine is built for exactly that: it stores CNAME edges
with timestamps, so "new target, never seen before" is a query.

**Unit economics (conservative):**
| | |
|---|---|
| Takeover payout, public H1/Bugcrowd program | $150–$1,000 typical; $2k+ on high-profile scopes |
| Valid findings per 1,000 watched domains per month | 0.5–2 (our corpus: 4 claimable across 171 domains in one pass — but that was a *first* pass with no prior sweeps) |
| Duplicate rate on paid programs | 40–70% |
| Accepted per month at 5,000 watched domains | 1–3 |
| **Monthly range** | **~$300–$2,500 once established, $0 in month one** |

**Blocker:** platform account + KYC + tax form, in Michael's name. Auto-submitting is not
advisable — sloppy duplicates and unedited AI reports get accounts flagged. The cron drafts, a
human clicks submit.

## Stream 2 — Paid DNS-hygiene audits (the one that pays this month)

The findings we already have are the sales asset. A report that proves a dangling record is a
door-opener; the *audit of the rest of the estate* is the product.

**The motion, in order, and the order matters legally:**
1. Disclose the finding free, to the published security contact, with the full report attached.
2. In the same email, one paragraph: "if useful, I sweep the rest of your estate and hand back the
   same report with a fix list — that is paid work; the finding above is free either way."
3. Never condition disclosure on payment. "Pay me or I publish/exploit" is extortion in most
   jurisdictions and would poison the safe-harbour position the whole operation depends on.

**Unit economics:**
| | |
|---|---|
| Audit price (one-off, up to ~5k subdomains, report + fix list) | $1,500–$5,000 |
| Monitoring retainer (monthly sweep + alerting) | $500–$1,500/mo |
| Cold-email → reply rate with a *real* finding attached | 5–15% (a generic security pitch is <1%) |
| Emails per closed deal | 20–60 |
| **Realistic first 90 days** | **1–3 audits → $3k–$10k**, plus one retainer if lucky |

**Why this converts:** the prospect cannot argue the finding is theoretical — it is their DNS,
their record, with `NXDOMAIN` printed next to it. That is a much shorter sales conversation than
"we can test your app".

**Scope guardrail that makes this legal without any program:** DNS records are public. Looking up
your own resolution of `foo.example.com` is not testing their systems. But for a **non-program**
prospect we do DNS + CT logs only — **no HTTP probing, no path checks, nothing that touches their
servers.** Inside a published program's scope we may make a single `GET /` per host. Never blur
those two envelopes: the whole legal position rests on it.

## Stream 3 — Productise the monitor

Sell the thing itself, not the findings:

- **Agency/MSP subscription.** Per-zone monitoring, alerts on new dangling records, $49–$299/mo.
  Sell to web agencies and MSPs who own hundreds of client zones and have no idea half are
  decaying.
- **Self-hosted tool**, Gumroad/Polar, $99–$199 one-off. Zero support burden, no infrastructure.
- **White-label reports** for agencies to put their logo on.

Tech is done. Distribution is the work: 10 conversations, not 10 features.

**Unit economics:** 20 subscriptions × $99 = ~$2k/mo recurring, but 6–12 months to get there and it
needs Stripe, a landing page and someone answering email.

## Where models actually belong (the "specialised API" question)

Not in detection. A model that decides "does this name resolve" is slower, costlier and wrong-er
than `dig`. The five places a model pays for itself:

1. **Namespace triage** — a dead target on an unlisted provider: "is `x.azurefd.net` claimable?"
   Local flint answers free, cloud model when it is ambiguous and the answer matters.
2. **Report drafting** — turn the deterministic facts into prose. Pennies per report at
   deepseek/Nous pricing; $0 on flint.
3. **Outreach copy** — a paragraph that references *their* finding, not a template. This is the
   one place generation moves conversion measurably.
4. **Triage of duplicates** — before submitting, ask "has this exact record been reported to this
   program in the last 90 days" against the program's public disclosures.
5. **Claimability research** — read provider docs and extract the reuse policy (that is how the
   Elastic Beanstalk quote got into the report).

Cost line for all of that: under $5/month at this volume. The compute was never the problem; the
accounts and the emails are.

## What needs Michael

| # | Decision | Why it blocks |
|---|---|---|
| 1 | Which sending account, and does Gmail get wired via connector | All three submissions are drafted and blocked on this |
| 2 | Paid platform accounts (H1/Bugcrowd/Intigriti) — yes/no | Unlocks stream 1; needs KYC in his name |
| 3 | Price for the audit and the retainer | Stream 2 pricing is a business call, not a technical one |
| 4 | Whether to push `~/Projects/bug-bounty` to a private `RDW-Labz` repo | Backup + collaboration; needs push target confirmed |

## 30 / 60 / 90

- **Week 1:** send the three existing reports free. Wire the daily cron. Watch 149 zones.
- **Weeks 2–6:** every new claimable finding → free disclosure + audit offer. Track reply rate.
  Add paid-program scopes to the watchlist as accounts land.
- **Weeks 6–12:** first audit delivered at price; if reply rate holds, productise the report
  (stream 3) rather than hunting harder.
