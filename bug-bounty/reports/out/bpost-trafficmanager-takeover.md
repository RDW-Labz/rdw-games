# Subdomain takeover of combomobile-1.[ac|st]bpost.be via unclaimed Traffic Manager profiles

**Program:** bpost (Intigriti)  
**Affected asset(s):** 2 hostname(s), all in scope  
**Suggested severity:** P3 (High) — Traffic Manager profile names are global and re-creatable  
**Verified:** 2026-11-07 (UTC), from a clean resolver

## Summary

2 hostnames (`combomobile-1.acbpost.be`, `combomobile-1.stbpost.be`, plus -2 more in the table below) are CNAMEs into 2 Azure Traffic Manager name(s) that no longer exist: `combomobile-ac`, `combomobile-st`. Each hostname is live in the organisation's DNS but resolves to nothing, because the upstream label was released and never re-created.

## Why this is claimable, not merely idle

Azure Traffic Manager profile names are global. A deleted profile frees its name, and a new profile with the same name answers on `combomobile-ac.trafficmanager.net`. Point the new profile's endpoint anywhere the attacker controls and every hostname still CNAME'd to the freed profile resolves to attacker content, with the attacker's choice of HTTP response.

The NXDOMAIN is not our resolver guessing: `combomobile-ac.trafficmanager.net` is answered NXDOMAIN by `tm1.dns-tm.com`, the authoritative nameserver for the zone. Microsoft is stating that the app does not exist; the label is therefore available to any subscriber.

## Affected hostnames

| hostname | CNAME target | target A record | victim HTTP |
|---|---|---|---|
| `combomobile-1.acbpost.be` | `combomobile-ac.trafficmanager.net` | none | hostname does not resolve (curl exit 6) |
| `combomobile-1.stbpost.be` | `combomobile-st.trafficmanager.net` | none | hostname does not resolve (curl exit 6) |

## Evidence

### `combomobile-1.acbpost.be`

- CNAME target: `combomobile-ac.trafficmanager.net`
- Target A record: **none** (no answer)
- Victim hostname: hostname does not resolve (curl exit 6)
- Target NXDOMAIN confirmed by `tm1.dns-tm.com` (the zone's own authoritative NS)
- Captured: `2026-11-07T20:59:55Z` — raw output in `evidence-takeover/combomobile-1.acbpost.be/`

### `combomobile-1.stbpost.be`

- CNAME target: `combomobile-st.trafficmanager.net`
- Target A record: **none** (no answer)
- Victim hostname: hostname does not resolve (curl exit 6)
- Target NXDOMAIN confirmed by `tm1.dns-tm.com` (the zone's own authoritative NS)
- Captured: `2026-11-07T20:59:55Z` — raw output in `evidence-takeover/combomobile-1.stbpost.be/`

## Steps to reproduce

1. `dig +short combomobile-1.acbpost.be CNAME` → the target in the table above.
2. `dig +short combomobile-ac.trafficmanager.net A` → empty (no address, no CNAME). The label is unowned.
3. `curl -sSI https://combomobile-1.acbpost.be/` → connection failure, confirming the hostname is dead end to end.
4. In an owned Azure subscription create a Traffic Manager profile named `combomobile-ac`; the freed label is accepted because nothing holds it.
5. With that resource pointed at attacker content, `https://combomobile-1.acbpost.be/` serves attacker content and `certbot --http-01` issues a trusted certificate for the victim hostname.

## Impact

Once the label is re-claimed the attacker serves arbitrary content from a hostname the organisation
still advertises as its own, which yields:

- **Valid TLS for the victim hostname.** With content control the attacker passes ACME HTTP-01 for
  `combomobile-1.acbpost.be` and gets a publicly trusted certificate for it. Browsers show no warning, so this is a
  full impersonation, not a phishing lookalike.
- **Cookie and token theft** — any parent-domain cookie (`Domain=.acbpost.be`) that is not `__Host-`
  prefixed is sent to the taken-over host.
- **Trust-boundary escape** — script loaded from `combomobile-1.acbpost.be` inherits the origin trust other properties
  extend to `*.acbpost.be` (CSP `script-src`, postMessage origin checks, `document.domain` relaxation).
- **OAuth / SSO abuse** — where the host is an allow-listed `redirect_uri` or `post_logout_redirect`
  value, the attacker receives the authorization code.
- **Reputation** — abuse, malware and credential-phishing traffic attributed to the brand's domain.

## Remediation

1. Delete the dangling CNAME, or re-point it at a resource the organisation controls today.
2. Re-create (or park) the freed Traffic Manager label in an owned subscription so nobody else can claim it.
3. Enable a dangling-DNS check in monitoring: any CNAME whose target stops resolving for more than a
   few hours should alarm, and should be treated as an incident rather than a hygiene ticket.

## Notes for the triager

Both hosts are the same mobile product on the .be and .st brand domains; the two profiles (combomobile-ac, combomobile-st) are independently claimable.
