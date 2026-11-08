# Payable-finding dossier — 2026-11-02

What this file is: every host the sweep has turned into a **submittable** finding, with the evidence
that decides whether it pays, and the exact next action for each one. Rows are ranked by
`verified × in-scope × pays`, not by how impressive they sound.

Measured coverage behind these numbers: **438,671 hostnames**, **66,006 CNAME edges**, **26,312 of
those edges sit on a hostname inside a paying programme** (after the scope-matcher fix described in
§0), of which 2,791 are provider-shaped. 70 claimable, **16 in paying scope**, **3 submittable
root causes**, 6 paid-audit offers delivered tonight.

## 0. Scope-matcher fix — why the payable count moved from 1 to 2

`programs.in_scope()` only reached its wildcard branch when `apex()` had already parsed the scope
entry. Platforms publish scope as URLs far more often than as bare hostnames — eToro's target is
literally `https://*.etoro.com` — and `apex()` does not strip a scheme, so it returned empty and
**every wildcard published in URL form was silently dropped**. The entry is now normalised to its
host part first (`strip scheme → split on / ? : → strip dots`) and only then matched.

Effect: 26,312 CNAME edges are now correctly attributed to a paying programme, up from ~8,300 under
the strict reading. Re-fingerprinting that set produced exactly one new takeover — eToro — and no
false positives: ExpressVPN/Netlify answered 401 (site exists, protected), MyFitnessPal points at the
bare `s3.amazonaws.com` apex (no bucket name to claim), bpost's two records are real but its
Intigriti programme carries no bounty.

## 1. VERIFIED PAYABLE — EPAM Systems (Bugcrowd), `*.emakina.at`

**14 hostnames → 2 deleted Azure App Service apps.** One root cause, one submission.

| | |
| --- | --- |
| Programme | EPAM Systems Managed Bug Bounty (Bugcrowd) — `bugcrowd.com/engagements/epam-mbb-og` |
| Scope proof | Tier 4 target `*.emakina.at` — "Any level subdomains are valid targets for Tier 4 bounties" |
| Bug class | Subdomain takeover (VRT: Server Security Misconfiguration → Subdomain Takeover → Non-Wildcard) |
| Reward | P3 at Tier 4 = **$150** (chart P1 $500 / P2 $300 / P3 $150 / P4 unpaid) |
| CVSS 3.1 | 7.2 — `AV:N/AC:L/PR:N/UI:N/S:C/C:L/I:L/A:N` |
| Status | **report complete, not filed** — `reports/epam-bugcrowd-submission.md` |

Evidence re-proved on the wire 2026-11-02T00:00Z: `donauchemie-dev.azurewebsites.net` and
`lsgganterdev.azurewebsites.net` both NXDOMAIN, 14 CNAMEs still resolving. Azure App Service names
are globally re-registerable once the app is deleted (provider documentation quoted in the report).

Action: paste `reports/epam-bugcrowd-submission.md` into the Bugcrowd submission form. Needs a logged-in
Bugcrowd session (the user's click).

---

## 1b. VERIFIED PAYABLE — eToro (Bugcrowd), `candle-src.etoro.com`

**One hostname → one deleted Azure Traffic Manager profile.** New today, unlocked by the scope fix.

| | |
| --- | --- |
| Programme | eToro Managed Bug Bounty (Bugcrowd) — `offers_bounty=1`, max bounty **$15,000** |
| Scope proof | published target `https://*.etoro.com` — wildcard covers any depth subdomain |
| Bug class | Subdomain takeover via dangling CNAME to a released Traffic Manager label |
| Record | `candle-src.etoro.com CNAME prod-candle.trafficmanager.net` (live) |
| Target | `prod-candle.trafficmanager.net` → **NXDOMAIN**, no A, no CNAME |
| CVSS 3.1 | 7.2 — `AV:N/AC:L/PR:N/UI:N/S:C/C:L/I:L/A:N` |
| Status | **report complete, not filed** — `reports/etoro-bugcrowd-submission.md` |

Why it is worth more than EPAM: the label `prod-candle` is guessable, and an attacker who recreates
the profile can attach an External endpoint and obtain a valid certificate for `candle-src.etoro.com`
by ordinary ACME HTTP-01 validation — so the takeover presents with a valid eToro certificate and
reaches `.etoro.com`-scoped cookies. The claim path was deliberately **not** exercised.

---

## 1c. VERIFIED PAYABLE — GitHub (HackerOne), `nines.githubapp.com`

| Field | Value |
| --- | --- |
| Programme | GitHub — `https://hackerone.com/github`, `offers_bounty=1`, submissions allowed |
| Scope proof | `*.githubapp.com` listed as a URL asset with `bounty=1` |
| Record | `nines.githubapp.com  60 IN CNAME ninesapp-app-service.azurewebsites.net.` |
| Target state | `NXDOMAIN` — App Service app deleted, name released to the global pool |
| Host state | no HTTP response (`curl` 000), consistent with a target that does not exist |
| Class | VRT Server Security Misconfiguration → Subdomain Takeover → Non-Wildcard |
| Severity | P3 suggested, CVSS 3.1 **7.2** `AV:N/AC:L/PR:N/UI:N/S:C/C:L/I:L/A:N` |
| Escalation path | any cookie or OAuth redirect scoped to `*.githubapp.com` turns this from brand abuse into token theft |
| Report | `reports/github-h1-submission.md` |
| Status | **report complete, not filed** (needs a HackerOne session) |

Found by the breadth sweep of the last 234 unenumerated zones — 456,203 hostnames and 68,580 CNAME
edges after it finished, +13,294 hosts and +1,693 edges over the previous run, and this was the only
new claimable record it produced. That is the expected density: roughly one real takeover per 13k
freshly enumerated hostnames at this provider mix.

## 2. VENDOR-CAVEAT LEAD — Intergamma (Intigriti), `www.audiotour.karwei.nl`

| | |
| --- | --- |
| Target | `karwei.netlify.app` (Netlify, CNAME live) |
| Programme | Intergamma on Intigriti — paying |
| Observed | custom domain returns Netlify `site not found` (404) while `karwei.netlify.app` itself serves 200 |
| What is proven | the custom domain is **not attached** to the live Netlify site |
| What is not proven | that a third party can attach it — Netlify restricts unverified custom domains |
| Reward | Intigriti VRT, low-to-medium band |

Action: only report if the claim path can be shown; otherwise it is a hygiene note, not a payout.

---

## 3. DOWNGRADED — Expedia Group BBP, `devex-mcp-registry.eg-internal.ghpages.expedia.biz`

Originally recorded as an unclaimed GitHub Pages site (404 + "There isn't a GitHub Pages site here" +
`api.github.com/users/eg-internal` = 404). **The sibling host `developer-ai-radar.eg-internal.ghpages.expedia.biz`
answers with the GitHub Pages *access-control* redirect (302 → `/pages/auth`)**, which means the
`eg-internal` GitHub account exists and publishes private Pages. The account name is therefore not
registrable and the custom domain cannot be re-bound by a stranger. Not payable; delete the record.

This is the trap worth remembering: a 404 from `<owner>.github.io` is *not* the claimability signal —
`api.github.com/users/<owner>` returning 404 does not either, because enterprise-managed accounts are
invisible to the public API. The reliable test is a **sibling hostname** under the same `<owner>`: if
any sibling serves the private-Pages redirect, the owner exists.

---

## What the sweep ruled out (so nobody re-litigates it)

| Channel | Result |
| --- | --- |
| Dead CNAME targets (1,788 edges) | 21 claimable, 14 paying — all EPAM |
| Provider fingerprinting, 615 provider-shaped hosts | 2 GitHub Pages private (owner exists), 1 GitHub unclaimed with a live sibling, 1 Netlify caveat, 4 live, 5 ambiguous |
| GitHub Pages owners, all 21 seen | 19 exist publicly, 2 are enterprise-managed (private Pages redirect) — none registrable |
| Dangling NS/MX (823 paying apexes, 2,863 records) | 0 real. The 4 hits are Microsoft placeholders (`.msv1.invalid`, `frontbridge.com`), which nobody can register |
| RDAP "available" domains | 0 real. `rdap.org` 404s whole TLDs (.io, .co, .ch); every candidate had live NS |
| Firebase `*.web.app` names | 0. All deleted-looking names return the vendor's own live 404 page |
| PayLution self-service subdomains (216 paying edges, 9 targets) | 0. All Fastly-backed and live |
| Elastic Beanstalk targets on `logi.com` (5 hosts, Logitech — pays) | 0. Every `*.elasticbeanstalk.com` target still resolves to a live ELB; the environment was never deleted |
| Shopify `*.ssl.shopify.com` (16 hosts, Shopify — pays) | 0. Shopify's own edge names, no probe response is not an unclaimed site |
| Unbounce `broker.mortgagechoice.com.au` (REA Group — pays) | 0. Host sits behind Cloudflare: HTTP 409 `error code: 1001`, origin unresolvable. Cloudflare holds the edge; no third party can claim it |
| Zendesk `legalrequests/vendor.reddithelp.com` (Reddit — pays) | 0. Both 302 to `/hc` on a live Zendesk help centre. The earlier "UNCLAIMED" read was the target-side probe, which matches redirect bodies — superseded by host-side fingerprinting |

## The arithmetic on "10 payable"

1 payable finding per ~128k hostnames, 1 per 615 provider-shaped CNAMEs. Ten findings needs roughly
**1M enumerated hostnames** — a 10× increase in coverage, i.e. several days of aggregator + CT-log
enumeration at 2 workers, not another pass over the same 823 zones. That is the honest constraint;
nothing in the current corpus is being held back.

---

## Ruled out on the second breadth pass (sweep-missing4, 2026-11-02T23:04Z)

4 more zones finished (`L5` + `bounty:` tiers were being skipped by a numeric `--tier` argument that
matched nothing): 484,845 hostnames, 73,979 CNAME edges, one new claimable record, and that one closes:

| Record | Target | Why it is not a finding |
| --- | --- | --- |
| `dev.customerservice-ccp.priceline.com` | `pcln-ccp-blue.us-east-1.elasticbeanstalk.com` | Target answers **NOERROR/NODATA, not NXDOMAIN** — the `elasticbeanstalk.com` zone is authoritative for any label, so DNS cannot prove the environment is gone. Priceline is on HackerOne but lists exact assets (`priceline.com`, `www.`, `press.`, `cruises.`), not a wildcard, so this host is outside documented scope as well. Downgraded. |

14 zones remain unenumerated, all disclose.io L5 (non-paying) — held back deliberately, no payout on
the other side of them.

---

## Filing state — measured, not assumed

Nothing is filed and nothing *can* be filed yet, for a reason that is not a login timeout:

| Platform | Account state (`~/.config/rdwlabz/platforms.json`) |
| --- | --- |
| HackerOne | `not_created` — GitHub report has nowhere to go |
| Bugcrowd | `pending_signup` — EPAM and eToro have nowhere to go |

Both need the identity/payout setup in `RUNBOOK-payout-setup.md` §1–2 (business bank account, Veriff as
authorised representative of RDW, W-9 with the EIN). That is Michael's step: it is KYC, not automation.

Everything on our side is staged in `reports/FILING-PACKET.md` — programme, asset, VRT class, severity,
CVSS vector and body file per report, so a verified account turns each one into a single pasted form.

## Invoicing through SquareHub (Michael's ruling, 2026-11-02)

Client revenue does not wait on any of that. The SquareHub rail is live and was verified over its own
API: `POST /api/v1/connectors/square/test` returns `token_readable: true` against the production Square
token, and the invoice table holds a real issued invoice (`INV-0005`, $1.00, plumbing check, never sent
to a customer). `engine/invoice_via_hub.py` is the bridge from a closed deal to money:

```
./engine/invoice_via_hub.py --to ap@vendor.com --name "Vendor Security" \
    --domain vendor.com --amount 1500 --apply --send
```

It creates the invoice, issues it (assigns `INV-####`) and — only with `--send` — emails it through
Square, whose webhook receiver records the payment back into the hub. Dry run by default.

## Appendix — every bug in the corpus, payable or not (2026-11-02)

**70 claimable records, 55 distinct vanished cloud resources, 18 companies.** Only 16 of those records
(3 root causes) sit in a programme that pays. The rest are real defects at companies that publish no
bug bounty or publish one that does not cover the hostname — they are worth money as audits, not as
submissions, which is why they are offers rather than reports.

| Company | Records | Bounty route | Disposition |
| --- | --- | --- | --- |
| UnifySquare (Microsoft subsidiary) | 21 | none that covers subdomains | offer delivered |
| EPAM / emakina.at | 14 | Bugcrowd, P3 = $150 | **filing-ready** |
| Starbucks | 7 | HackerOne covers `.com.cn` only | filed 11-03 as 4169021 → **closed informative**; audit offer also delivered |
| TeamViewer | 6 | YesWeHack, listed hosts only | offer delivered |
| Harman | 4 | YesWeHack, listed hosts only | offer delivered |
| Majid Al Futtaim (`retailsso.com`) | 3 | none | offer blocked — no MX on that zone |
| Differential | 2 | none | offer delivered 11-01 |
| Stewart | 2 | none | offer delivered 11-01 |
| bpost (`acbpost.be`, `stbpost.be`) | 2 | Intigriti, no bounty | offer delivered |
| VFS Global (`tasheer.com`) | 2 | none | offer bounced, contact TBD |
| eToro | 1 | Bugcrowd, max $15,000 | **filing-ready** |
| GitHub (`githubapp.com`) | 1 | HackerOne, pays | filed 11-03 as 4168910 → **closed informative** |
| Chipotle | 1 | none | offer delivered |
| Safaricom | 1 | none | offer delivered |
| Unit4 | 1 | none | offer delivered (`security@unit4.com`, after `@unit4cloud.com` bounced) |
| Luva Bet | 1 | none | offer delivered (`security@luva.bet`, after `.com.br` bounced) |
| Celemi | 1 | none | offer delivered 11-01 |
| Xola | 1 | none | offer delivered 11-01 |
| Bentley (LumenRT, `qa-manage-staging`) | 1 | — | **stale**: hostname no longer resolves, record withdrawn; downgraded `claimable=0` |

Two provider classes account for all 70: Azure App Service (`azurewebsites.net`, 44) and Azure Traffic
Manager (`trafficmanager.net`, 19), plus 7 Elastic Beanstalk. Every row was re-verified host-side —
the CNAME must still be live *and* the target must be NXDOMAIN; a dead hostname with a stale row is
not a finding (see Bentley).

**Sequence note:** the same 9 addresses that received the first offer get exactly one follow-up, 44–120h
later, from a 6-hourly idempotent cron. Two addresses bounced at the domain level
(`security@vfsglobal.com`, `security@unit4cloud.com`, `security@luva.bet.br`) and were re-sent to a
working mailbox on the corporate domain when one exists.
