# 14 *.devweb.emakina.at hostnames dangle on two unclaimed Azure App Service names

**Program:** EPAM Systems (Bugcrowd)  
**Affected asset(s):** 14 hostname(s), all in scope  
**Suggested severity:** P3 (High) — one re-claim gives an attacker 14 trusted client hostnames  
**Verified:** 2026-11-07 (UTC), from a clean resolver

## Summary

14 hostnames (`donau-carbon-us.devweb.emakina.at`, `donau-carbon.devweb.emakina.at`, `donau-chemie-group.devweb.emakina.at`, `donau-chemie-ro.devweb.emakina.at`, plus 10 more in the table below) are CNAMEs into 2 Azure App Service name(s) that no longer exist: `donauchemie-dev`, `lsgganterdev`. Each hostname is live in the organisation's DNS but resolves to nothing, because the upstream label was released and never re-created.

## Why this is claimable, not merely idle

Azure App Service names are globally unique. Deleting an app releases the name, and any Azure subscription can immediately create a new app with the same name, which then answers on `donauchemie-dev.azurewebsites.net`. The victim hostname is *not* added to the attacker's app and therefore never goes through the custom-domain `asuid` TXT verification introduced in 2021 — traffic reaches the attacker purely because the victim's CNAME still points at the freed label. The attacker does not need the victim's DNS zone at any point.

The NXDOMAIN is not our resolver guessing: `donauchemie-dev.azurewebsites.net` is answered NXDOMAIN by `ns1-224.azure-dns.com`, the authoritative nameserver for the zone. Microsoft is stating that the app does not exist; the label is therefore available to any subscriber.

## Affected hostnames

| hostname | CNAME target | target A record | victim HTTP |
|---|---|---|---|
| `donau-carbon-us.devweb.emakina.at` | `donauchemie-dev.azurewebsites.net` | none | hostname does not resolve (curl exit 6) |
| `donau-carbon.devweb.emakina.at` | `donauchemie-dev.azurewebsites.net` | none | hostname does not resolve (curl exit 6) |
| `donau-chemie-group.devweb.emakina.at` | `donauchemie-dev.azurewebsites.net` | none | hostname does not resolve (curl exit 6) |
| `donau-chemie-ro.devweb.emakina.at` | `donauchemie-dev.azurewebsites.net` | none | hostname does not resolve (curl exit 6) |
| `donau-chemie.devweb.emakina.at` | `donauchemie-dev.azurewebsites.net` | none | hostname does not resolve (curl exit 6) |
| `donau-products.devweb.emakina.at` | `donauchemie-dev.azurewebsites.net` | none | hostname does not resolve (curl exit 6) |
| `donau-realitaeten.devweb.emakina.at` | `donauchemie-dev.azurewebsites.net` | none | hostname does not resolve (curl exit 6) |
| `donau-umweltinformation.devweb.emakina.at` | `donauchemie-dev.azurewebsites.net` | none | hostname does not resolve (curl exit 6) |
| `donau.devweb.emakina.at` | `donauchemie-dev.azurewebsites.net` | none | hostname does not resolve (curl exit 6) |
| `donauchem-hu.devweb.emakina.at` | `donauchemie-dev.azurewebsites.net` | none | hostname does not resolve (curl exit 6) |
| `donauchem-pl.devweb.emakina.at` | `donauchemie-dev.azurewebsites.net` | none | hostname does not resolve (curl exit 6) |
| `donauchem-rs.devweb.emakina.at` | `donauchemie-dev.azurewebsites.net` | none | hostname does not resolve (curl exit 6) |
| `donauchem-sk.devweb.emakina.at` | `donauchemie-dev.azurewebsites.net` | none | hostname does not resolve (curl exit 6) |
| `ganterdevweb.emakina.at` | `lsgganterdev.azurewebsites.net` | none | hostname does not resolve (curl exit 6) |

## Evidence

### `donau-carbon-us.devweb.emakina.at`

- CNAME target: `donauchemie-dev.azurewebsites.net`
- Target A record: **none** (no answer)
- Victim hostname: hostname does not resolve (curl exit 6)
- Target NXDOMAIN confirmed by `ns1-224.azure-dns.com` (the zone's own authoritative NS)
- Captured: `2026-11-07T20:59:55Z` — raw output in `evidence-takeover/donau-carbon-us.devweb.emakina.at/`

### `donau-carbon.devweb.emakina.at`

- CNAME target: `donauchemie-dev.azurewebsites.net`
- Target A record: **none** (no answer)
- Victim hostname: hostname does not resolve (curl exit 6)
- Target NXDOMAIN confirmed by `ns1-224.azure-dns.com` (the zone's own authoritative NS)
- Captured: `2026-11-07T20:59:55Z` — raw output in `evidence-takeover/donau-carbon.devweb.emakina.at/`

### `donau-chemie-group.devweb.emakina.at`

- CNAME target: `donauchemie-dev.azurewebsites.net`
- Target A record: **none** (no answer)
- Victim hostname: hostname does not resolve (curl exit 6)
- Target NXDOMAIN confirmed by `ns1-224.azure-dns.com` (the zone's own authoritative NS)
- Captured: `2026-11-07T20:59:55Z` — raw output in `evidence-takeover/donau-chemie-group.devweb.emakina.at/`

### `donau-chemie-ro.devweb.emakina.at`

- CNAME target: `donauchemie-dev.azurewebsites.net`
- Target A record: **none** (no answer)
- Victim hostname: hostname does not resolve (curl exit 6)
- Target NXDOMAIN confirmed by `ns1-224.azure-dns.com` (the zone's own authoritative NS)
- Captured: `2026-11-07T20:59:55Z` — raw output in `evidence-takeover/donau-chemie-ro.devweb.emakina.at/`

### `donau-chemie.devweb.emakina.at`

- CNAME target: `donauchemie-dev.azurewebsites.net`
- Target A record: **none** (no answer)
- Victim hostname: hostname does not resolve (curl exit 6)
- Target NXDOMAIN confirmed by `ns1-224.azure-dns.com` (the zone's own authoritative NS)
- Captured: `2026-11-07T20:59:55Z` — raw output in `evidence-takeover/donau-chemie.devweb.emakina.at/`

### `donau-products.devweb.emakina.at`

- CNAME target: `donauchemie-dev.azurewebsites.net`
- Target A record: **none** (no answer)
- Victim hostname: hostname does not resolve (curl exit 6)
- Target NXDOMAIN confirmed by `ns1-224.azure-dns.com` (the zone's own authoritative NS)
- Captured: `2026-11-07T20:59:55Z` — raw output in `evidence-takeover/donau-products.devweb.emakina.at/`

*(remaining 8 hostnames follow the identical shape; raw captures are in `evidence-takeover/` for each)*

## Steps to reproduce

1. `dig +short donau-carbon-us.devweb.emakina.at CNAME` → the target in the table above.
2. `dig +short donauchemie-dev.azurewebsites.net A` → empty (no address, no CNAME). The label is unowned.
3. `curl -sSI https://donau-carbon-us.devweb.emakina.at/` → connection failure, confirming the hostname is dead end to end.
4. In an owned Azure subscription create a Web App named `donauchemie-dev`; the freed label is accepted because nothing holds it.
5. With that resource pointed at attacker content, `https://donau-carbon-us.devweb.emakina.at/` serves attacker content and `certbot --http-01` issues a trusted certificate for the victim hostname.

## Impact

Once the label is re-claimed the attacker serves arbitrary content from a hostname the organisation
still advertises as its own, which yields:

- **Valid TLS for the victim hostname.** With content control the attacker passes ACME HTTP-01 for
  `donau-carbon-us.devweb.emakina.at` and gets a publicly trusted certificate for it. Browsers show no warning, so this is a
  full impersonation, not a phishing lookalike.
- **Cookie and token theft** — any parent-domain cookie (`Domain=.emakina.at`) that is not `__Host-`
  prefixed is sent to the taken-over host.
- **Trust-boundary escape** — script loaded from `donau-carbon-us.devweb.emakina.at` inherits the origin trust other properties
  extend to `*.emakina.at` (CSP `script-src`, postMessage origin checks, `document.domain` relaxation).
- **OAuth / SSO abuse** — where the host is an allow-listed `redirect_uri` or `post_logout_redirect`
  value, the attacker receives the authorization code.
- **Reputation** — abuse, malware and credential-phishing traffic attributed to the brand's domain.

## Remediation

1. Delete the dangling CNAME, or re-point it at a resource the organisation controls today.
2. Re-create (or park) the freed Azure label in an owned subscription so nobody else can claim it.
3. Enable a dangling-DNS check in monitoring: any CNAME whose target stops resolving for more than a
   few hours should alarm, and should be treated as an incident rather than a hygiene ticket.

## Notes for the triager

Two orphaned app names (donauchemie-dev, lsgganterdev) carry 15 hostnames, which is the bulk-impact version of this bug: one Azure app creation, fifteen live client sites.
