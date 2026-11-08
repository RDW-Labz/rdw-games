# Bugcrowd submission — EPAM Systems Managed Bug Bounty (`epam-mbb-og`)

**Title:** Subdomain takeover via dangling CNAMEs to released Azure App Service hostnames on emakina.at

**VRT:** Server Security Misconfiguration → Subdomain Takeover → Non-Wildcard
**Suggested priority:** P3 — the takeover inherits a valid certificate for an EPAM hostname and any
cookie scoped to the parent domain. CVSS 3.1 `AV:N/AC:L/PR:N/UI:N/S:C/C:L/I:L/A:N` = **7.2**.

**Scope relied on:** Tier 4 target `*.emakina.at` — "Any level subdomains are valid targets for Tier 4
bounties". Tier 4 chart: P1 $500 / P2 $300 / **P3 $150** / P4 accepted but unpaid.

Worth knowing before submitting: the engagement's flat **$150 "Subdomain takeover — Tier 0"** target is
limited to `*.epam.com` ("any domain that is not under *.epam.com is strictly out of scope"), so this
finding does not qualify for that carve-out — it is paid at the Tier 4 chart instead. Both routes are
$150 at P3, so the expected value is the same either way.

## Description

2 CNAME records in the `emakina.at` zone point at Azure App Service hostnames that no longer
exist. App Service names are global and are released when an app is deleted; whoever creates an app with
that name in any Azure subscription receives traffic for the EPAM hostname, with a certificate Azure
issues automatically. Nothing on the DNS side has to change for the attacker to succeed.

## Assets

- `donauchemie-dev.azurewebsites.net` → `donau-carbon-us.devweb.emakina.at`
- `donauchemie-dev.azurewebsites.net` → `donau-carbon.devweb.emakina.at`
- `donauchemie-dev.azurewebsites.net` → `donau-chemie-group.devweb.emakina.at`
- `donauchemie-dev.azurewebsites.net` → `donau-chemie-ro.devweb.emakina.at`
- `donauchemie-dev.azurewebsites.net` → `donau-chemie.devweb.emakina.at`
- `donauchemie-dev.azurewebsites.net` → `donau-products.devweb.emakina.at`
- `donauchemie-dev.azurewebsites.net` → `donau-realitaeten.devweb.emakina.at`
- `donauchemie-dev.azurewebsites.net` → `donau-umweltinformation.devweb.emakina.at`
- `donauchemie-dev.azurewebsites.net` → `donau.devweb.emakina.at`
- `donauchemie-dev.azurewebsites.net` → `donauchem-hu.devweb.emakina.at`
- `donauchemie-dev.azurewebsites.net` → `donauchem-pl.devweb.emakina.at`
- `donauchemie-dev.azurewebsites.net` → `donauchem-rs.devweb.emakina.at`
- `donauchemie-dev.azurewebsites.net` → `donauchem-sk.devweb.emakina.at`
- `lsgganterdev.azurewebsites.net` → `ganterdevweb.emakina.at`

All 14 hostnames resolve as CNAMEs from EPAM's zone; every target returns **no A record**
(NXDOMAIN), i.e. the backing app is gone. Re-verified on the wire 2026-11-02T00:33:36Z: 15 CNAME
records still present, both Azure targets still NXDOMAIN.

## Reproduction

    dig +short CNAME donau-chemie.devweb.emakina.at
    donauchemie-dev.azurewebsites.net.
    dig +short A donauchemie-dev.azurewebsites.net
    (empty — NXDOMAIN)

No HTTP request was sent to any of the hostnames, no Azure app name was registered, claimed or reserved,
and the in-scope apexes listed under "Do not perform any testing on" were never touched. The finding is
DNS-record evidence only, which is also why it can be verified by your team in seconds. (The
`X-Bugcrowd` header and `@bugcrowdninja.com` alias requirements apply to requests against targets; none
were made.)

## Impact

- Phishing, malware hosting and credential capture served under an EPAM client-facing hostname
  (`devweb` suggests client staging sites still referenced in client configuration and QA).
- Cookies scoped to `.emakina.at` become reachable from attacker-controlled content on the same parent.
- Allow-lists and CSP `script-src` that trust `*.emakina.at` are bypassed.
- Mail flows and API integrations still pointing at these names fail silently or reach the attacker.

## Remediation

Delete the CNAME records listed above, then audit the remainder of `*.devweb.emakina.at` for App Service
targets that are no longer provisioned. Where a site must stay reachable, recreate the app and keep the
name reserved for as long as the record exists.

---
Draft prepared 2026-11-01. Evidence regenerated from `engine/state.db` (21 claimable findings, 9 root
causes); the 13 hosts sharing `donauchemie-dev` are one root cause and belong in one submission.
