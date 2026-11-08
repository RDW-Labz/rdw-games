# Platforms to stand up, ranked by what we can actually submit

Our ingestion covers four platforms (`programs.py sync` from `bounty-targets-data`). This is the
set-up order, why that order, and what each one demands of the entity before a report can be paid.

Numbers below are from `engine/state.db` on 2026-11-01.

## Why the order is what it is

| Platform | Programs | Paying | With apices in our pool | Pool apices | Payout entity requirement |
|---|---|---|---|---|---|
| HackerOne | 450 | 219 | 41 | 373 | Business account: Veriff + company bank + corporate W-9 |
| Bugcrowd | 297 | **292** | 21 | 168 | Bank transfer or PayPal, plus W-9 (corporate form accepted) |
| YesWeHack | 55 | 53 | 1 | 80 | E-wallet, withdraw to bank |
| Intigriti | 107 | 41 | 6 | 53 | Identity verification before any reward is released |

HackerOne first only because the paperwork is already planned (`RUNBOOK-payout-setup.md`) — it is also
the largest pool. **Bugcrowd second and urgently**: 292 of its 297 listed programmes pay, which is the
highest paying ratio of any platform we index, and we have no account there at all. YesWeHack's pool is
small but concentrated — one open programme (vidaXL) alone contributes 80 apices. Intigriti is six
programmes deep for us; worth an account, not worth slowing down for.

Published maximums are only usable on Bugcrowd/Intigriti/YesWeHack — `bounty-targets-data` ships no
caps for HackerOne, so a zero there means "unknown", never "pays nothing". Bugcrowd alone has 189
paying programmes with a published cap of $2,000 or more.

## Set-up order

1. **HackerOne** — business account, details in `RUNBOOK-payout-setup.md`. Nothing new to decide.
2. **Bugcrowd** — `bugcrowd.com` sign-up with `security@rdwlabz.com`. Payout method first (bank
   transfer: 1–2 business days; PayPal: same day), then the tax form — a U.S.-incorporated entity files
   **W-9**, and the substitute form takes the business name in the *Business Name* field while an
   already-completed W-9 can be uploaded instead. Reports from this account go out under RDW from day
   one; Bugcrowd only splits a payment across researchers via collaboration *before* submission, so a
   later "move it to the business" is not available.
3. **YesWeHack** — account, bounty e-wallet, bank details for withdrawal. Straightforward, EU-heavy
   programmes, decent caps (Swiss Post e-voting $230k, Doctolib $50k, Kiteworks $50k).
4. **Intigriti** — account plus identity verification; payouts stay in an error state until the
   researcher is verified, so do it before submitting rather than after winning.

## Programmes to work first, by platform

- **Bugcrowd** — **EPAM Systems (`epam-mbb-og`) carries a live, in-scope finding already:** 14 hosts
  under `*.devweb.emakina.at` CNAME to deleted Azure apps (`donauchemie-dev`, `lsgganterdev`), which are
  NXDOMAIN and globally re-registerable — draft in `reports/epam-emakina-azure-dangling.md`. That alone
  justifies the Bugcrowd account. Also T-Mobile (12 apices in pool), Tesla ($100k cap), SpaceX/Starlink
  ($100k), Opera, Latitude Financial, Just Eat Takeaway, The Trade Desk (10 apices).
- **HackerOne** — PayPal, Remitly, Playtika, Live Nation, Hyatt, Goldman Sachs (12 apices each in our
  pool). Note PayPal and Goldman both run strict programmes; a dangling-DNS report wants evidence+
  no speculation.
- **YesWeHack** — vidaXL (80 apices), then Doctolib, Kiteworks, OVHcloud.
- **Intigriti** — Intergamma, AS Watson, Kinepolis, Posti, DigitalOcean.

## The real limiter — and it is not platform count

241 findings in the database: **5 are genuinely claimable** and drafted, 236 are not.

- 43 — name embeds the AWS account id (cannot be recreated)
- 20 — CloudFront distribution hostname is AWS-generated
- 9 — target derived from the domain name, needs ownership proof
- 6 — Microsoft-owned, 5 Oracle instance names, 1 Marketo, 2 custom-domain ids
- **150 — "unclassified namespace"**, which is a triage gap, not a verdict. Sampled, they are mostly
  `*.cidaas.com` → `proxy-ssl.hopin.com` (a white-label SSO proxy — benign) and `doorfeed.com`
  internal names. Classifying these into known providers or into junk is the cheapest way to raise the
  claimable count, and it costs no new platforms.

So: add Bugcrowd and YesWeHack because they widen the paying pool, but the conversion path is
**provider-weighted**: prefer programmes whose scope resolves to providers we can actually prove are
claimable (`elasticbeanstalk.com`, `trafficmanager.net`, `herokuapp.com`, `s3`, `azurewebsites.net`,
unclaimed apexes), and keep the scope gate (`programs.py check`) in front of every draft.

## Not yet in our data — evaluate before spending time

Immunefi (web3; payouts in crypto), huntr (AI/ML and OSS libraries), HackenProof, Zerocopter,
Federacy, Open Bug Bounty (disclosure only, no money). None are ingested, and none have been checked
against the licensing/scope rules in `PAYMENTS.md` — treat them as leads, not as a plan.
