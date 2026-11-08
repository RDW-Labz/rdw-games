# Filing packet — three reports, ready to submit

Everything below is the exact data each platform's form asks for. Bodies are already written; this file
exists so filing is three forms of pasting, not three hours of re-deriving scope and severity.

---

## 1. GitHub — HackerOne

| Form field | Value |
| --- | --- |
| Programme | `github` — https://hackerone.com/github |
| Asset | `*.githubapp.com` |
| Weakness | Server Security Misconfiguration → Subdomain Takeover → Non-Wildcard |
| Severity | Medium (P3) |
| CVSS 3.1 vector | `AV:N/AC:L/PR:N/UI:N/S:C/C:L/I:L/A:N` (7.2) |
| Affected host | `nines.githubapp.com` |
| Title | Subdomain takeover: `nines.githubapp.com` CNAME points to a deleted Azure App Service app |
| Body | `reports/github-h1-submission.md` |
| Impact line | Attacker-served content on a GitHub-owned domain with a valid certificate; cookie and OAuth-redirect inheritance from `*.githubapp.com` |

## 2. EPAM Systems — Bugcrowd

| Form field | Value |
| --- | --- |
| Engagement | `epam-mbb-og` — https://bugcrowd.com/engagements/epam-mbb-og |
| Target | `*.emakina.at` (Tier 4) |
| VRT | Server Security Misconfiguration → Subdomain Takeover → Non-Wildcard |
| Severity | P3 (programme pays $150 at P3) |
| CVSS 3.1 vector | `AV:N/AC:L/PR:N/UI:N/S:C/C:L/I:L/A:N` (7.2) |
| Affected hosts | 15 CNAMEs under `*.emakina.at` → two deleted Azure App Service apps, both NXDOMAIN |
| Title | Subdomain takeover: multiple `*.emakina.at` records point at deleted Azure App Service apps |
| Body | `reports/epam-bugcrowd-submission.md` (wire re-verified `2026-11-02T00:33:36Z`) |
| Expected payout | $150 |

## 3. eToro — Bugcrowd

| Form field | Value |
| --- | --- |
| Engagement | eToro Managed Bug Bounty — https://bugcrowd.com/engagements/etoro-mbb-og |
| Target | `*.etoro.com` |
| VRT | Server Security Misconfiguration → Subdomain Takeover → Non-Wildcard |
| Severity | P3 |
| CVSS 3.1 vector | `AV:N/AC:L/PR:N/UI:N/S:C/C:L/I:L/A:N` (7.2) |
| Affected host | `candle-src.etoro.com` → `prod-candle.trafficmanager.net` (NXDOMAIN) |
| Title | Subdomain takeover via dangling CNAME to a released Azure Traffic Manager profile |
| Body | `reports/etoro-bugcrowd-submission.md` |
| Programme max | $15,000; ACME HTTP-01 angle makes the takeover mechanically demonstrable |

---

## What blocks each one

Both platforms are logged out in the automation browser, and both want a password **plus** a TOTP code
that lives in Michael's authenticator. Account email/password pairs exist in
`~/.config/rdwlabz/platforms.json` (accounts created 2026-11-01); the vault has no entry for either
site and the TOTP secrets are deliberately **not** stored on this box.

So the sequence is: Michael unlocks one site in the automation browser (vault `save_login` prompt →
masked entry, saved for next time), types the 6-digit code, and the filing below takes minutes.

After each submission: update `reports/PAYABLE-DOSSIER.md` status from *report complete, not filed* to
the submission URL, and record the platform's triage state — nothing else in the pipeline changes.
