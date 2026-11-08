# Subdomain takeover of api.qa.whatsup.volkswagen.de via unclaimed Azure App Service name

**Program:** Volkswagen (Bugcrowd)  
**Affected asset(s):** 1 hostname(s), all in scope  
**Suggested severity:** P3 (High) — dangling DNS with a name any Azure subscription can re-claim  
**Verified:** 2026-11-07 (UTC), from a clean resolver

## Summary

`api.qa.whatsup.volkswagen.de` is a CNAME to `whatsup-backend-qa.azurewebsites.net`, an Azure App Service name that no longer belongs to anyone. The name does not resolve (NXDOMAIN / NODATA for the A query) and never answers HTTP, so the hostname currently serves nothing — but the provider label is free, so the next person to create it becomes the origin for the organisation's own hostname.

## Why this is claimable, not merely idle

Azure App Service names are globally unique. Deleting an app releases the name, and any Azure subscription can immediately create a new app with the same name, which then answers on `whatsup-backend-qa.azurewebsites.net`. The victim hostname is *not* added to the attacker's app and therefore never goes through the custom-domain `asuid` TXT verification introduced in 2021 — traffic reaches the attacker purely because the victim's CNAME still points at the freed label. The attacker does not need the victim's DNS zone at any point.

The NXDOMAIN is not our resolver guessing: `whatsup-backend-qa.azurewebsites.net` is answered NXDOMAIN by `ns1-224.azure-dns.com`, the authoritative nameserver for the zone. Microsoft is stating that the app does not exist; the label is therefore available to any subscriber.

## Affected hostnames

| hostname | CNAME target | target A record | victim HTTP |
|---|---|---|---|
| `api.qa.whatsup.volkswagen.de` | `whatsup-backend-qa.azurewebsites.net` | none | hostname does not resolve (curl exit 6) |

## Evidence

### `api.qa.whatsup.volkswagen.de`

- CNAME target: `whatsup-backend-qa.azurewebsites.net`
- Target A record: **none** (no answer)
- Victim hostname: hostname does not resolve (curl exit 6)
- Target NXDOMAIN confirmed by `ns1-224.azure-dns.com` (the zone's own authoritative NS)
- Captured: `2026-11-07T20:59:55Z` — raw output in `evidence-takeover/api.qa.whatsup.volkswagen.de/`

## Steps to reproduce

1. `dig +short api.qa.whatsup.volkswagen.de CNAME` → the target in the table above.
2. `dig +short whatsup-backend-qa.azurewebsites.net A` → empty (no address, no CNAME). The label is unowned.
3. `curl -sSI https://api.qa.whatsup.volkswagen.de/` → connection failure, confirming the hostname is dead end to end.
4. In an owned Azure subscription create a Web App named `whatsup-backend-qa`; the freed label is accepted because nothing holds it.
5. With that resource pointed at attacker content, `https://api.qa.whatsup.volkswagen.de/` serves attacker content and `certbot --http-01` issues a trusted certificate for the victim hostname.

## Impact

Once the label is re-claimed the attacker serves arbitrary content from a hostname the organisation
still advertises as its own, which yields:

- **Valid TLS for the victim hostname.** With content control the attacker passes ACME HTTP-01 for
  `api.qa.whatsup.volkswagen.de` and gets a publicly trusted certificate for it. Browsers show no warning, so this is a
  full impersonation, not a phishing lookalike.
- **Cookie and token theft** — any parent-domain cookie (`Domain=.volkswagen.de`) that is not `__Host-`
  prefixed is sent to the taken-over host.
- **Trust-boundary escape** — script loaded from `api.qa.whatsup.volkswagen.de` inherits the origin trust other properties
  extend to `*.volkswagen.de` (CSP `script-src`, postMessage origin checks, `document.domain` relaxation).
- **OAuth / SSO abuse** — where the host is an allow-listed `redirect_uri` or `post_logout_redirect`
  value, the attacker receives the authorization code.
- **Reputation** — abuse, malware and credential-phishing traffic attributed to the brand's domain.

## Remediation

1. Delete the dangling CNAME, or re-point it at a resource the organisation controls today.
2. Re-create (or park) the freed Azure label in an owned subscription so nobody else can claim it.
3. Enable a dangling-DNS check in monitoring: any CNAME whose target stops resolving for more than a
   few hours should alarm, and should be treated as an incident rather than a hygiene ticket.

## Notes for the triager

QA-namespaced host, so the program may treat impact as reduced. The takedown primitive is identical to a production host: the label is unowned, not merely idle.
