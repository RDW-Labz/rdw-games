# Bug bounty / VDP work

Four findings, each with a ready-to-send report and evidence bundle. **All four were sent on
2026-11-01** from `security@rdwlabz.com`; message ids and delivery state are in `sent.json`.

| # | Finding | Program | Channel | Severity |
|---|---------|---------|---------|----------|
| 1 | `wixdemo.xola.com` — dangling CNAME to unclaimed Wix edge | Xola VDP | security@xola.com | Medium (CVSS 6.1) |
| 2 | `bas-facility-layout-tool-api-{dev,staging}.differential.com` — dangling CNAME to terminated Elastic Beanstalk env (NXDOMAIN, hostname released by AWS per AWS's own docs) | Differential VDP | security@differential.com | Medium (CVSS 6.1) |
| 3 | `ind-dev.stewart.com`, `ind-uat.stewart.com` — dangling CNAME to deprovisioned Azure Traffic Manager profiles (NXDOMAIN; name reusable by another tenant once the reservation lapses) | Stewart VDP | secops@stewart.com | Medium (takeover) / Low (dangling) |
| 4 | `dig.sim.celemi.com` — dangling CNAME to a terminated Elastic Beanstalk env, hashed form (claimable by creating an env whose DNS name is the id segment) | Celemi VDP | security@celemi.com | Medium (CVSS 6.1) |

Finding 4 came out of the automated sweep, not a manual run — the engine found it 25 zones in.

- `report-*.md` — full report for each program
- `submission-email-*.txt` — the email to send as-is
- `evidence/` — Xola: DNS chain, headers, raw body, rendered DOM, screenshot
- `evidence-diff/` — Differential: DNS + NXDOMAIN proof, HTTP, AWS doc quote, fingerprint row,
  plus the raw `cname_targets.txt` / `dead_targets2.txt` sweep output
- `evidence-stewart/` — Stewart: DNS + NXDOMAIN proof, Microsoft FAQ quote on profile-name
  reservation, public claim-mechanics write-ups

## Sending identity

Disclosures go out as **`security@rdwlabz.com`**, not from a personal mailbox:

- **Outbound** — Resend, domain `rdwlabz.com` (`f80f2ae1-4908-4701-a197-86c8115e7329`), DKIM +
  SPF + return-path MX all verified in Cloudflare DNS. Pay-as-you-go is switched on
  ($0.90 / 1,000 extra emails) because the Pro plan's monthly quota was already spent.
- **Inbound** — Cloudflare Email Routing rule `security@rdwlabz.com` → `jmacluer@gmail.com`
  (active), so vendor replies land in a human inbox.
- **Key** — `~/.config/rdwlabz/resend.key` (mode 600, outside the repo; never commit it).
- **Send** — `python3 engine/send_reports.py --dry-run` then `python3 engine/send_reports.py`.
  Each mail carries the draft text with the full report inlined *and* attached as `.md`;
  `sent.json` makes re-runs idempotent.

## Automation

- `engine/programs.py` — the paying pool. Pulls the daily `bounty-targets-data` scope dump for
  HackerOne / Bugcrowd / Intigriti / YesWeHack into the same `state.db`, normalises every scope
  entry to its registrable apex (dropping app-store listings and non-DNS asset types), and seeds
  zones for the sweep: `sync / stats / seed / plan / lookup / top`. **605 paying programmes,
  2,123 bounty-eligible apex domains** as of 2026-11-01 — that is what
  `dangling.py run` should be pointed at, not the disclosure-only corpus.
- `engine/dangling.py` — stdlib-only, SQLite state (`state.db`), subcommands `add / enum / cname /
  resolve / report / findings / run`. Deterministic detection: `dig` + a namespace claimability
  table. No model in the detection path, so a sweep costs nothing.
- `engine/reports/` — auto-drafted report + outreach email per claimable finding (human-edit before
  sending).
- Cron `163a59648e8e` — "bounty: dangling-DNS sweep", daily 06:00, `--no-agent`, silent unless a new
  claimable finding appears. Script: `profile/scripts/bounty-sweep.sh`.
- `engine/audit.py` — the paid deliverable: takes zones, emits a client-ready markdown report
  (executive summary, dead-record table, remediation checklist, method/limits) plus a CSV of every
  record examined. `samples/sample-audit-celemi.md` is a real run.
- `engine/board.py` — the one-page state of the operation: every rail (HackerOne read/write,
  Bugcrowd token and web session, Gmail, recon flock) probed live, the filing queue, the claimable
  backlog, the money tally from `money.py`, and a rule-derived NEXT list. `--json`, `--write`
  (`reports/BOARD.md`), `--no-probe`. This is what the Bounty bot runs before answering any status
  question, and what the daily brief prints first.
- `PLAN.md` — the money side: three revenue streams, unit economics, legal ordering rules, and the
  decisions that are not mine to make.

## Method (reproducible)

1. Candidate programs from disclose.io where the maturity tier is **L5 = full safe harbour + CVD**
   (explicit authorization to test), filtered to non-provider domains.
2. Passive subdomain enumeration per domain: `api.subdomain.center`, then `crt.sh`, then
   `api.certspotter.com`. No brute forcing.
3. Bulk CNAME resolution over every hostname (`dig +short CNAME`, 120 parallel).
4. Two takeover tests:
   - **provider fingerprint** — CNAME target matched against the takeover-prone SaaS list and the
     public error page checked for the provider's dangling signature (`can-i-take-over-xyz`);
   - **dead target** — resolve every CNAME target and flag `NXDOMAIN`. That is the exact signature
     for AWS Elastic Beanstalk and S3, and it is what produced finding 2.
5. Secondary classes swept on the same corpus, all zero-hit: exposed `/.git`, `/.env`, `/.svn`,
   Spring `/actuator/*`, Prometheus `/metrics`, Apache `/server-status`, phpinfo, public
   Swagger/OpenAPI, secrets in public JS bundles, unauthenticated admin appliances
   (Grafana/Jenkins/Kibana/Argo/Harbor/SonarQube…).

Scale of the run: 171 domains / 180 organisations (the entire disclose.io L5 pool), 14,136
hostnames, 1,395 distinct CNAME targets, 95 dead targets — of which 2 were Elastic Beanstalk
names (AWS documents that terminated environments release their hostname for reuse) and 2 were
Azure Traffic Manager profiles (Microsoft documents that the name is reusable by another tenant
once the reservation lapses). The other 91 dead targets sat on namespaces no outsider can claim:
`elb.amazonaws.com`, `cloudfront.net`, `herokudns.com`, `execute-api.*`, plus 56 self-hosted or
non-claimable records.

## Ground rules used

Fully passive: CT logs and public aggregators, `dig`, one GET per host, public JS reads. No
scanning, no fuzzing, no credential use, no account creation, no claim attempts on live assets.
