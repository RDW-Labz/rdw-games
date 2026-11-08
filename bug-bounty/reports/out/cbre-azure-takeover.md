# Subdomain takeover of scorecard.prod.cbreapps.com and test.angulardemo.emerald.cbre.com

**Program:** CBRE (HackerOne)  
**Affected asset(s):** 2 hostname(s), all in scope  
**Suggested severity:** High  
**Verified:** 2026-11-07 (UTC), from a clean resolver

## Summary

2 hostnames (`scorecard.prod.cbreapps.com`, `test.angulardemo.emerald.cbre.com`, plus -2 more in the table below) are CNAMEs into 2 Azure App Service name(s) that no longer exist: `gws-scorecard-prod-uks-app`, `testemeraldangulardemo`. Each hostname is live in the organisation's DNS but resolves to nothing, because the upstream label was released and never re-created.

## Why this is claimable, not merely idle

Azure App Service names are globally unique. Deleting an app releases the name, and any Azure subscription can immediately create a new app with the same name, which then answers on `gws-scorecard-prod-uks-app.azurewebsites.net`. The victim hostname is *not* added to the attacker's app and therefore never goes through the custom-domain `asuid` TXT verification introduced in 2021 — traffic reaches the attacker purely because the victim's CNAME still points at the freed label. The attacker does not need the victim's DNS zone at any point.

The NXDOMAIN is not our resolver guessing: `gws-scorecard-prod-uks-app.azurewebsites.net` is answered NXDOMAIN by `ns1-224.azure-dns.com`, the authoritative nameserver for the zone. Microsoft is stating that the app does not exist; the label is therefore available to any subscriber.

## Affected hostnames

| hostname | CNAME target | target A record | victim HTTP |
|---|---|---|---|
| `scorecard.prod.cbreapps.com` | `gws-scorecard-prod-uks-app.azurewebsites.net` | none | hostname does not resolve (curl exit 6) |
| `test.angulardemo.emerald.cbre.com` | `testemeraldangulardemo.azurewebsites.net` | none | hostname does not resolve (curl exit 6) |

## Evidence

### `scorecard.prod.cbreapps.com`

- CNAME target: `gws-scorecard-prod-uks-app.azurewebsites.net`
- Target A record: **none** (no answer)
- Victim hostname: hostname does not resolve (curl exit 6)
- Target NXDOMAIN confirmed by `ns1-224.azure-dns.com` (the zone's own authoritative NS)
- Captured: `2026-11-07T20:59:55Z` — raw output in `evidence-takeover/scorecard.prod.cbreapps.com/`

### `test.angulardemo.emerald.cbre.com`

- CNAME target: `testemeraldangulardemo.azurewebsites.net`
- Target A record: **none** (no answer)
- Victim hostname: hostname does not resolve (curl exit 6)
- Target NXDOMAIN confirmed by `ns1-224.azure-dns.com` (the zone's own authoritative NS)
- Captured: `2026-11-07T20:59:55Z` — raw output in `evidence-takeover/test.angulardemo.emerald.cbre.com/`

## Steps to reproduce

1. `dig +short scorecard.prod.cbreapps.com CNAME` → the target in the table above.
2. `dig +short gws-scorecard-prod-uks-app.azurewebsites.net A` → empty (no address, no CNAME). The label is unowned.
3. `curl -sSI https://scorecard.prod.cbreapps.com/` → connection failure, confirming the hostname is dead end to end.
4. In an owned Azure subscription create a Web App named `gws-scorecard-prod-uks-app`; the freed label is accepted because nothing holds it.
5. With that resource pointed at attacker content, `https://scorecard.prod.cbreapps.com/` serves attacker content and `certbot --http-01` issues a trusted certificate for the victim hostname.

## Impact

Once the label is re-claimed the attacker serves arbitrary content from a hostname the organisation
still advertises as its own, which yields:

- **Valid TLS for the victim hostname.** With content control the attacker passes ACME HTTP-01 for
  `scorecard.prod.cbreapps.com` and gets a publicly trusted certificate for it. Browsers show no warning, so this is a
  full impersonation, not a phishing lookalike.
- **Cookie and token theft** — any parent-domain cookie (`Domain=.cbreapps.com`) that is not `__Host-`
  prefixed is sent to the taken-over host.
- **Trust-boundary escape** — script loaded from `scorecard.prod.cbreapps.com` inherits the origin trust other properties
  extend to `*.cbreapps.com` (CSP `script-src`, postMessage origin checks, `document.domain` relaxation).
- **OAuth / SSO abuse** — where the host is an allow-listed `redirect_uri` or `post_logout_redirect`
  value, the attacker receives the authorization code.
- **Reputation** — abuse, malware and credential-phishing traffic attributed to the brand's domain.

## Remediation

1. Delete the dangling CNAME, or re-point it at a resource the organisation controls today.
2. Re-create (or park) the freed Azure label in an owned subscription so nobody else can claim it.
3. Enable a dangling-DNS check in monitoring: any CNAME whose target stops resolving for more than a
   few hours should alarm, and should be treated as an incident rather than a hygiene ticket.
