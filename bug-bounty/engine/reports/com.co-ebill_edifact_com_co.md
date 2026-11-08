# Dangling DNS / subdomain takeover: `ebill.edifact.com.co`

**Program / owner:** amazonvrp,mercadolibre
**Channel:** 
**Asset:** `ebill.edifact.com.co` -> `facturaelectronica1.trafficmanager.net`
**Namespace:** trafficmanager.net
**Verdict:** claimable by a third party
**Detected:** 2026-11-03T03:18:57+00:00
**Severity:** Medium (takeover) — CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N (6.1)

## Summary

`ebill.edifact.com.co` is a rule in the amazonvrp,mercadolibre DNS zone that points at `facturaelectronica1.trafficmanager.net`, which no longer answers:

```
ebill.edifact.com.co.	3600	IN	CNAME	facturaelectronica1.trafficmanager.net.

; facturaelectronica1.trafficmanager.net -> status: NXDOMAIN
```

How the name is claimable: Microsoft: profile name is reserved after deletion, then reusable by a different tenant.

Claim path: `create a Traffic Manager profile with the same name, add an External endpoint` (Azure subscription).

## Impact

A stranger holding that hostname serves attacker-controlled content at `https://ebill.edifact.com.co` — with a
certificate issued for the exact name, since DNS validation passes through the record. That buys
phishing inside the amazonvrp,mercadolibre brand, bypass of any `*` allow-list keyed on the domain (CORS,
`redirect_uri`, CSP, proxy rules), and capture of any request — including bearer tokens — still
configured for the dead hostname.

## Remediation

1. Delete the DNS record for `ebill.edifact.com.co`. That alone closes it.
2. Add "delete the DNS records" to the service teardown checklist.
3. Sweep the zone once for any CNAME whose target no longer resolves.

## Testing notes

Passive only: certificate transparency logs plus `dig`. No HTTP requests to the record, no account
created, nothing claimed. I will keep this private for the policy window.

_Auto-drafted by engine/dangling.py — human-edit before sending._
