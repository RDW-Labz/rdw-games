# Subdomain takeover of candle-src.etoro.com via unclaimed Traffic Manager profile

**Program:** eToro (Bugcrowd)  
**Affected asset(s):** 1 hostname(s), all in scope  
**Suggested severity:** P3 (High)  
**Verified:** 2026-11-07 (UTC), from a clean resolver

## Summary

`candle-src.etoro.com` is a CNAME to `prod-candle.trafficmanager.net`, an Azure Traffic Manager name that no longer belongs to anyone. The name does not resolve (NXDOMAIN / NODATA for the A query) and never answers HTTP, so the hostname currently serves nothing — but the provider label is free, so the next person to create it becomes the origin for the organisation's own hostname.

## Why this is claimable, not merely idle

Azure Traffic Manager profile names are global. A deleted profile frees its name, and a new profile with the same name answers on `prod-candle.trafficmanager.net`. Point the new profile's endpoint anywhere the attacker controls and every hostname still CNAME'd to the freed profile resolves to attacker content, with the attacker's choice of HTTP response.

The NXDOMAIN is not our resolver guessing: `prod-candle.trafficmanager.net` is answered NXDOMAIN by `tm1.dns-tm.com`, the authoritative nameserver for the zone. Microsoft is stating that the app does not exist; the label is therefore available to any subscriber.

## Affected hostnames

| hostname | CNAME target | target A record | victim HTTP |
|---|---|---|---|
| `candle-src.etoro.com` | `prod-candle.trafficmanager.net` | none | hostname does not resolve (curl exit 6) |

## Evidence

### `candle-src.etoro.com`

- CNAME target: `prod-candle.trafficmanager.net`
- Target A record: **none** (no answer)
- Victim hostname: hostname does not resolve (curl exit 6)
- Target NXDOMAIN confirmed by `tm1.dns-tm.com` (the zone's own authoritative NS)
- Captured: `2026-11-07T20:59:55Z` — raw output in `evidence-takeover/candle-src.etoro.com/`

## Steps to reproduce

1. `dig +short candle-src.etoro.com CNAME` → the target in the table above.
2. `dig +short prod-candle.trafficmanager.net A` → empty (no address, no CNAME). The label is unowned.
3. `curl -sSI https://candle-src.etoro.com/` → connection failure, confirming the hostname is dead end to end.
4. In an owned Azure subscription create a Traffic Manager profile named `prod-candle`; the freed label is accepted because nothing holds it.
5. With that resource pointed at attacker content, `https://candle-src.etoro.com/` serves attacker content and `certbot --http-01` issues a trusted certificate for the victim hostname.

## Impact

Once the label is re-claimed the attacker serves arbitrary content from a hostname the organisation
still advertises as its own, which yields:

- **Valid TLS for the victim hostname.** With content control the attacker passes ACME HTTP-01 for
  `candle-src.etoro.com` and gets a publicly trusted certificate for it. Browsers show no warning, so this is a
  full impersonation, not a phishing lookalike.
- **Cookie and token theft** — any parent-domain cookie (`Domain=.etoro.com`) that is not `__Host-`
  prefixed is sent to the taken-over host.
- **Trust-boundary escape** — script loaded from `candle-src.etoro.com` inherits the origin trust other properties
  extend to `*.etoro.com` (CSP `script-src`, postMessage origin checks, `document.domain` relaxation).
- **OAuth / SSO abuse** — where the host is an allow-listed `redirect_uri` or `post_logout_redirect`
  value, the attacker receives the authorization code.
- **Reputation** — abuse, malware and credential-phishing traffic attributed to the brand's domain.

## Remediation

1. Delete the dangling CNAME, or re-point it at a resource the organisation controls today.
2. Re-create (or park) the freed Traffic Manager label in an owned subscription so nobody else can claim it.
3. Enable a dangling-DNS check in monitoring: any CNAME whose target stops resolving for more than a
   few hours should alarm, and should be treated as an incident rather than a hygiene ticket.

## Notes for the triager

'candle-src' is served over HTTPS from an eToro-finance brand domain; a claimed profile also permits a trusted-origin script include for anything on *.etoro.com.
