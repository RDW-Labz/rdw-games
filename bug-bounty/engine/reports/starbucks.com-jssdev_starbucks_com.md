# Dangling DNS / subdomain takeover: `jssdev.starbucks.com`

**Program / owner:** Starbucks
**Channel:** security
**Asset:** `jssdev.starbucks.com` -> `jssdev-starbucks.trafficmanager.net`
**Namespace:** trafficmanager.net
**Verdict:** claimable by a third party
**Detected:** 2026-11-02T03:36:20+00:00
**Severity:** Medium (takeover) — CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N (6.1)

## Summary

`jssdev.starbucks.com` is a rule in the Starbucks DNS zone that points at `jssdev-starbucks.trafficmanager.net`, which no longer answers:

```
jssdev.starbucks.com.	6723	IN	CNAME	jssdev-starbucks.trafficmanager.net.

; jssdev-starbucks.trafficmanager.net -> status: NXDOMAIN
```

How the name is claimable: Microsoft: profile name is reserved after deletion, then reusable by a different tenant.

Claim path: `create a Traffic Manager profile with the same name, add an External endpoint` (Azure subscription).

## Impact

A stranger holding that hostname serves attacker-controlled content at `https://jssdev.starbucks.com` — with a
certificate issued for the exact name, since DNS validation passes through the record. That buys
phishing inside the Starbucks brand, bypass of any `*` allow-list keyed on the domain (CORS,
`redirect_uri`, CSP, proxy rules), and capture of any request — including bearer tokens — still
configured for the dead hostname.

## Remediation

1. Delete the DNS record for `jssdev.starbucks.com`. That alone closes it.
2. Add "delete the DNS records" to the service teardown checklist.
3. Sweep the zone once for any CNAME whose target no longer resolves.

## Testing notes

Passive only: certificate transparency logs plus `dig`. No HTTP requests to the record, no account
created, nothing claimed. I will keep this private for the policy window.

_Auto-drafted by engine/dangling.py — human-edit before sending._
